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
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('brain-command');
/** inspect 默认回看目标 Agent 最近的工具调用条数 */
const INSPECT_DEFAULT_LIMIT = 20;

export interface BrainCommandHandlerDeps {
  agentManager: AgentManager;
  db: Database.Database;
}

/**
 * 在 Brain 的 IPC 上注册 brain.command handler。
 *
 * @param brainIpc  Brain（reviewer）的 IPC 通道
 * @param deps      agentManager（查 Agent 状态/委托）+ db（inspect 查询）
 */
export function setupBrainCommandHandler(
  brainIpc: IpcChannel,
  deps: BrainCommandHandlerDeps,
): void {
  brainIpc.onMessage('brain.command', (msg: IpcMessage) => {
    const cmd = msg.payload as BrainCommand;
    const correlationId = msg.correlationId ?? msg.id;
    const result = dispatchBrainCommand(cmd, deps);
    logger.debug({ target: cmd.target, type: cmd.type, success: result.success }, 'brain.command 已处理');
    brainIpc.send('brain.command.result', 'brain', result, correlationId);
  });
}

/** 按 type 分发 brain.command，返回结果（不抛错，异常 → success:false） */
function dispatchBrainCommand(cmd: BrainCommand, deps: BrainCommandHandlerDeps): BrainCommandResult {
  try {
    switch (cmd.type) {
      case 'report':
        return reportAgent(cmd, deps);
      case 'inspect':
        return inspectAgent(cmd, deps);
      case 'execute':
        return executeAgent(cmd, deps);
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

/** inspect：返回目标 Agent 最近的工具调用（机制 C 上线后可触发深度 Auditor 扫描） */
function inspectAgent(cmd: BrainCommand, deps: BrainCommandHandlerDeps): BrainCommandResult {
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
 * execute：委托目标 Agent 执行新任务。
 *
 * 完整实现需要 mission/delegation 上下文（sessionId / correlationId / requester），
 * 当前返回结构化确认并记日志，确保通道可用；delegation 接线随 mission 上下文接入。
 */
function executeAgent(cmd: BrainCommand, deps: BrainCommandHandlerDeps): BrainCommandResult {
  const agent = deps.agentManager.getAgent(cmd.target);
  if (!agent) {
    return { success: false, error: `目标 Agent 不存在或未加载: ${cmd.target}` };
  }
  logger.info({ target: cmd.target, priority: cmd.priority, payload: cmd.payload }, 'brain.command execute：待 delegation 上下文接线');
  return {
    success: true,
    data: { name: cmd.target, acknowledged: true, note: 'execute 需 mission/delegation 上下文，当前已确认接收，待接线' },
  };
}
