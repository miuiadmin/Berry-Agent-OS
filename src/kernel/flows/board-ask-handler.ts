/**
 * 板上 ask(@brain) 升级入口 handler（架构升级 16.0 P3-C2，设计文档/23 §4.4）。
 *
 * 定位：**消费侧**。P3-C1 已在 15.0 机制 B 的 4 个 escalation 出口加了 ask(@brain)
 * fire-and-forget 落板投影（见 `board-projection.ts:postAskEnvelope`）。本 handler 负责
 * 在 ask 信封落板后唤醒 brain 介入——把「板上有求助」这件事转换成 brain 能消费的信号。
 *
 * 核心设计（遵 CLAUDE.md「架构优雅定律 / 复用现有机制」）：
 *   - **复用现有 checkpoint 机制**让 brain 介入——不新造 brain 触发路径。emit
 *     `delegation.checkpoint_needed`（trigger='board_ask'），现有 correction-flow 订阅者
 *     会拿 delegationId 去构造 CorrectionContext 并把 checkpoint 投给 brain IPC
 *     （correction-flow.ts:setup → handleCheckpointNeeded）。这条路径就是 15.0 机制 B
 *     升级走的老路，board 只是把「求助来源」从 4 个 escalation 出口扩到板上 ask。
 *   - **不阻塞**（§4.2 看板异步）——ask 落板不阻塞板上其他发言，handleAsk 本身同步
 *     返回，brain 介入是后续 checkpoint 异步评估的结果。
 *   - **现有 escalation 4 出口语义不变**——handler 只是额外的板消费侧。P3-C1 的投影
 *     已经 emit 了一次 checkpoint_needed（board-projection.deriveEventFromBoardMessage），
 *     本 handler 不重复 emit（去重见 handleAsk 注释），避免双触发。
 *
 * peer 求助（to !== 'brain'）的处理：仅落板供 peer 下轮读取，不主动唤醒。
 * 设计文档/23 §4.4：「`@peer`=板内求助（不惊动治理硬闸，只进 brain 看板）」。
 */

import { getEventBus } from '../event-bus.js';
import { getLogger } from '../../utils/logger.js';
import { getBoardContext } from '../board-repo.js';
import type { BoardContext } from '../board-repo.js';
import type { BoardMessage } from '../../contracts/board-message.js';

/**
 * AskMessage 收窄类型：从 BoardMessage 判别联合提取 type='ask' 变体。
 * （board-message 契约只导出 BoardMessage 联合 + Schema，未单独导出 AskMessage 类型名，
 *  此处用 Extract 本地收窄，等价于 AskMsgSchema 的推导类型。）
 */
type AskMessage = Extract<BoardMessage, { type: 'ask' }>;

const logger = getLogger('board-ask-handler');

/**
 * handler 依赖：仅注入它需要的两个外部句柄。
 * - sessionManager：预留（P3-C2 集成阶段会用 sessionId 关联用户对话；当前最小版用不到，
 *   保留在签名里让集成层注入时不破坏接口）。
 * - eventBus：显式注入便于测试；默认取全局单例（getEventBus）。
 */
export interface BoardAskHandlerDeps {
  /** 会话管理器（关联用户对话 session，当前最小版预留） */
  sessionManager?: unknown;
  /** EventBus 实例（默认全局单例；测试可注入 mock） */
  eventBus?: ReturnType<typeof getEventBus>;
}

/**
 * 在 P3-C2 集成阶段装配本 handler。
 *
 * 当前最小版只导出 handleAsk（调用方在 postBoardMessage(ask) 后主动调），
 * 不做 EventBus 订阅——避免与 board-projection.deriveEventFromBoardMessage 双触发。
 * 后续如需「被动订阅 board 落板事件」，再在此处注册订阅并做去重。
 */
export function setupBoardAskHandler(_deps: BoardAskHandlerDeps): {
  handleAsk: (taskId: string, askMsg: AskMessage) => void;
} {
  // 当前装配是 no-op（最小版只暴露 handleAsk）。保留 setup 入口是为了：
  // 1. 与 flows/ 目录其他 handler（brain-command-handler.setupXxx）形态一致
  // 2. 后续若需要 EventBus 订阅，装配点就在这里
  return { handleAsk };
}

