import type { PermissionCoordinator } from '../permission-coordinator.js';
import type { AgentManager } from '../agent-manager.js';
import type { AgentRegistry } from '../agent-registry.js';
import type { SessionManager } from '../session-manager.js';
import type { BrainDecisionRecorder } from '../brain-decision-recorder.js';
import type { IpcMessageType, IpcMessage } from '../types.js';
import type { PermissionJudgeResultPayload } from '../../contracts/routing.js';
import type { PermissionRequestPayload, PermissionValidatePayload, PermissionConsumePayload, PermissionAcquirePayload } from '../../contracts/permissions.js';
import type { DangerLevel } from '../../bus/contract.js';
import { genId } from '../../utils/id.js';
import { getEventBus } from '../event-bus.js';

type AgentIpc = { send: (type: IpcMessageType, to: string, payload: unknown, correlationId?: string) => boolean; onMessage: (type: IpcMessageType, handler: (msg: IpcMessage) => void) => void };

const JUDGE_TIMEOUT_MS = 30_000;
const JUDGE_WINDOW_MS = 10_000;
const JUDGE_MAX_PER_WINDOW = 5;

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
  private pendingUserConfirms = new Map<string, { agentIpc: AgentIpc; agentName: string; replyId: string; timer: ReturnType<typeof setTimeout> }>();
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

  setupHandlers(agentIpc: AgentIpc, agentName: string, isPrimary: boolean): void {
    agentIpc.onMessage('permission.request', (msg: IpcMessage) => {
      const { toolName, toolInput, dangerLevel, taskId, sessionId: explicitSessionId } = msg.payload as PermissionRequestPayload;
      const replyId = msg.id;

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
          if (dangerLevel !== 'dangerous') {
            agentIpc.send('permission.result', agentName, { allowed: true, reason: 'auto-approved (moderate)' }, replyId);
            return;
          }

          const requestId = result.requestId ?? genId('perm');
          getEventBus().emit('permission.user_confirm_needed', {
            requestId,
            sessionId,
            agentName,
            toolName,
            toolInput: toolInput.slice(0, 500),
            dangerLevel,
            brainReason: '危险操作，需要用户确认',
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
          this.pendingUserConfirms.set(requestId, { agentIpc, agentName, replyId, timer });
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
    });
  }

  resolveUserConfirm(requestId: string, allowed: boolean, reason?: string): boolean {
    const pending = this.pendingUserConfirms.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingUserConfirms.delete(requestId);
    pending.agentIpc.send('permission.result', pending.agentName, { allowed, reason: reason ?? (allowed ? '用户已确认' : '用户已拒绝') }, pending.replyId);
    return true;
  }

  private isRateLimited(): boolean {
    const now = Date.now();
    this.judgeTimestamps = this.judgeTimestamps.filter(t => now - t < JUDGE_WINDOW_MS);
    return this.judgeTimestamps.length >= JUDGE_MAX_PER_WINDOW;
  }
}
