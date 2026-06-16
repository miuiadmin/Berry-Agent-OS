import type { PermissionCoordinator } from '../permission-coordinator.js';
import type { AgentManager } from '../agent-manager.js';
import type { AgentRegistry } from '../agent-registry.js';
import type { SessionManager } from '../session-manager.js';
import type { BrainDecisionRecorder } from '../brain-decision-recorder.js';
import type { IpcMessageType, IpcMessage } from '../types.js';
import type { PermissionJudgeResultPayload } from '../../contracts/routing.js';
import type { PermissionRequestPayload, PermissionValidatePayload, PermissionConsumePayload, PermissionAcquirePayload } from '../../contracts/permissions.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('permission-flow');
import type { DangerLevel } from '../../bus/contract.js';
import type { PermissionMode } from '../../safety/permissions.js';
import { genId } from '../../utils/id.js';
import { getEventBus } from '../event-bus.js';
import { applyBoardStatus } from '../board-repo.js';

type AgentIpc = { send: (type: IpcMessageType, to: string, payload: unknown, correlationId?: string) => boolean; onMessage: (type: IpcMessageType, handler: (msg: IpcMessage) => void) => void };

const JUDGE_TIMEOUT_MS = 30_000;
const JUDGE_WINDOW_MS = 10_000;
const JUDGE_MAX_PER_WINDOW = 5;

/**
 * 15.0 机制 A：requiresReview 的路由决策（纯函数，便于单测）。
 *
 * 决策规则：
 * - L2 moderate → 'brain'（任何模式下都由 Brain LLM 审批，替代旧的规则放行/用户确认）
 * - L3 dangerous / 危险工具类别（dangerLevel 非 moderate）→ ask 模式 'user'（用户最终权威），
 *   yolo 模式 'brain'（用户委托 Brain）
 *
 * @param dangerLevel 工具危险等级（safe/moderate/dangerous；safe 进此分支说明命中危险工具类别）
 * @param mode 当前权限模式
 * @returns 'brain'（交 Brain permission.judge）| 'user'（交用户确认）
 */
export function routeReviewTarget(dangerLevel: DangerLevel | string, mode: PermissionMode): 'brain' | 'user' {
  // L2 moderate 一律走 Brain（机制 A 核心行为）
  if (dangerLevel === 'moderate') return 'brain';
  // 其余（dangerous / 危险工具类别）：yolo → Brain，否则 → 用户确认
  return mode === 'yolo' ? 'brain' : 'user';
}

export interface PermissionFlowDeps {
  permissionCoordinator: PermissionCoordinator;
  registry: AgentRegistry;
  agentManager: AgentManager;
  sessionManager: SessionManager;
  brainDecisionRecorder: BrainDecisionRecorder | null;
}

export class PermissionFlow {
  private deps: PermissionFlowDeps;
  private pendingJudges = new Map<string, (result: PermissionJudgeResultPayload) => void>();
  private pendingJudgeInputs = new Map<string, { sessionId: string; toolName: string }>();
  private pendingUserConfirms = new Map<string, { agentIpc: AgentIpc; agentName: string; replyId: string; timer: ReturnType<typeof setTimeout>; taskId?: string }>();
  private judgeTimestamps: number[] = [];

  constructor(deps: PermissionFlowDeps) {
    this.deps = deps;
  }

  setupJudgeHandler(reviewerIpc: AgentIpc): void {
    reviewerIpc.onMessage('permission.judge.result', (msg: IpcMessage) => {
      const result = msg.payload as PermissionJudgeResultPayload;
      const correlationId = msg.correlationId!;

      const judgeInput = this.pendingJudgeInputs.get(correlationId);
      if (judgeInput) {
        this.deps.brainDecisionRecorder?.recordPermissionDecision(
          judgeInput.sessionId,
          judgeInput.toolName,
          result as unknown as Record<string, unknown>,
        );
        this.pendingJudgeInputs.delete(correlationId);
      }

      const pending = this.pendingJudges.get(correlationId);
      if (pending) {
        pending(result);
        this.pendingJudges.delete(correlationId);
      }
    });
  }