/**
 * 处理板上 ask 信封（P3-C2 消费侧入口）。
 *
 * 调用时机：P3-C1 的 postAskEnvelope（或任意 postBoardMessage(ask)）落板成功后，
 * 集成层主动调本方法。**注意去重**：board-projection.deriveEventFromBoardMessage 已经
 * 在落板时 emit 了一次 `delegation.checkpoint_needed`。本方法默认不再重复 emit，
 * 仅在 caller 显式 opts.skipDuplicateGuard=false 时才补 emit（应对「投影未接线」的边界场景）。
 *
 * 分路（§4.4 判别 = to 字段）：
 *   a. ask.to === 'brain' → 升级路径：
 *      - getBoardContext(taskId) 拼 brain 看板上下文（meta + 花名册 + 近 N 条发言）
 *      - （去重保护下）emit `delegation.checkpoint_needed`，现有 correction-flow 消费 → brain 介入
 *      - 不阻塞，立即返回
 *   b. ask.to !== 'brain'（peer 求助）→ 仅落板供 peer 下轮读取（不主动唤醒，debug 日志留痕）
 *
 * @param taskId   所属 task board（= delegationId，板与 delegation 1:1）
 * @param askMsg   落板的 ask 信封（BoardMessage type='ask'）
 * @param opts     调用选项（默认 skipDuplicateGuard=true，不重复 emit checkpoint）
 */
export function handleAsk(
  taskId: string,
  askMsg: AskMessage,
  opts: { skipDuplicateGuard?: boolean } = {},
): void {
  // ── b. peer 求助：不惊动治理硬闸，只进 brain 看板（落板即完成，下轮 peer 自取）──
  if (askMsg.to !== 'brain') {
    logger.debug(
      { taskId, from: askMsg.from, to: askMsg.to, blocking: askMsg.blocking },
      'board-ask: peer 求助已落板，不主动唤醒（peer 下轮自取）',
    );
    return;
  }

  // ── a. 升级路径：拼 brain 上下文 + 复用 checkpoint 机制 ──

  // 组装 board 看板上下文（§10.5）：meta + 花名册 + 近 N 条发言窗口。
  // 当前最小版用于 debug 可观测 + 预留 brain prompt 组装（后续 P3 brain 看板消费）。
  // 失败仅 debug 日志——板可能尚未 initBoard（投影未跑）或库未建表，不阻断升级。
  const context: BoardContext | null = (() => {
    try {
      return getBoardContext(taskId);
    } catch (err) {
      logger.debug(
        { err, taskId },
        'board-ask: getBoardContext 失败（板未初始化或库未建表），降级仅 emit checkpoint',
      );
      return null;
    }
  })();

  // 去重保护：P3-C1 投影（board-projection.deriveEventFromBoardMessage）落板时已经
  // emit 过一次 checkpoint_needed。本 handler 默认不重复 emit，避免 correction-flow
  // 重复触发 brain checkpoint 评估（pendingCheckpoints 去重也会拦，但少一次无效 emit 更干净）。
  // 只有 caller 明确 opts.skipDuplicateGuard=false（投影未接线的边界）才补 emit。
  const skipDuplicateGuard = opts.skipDuplicateGuard ?? true;
  if (!skipDuplicateGuard) {
    try {
      // 复用现有 checkpoint 机制：emit delegation.checkpoint_needed → correction-flow 订阅
      // → buildCorrectionContext(delegationId) → 投 checkpoint.evaluate 给 brain IPC。
      // trigger='board_ask' 与 board-projection.deriveEventFromBoardMessage 的 trigger 对齐。
      // （correction-flow 内部把 trigger as CheckpointTrigger，字符串 trigger 安全。）
      getEventBus().emit('delegation.checkpoint_needed', {
        delegationId: taskId,
        trigger: 'board_ask',
      });
    } catch (err) {
      // emit 失败仅 debug——checkpoint 路径有多处兜底（correction-flow 超时继续、
      // delegation terminal cleanup），且 P3-C1 投影那条 emit 是主路径。
      logger.debug(
        { err, taskId },
        'board-ask: emit delegation.checkpoint_needed 失败（不阻断，依赖 P3-C1 投影兜底）',
      );
    }
  }

  logger.info(
    {
      taskId,
      from: askMsg.from,
      question: askMsg.question,
      blocking: askMsg.blocking,
      hasContext: !!context,
      skipDuplicateGuard,
    },
    'board-ask(@brain): 升级信号已处理（复用 checkpoint 机制，brain 将异步介入）',
  );
}

/**
 * 类型守卫：从 BoardMessage 判别联合中收窄出 AskMessage。
 * 集成层（P3-C2）在 board 落板回调里拿到的是联合类型，用此 helper 收窄后传 handleAsk。
 */
export function isAskMessage(msg: BoardMessage): msg is AskMessage {
  return msg.type === 'ask';
}
