import type { LlmClient } from '../llm/index.js';
import type { WorldModelRuntime } from './world-model.js';
import type { ICapabilityBus, InvokeContext } from '../bus/contract.js';
import type { ImaginationEngine } from './imagination-engine.js';
import type { TimeIntelligence } from './time-intelligence.js';
import type { SuggestionQueue } from './suggestion-queue.js';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/id.js';
import { metrics } from '../observability/metrics.js';
import type Database from 'better-sqlite3';

const logger = getLogger('will-loop');

export type WillAction = 'execute' | 'prepare' | 'suggest' | 'observe';

export interface WillDecision {
  action: WillAction;
  description: string;
  capability?: string;
  input?: unknown;
  reason: string;
  dangerLevel: 'safe' | 'moderate' | 'dangerous';
  confidence: number;
}

export interface WillLoopConfig {
  enabled: boolean;
  intervalMs: number;
  maxAutoDangerLevel: 'safe' | 'moderate';
  maxActionsPerHour: number;
}

const DEFAULT_CONFIG: WillLoopConfig = {
  enabled: false,
  intervalMs: 300_000, // 5 minutes
  maxAutoDangerLevel: 'moderate',
  maxActionsPerHour: 5,
};

const WILL_LOOP_PROMPT = `你是 Brain 的意志循环（Will Loop）。你持续观察世界模型，决定是否需要主动行动。

## 输出格式（严格 JSON）

{
  "action": "execute|prepare|suggest|observe",
  "description": "简明描述要做什么",
  "capability": "Bus 上的能力名称（execute/prepare 时必填）",
  "input": {},
  "reason": "为什么现在需要这样做",
  "dangerLevel": "safe|moderate|dangerous",
  "confidence": 0.0-1.0
}

## 行动级别

- **observe**: 不做任何事，只是记录观察。confidence < 0.5 或没有值得做的事时选此。
- **suggest**: 准备一个建议，等用户下次交互时提出。不立即执行。
- **prepare**: 准备方案（如草拟修复代码），但等用户确认后才执行。中风险操作。
- **execute**: 立即自主执行。仅限 safe/moderate 且 confidence >= 0.8 的操作。

## 判断规则

1. 不做比做错好 — 默认 observe，只在明确有价值时才升级
2. 用户不在线时更保守 — 如果 lastInteractionAt 超过 30 分钟，只 observe/suggest
3. 紧急安全问题例外 — 如果发现 critical severity 外部事件，可以 prepare
4. 不重复做 — 如果最近已有相同建议/执行，不再重复

## 世界模型状态
`;

