import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CapabilityBus } from '../bus/capability-bus.js';
import { PermissionGate } from '../bus/permission-gate.js';
import { BusAuditLogger } from '../bus/audit-logger.js';
import { registerToolsAsBusCapabilities } from '../bus/tool-adapter.js';
import { registerPermissionCapabilities } from '../bus/permission-capability.js';
import { registerTimeIntelligenceCapabilities } from '../bus/time-capability.js';
import { WorldModelRuntime } from './world-model.js';
import { TimeIntelligence } from './time-intelligence.js';
import { SuggestionQueue } from './suggestion-queue.js';
import { PromptVersioning } from './prompt-versioning.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import { PermissionEngine } from '../safety/permissions.js';
import { TokenIssuer } from '../safety/token-issuer.js';
import { ApprovalManager } from '../safety/approval-manager.js';
import { runInsightsLifecycle } from './insights-lifecycle.js';
import { BrainDecisionRecorder } from './brain-decision-recorder.js';
import type { ToolDefinition } from '../tools/types.js';
import { z } from 'zod';

function setupFullDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE world_model (id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, session_id TEXT, decision_type TEXT, input_summary TEXT, output_json TEXT, confidence REAL, outcome TEXT, feedback_source TEXT, created_at INTEGER);
    CREATE TABLE system_insights (id TEXT PRIMARY KEY, category TEXT, title TEXT, content TEXT, confidence REAL, status TEXT DEFAULT 'tentative', source_decisions TEXT, adopted_count INTEGER DEFAULT 0, last_adopted_at INTEGER, created_at INTEGER, updated_at INTEGER, expired_at INTEGER);
    CREATE TABLE approval_requests (id TEXT PRIMARY KEY, run_id TEXT, session_id TEXT, task_id TEXT, correlation_id TEXT, kind TEXT, requester TEXT, risk_level TEXT, request_payload TEXT, binding_payload TEXT, status TEXT DEFAULT 'pending', decision_source TEXT, reason TEXT, expires_at INTEGER, created_at INTEGER, resolved_at INTEGER);
    CREATE TABLE permission_tokens (id TEXT PRIMARY KEY, approval_id TEXT, session_id TEXT, agent_name TEXT, tool_name TEXT, input_hash TEXT, cwd TEXT, verdict TEXT, expires_at INTEGER, consumed INTEGER DEFAULT 0, created_at INTEGER);
    CREATE TABLE capability_invocations (id TEXT PRIMARY KEY, capability_name TEXT, provider_type TEXT, provider_name TEXT, caller_agent TEXT, session_id TEXT, correlation_id TEXT, call_chain TEXT DEFAULT '[]', input_json TEXT, output_json TEXT, ok INTEGER DEFAULT 1, error TEXT, duration_ms INTEGER, created_at INTEGER);
  `);
  return db;
}

describe('5.0 Architecture E2E Integration', () => {
  let db: Database.Database;
  let bus: CapabilityBus;
  let worldModel: WorldModelRuntime;
  let timeIntelligence: TimeIntelligence;
  let suggestionQueue: SuggestionQueue;
  let promptVersioning: PromptVersioning;

  beforeEach(() => {
    db = setupFullDb();
    bus = new CapabilityBus();
    worldModel = new WorldModelRuntime(db);
    timeIntelligence = new TimeIntelligence(db);
    suggestionQueue = new SuggestionQueue(db);
    promptVersioning = new PromptVersioning(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('Capability Bus → Permission → Audit', () => {
    it('full tool invocation with permission check and audit', async () => {
      // Setup permission system
      const permissionEngine = new PermissionEngine('ask');
      const tokenIssuer = new TokenIssuer(db);
      const approvalManager = new ApprovalManager(db, tokenIssuer, 'ask');
      const coordinator = new PermissionCoordinator({ engine: permissionEngine, tokenIssuer, approvalManager });

      // Setup permission gate with mock Brain judge
      const gate = new PermissionGate();
      gate.setBrainJudge({
        requestJudge: async () => ({ allowed: true, reason: 'Brain approved' }),
      });
      bus.setPermissionGate(gate);
      bus.setAuditLogger(new BusAuditLogger(db));

      // Register a dangerous tool
      const dangerousTool: ToolDefinition = {
        name: 'delete_file',
        description: 'Delete a file',
        inputSchema: z.object({ path: z.string() }),
        dangerLevel: 'dangerous',
        execute: async (input: any) => ({ content: `Deleted ${input.path}`, isError: false }),
      };
      registerToolsAsBusCapabilities(bus, [dangerousTool]);

      // Register permission capabilities
      registerPermissionCapabilities(bus, {
        permissionCoordinator: coordinator,
        requestBrainJudge: async () => ({ allowed: true, reason: 'approved' }),
      });

      // Invoke the dangerous tool — should pass through permission gate
      const result = await bus.invoke('delete_file', { path: '/tmp/test' }, {
        callChain: [],
        callerAgent: 'conversation',
        sessionId: 'sess-1',
        correlationId: 'corr-1',
      });

      expect(result.ok).toBe(true);
      expect(result.data).toBe('Deleted /tmp/test');

      // Verify audit trail
      const audits = db.prepare(`SELECT * FROM capability_invocations`).all() as Array<Record<string, unknown>>;
      expect(audits.length).toBeGreaterThan(0);
      expect(audits[0].capability_name).toBe('delete_file');
    });
  });

  describe('World Model → Brain Decision → Insights lifecycle', () => {
    it('conversation updates world model, records decision, cycles insights', () => {
      // Simulate conversation
      worldModel.updateFromConversation({
        userMessage: '这个 bug 又出现了，为什么总是修不好',
        assistantResponse: '让我重新检查一下',
        sessionId: 'sess-1',
      });

      const snapshot = worldModel.getSnapshot();
      expect(snapshot.user.frustrationSignals).toBeGreaterThan(0);
      expect(snapshot.temporal.turnsInSession).toBe(1);

      // Record brain decision
      const recorder = new BrainDecisionRecorder(db);
      recorder.recordRouteDecision('sess-1', '这个 bug 又出现了', {
        intent: 'code',
        targetAgent: 'code',
        confidence: 0.8,
      });

      const decisions = db.prepare(`SELECT * FROM brain_decisions`).all() as Array<Record<string, unknown>>;
      expect(decisions.length).toBe(1);
      expect(decisions[0].decision_type).toBe('route');

      // Insert a tentative insight and adopt it
      db.prepare(`
        INSERT INTO system_insights (id, category, title, content, confidence, status, adopted_count, created_at, updated_at)
        VALUES ('ins-1', 'routing', 'Code routing high confidence', '{}', 0.7, 'tentative', 3, ?, ?)
      `).run(Date.now() - 86400_000, Date.now());

      // Run lifecycle — should validate since adopted_count >= 3
      const lifecycle = runInsightsLifecycle(db);
      expect(lifecycle.validated).toBe(1);
    });
  });

  describe('Time Intelligence → Bus execution', () => {
    it('creates plan and executes ready steps via Bus', async () => {
      let executed = false;
      bus.register(
        { name: 'run_test', description: 'Run tests', dangerLevel: 'safe', provider: { type: 'builtin', name: 'test' } },
        async () => { executed = true; return 'tests passed'; },
      );

      registerTimeIntelligenceCapabilities(bus, timeIntelligence);

      // Create a plan with a step that's already due
      const plan = timeIntelligence.createPlan({
        title: 'Run nightly tests',
        description: 'Automated test suite',
        createdBy: 'brain',
        steps: [
          { description: 'Execute tests', triggerType: 'scheduled', triggerAt: Date.now() - 1000, capability: 'run_test' },
        ],
      });

      // Get ready steps and execute
      const ready = timeIntelligence.getReadySteps();
      expect(ready).toHaveLength(1);

      const result = await bus.invoke(ready[0].capability!, ready[0].input ?? {}, {
        callChain: [],
        callerAgent: 'brain',
        sessionId: 'time-plan',
        correlationId: 'tp-1',
      });

      expect(result.ok).toBe(true);
      expect(executed).toBe(true);

      timeIntelligence.completeStep(ready[0].id, result.data as string);

      // Plan should be completed
      const active = timeIntelligence.getActivePlans();
      expect(active).toHaveLength(0);
    });
  });

  describe('Suggestion Queue → Brain routing context', () => {
    it('stores suggestions and delivers as prompt block', () => {
      suggestionQueue.push({
        source: 'will_loop',
        title: '项目 X 有 3 天没动了',
        description: 'deadline 临近，建议提醒用户',
        urgency: 'high',
      });
      suggestionQueue.push({
        source: 'learning',
        title: '代码风格偏好已更新',
        description: '用户倾向 functional style',
        urgency: 'low',
      });

      const block = suggestionQueue.buildPromptBlock();
      expect(block).toContain('项目 X');
      expect(block).toContain('代码风格');
      expect(block).toContain('will_loop');

      // After delivery, no more pending
      const pending = suggestionQueue.getPending();
      expect(pending).toHaveLength(0);
    });
  });

  describe('Prompt Versioning → Self-modification', () => {
    it('creates versioned prompt, rolls back on regression', () => {
      // Propose initial version
      promptVersioning.propose({
        promptKey: 'brain.routing',
        newContent: 'You are a router. Route messages to agents.',
        changeReason: 'Initial setup',
        changeSource: 'manual',
      });

      // Brain proposes improvement
      const v2 = promptVersioning.propose({
        promptKey: 'brain.routing',
        newContent: 'You are an intelligent router. Consider context deeply.',
        changeReason: 'Brain self-improvement based on high fallback rate',
        changeSource: 'brain',
        currentMetrics: { fallbackRate: 0.3 },
      });

      expect(promptVersioning.getActiveVersion('brain.routing')?.version).toBe(2);

      // Metrics worsen → rollback
      promptVersioning.recordMetricsAfterAdoption(v2.id, { fallbackRate: 0.5 });
      const rolledBack = promptVersioning.rollback('brain.routing', 'fallback rate increased');

      expect(rolledBack?.version).toBe(1);
      expect(rolledBack?.content).toContain('Route messages');
    });
  });

  describe('Full autonomous cycle simulation', () => {
    it('world event → suggestion → delivery on next interaction', () => {
      // External event arrives
      worldModel.updateFromEvent({
        type: 'ci_failure',
        source: 'github',
        summary: 'Build failed on main branch',
        severity: 'warning',
      });

      // Will Loop would produce suggestion (simulating)
      suggestionQueue.push({
        source: 'will_loop',
        title: 'CI 构建失败',
        description: '主分支构建失败，可能需要关注',
        urgency: 'high',
        capability: 'run_command',
        input: { command: 'npm test' },
      });

      // Next user interaction: build context
      const worldSummary = worldModel.getSummary();
      const suggestionsBlock = suggestionQueue.buildPromptBlock('sess-1');

      // Brain would see this in routing
      const routingContext = [worldSummary, suggestionsBlock].filter(Boolean).join('\n');
      expect(routingContext).toContain('CI');
      expect(routingContext).toContain('构建失败');

      // After delivery, queue is clean
      expect(suggestionQueue.getPending()).toHaveLength(0);
    });
  });
});
