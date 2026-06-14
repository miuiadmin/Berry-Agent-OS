/**
 * 任务板 tool_request 统一入口（架构升级 16.0 P3-B1）—— 板上的「权限专员闸」shadow handler。
 *
 * 设计文档/23 §4.1 ①权限专员 Gate：当板上有 tool_request 信封时，本 handler 作为板上的
 * 统一工具执行入口。当前阶段（P3-B1）仍是**双写**：
 *   - 现有 permission.request IPC 路径仍是主执行路径（持有真实工具执行权）
 *   - 本 handler 是并行 shadow 路径——只走权限决策（acquire），落 shadow-approved / shadow-rejected
 *     的 tool_result 信封，不真正执行工具
 *
 * 为什么 shadow 而不直接接管执行：
 *   - P3-B3 已在 permission-flow.ts 的 permission.request handler 落 tool_request 投影（fire-and-forget 审计）
 *   - P3-B1 进一步建立「板可信」——让 board 上对每个 tool_request 都有与之配对的 tool_result，
 *     形成 request/result 完整配对，为后续把执行入口迁到板上铺路（P3-B2+）
 *   - 现阶段复用 PermissionCoordinator.acquire（L1/L2/L3 全链路逻辑 100% 不变），不重写权限
 *
 * 与 board-projection.ts 的关系：board-projection 是单向落板（现有主路径 → 板），本 handler
 * 是反向——从板上读 tool_request 信封 → 决策 → 落 tool_result 信封回板。两者正交。
 *
 * 失败语义：所有操作 try/catch + logger.debug，失败 no-op（绝不影响现有 IPC 主路径）。
 */

import type { PermissionCoordinator } from './permission-coordinator.js';
import type { ToolRegistry } from '../tools/index.js';
import type { SessionManager } from './session-manager.js';
import type { DangerLevel } from '../utils/types.js';
import type { BoardMessage } from '../contracts/board-message.js';
import { postBoardMessage } from './board-repo.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('board-tool-request-handler');

/**
 * tool_request 信封变体（从 BoardMessage 判别联合中提取）。
 * contracts/board-message.ts 只导出完整联合 BoardMessage，未单独导出变体类型，
 * 这里用 Extract 派生——保持与契约单一来源一致，避免重复定义。
 */
type ToolRequestMsg = Extract<BoardMessage, { type: 'tool_request' }>;

/**
 * handler 的依赖注入参数。
 * 全部为既有模块的实例，复用而不重写——体现「补丁即重构反模式」（CLAUDE.md）。
 */
export interface BoardToolRequestHandlerDeps {
  /** 权限协调器（复用 L1/L2/L3 全链路决策，不改它） */
  permissionCoordinator: PermissionCoordinator;
  /** 工具注册表（查工具的 dangerLevel，决定走哪条权限路径） */
  toolRegistry: ToolRegistry;
  /** 会话管理器（查 tool_request 信封关联的 sessionId / taskId） */
  sessionManager: SessionManager;
}

/**
 * 一条已处理的 tool_request 信封的 shadow 决策结果。
 * 内部用：决定落 tool_result 的 ok / output 内容。
 */
interface ShadowDecision {
  /** true=放行 shadow-approved / false=拒绝 shadow-rejected */
  ok: boolean;
  /** 落到 tool_result.output 的字符串（'shadow-approved' / 'shadow-rejected: reason'） */
  output: string;
}

/**
 * 设置板 tool_request handler。
 *
 * 调用方在 postBoardMessage(tool_request) 之后触发本 handler 处理该信封。
 * 当前阶段 handler 是**纯函数式调用**——由调用方主动传入要处理的 tool_request 信封，
 * 而不是订阅板变化（避免引入新的异步监听机制，遵循「架构优雅定律：已有机制优先」）。
 *
 * 处理流程：
 *   1. 从信封读 { from(=agentName), taskId, sessionId, toolName, input }
 *   2. 查 tool registry 取 dangerLevel
 *   3. 调 PermissionCoordinator.acquire（复用现有 L1/L2/L3 逻辑）
 *   4. 放行 → 落 tool_result(ok:true, output:'shadow-approved')
 *      拒绝 → 落 tool_result(ok:false, output:'shadow-rejected: reason')
 *
 * 关键约束（P3-B1）：
 *   - **当前阶段不执行工具**——只是 shadow approve/reject 落板，真正的工具执行仍走
 *     现有 IPC permission.request 路径（持有 tokenId 的才是执行权）
 *   - **现有权限逻辑 100% 不变**——handler 只复用 PermissionCoordinator.acquire，不改它
 *   - **fire-and-forget**——所有操作 try/catch + logger.debug，失败 no-op
 *
 * @param deps   依赖注入（permissionCoordinator / toolRegistry / sessionManager）
 * @param envelope 板上的 tool_request 信封（已落板，handler 读它做 shadow 决策）
 */
