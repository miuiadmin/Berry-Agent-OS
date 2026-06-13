import type { CorrectionFlowDeps } from '../delegation-orchestrator.js';
import { getEventBus } from '../event-bus.js';
import { genId } from '../../utils/id.js';
import { getLogger } from '../../utils/logger.js';
import { BrainDecisionRecorder } from '../brain-decision-recorder.js';
import { getDb } from '../../memory/index.js';
import { getCorrectionFrequencyDetector } from '../correction-frequency-detector.js';
import { getCorrectionEscalationDetector } from '../correction-escalation-detector.js';
import type { IpcMessage, IpcMessageType } from '../types.js';
import type {
  TurnCheckpointPayload,
  TurnCorrectionPayload,
  CheckpointTrigger,
} from '../../contracts/delegation.js';
import { isDelegationTerminal, CORRECTION_LIMITS } from '../../contracts/delegation.js';
import type { RouteRequestPayload } from '../../contracts/routing.js';
import { buildAvailableAgentsList } from '../agent-registry.js';
import type { CorrectionEntry, BehaviorNote } from '../state-cache.js';

const logger = getLogger('correction-flow');

const CORRECTION_TIMEOUT_MS = 45_000;

interface AgentIpc {
  onMessage: (type: IpcMessageType, handler: (msg: IpcMessage) => void) => void;
  send: (type: IpcMessageType, to: string, payload: unknown, correlationId?: string) => boolean;
}

export class CorrectionFlow {
  private pendingCheckpoints = new Map<string, { correlationId: string; timeoutId: ReturnType<typeof setTimeout>; sessionId?: string }>();
  private ctx: CorrectionFlowDeps;
  private recorder: BrainDecisionRecorder;

  constructor(ctx: CorrectionFlowDeps) {
    this.ctx = ctx;
    this.recorder = new BrainDecisionRecorder(getDb());
  }

  setup(reviewerIpc: AgentIpc): void {
    getEventBus().on('delegation.checkpoint_needed', (payload) => {
      this.handleCheckpointNeeded(payload.delegationId, payload.trigger as CheckpointTrigger);
    });

    reviewerIpc.onMessage('checkpoint.evaluate.result', (msg: IpcMessage) => {
      this.handleCorrectionResult(msg);
    });

    getEventBus().on('delegation.completed', ({ delegationId }) => {
      this.cancelPending(delegationId);
    });
    getEventBus().on('delegation.failed', ({ delegationId }) => {
      this.cancelPending(delegationId);
    });
  }

  private handleCheckpointNeeded(delegationId: string, trigger: CheckpointTrigger): void {
    const entry = this.ctx.delegationManager.get(delegationId);
    if (!entry || isDelegationTerminal(entry.state)) return;

    if (this.pendingCheckpoints.has(delegationId)) {
      logger.debug({ delegationId }, 'Checkpoint already pending, skipping');
      return;
    }

    const orchestrator = this.ctx.registry.requireRole('orchestrator');
    const brain = this.ctx.agentManager.getAgent(orchestrator.manifest.name);
    if (!brain) {
      logger.warn({ delegationId }, 'Brain not available for checkpoint evaluation');
      return;
    }

    const context = this.ctx.delegationManager.buildCorrectionContext(delegationId);
    if (!context) return;

    const correlationId = genId('chkpt');
    const payload: TurnCheckpointPayload = {
      delegationId,
      trigger,
      context,
    };

    const timeoutId = setTimeout(() => {
      this.pendingCheckpoints.delete(delegationId);
      logger.debug({ delegationId }, 'Checkpoint evaluation timed out, continuing');
    }, CORRECTION_TIMEOUT_MS);

    this.pendingCheckpoints.set(delegationId, { correlationId, timeoutId });

    brain.ipc.send('checkpoint.evaluate', orchestrator.manifest.name, payload, correlationId);
    logger.info({ delegationId, trigger, correlationId }, 'Checkpoint sent to Brain for evaluation');
  }