  requestJudge(input: {
    sessionId: string;
    agentName: string;
    toolName: string;
    toolInput: string;
    dangerLevel: DangerLevel;
    taskContext?: string;
  }): Promise<PermissionJudgeResultPayload> {
    if (this.isRateLimited()) {
      return Promise.resolve({ allowed: false, reason: '权限判断请求过于频繁，已限流' });
    }
    this.judgeTimestamps.push(Date.now());

    return new Promise((resolve) => {
      const correlationId = genId('pjudge');
      const timeout = setTimeout(() => {
        this.pendingJudges.delete(correlationId);
        this.pendingJudgeInputs.delete(correlationId);
        resolve({ allowed: false, reason: '权限判断超时' });
      }, JUDGE_TIMEOUT_MS);

      this.pendingJudges.set(correlationId, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      this.pendingJudgeInputs.set(correlationId, { sessionId: input.sessionId, toolName: input.toolName });

      const orchestratorAgent = this.deps.registry.requireRole('orchestrator');
      const brain = this.deps.agentManager.getAgent(orchestratorAgent.manifest.name);
      if (!brain) {
        clearTimeout(timeout);
        this.pendingJudges.delete(correlationId);
        resolve({ allowed: false, reason: 'Brain 不可用' });
        return;
      }

      brain.ipc.send('permission.judge', orchestratorAgent.manifest.name, {
        sessionId: input.sessionId,
        agentName: input.agentName,
        toolName: input.toolName,
        toolInput: input.toolInput,
        dangerLevel: input.dangerLevel,
        taskContext: input.taskContext,
      }, correlationId);
    });
  }

  /**
   * 15.0 机制 A：把 requiresReview 交由 Brain permission.judge 审批。
   *
   * 触发条件（见 routeReviewTarget）：L2 moderate（任意模式）/ L3 dangerous（yolo 模式）。
   * Brain approve → resolve approval request 签 token；Brain deny / 超时 / 不可用 / 限流 → 拒绝。
   * fail-closed：requestJudge 在超时/限流/Brain 不可用时返回 allowed:false，此处统一按拒绝处理。
   */
  private async handleBrainReview(params: {
    agentIpc: AgentIpc;
    agentName: string;
    replyId: string;
    requestId: string;
    sessionId: string;
    toolName: string;
    toolInput: string;
    dangerLevel: DangerLevel;
    taskId?: string;
  }): Promise<void> {
    const { agentIpc, agentName, replyId, requestId, sessionId, toolName, toolInput, dangerLevel, taskId } = params;
    const judge = await this.requestJudge({
      sessionId,
      agentName,
      toolName,
      toolInput,
      dangerLevel,
      taskContext: taskId,
    });
    // 15.0 机制 B：Brain 拿不准（uncertain）→ 升级到用户确认，复用 handleUserConfirm，
    // 不直接拒绝。questionToUser 优先用 Brain 给的 escalation 问题，否则回退通用提示。
    if (judge.uncertain) {
      this.handleUserConfirm({
        agentIpc, agentName, replyId, requestId, sessionId, toolName, toolInput, dangerLevel,
        brainReason: judge.escalation?.questionToUser ?? (judge.reason || 'Brain 不确定是否批准，需用户确认'),
        taskId,
      });
      return;
    }
    if (judge.allowed) {
      const token = this.deps.permissionCoordinator.resolve(requestId, {
        verdict: 'approved',
        source: 'brain',
        reason: judge.reason,
      });
      agentIpc.send(
        'permission.result',
        agentName,
        token
          ? { allowed: true, reason: judge.reason ?? 'Brain 审批通过', tokenId: token.id }
          : { allowed: false, reason: 'Brain 审批通过但签发 token 失败' },
        replyId,
      );
    } else {
      agentIpc.send(
        'permission.result',
        agentName,
        { allowed: false, reason: judge.reason ?? 'Brain 拒绝执行' },
        replyId,
      );
    }
  }

  /**
   * 用户确认流程（L3 dangerous 直接走 / 机制 B uncertain 升级走）。
   *
   * emit permission.user_confirm_needed 让前端/CLI 弹确认；登记 pendingUserConfirms，
   * 5 分钟超时自动拒绝。resolveUserConfirm() 处理用户回答。
   *
   * 15.0 机制 B：从 handler 内联块抽成可复用方法，供 handleBrainReview 的 uncertain 分支复用。
   */
  private handleUserConfirm(params: {
    agentIpc: AgentIpc;
    agentName: string;
    replyId: string;
    requestId: string;
    sessionId: string;
    toolName: string;
    toolInput: string;
    dangerLevel: DangerLevel | string;
    brainReason: string;
    taskId?: string;
  }): void {
    const { agentIpc, agentName, replyId, requestId, sessionId, toolName, toolInput, dangerLevel, brainReason, taskId } = params;
    // 16.0 §6.5.1/D：L3 危险工具 / uncertain 升级问用户 → 板状态 awaiting_user（无 board 则 no-op）
    if (taskId) applyBoardStatus(taskId, { kind: 'await_user' });
    getEventBus().emit('permission.user_confirm_needed', {
      requestId,
      sessionId,
      agentName,
      toolName,
      toolInput: toolInput.slice(0, 500),
      dangerLevel,
      brainReason,
    });
    const timer = setTimeout(() => {
      if (this.pendingUserConfirms.has(requestId)) {
        this.pendingUserConfirms.delete(requestId);
        agentIpc.send('permission.result', agentName, {
          allowed: false,
          reason: '用户确认超时（5 分钟），自动拒绝',
        }, replyId);
      }
    }, 300_000);
    this.pendingUserConfirms.set(requestId, { agentIpc, agentName, replyId, timer, taskId });
  }

  setupHandlers(agentIpc: AgentIpc, agentName: string, isPrimary: boolean): void {
    agentIpc.onMessage('permission.request', (msg: IpcMessage) => {
      const { toolName, toolInput, dangerLevel, taskId, sessionId: explicitSessionId } = msg.payload as PermissionRequestPayload;
      const replyId = msg.id;

      // 16.0 P3-B3：工具调用投影 tool_request 信封（fire-and-forget 审计影子）
      // 在 kernel 侧（permission.request handler 收到 agent 的 IPC 时）落板，不在 agent 子进程。
      // 映射：agentName→from, 'system'→to, toolName+toolInput→body。现有权限逻辑不变。
      if (taskId) {
        try {
          const { postBoardMessage } = require('../board-repo.js');
          const { genId } = require('../../utils/id.js');
          postBoardMessage(taskId, {
            id: genId('bmsg'),
            type: 'tool_request',
            from: agentName,
            to: 'system',
            taskId,
            sessionId: explicitSessionId,
            ts: Date.now(),
            toolName,
            input: (() => { try { return JSON.parse(toolInput); } catch { return { raw: toolInput }; } })(),
          });
        } catch { /* fire-and-forget */ }
      }

      let sessionId: string;
      if (explicitSessionId) {
        // dialogue 模式：payload 显式携带 sessionId，跳过 findPending 反查
        sessionId = explicitSessionId;
      } else if (isPrimary) {
        const pendingReq = (taskId ? this.deps.sessionManager.findPendingByTaskId(taskId) : undefined)
          ?? this.deps.sessionManager.findAnyPendingWithTaskId();
        sessionId = pendingReq?.sessionId ?? 'unknown';
      } else {
        sessionId = taskId ?? agentName;
      }

      if (isPrimary || explicitSessionId) {
        const result = this.deps.permissionCoordinator.checkAndIssue({
          agentName,
          sessionId,
          toolName,
          toolInput,
          dangerLevel: dangerLevel as DangerLevel,
          taskId,
          correlationId: msg.correlationId ?? replyId,
        });
        agentIpc.send('permission.result', agentName, result, replyId);
      } else {
        sessionId = taskId ?? agentName;
        const result = this.deps.permissionCoordinator.checkAndIssueSimple({
          agentName,
          sessionId,
          toolName,
          toolInput,
          dangerLevel: dangerLevel as DangerLevel,
          taskId, // 13.0 §3.8: 传入 taskId 用于 active_scope 硬拦截
        });
        agentIpc.send('permission.result', agentName, result, replyId);
      }
    });

    agentIpc.onMessage('permission.validate', (msg: IpcMessage) => {
      const { tokenId, sessionId, toolName, toolInput } = msg.payload as PermissionValidatePayload;
      const result = this.deps.permissionCoordinator.validate({ tokenId, sessionId, agentName, toolName, toolInput });
      agentIpc.send('permission.result', agentName, result, msg.id);
    });

    agentIpc.onMessage('permission.consume', (msg: IpcMessage) => {
      const { tokenId } = msg.payload as PermissionConsumePayload;
      const result = this.deps.permissionCoordinator.consume(tokenId);
      agentIpc.send('permission.result', agentName, result, msg.id);
    });

    agentIpc.onMessage('permission.acquire', async (msg: IpcMessage) => {
      const { toolName, toolInput, dangerLevel, taskId } = msg.payload as PermissionAcquirePayload;
      const replyId = msg.id;
      logger.debug({ agentName, toolName, dangerLevel, isPrimary, replyId }, 'permission.acquire: 收到请求（DEBUG）');

      try {
      let sessionId: string;
      if (isPrimary) {
        const pendingReq = (taskId ? this.deps.sessionManager.findPendingByTaskId(taskId) : undefined)
          ?? this.deps.sessionManager.findAnyPendingWithTaskId();
        sessionId = pendingReq?.sessionId ?? 'unknown';

        const result = this.deps.permissionCoordinator.acquire({
          agentName,
          sessionId,
          toolName,
          toolInput,
          dangerLevel: dangerLevel as DangerLevel,
          taskId,
          correlationId: msg.correlationId ?? replyId,
        });

        if (result.requiresReview) {
          // 15.0：所有 requiresReview 统一带 requestId（checkAndIssue 已保证）。
          const requestId = result.requestId ?? genId('perm');
          const mode = this.deps.permissionCoordinator.getMode(sessionId);
          // 机制 A：按 routeReviewTarget 分流 —— moderate(任意模式) / 任意风险(yolo) 走 Brain；
          // dangerous(ask) 走用户确认。
          if (routeReviewTarget(dangerLevel, mode) === 'brain') {
            void this.handleBrainReview({
              agentIpc, agentName, replyId, requestId, sessionId, toolName, toolInput,
              dangerLevel: dangerLevel as DangerLevel, taskId,
            });
            return;
          }
          // L3 dangerous（ask 模式）→ 用户确认
          this.handleUserConfirm({
            agentIpc, agentName, replyId, requestId, sessionId, toolName, toolInput, dangerLevel,
            brainReason: '危险操作，需要用户确认',
            taskId,
          });
          return;
        } else {
          agentIpc.send('permission.result', agentName, result, replyId);
        }
      } else {
        sessionId = taskId ?? agentName;
        const result = this.deps.permissionCoordinator.checkAndIssueSimple({
          agentName,
          sessionId,
          toolName,
          toolInput,
          dangerLevel: dangerLevel as DangerLevel,
          taskId, // 13.0 §3.8: 传入 taskId 用于 active_scope 硬拦截
        });
        agentIpc.send('permission.result', agentName, result, replyId);
      }
      } catch (err) {
        // DEBUG: 捕获 acquire handler 内的所有异常，确保一定能回复（否则 IPC request 超时）
        logger.error({ err, agentName, toolName, replyId }, 'permission.acquire: handler 异常（DEBUG）');
        agentIpc.send('permission.result', agentName, { allowed: false, reason: `权限处理异常: ${(err as Error).message}` }, replyId);
      }
    });
  }

  resolveUserConfirm(requestId: string, allowed: boolean, reason?: string, tokenId?: string): boolean {
    const pending = this.pendingUserConfirms.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingUserConfirms.delete(requestId);
    // 16.0 §6.5.1/D：用户确认结果 → 板状态机 terminal（awaiting_user → user_resumed[允许]/user_rejected[拒绝]）
    if (pending.taskId) applyBoardStatus(pending.taskId, { kind: allowed ? 'user_resumed' : 'user_rejected' });
    // 批准时必须携带 tokenId：tool-caller 执行层强制要求 tokenId，
    // 无 token 则判定"缺少 permission token"拒绝执行（即使 allowed=true）。
    pending.agentIpc.send('permission.result', pending.agentName,
      { allowed, reason: reason ?? (allowed ? '用户已确认' : '用户已拒绝'), ...(tokenId ? { tokenId } : {}) },
      pending.replyId);
    return true;
  }

  private isRateLimited(): boolean {
    const now = Date.now();
    this.judgeTimestamps = this.judgeTimestamps.filter(t => now - t < JUDGE_WINDOW_MS);
    return this.judgeTimestamps.length >= JUDGE_MAX_PER_WINDOW;
  }
}
