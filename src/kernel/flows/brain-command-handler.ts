/**
 * 15.0 机制 D：Brain 指挥通道（brain.command）handler。
 *
 * Brain 通过 brain.command 向任意 Agent 发号施令（execute/inspect/report）。
 * 本 handler 注册在 Brain 的 IPC 上，按 type 分发：
 * - report：返回目标 Agent 状态（agentManager 实时查询，完全可用）
 * - inspect：返回目标 Agent 最近的工具调用（查 agent_tool_calls，真实可用；
 *   机制 C Auditor 上线后，inspect 可进一步触发 Auditor 深度扫描）
 * - execute：委托目标 Agent 执行新任务——需要 mission/delegation 上下文，
 *   当前返回结构化确认（已记录），完整 delegation 接线随 mission 上下文接入
 *
 * 结果通过 brain.command.result 回复 Brain。FORBIDDEN_TARGETS 语义不变（Brain 是指挥官，
 * 非对话伙伴）；target 不存在或不可达 → success:false，fail-closed。
 */
import type { IpcMessage } from '../types.js';
import type { IpcChannel } from '../ipc.js';
import type { AgentManager } from '../agent-manager.js';
import type Database from 'better-sqlite3';
import type { BrainCommand, BrainCommandResult } from '../../contracts/brain.js';
import { runAudit } from '../../agents/bundled/auditor/scan.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('brain-command');
/** inspect 默认回看目标 Agent 最近的工具调用条数 */
const INSPECT_DEFAULT_LIMIT = 20;

/** execute 委派回调：复用 orchestrator 的 dispatchModuleTask（支持 targetAgentOverride 定向派发） */
export type DispatchExecuteFn = (input: {
  sessionId: string;
  taskType: string;
  requester: string;
  inputPayload: Record<string, unknown>;
  foreground?: boolean;
  targetAgentOverride?: string;
}) => Promise<{ taskId: string; targetAgent: string }>;

export interface BrainCommandHandlerDeps {
  agentManager: AgentManager;
  db: Database.Database;
  /** 15.0 机制 D execute：真实委派到目标 Agent（orchestrator 注入 dispatchModuleTask） */
  dispatchExecute?: DispatchExecuteFn;
}

/**
 * 在 Brain 的 IPC 上注册 brain.command handler。
 *
 * @param brainIpc  Brain（reviewer）的 IPC 通道
 * @param deps      agentManager + db + dispatchExecute（execute 真实委派）
 */
export function setupBrainCommandHandler(
  brainIpc: IpcChannel,
  deps: BrainCommandHandlerDeps,
): void {
  brainIpc.onMessage('brain.command', async (msg: IpcMessage) => {
    const cmd = msg.payload as BrainCommand;
    const correlationId = msg.correlationId ?? msg.id;
    const result = await dispatchBrainCommand(cmd, deps);
    logger.debug({ target: cmd.target, type: cmd.type, success: result.success }, 'brain.command 已处理');
    brainIpc.send('brain.command.result', 'brain', result, correlationId);
  });
}

/** 按 type 分发 brain.command，返回结果（不抛错，异常 → success:false） */
async function dispatchBrainCommand(cmd: BrainCommand, deps: BrainCommandHandlerDeps): Promise<BrainCommandResult> {
  try {
    switch (cmd.type) {
      case 'report':
        return reportAgent(cmd, deps);
      case 'inspect':
        return inspectAgent(cmd, deps);
      case 'execute':
        return await executeAgent(cmd, deps);
      default:
        return { success: false, error: `未知 brain.command 类型: ${String(cmd.type)}` };
    }
  } catch (err) {
    return { success: false, error: `brain.command 处理异常: ${(err as Error).message}` };
  }
}

/** report：返回目标 Agent 实时状态 */
function reportAgent(cmd: BrainCommand, deps: BrainCommandHandlerDeps): BrainCommandResult {
  const agent = deps.agentManager.getAgent(cmd.target);
  if (!agent) {
    return { success: false, error: `目标 Agent 不存在或未加载: ${cmd.target}` };
  }
  return {
    success: true,
    data: {
      name: cmd.target,
      status: agent.status,
      ready: agent.status === 'ready',
    },
  };
}