  private handleCorrectionResult(msg: IpcMessage): void {
    const correction = msg.payload as TurnCorrectionPayload;
    const correlationId = msg.correlationId;
    if (!correlationId) return;

    const pending = this.findPendingByCorrelation(correlationId);
    if (!pending) {
      logger.debug({ correlationId }, 'Correction result for unknown/expired checkpoint');
      return;
    }

    const { delegationId, timeoutId } = pending;
    clearTimeout(timeoutId);
    this.pendingCheckpoints.delete(delegationId);

    const entry = this.ctx.delegationManager.get(delegationId);
    if (!entry || isDelegationTerminal(entry.state)) {
      logger.debug({ delegationId, action: correction.action }, 'Delegation already terminal, discarding correction');
      return;
    }

    logger.info({ delegationId, action: correction.action }, 'Applying correction');

    // 15.0 机制 B：checkpoint 拿不准任务走向 → 升级问用户，不 apply action（continue/adjust/stop/restart）
    if (correction.escalation) {
      getEventBus().emit('conversation.ask_user', {
        sessionId: entry.sessionId,
        taskId: delegationId,
        agent: 'brain',
        question: correction.escalation.questionToUser,
      });
      logger.info({ delegationId, question: correction.escalation.questionToUser.slice(0, 100) }, 'checkpoint 升级问用户（机制 B）');
      return;
    }

    // Record correction decision for evolution feedback
    const entry2 = this.ctx.delegationManager.get(delegationId);
    this.recorder.record({
      sessionId: entry2?.sessionId ?? 'unknown',
      decisionType: 'correction',
      inputSummary: `delegation:${delegationId} trigger:checkpoint`,
      outputJson: { action: correction.action, delegationId },
    });

    this.applyCorrection(delegationId, correction).catch((err: unknown) => {
      logger.error({ err, delegationId }, 'applyCorrection async failed');
    });
  }

  private async applyCorrection(delegationId: string, correction: TurnCorrectionPayload): Promise<void> {
    // 13.0 §5.1.3: 发出 brain.correction EventBus 事件（前端 WS 订阅后可实时显示纠偏原因）
    // 这与 turn.correction IPC（agent 端消费）互补——前者给人看，后者给机器消费
    try {
      const entry = this.ctx.delegationManager.get(delegationId);
      const escalation = getCorrectionEscalationDetector();
      const result = entry
        ? escalation.evaluate(entry.targetAgent, delegationId, baseSeverityFromCorrection(correction))
        : null;
      getEventBus().emit('brain.correction', {
        sessionId: entry?.sessionId ?? 'unknown',
        taskId: delegationId,
        agentName: entry?.targetAgent ?? 'unknown',
        action: correction.action,
        severity: result?.suggestedSeverity ?? baseSeverityFromCorrection(correction),
        instruction: correction.instruction,
        newConstraints: correction.newConstraints
          ? {
              forbiddenTools: correction.newConstraints.forbiddenTools,
              maxRemainingTokens: correction.newConstraints.maxRemainingTokens,
              requiredApproach: correction.newConstraints.requiredApproach,
            }
          : undefined,
        createdAt: Date.now(),
      });
    } catch (err) {
      logger.warn({ err, delegationId }, 'brain.correction event emit failed');
    }

    switch (correction.action) {
      case 'continue':
        break;

      case 'adjust':
        this.applyAdjust(delegationId, correction);
        break;

      case 'stop':
        await this.applyStop(delegationId, correction);
        break;

      case 'restart':
        this.applyRestart(delegationId, correction);
        break;

      default: {
        // 15.0 R2-6：未知 action（LLM 输出走样等）不再静默穿透——记 warn 并按 continue 处理（最保守）
        logger.warn({ delegationId, action: correction.action }, '未知 correction action，按 continue 处理');
        break;
      }
    }
  }