export function setupBoardToolRequestHandler(
  deps: BoardToolRequestHandlerDeps,
  envelope: ToolRequestMsg,
): void {
  try {
    const decision = shadowDecide(deps, envelope);
    postShadowResult(deps, envelope, decision);
  } catch (err) {
    // 兜底：整个 handler 任何未预期异常都 no-op，绝不影响现有 IPC 主路径
    logger.debug(
      { err, taskId: envelope.taskId, toolName: envelope.toolName },
      'board-tool-request-handler: 处理 tool_request 信封异常（no-op，不影响主路径）',
    );
  }
}

/**
 * 对一条 tool_request 信封做 shadow 权限决策（不执行工具）。
 *
 * 复用 PermissionCoordinator.acquire 的全链路：
 *   - active_scope 三态（block/grant/null，§3.8 + 15.0 R4 委派即授权）
 *   - engine 硬确定性检查（dangerous_tool / blocklist / deny-all）
 *   - autoDecide（allow-all 放行 / ask low 放行）
 *   - requiresReview（需要 Brain / 用户审核的）
 *
 * 注意：acquire 返回 requiresReview 时表示「需要异步审核」——shadow 阶段无法等待，
 * 按「fail-closed」原则记为 rejected（与现有同步路径的保守语义一致），并在 output 里标注原因。
 *
 * @param deps     依赖
 * @param envelope tool_request 信封
 * @returns shadow 决策（ok + output 文本）
 */
function shadowDecide(deps: BoardToolRequestHandlerDeps, envelope: ToolRequestMsg): ShadowDecision {
  const { from: agentName, taskId, sessionId, toolName, input } = envelope;

  // ① 查工具注册表取 dangerLevel——决定走哪条权限路径（safe/moderate/dangerous）
  const tool = deps.toolRegistry.get(toolName);
  const dangerLevel: DangerLevel = tool?.dangerLevel ?? 'moderate';

  // ② input（结构化对象）序列化为 toolInput 字符串——PermissionCoordinator 的契约要求字符串
  //    inputHash 校验依赖此字符串形式；保持与 permission.request IPC 路径一致
  const toolInput = JSON.stringify(input);

  // ③ 反查 sessionId——信封里可能没带（旧路径投影时 explicitSessionId 可空），用 sessionManager 补
  const resolvedSessionId = sessionId
    ?? deps.sessionManager.findPendingByTaskId(taskId)?.sessionId
    ?? taskId;

  // ④ 复用 acquire（L1/L2/L3 全链路）。shadow 阶段只读决策，不消费 token。
  const result = deps.permissionCoordinator.acquire({
    agentName,
    sessionId: resolvedSessionId,
    toolName,
    toolInput,
    dangerLevel,
    taskId,
  });

  // ⑤ 映射决策结果到 shadow 文本
  if (result.allowed) {
    // 放行（含 active_scope grant / autoDecide 签 token / engine 直接允许）
    return { ok: true, output: 'shadow-approved' };
  }
  if (result.requiresReview) {
    // 需要异步审核（Brain judge / 用户确认）——shadow 无法等待，记 rejected 并标明
    return {
      ok: false,
      output: `shadow-rejected: requiresReview（${result.reason ?? '需异步审核，shadow 阶段无法等待'}）`,
    };
  }
  // 硬拒（blocklist / deny-all / active_scope block / 危险工具 fail-closed）
  return { ok: false, output: `shadow-rejected: ${result.reason ?? '权限拒绝'}` };
}

/**
 * 把 shadow 决策落成板上的 tool_result 信封（from 固定 'system'）。
 *
 * tool_result 的契约（contracts/board-message.ts）：结果是事实非动作，不再过任何审核闸。
 * callId 用 tool_request 信封的 id 做幂等定位（一对 request/result 配对）。
 *
 * @param deps     依赖（当前只用 logger，保持签名对称便于未来扩展）
 * @param request  原始 tool_request 信封（取 taskId/sessionId/parentTaskId + id 作 callId）
 * @param decision shadow 决策结果
 */
function postShadowResult(
  _deps: BoardToolRequestHandlerDeps,
  request: ToolRequestMsg,
  decision: ShadowDecision,
): void {
  try {
    const resultEnvelope: BoardMessage = {
      id: genId('bmsg'),
      type: 'tool_result',
      // from 固定 'system'——工具结果由系统产出（即便 shadow，主体仍是 system）
      from: 'system',
      // to 配对回原发起者（agentName），让板上可见是「系统回了谁的请求」
      to: request.from,
      taskId: request.taskId,
      parentTaskId: request.parentTaskId,
      sessionId: request.sessionId,
      ts: Date.now(),
      // callId = 原 tool_request 信封 id，板上 request/result 幂等配对定位用
      callId: request.id,
      output: decision.output,
      ok: decision.ok,
    };
    postBoardMessage(request.taskId, resultEnvelope);
    logger.debug(
      { taskId: request.taskId, toolName: request.toolName, ok: decision.ok },
      'board-tool-request-handler: shadow tool_result 已落板',
    );
  } catch (err) {
    logger.debug(
      { err, taskId: request.taskId, toolName: request.toolName },
      'board-tool-request-handler: 落 tool_result 失败（fire-and-forget，不影响主路径）',
    );
  }
}