export class WillLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: WillLoopConfig;
  private actionsThisHour: number[] = [];
  private recentDecisions: Array<{ description: string; timestamp: number }> = [];
  private imagination: ImaginationEngine | null = null;
  private timeIntelligence: TimeIntelligence | null = null;
  private suggestionQueue: SuggestionQueue | null = null;

  private willIterations = metrics.counter('will_loop_iterations_total');
  private willActions = metrics.counter('will_loop_actions_total');

  constructor(
    private readonly llm: LlmClient,
    private readonly worldModel: WorldModelRuntime,
    private readonly bus: ICapabilityBus | null,
    private readonly db: Database.Database,
    config?: Partial<WillLoopConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setImaginationEngine(engine: ImaginationEngine): void {
    this.imagination = engine;
  }

  setTimeIntelligence(ti: TimeIntelligence): void {
    this.timeIntelligence = ti;
  }

  setSuggestionQueue(queue: SuggestionQueue): void {
    this.suggestionQueue = queue;
  }

  start(): void {
    if (!this.config.enabled) {
      logger.info('Will Loop 未启用');
      return;
    }
    if (this.timer) return;

    logger.info({ intervalMs: this.config.intervalMs }, 'Will Loop 启动');
    this.timer = setInterval(() => this.tick(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Will Loop 停止');
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  async tick(): Promise<WillDecision | null> {
    this.willIterations.inc();
    this.pruneActionHistory();

    if (this.actionsThisHour.length >= this.config.maxActionsPerHour) {
      logger.debug('Will Loop 跳过: 本小时行动次数已达上限');
      return null;
    }

    // Process time-based plan steps
    await this.processTimeSteps();

    const worldSummary = this.worldModel.getSummary();
    const snapshot = this.worldModel.getSnapshot();

    // Skip if nothing interesting in the world
    if (!worldSummary && snapshot.environment.externalEvents.filter(e => !e.handled).length === 0) {
      return null;
    }

    try {
      const decision = await this.deliberate(worldSummary, snapshot);
      if (!decision || decision.action === 'observe') return decision;

      // Enforce safety constraints
      if (!this.isActionAllowed(decision)) {
        logger.info({ decision: decision.description, reason: 'safety constraint' }, 'Will Loop 行动被安全约束阻止');
        return { ...decision, action: 'observe' };
      }

      // Imagination Engine: simulate before executing
      if (decision.action === 'execute' && this.imagination && decision.capability) {
        const simulation = await this.imagination.simulateAutonomousAction(
          decision.capability,
          decision.input,
          decision.reason,
        );
        if (!simulation.shouldProceed) {
          logger.info({ decision: decision.description, simReason: simulation.reasoning }, 'Will Loop 行动被想象力引擎否决，降级为建议');
          return { ...decision, action: 'suggest' };
        }
      }

      await this.executeDecision(decision);
      return decision;
    } catch (err) {
      logger.error({ err }, 'Will Loop tick 失败');
      return null;
    }
  }

  private async processTimeSteps(): Promise<void> {
    if (!this.timeIntelligence || !this.bus) return;

    const readySteps = this.timeIntelligence.getReadySteps();
    for (const step of readySteps) {
      if (step.capability) {
        const ctx: InvokeContext = {
          callChain: ['will-loop', 'time-plan'],
          callerAgent: 'brain',
          sessionId: 'time-plan',
          correlationId: genId('tplan'),
          timeout: 30_000,
        };
        const result = await this.bus.invoke(step.capability, step.input ?? {}, ctx);
        if (result.ok) {
          this.timeIntelligence.completeStep(step.id, typeof result.data === 'string' ? result.data : JSON.stringify(result.data));
          logger.info({ stepId: step.id, capability: step.capability }, 'Time plan step executed');
        } else {
          this.timeIntelligence.failStep(step.id, result.error ?? 'Unknown error');
          logger.warn({ stepId: step.id, error: result.error }, 'Time plan step failed');
        }
      } else {
        this.timeIntelligence.completeStep(step.id, 'no capability specified');
      }
    }

    // Check expired deadlines
    const expired = this.timeIntelligence.getExpiredDeadlines();
    for (const step of expired) {
      this.timeIntelligence.failStep(step.id, 'Deadline expired');
      logger.info({ stepId: step.id, description: step.description }, 'Time plan deadline expired');
    }
  }

  private async deliberate(worldSummary: string, snapshot: any): Promise<WillDecision | null> {
    const stateDescription = worldSummary || '（世界模型无显著状态）';
    const unhandledEvents = (snapshot.environment?.externalEvents ?? [])
      .filter((e: any) => !e.handled)
      .slice(-5)
      .map((e: any) => `[${e.severity}] ${e.source}: ${e.summary}`)
      .join('\n');

    const recentSuggestions = this.recentDecisions
      .slice(-3)
      .map(d => `- ${d.description} (${new Date(d.timestamp).toLocaleTimeString()})`)
      .join('\n');

    let userPrompt = `世界状态: ${stateDescription}`;
    if (unhandledEvents) userPrompt += `\n\n未处理事件:\n${unhandledEvents}`;
    if (recentSuggestions) userPrompt += `\n\n近期行动记录:\n${recentSuggestions}`;

    const result = await this.llm.chat(
      [{ role: 'user', content: userPrompt }],
      {
        system: WILL_LOOP_PROMPT,
        maxTokens: 256,
        temperature: 0.2,
        agent: 'brain',
        purpose: 'brain_routing',
        modelTier: 'fast',
        sessionId: 'will-loop',
      },
    );

    return this.parseDecision(result.content);
  }

  private parseDecision(text: string): WillDecision | null {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]);

      if (!parsed.action || !parsed.description) return null;
      if (!['execute', 'prepare', 'suggest', 'observe'].includes(parsed.action)) return null;

      return {
        action: parsed.action,
        description: String(parsed.description).slice(0, 300),
        capability: parsed.capability,
        input: parsed.input,
        reason: String(parsed.reason ?? '').slice(0, 200),
        dangerLevel: parsed.dangerLevel ?? 'safe',
        confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
      };
    } catch {
      return null;
    }
  }

  private isActionAllowed(decision: WillDecision): boolean {
    if (decision.action === 'observe' || decision.action === 'suggest') return true;

    // Confidence threshold for autonomous execution
    if (decision.action === 'execute' && decision.confidence < 0.8) return false;

    // Danger level check
    const dangerLevels = ['safe', 'moderate', 'dangerous'];
    const maxLevel = dangerLevels.indexOf(this.config.maxAutoDangerLevel);
    const actionLevel = dangerLevels.indexOf(decision.dangerLevel);
    if (actionLevel > maxLevel) return false;

    // Dedup check
    const isDuplicate = this.recentDecisions.some(
      d => d.description === decision.description && Date.now() - d.timestamp < 3600_000,
    );
    if (isDuplicate) return false;

    return true;
  }

  private async executeDecision(decision: WillDecision): Promise<void> {
    this.actionsThisHour.push(Date.now());
    this.recentDecisions.push({ description: decision.description, timestamp: Date.now() });
    if (this.recentDecisions.length > 20) this.recentDecisions.shift();

    this.willActions.inc({ action: decision.action, dangerLevel: decision.dangerLevel });

    // Record to DB for audit
    this.recordWillAction(decision);

    if (decision.action === 'execute' && decision.capability && this.bus) {
      const ctx: InvokeContext = {
        callChain: ['will-loop'],
        callerAgent: 'brain',
        sessionId: 'will-loop',
        correlationId: genId('will'),
        timeout: 30_000,
      };

      const result = await this.bus.invoke(decision.capability, decision.input ?? {}, ctx);
      if (!result.ok) {
        logger.warn({ capability: decision.capability, error: result.error }, 'Will Loop 自主执行失败');
      } else {
        logger.info({ capability: decision.capability, description: decision.description }, 'Will Loop 自主执行成功');
      }
    }

    if (decision.action === 'suggest' || decision.action === 'prepare') {
      logger.info({ action: decision.action, description: decision.description }, 'Will Loop 产生建议/方案');
      if (this.suggestionQueue) {
        this.suggestionQueue.push({
          source: 'will_loop',
          title: decision.description,
          description: decision.reason,
          capability: decision.capability,
          input: decision.input,
          urgency: decision.dangerLevel === 'dangerous' ? 'high' : 'normal',
        });
      }
    }
  }

  private recordWillAction(decision: WillDecision): void {
    try {
      this.db.prepare(`
        INSERT INTO brain_decisions (id, session_id, decision_type, input_summary, output_json, confidence, created_at)
        VALUES (?, 'will-loop', 'will_action', ?, ?, ?, ?)
      `).run(
        genId('bdec'),
        decision.description.slice(0, 200),
        JSON.stringify(decision),
        decision.confidence,
        Date.now(),
      );
    } catch {
      // best-effort audit
    }
  }

  private pruneActionHistory(): void {
    const oneHourAgo = Date.now() - 3600_000;
    this.actionsThisHour = this.actionsThisHour.filter(t => t > oneHourAgo);
  }
}