  private applyAdjust(delegationId: string, correction: TurnCorrectionPayload): void {
    if (correction.newConstraints) {
      this.ctx.delegationManager.applyConstraints(delegationId, correction.newConstraints);
    }

    const entry = this.ctx.delegationManager.get(delegationId);
    if (!entry) return;

    // 13.0 §3.8 第二层 + 15.0 R4: 把 Brain 纠偏的 forbiddenTools/blockPaths 并入 active_scope
    // setActiveScope 已是合并语义（read-modify-write，数组的并集），所以这里只需传入本次
    // 新增约束——既有的 allowTools:['*']（委派即授权）与之前的 blockPaths 都会被保留，
    // 不会因纠偏写入而丢失授权。
    // （旧版在此用 checkActiveScope('__dummy__') 取旧 scope 做"手工合并"，但 checkActiveScope
    //  返回的是拒绝原因字符串、拿不到 scope 对象，合并恒为失效——属于死补丁，已随 setActiveScope
    //  内建合并一并移除。）
    const corrBlockPaths = correction.newConstraints?.blockPaths;
    const corrForbiddenTools = correction.newConstraints?.forbiddenTools;
    if ((corrForbiddenTools && corrForbiddenTools.length > 0) || (corrBlockPaths && corrBlockPaths.length > 0)) {
      this.ctx.permissionCoordinator?.setActiveScope(delegationId, {
        blockTools: corrForbiddenTools,
        blockPaths: corrBlockPaths,
      });
      logger.debug({ delegationId, forbiddenTools: corrForbiddenTools, blockPaths: corrBlockPaths }, 'applyAdjust: 并入 active_scope（blockTools + blockPaths）');
    }

    // 13.0 §13.20: 记录到 frequency detector，Evolution 学习闭环的触发器
    this.recordCorrection(entry.sessionId, entry.targetAgent, entry.id, 'adjust', correction);

    // ─── 13.0 §3.9: 将纠偏指令写入 StateCache ───
    // correction 命名空间：供 buildMissionContextPrompt() 注入到后续任务的 system prompt
    // behavior_note 命名空间：跨 task 的行为习惯纠偏（§5.3.8）
    if (correction.instruction && this.ctx.stateCache) {
      // 写入 correction 命名空间（按 sessionId:taskId 隔离，§5.3.1）
      const correctionKey = `${entry.sessionId}:${delegationId}`;
      const correctionEntry: CorrectionEntry = {
        instruction: correction.instruction,
        severity: 'medium', // checkpoint 触发的纠偏默认 medium
        scopeUpdate: correction.newConstraints ? {
          // §3.8 硬注入：blockPaths 从 Brain 纠偏的 newConstraints.blockPaths 提取（修复旧版死代码三元）
          blockPaths: correction.newConstraints.blockPaths,
          blockTools: correction.newConstraints.forbiddenTools,
          constraints: correction.newConstraints.requiredApproach ? [correction.newConstraints.requiredApproach] : [],
        } : undefined,
        createdAt: Date.now(),
      };
      this.ctx.stateCache.set('correction', correctionKey, correctionEntry);

      // 写入 behavior_note 命名空间（跨 task 持久，§8.4）
      const behaviorNote: BehaviorNote = {
        instruction: correction.instruction,
        createdAt: Date.now(),
      };
      this.ctx.stateCache.set('behavior_note', entry.sessionId, behaviorNote);

      logger.debug({ delegationId, sessionId: entry.sessionId, instruction: correction.instruction.slice(0, 100) },
        'applyAdjust: 纠偏已写入 StateCache (correction + behavior_note)');
    }

    if (entry.targetKind === 'daemon') {
      if (this.ctx.daemonBridge?.isAvailable) {
        this.ctx.daemonBridge.deliverCorrection(
          delegationId,
          'adjust',
          correction.instruction,
          correction.newConstraints,
        );
        logger.debug({ delegationId }, 'Correction sent to daemon');
      }
      return;
    }

    const agent = this.ctx.agentManager.getAgent(entry.targetAgent);
    if (agent) {
      agent.ipc.send('turn.correction', entry.targetAgent, correction, genId('corr'));
      logger.debug({ delegationId, targetAgent: entry.targetAgent }, 'Correction sent to agent');
    }
  }

