import type { Database } from 'better-sqlite3';
import { SkillsRegistry } from '../skills/index.js';
import { PluginRegistry } from '../plugins/index.js';
import { detectLearningSignals } from './detector.js';
import { EvolutionProposalStore } from './store.js';
import type { IEvolutionEngine } from './contract.js';
import type { EvolutionRunResult, LearningSignal } from './types.js';
import type { UnifiedEvolutionExtractor, EvolutionExtractionInput } from './unified-extractor.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('evolution-engine');
import { genId } from '../utils/id.js';
import { redactSecrets } from '../observability/redaction.js';

export class EvolutionEngine implements IEvolutionEngine {
  private readonly proposals: EvolutionProposalStore;
  private readonly skills: SkillsRegistry;
  private readonly plugins: PluginRegistry;
  private extractor: UnifiedEvolutionExtractor | null = null;

  constructor(private readonly db: Database) {
    this.proposals = new EvolutionProposalStore(db);
    this.skills = new SkillsRegistry(db);
    this.plugins = new PluginRegistry(db);
  }

  setExtractor(extractor: UnifiedEvolutionExtractor): void {
    this.extractor = extractor;
  }

  hasExtractor(): boolean {
    return this.extractor !== null;
  }

  runAfterConversation(input: {
    sessionId: string;
    userMessage: string;
    assistantResponse: string;
  }): EvolutionRunResult {
    const signals = detectLearningSignals(input.userMessage, input.assistantResponse);
    return this.runSignals(input, signals);
  }

  async runAfterConversationAsync(input: EvolutionExtractionInput): Promise<EvolutionRunResult> {
    if (!this.extractor) {
      return this.runAfterConversation(input);
    }

    const extraction = await this.extractor.extract(input);

    // Store user facts in knowledge table
    this.storeUserFacts(input.sessionId, extraction.userFacts);

    // Process capability gaps through existing signal flow
    return this.runSignals(input, extraction.capabilityGaps);
  }

  private storeUserFacts(sessionId: string, facts: Array<{ type: string; summary: string; confidence: number }>): void {
    if (facts.length === 0) return;
    try {
      for (const fact of facts) {
        const existing = this.db.prepare(
          `SELECT id FROM knowledge WHERE summary = ? AND owner_key = 'user:owner' LIMIT 1`,
        ).get(fact.summary) as { id: string } | undefined;
        if (existing) continue;

        this.db.prepare(`
          INSERT INTO knowledge (id, owner_key, type, summary, evidence_kind, source, confidence, created_at, updated_at, last_seen_at)
          VALUES (?, 'user:owner', ?, ?, 'inferred', 'conversation', ?, ?, ?, ?)
        `).run(
          genId('kn'),
          mapFactTypeToKnowledgeType(fact.type),
          redactSecrets(fact.summary),
          fact.confidence,
          Date.now(),
          Date.now(),
          Date.now(),
        );
      }
    } catch (err) {
      // knowledge table schema may differ during migration
      logger.debug({ err, factCount: facts.length, sessionId }, 'evolution: knowledge insert skipped (schema mismatch)');
    }
  }

  runSignals(input: {
    sessionId: string;
    userMessage: string;
    assistantResponse: string;
  }, signals: LearningSignal[]): EvolutionRunResult {
    if (signals.length === 0) {
      return { proposals: [], applied: [], skippedReason: '没有发现需要沉淀的自进化信号' };
    }

    const proposals = [];
    const applied: EvolutionRunResult['applied'] = [];

    for (const signal of signals) {
      const proposalType = signal.kind === 'skill' ? 'skill_create' : 'plugin_create';
      if (signal.kind === 'skill' && this.skills.get(signal.targetName)) {
        this.recordSignalHistory(signal, input.sessionId, 'deduped');
        continue;
      }
      if (signal.kind === 'plugin' && this.plugins.get(signal.targetName)) {
        this.recordSignalHistory(signal, input.sessionId, 'deduped');
        continue;
      }

      const existing = this.proposals.findOpenByTarget(proposalType, signal.targetName);
      if (existing) {
        this.recordSignalHistory(signal, input.sessionId, 'deduped');
        proposals.push(existing);
        continue;
      }

      this.recordSignalHistory(signal, input.sessionId, 'accepted');

      const proposal = this.proposals.create({
        type: proposalType,
        source: 'conversation',
        targetName: signal.targetName,
        riskLevel: signal.riskLevel,
        status: signal.kind === 'skill' ? 'approved' : 'validating',
        reason: signal.description,
        evidence: {
          sessionId: input.sessionId,
          userMessage: input.userMessage,
          assistantResponse: input.assistantResponse,
          observations: signal.observations,
          confidence: signal.kind === 'skill' ? 0.72 : 0.62,
        },
      });
      proposals.push(proposal);

      if (signal.kind === 'skill') {
        const skill = this.skills.createOrUpdateGeneratedSkill({
          name: signal.targetName,
          description: signal.description,
          evidence: buildEvidence(signal, input.userMessage),
          source: 'conversation',
        });
        const updated = this.proposals.update(proposal.id, {
          status: 'applied',
          draftPath: skill.filePath,
          validatorResult: { ok: true, kind: 'skill' },
        });
        proposals[proposals.length - 1] = updated;
        applied.push({ proposalId: proposal.id, targetName: skill.name, path: skill.filePath, kind: 'skill' });
      } else {
        const { manifest, validation } = this.plugins.createDraft({
          name: signal.targetName,
          description: signal.description,
          evidence: buildEvidence(signal, input.userMessage),
          riskLevel: signal.riskLevel,
        });
        const updated = this.proposals.update(proposal.id, {
          status: validation.ok ? 'pending_review' : 'failed',
          draftPath: manifest.pluginDir,
          validatorResult: { ...validation },
        });
        proposals[proposals.length - 1] = updated;
        applied.push({ proposalId: proposal.id, targetName: manifest.name, path: manifest.pluginDir, kind: 'plugin' });
      }
    }

    return { proposals, applied };
  }

  listProposals() {
    return this.proposals.list();
  }

  getSignalHistory(opts?: { target?: string; limit?: number }) {
    return this.proposals.getSignalHistory(opts);
  }

  private recordSignalHistory(
    signal: LearningSignal,
    sessionId: string,
    outcome: 'pending' | 'accepted' | 'rejected' | 'deduped',
  ): void {
    try {
      this.db.prepare(`
        INSERT INTO signal_history (id, signal_type, target, confidence, source_turn_id, outcome, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        genId('sig'),
        signal.kind,
        signal.targetName,
        signal.kind === 'skill' ? 0.72 : 0.62,
        sessionId,
        outcome,
        Date.now(),
      );
    } catch (err) {
      // table may not exist yet during initial migration
      logger.debug({ err, signalKind: signal.kind, target: signal.targetName, outcome }, 'evolution: signal_history insert skipped (table not ready)');
    }
  }
}

function buildEvidence(signal: LearningSignal, userMessage: string): string[] {
  return [
    `用户原话: ${userMessage}`,
    ...signal.observations,
  ];
}

function mapFactTypeToKnowledgeType(factType: string): string {
  const mapping: Record<string, string> = {
    preference: 'preference',
    knowledge: 'fact',
    habit: 'habit',
    constraint: 'constraint',
    goal: 'goal',
  };
  return mapping[factType] ?? 'fact';
}