/** inspect：scope='audit' → 运行 Auditor 5 维扫描；否则返回目标 Agent 最近工具调用 */
function inspectAgent(cmd: BrainCommand, deps: BrainCommandHandlerDeps): BrainCommandResult {
  // 15.0 机制 D→C 闭环：inspect 审计范围直接在进程内跑确定性扫描（复用 scan.ts 纯逻辑），
  // 不必启动 auditor 子进程。重活/定时扫描走 cron + auditor agent；轻量 inspect 走这里。
  if (cmd.payload?.scope === 'audit') {
    const report = runAudit(deps.db, {
      since: typeof cmd.payload.since === 'number' ? cmd.payload.since : undefined,
      to: typeof cmd.payload.to === 'number' ? cmd.payload.to : undefined,
    });
    return { success: true, data: { audit: report } };
  }

  const agent = deps.agentManager.getAgent(cmd.target);
  if (!agent) {
    return { success: false, error: `目标 Agent 不存在或未加载: ${cmd.target}` };
  }
  const limit = typeof cmd.payload?.limit === 'number' ? cmd.payload.limit : INSPECT_DEFAULT_LIMIT;
  const rows = deps.db
    .prepare(
      `SELECT tool_name, success, approved_by, duration_ms, error_message, created_at
       FROM agent_tool_calls
       WHERE agent_name = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(cmd.target, Math.min(limit, 100)) as Array<Record<string, unknown>>;
  return { success: true, data: { name: cmd.target, status: agent.status, recentToolCalls: rows } };
}

/**
 * execute：真实委派目标 Agent 执行新任务（机制 D 核心，非 stub）。
 *
 * 通过 orchestrator 注入的 dispatchExecute（dispatchModuleTask + targetAgentOverride）
 * 创建 foreground/background 委派到 cmd.target，返回 taskId。任务结果经正常 delegation
 * 生命周期异步回传（brain.command.result 此处只回派发回执 = taskId）。
 *
 * 不再返回「待接线」假确认 —— 那是补丁，违反「彻底不打补丁」。
 */
async function executeAgent(cmd: BrainCommand, deps: BrainCommandHandlerDeps): Promise<BrainCommandResult> {
  if (!deps.dispatchExecute) {
    return { success: false, error: 'execute 委派未接线（orchestrator 未注入 dispatchExecute）' };
  }
  // 15.0 R2-5 NG-2：禁止 Brain 派任务给自己（递归无 maxDepth，FORBIDDEN_TARGETS 语义）
  if (cmd.target === 'brain') {
    return { success: false, error: '禁止 Brain 向自身派任务（递归）' };
  }
  // 15.0 R2-3：移除 getAgent 运行态预检——它对 on-demand agent（如 auditor）语义错误
  // （未启动时 getAgent 返回 undefined），首次 execute target=auditor 必返回「未加载」，
  // dispatchExecute→ensureAgent 那条真 fork 子进程的路径被短路。
  // 改由 dispatchExecute（→dispatchModuleTask→ensureAgent→registry.get）统一处理：
  // 已注册则按需启动，未注册则 ensureAgent 抛「未注册」→ 下面 catch 返回 success:false。
  const sessionId = typeof cmd.payload.sessionId === 'string' ? cmd.payload.sessionId : 'brain-command';
  const taskType = typeof cmd.payload.taskType === 'string' ? cmd.payload.taskType : 'brain_command';
  try {
    const { taskId, targetAgent } = await deps.dispatchExecute({
      sessionId,
      taskType,
      requester: 'brain',
      inputPayload: cmd.payload,
      foreground: cmd.payload.foreground !== false, // 默认 foreground（Brain 通常要结果）
      targetAgentOverride: cmd.target,
    });
    logger.info({ target: cmd.target, taskId, taskType, priority: cmd.priority }, 'brain.command execute：委派已派发');
    return { success: true, data: { taskId, targetAgent, taskType } };
  } catch (err) {
    return { success: false, error: `委派派发失败: ${(err as Error).message}` };
  }
}