  private async applyStop(delegationId: string, correction: TurnCorrectionPayload): Promise<void> {
    const entry = this.ctx.delegationManager.get(delegationId);
    if (!entry) return;

    if (entry.targetKind === 'daemon' && this.ctx.daemonBridge?.isAvailable) {
      this.ctx.daemonBridge.deliverCorrection(delegationId, 'stop', correction.instruction);
    }

    // 13.0 §13.7: 用户拒绝 / Brain stop 触发回滚 — 按 task 倒序恢复所有文件修改。
    // 文件系统备份跨进程安全：Code Agent 子进程写入的文件，Kernel 主进程可直接回滚。
    // 回滚失败不阻塞 stop 主流程（文件可能已被其他途径修改），仅记录 warn。
    try {
      const { rollbackTask } = await import('../file-edit-rollback.js');
      const result = await rollbackTask(delegationId);
      if (result.restored > 0 || result.failed > 0) {
        logger.info({ delegationId, restored: result.restored, failed: result.failed }, 'applyStop: §13.7 文件回滚已执行');
      }
    } catch (err) {
      logger.warn({ err, delegationId }, 'applyStop: §13.7 文件回滚失败（非致命）');
    }

    const partialResponse = correction.instruction
      ?? entry.finalResponse
      ?? this.buildPartialResponse(entry);

    this.ctx.delegationManager.submitForReview(delegationId, {
      delegationId,
      response: partialResponse,
    });

    // 13.0 §13.20: 记录到 frequency detector
    this.recordCorrection(entry.sessionId, entry.targetAgent, delegationId, 'stop', correction);
  }

  private applyRestart(delegationId: string, correction: TurnCorrectionPayload): void {
    const entry = this.ctx.delegationManager.get(delegationId);
    if (!entry) return;

    // 13.0 §5.3.14: reRouteDepth 达上限 → 降级为 askUser（不再盲目 stop）
    if (entry.reRouteDepth >= entry.budget.maxReRouteDepth) {
      logger.warn({
        delegationId,
        depth: entry.reRouteDepth,
        maxReRoute: entry.budget.maxReRouteDepth,
      }, 'applyRestart: reRoute 达上限，降级为 askUser');

      // 13.0 §8.7: emit task.reject 让 Brain observe
      getEventBus().emit('task.reject', {
        taskId: delegationId,
        agentName: entry.targetAgent,
        reason: correction.instruction ?? 'Brain 多次 reRoute 失败',
        capabilityGap: correction.instruction,
        timestamp: Date.now(),
      });

      // askUser：让 Conversation agent 把问题暴露给真实用户
      const pending = this.ctx.sessionManager.getPending(entry.correlationId);
      if (pending) {
        const questionText = correction.instruction
          ?? `我尝试了多种方案处理你的请求但都失败了。能否提供更多细节？`;
        // 直接 resolve pending（让 conversation 把 askUser 转给真实用户）
        const finalized = this.ctx.sessionManager.complete(entry.correlationId, questionText, { skipResolve: false });
        if (finalized && typeof finalized !== 'boolean') {
          finalized.resolve(questionText, {
            verdict: 'modify',
            reason: 'Brain 多次 reRoute 失败 — 降级为 askUser',
            originalDraft: pending.draftResponse ?? pending.userMessage,
          });
        }
        logger.info({ delegationId, correlationId: entry.correlationId }, 'applyRestart: 降级为 askUser 完成');
      }
      return;
    }

    this.ctx.delegationManager.fail(delegationId, 'Brain correction: restart');

    const pending = this.ctx.sessionManager.getPending(entry.correlationId);
    if (pending) {
      const availableAgents = buildAvailableAgentsList(this.ctx.registry);
      const routePayload: RouteRequestPayload = {
        sessionId: entry.sessionId,
        message: entry.userMessage,
        taskId: pending.taskId ?? delegationId,
        availableAgents,
        sessionContext: undefined,
      };
      this.ctx.sendRouteRequest(routePayload, entry.correlationId);
      logger.info({ delegationId, correlationId: entry.correlationId }, 'Re-routing after restart correction');
    }

    // 13.0 §13.20: 记录到 frequency detector
    this.recordCorrection(entry.sessionId, entry.targetAgent, delegationId, 'restart', correction);
  }

