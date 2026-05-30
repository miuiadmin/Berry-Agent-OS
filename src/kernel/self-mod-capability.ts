import type { CapabilityBus } from '../bus/capability-bus.js';
import type { CapabilityExecutor, InvokeContext } from '../bus/contract.js';
import type { SelfModificationAudit, PromptTarget, ModificationProposal } from './self-modification-audit.js';
import type { ImaginationEngine } from './imagination-engine.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('self-mod-capability');

const VALID_TARGETS: PromptTarget[] = ['brain_routing', 'brain_review', 'brain_permission', 'brain_correction'];

export interface SelfModCapabilityDeps {
  audit: SelfModificationAudit;
  imagination?: ImaginationEngine | null;
  requireSimulation?: boolean;
  minSimulationScore?: number;
}

export function registerSelfModificationCapabilities(bus: CapabilityBus, deps: SelfModCapabilityDeps): void {
  // 1. Propose a prompt modification (Brain calls this to modify itself)
  bus.register(
    {
      name: 'brain.self_modify',
      description: 'Propose a modification to one of Brain\'s own system prompts. Requires reason and evidence.',
      dangerLevel: 'moderate',
      provider: { type: 'builtin', name: 'self-modification' },
    },
    createModifyExecutor(deps),
  );

  // 2. View current prompt version
  bus.register(
    {
      name: 'brain.prompt_version',
      description: 'Get the current active version of a Brain prompt target.',
      dangerLevel: 'safe',
      provider: { type: 'builtin', name: 'self-modification' },
    },
    async (input) => {
      const { target } = input as { target: string };
      if (!VALID_TARGETS.includes(target as PromptTarget)) {
        throw new Error(`Invalid target: ${target}. Valid: ${VALID_TARGETS.join(', ')}`);
      }
      const version = deps.audit.getCurrentVersion(target as PromptTarget);
      if (!version) return { exists: false, target };
      return { exists: true, target, version: version.version, contentLength: version.content.length, reason: version.reason, source: version.source };
    },
  );

  // 3. Rollback to previous version
  bus.register(
    {
      name: 'brain.prompt_rollback',
      description: 'Roll back a Brain prompt to a previous version. Use when a modification degraded performance.',
      dangerLevel: 'moderate',
      provider: { type: 'builtin', name: 'self-modification' },
    },
    async (input) => {
      const { target, toVersion } = input as { target: string; toVersion?: number };
      if (!VALID_TARGETS.includes(target as PromptTarget)) {
        throw new Error(`Invalid target: ${target}`);
      }
      return deps.audit.rollback(target as PromptTarget, toVersion);
    },
  );

  // 4. Get modification history/stats
  bus.register(
    {
      name: 'brain.prompt_stats',
      description: 'Get modification statistics for a Brain prompt target.',
      dangerLevel: 'safe',
      provider: { type: 'builtin', name: 'self-modification' },
    },
    async (input) => {
      const { target } = input as { target: string };
      if (!VALID_TARGETS.includes(target as PromptTarget)) {
        throw new Error(`Invalid target: ${target}`);
      }
      const stats = deps.audit.getModificationStats(target as PromptTarget);
      const history = deps.audit.getVersionHistory(target as PromptTarget, 5);
      return {
        ...stats,
        recentVersions: history.map(v => ({
          version: v.version,
          reason: v.reason,
          source: v.source,
          status: v.status,
          score: v.performanceScore,
        })),
      };
    },
  );

  logger.info('Self-modification capabilities registered on Bus');
}

function createModifyExecutor(deps: SelfModCapabilityDeps): CapabilityExecutor {
  return async (input, ctx) => {
    const { target, newContent, reason, evidenceIds, expectedImprovement } = input as {
      target: string;
      newContent: string;
      reason: string;
      evidenceIds?: string[];
      expectedImprovement?: string;
    };

    if (!VALID_TARGETS.includes(target as PromptTarget)) {
      throw new Error(`Invalid target: ${target}. Valid: ${VALID_TARGETS.join(', ')}`);
    }
    if (!newContent || newContent.length < 50) {
      throw new Error('New prompt content must be at least 50 characters');
    }
    if (!reason || reason.length < 10) {
      throw new Error('Reason must be at least 10 characters explaining why this modification is needed');
    }

    const proposal: ModificationProposal = {
      target: target as PromptTarget,
      newContent,
      reason,
      evidenceIds: evidenceIds ?? [],
      expectedImprovement: expectedImprovement ?? '',
    };

    // Run imagination simulation if available and required
    if (deps.imagination && deps.requireSimulation !== false) {
      const simulationResult = await deps.imagination.simulate({
        proposedChange: `[${proposal.target}] ${proposal.reason}\n\n${proposal.newContent.slice(0, 500)}`,
        changeType: 'prompt_modification',
        context: proposal.expectedImprovement,
      });
      const minScore = deps.minSimulationScore ?? 0.6;

      if (!simulationResult.shouldProceed || simulationResult.confidence < minScore) {
        logger.info({
          target,
          confidence: simulationResult.confidence,
          shouldProceed: simulationResult.shouldProceed,
          minScore,
        }, 'Self-modification rejected by imagination engine');

        return {
          approved: false,
          reason: `Simulation rejected: confidence ${simulationResult.confidence.toFixed(2)}, improvement ${simulationResult.predictedImprovement.toFixed(2)} — ${simulationResult.reasoning}`,
          simulationConfidence: simulationResult.confidence,
        };
      }
    }

    // Apply modification through audit framework
    const result = deps.audit.applyModification(proposal, 'brain_self');

    logger.info({
      target,
      approved: result.approved,
      versionId: result.versionId,
      reason: result.reason,
    }, 'Self-modification applied');

    return result;
  };
}