  private buildPartialResponse(entry: { outputs: Array<{ kind: string; data: unknown }> }): string {
    const textParts: string[] = [];
    for (const out of entry.outputs) {
      if (out.kind === 'text_delta') {
        const d = out.data as { text?: string };
        if (d.text) textParts.push(d.text);
      }
    }
    return textParts.join('') || '[任务已被纠偏系统终止]';
  }

  /**
   * 13.0 §13.20: 把纠偏事件喂给 frequency detector，Evolution 学习的触发器。
   *
   * 失败仅 warn — 不阻塞纠偏主流程（detector 自身的 record 内部也 try/catch）。
   */
  private recordCorrection(
    sessionId: string,
    agentName: string,
    taskId: string,
    action: 'continue' | 'adjust' | 'stop' | 'restart',
    correction: TurnCorrectionPayload,
  ): void {
    try {
      const frequencyDetector = getCorrectionFrequencyDetector();
      const escalationDetector = getCorrectionEscalationDetector();

      // ① 基础 severity：按 Brain LLM 给出的 instruction 内容粗略判断
      // forbiddenTools 出现 → 至少 medium（限制工具是高风险）
      // action=stop/restart → high
      // 默认 low
      let baseSeverity: 'low' | 'medium' | 'high' = 'low';
      if (action === 'stop' || action === 'restart') {
        baseSeverity = 'high';
      } else if (correction.newConstraints?.forbiddenTools?.length) {
        baseSeverity = 'medium';
      }

      // ② §3.7 升级式纠偏：查 (agent, task) 窗口内历史纠偏次数，必要时升级
      const escalation = escalationDetector.evaluate(agentName, taskId, baseSeverity);
      const finalSeverity = escalation.suggestedSeverity;

      // ③ 写入 brain_corrections（供 frequency detector + escalation detector 联合使用）
      frequencyDetector.record({
        sessionId,
        taskId,
        agentName,
        severity: finalSeverity,
        action,
        instruction: correction.instruction ?? `${action} correction`,
        blockTools: correction.newConstraints?.forbiddenTools,
      });

      // ④ 升级时打 warn（让运维看到「这个 agent 在反复被纠偏」）
      if (escalation.upgradeReason) {
        logger.warn({
          agentName,
          taskId,
          baseSeverity,
          suggestedSeverity: finalSeverity,
          reason: escalation.upgradeReason,
          stats: escalation.stats,
        }, 'correction-flow: severity escalated');
      }
    } catch (err) {
      logger.warn({ err, agentName, action }, 'correction-flow: failed to record correction for frequency detection');
    }
  }

  private cancelPending(delegationId: string): void {
    const pending = this.pendingCheckpoints.get(delegationId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingCheckpoints.delete(delegationId);
    }
  }

  private findPendingByCorrelation(correlationId: string): { delegationId: string; timeoutId: ReturnType<typeof setTimeout> } | undefined {
    for (const [delegationId, pending] of this.pendingCheckpoints) {
      if (pending.correlationId === correlationId) {
        return { delegationId, timeoutId: pending.timeoutId };
      }
    }
    return undefined;
  }
}

/**
 * 从 correction payload 推导基础 severity（Brain LLM 给的 instruction 自身暗示）。
 * 与 escalation detector 配合：先算 base，再让 detector 决定是否升级。
 */
function baseSeverityFromCorrection(correction: TurnCorrectionPayload): 'low' | 'medium' | 'high' {
  if (correction.action === 'stop' || correction.action === 'restart') return 'high';
  if (correction.newConstraints?.forbiddenTools?.length) return 'medium';
  return 'low';
}
