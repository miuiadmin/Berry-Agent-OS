/**
 * 任务板信封契约（架构升级 16.0）—— 多智能体协作的统一发言格式。
 *
 * 设计目标（见 设计文档/废弃/23-架构升级-16.0-任务板协作.md）：
 *   把 agent 间散落在 IPC / EventBus / delegation / brain.command 四套通道的通信，
 *   收敛到「任务板上的一条发言」。7 种言语行为（type 判别联合）覆盖所有协作场景：
 *   指派(delegate) / 附成果(report) / 讨论(tell) / 求助(ask) /
 *   工具调用(tool_request) / 工具结果(tool_result) / 治理指令(command)。
 *
 * 与 doc 22 Block 的关系（两层正交，§13）：
 *   - board 层 = 一块 task 内「谁说了话」的多 agent 发言序列（BoardMessage）。
 *   - block 层 = 单个 agent 一轮回复内部的结构（Block，doc 22）。
 *   一条 BoardMessage 的内容可以是一串 Block[]（该 agent 那轮的思考+工具+文本）。
 *
 * 持久化：BoardMessage 落库到 task_thread 表（每条一行，payload_json = 完整信封序列化）。
 * 落盘前经 redactSecrets 清洗（复用 15.0 覆盖网）。
 */

import { z } from 'zod';

// ─── 公共信封头（§3.1）───

/** 发言者 / 目标 agent 引用（agentId 字符串） */
type AgentRef = string;

/** 板上发言的 7 种言语行为（判别字段 = type） */
export type BoardMessageType =
  | 'delegate'
  | 'report'
  | 'tell'
  | 'ask'
  | 'tool_request'
  | 'tool_result'
  | 'command';

/** 目标字段：agentId | 特殊路由目标 */
export type MessageTarget = AgentRef | 'all' | 'system' | 'brain' | 'user';

/**
 * 板上一条发言/动作的信封头（公共部分）。
 * 完整信封 = 本头 + 对应 type 的 body 字段（§12 判别联合组合）。
 */
export interface BoardMessageEnvelope {
  /** 信封 id（genId） */
  id: string;
  /** 言语行为判别字段（与 body 的 type 一致） */
  type: BoardMessageType;
  /** 发言者 agentId（system/runtime 发的工具结果用 'system'；brain 发的指令用 'brain'） */
  from: AgentRef;
  /**
   * @目标：
   * - agentId → 指定某 agent
   * - 'all' → 板内广播
   * - 'system' → 工具调用（撞①权限专员闸）
   * - 'brain' → 升级求助
   * - 'user' → 经助手转交用户
   */
  to: MessageTarget;
  /** 所属 task board（板 = task，§5.1） */
  taskId: string;
  /** 父 task（子任务递归，根 task 此字段空） */
  parentTaskId?: string;
  /** 会话 id（关联用户对话 session） */
  sessionId?: string;
  /** 时间戳（毫秒） */
  ts: number;
}

// ─── 信封公共字段（Zod 版，spread 到每 type schema）───
const Env = {
  id: z.string(),
  from: z.string(),
  to: z.string(),
  taskId: z.string(),
  parentTaskId: z.string().optional(),
  sessionId: z.string().optional(),
  ts: z.number(),
};

// ─── 7 种 body schema（§12 定稿，每个含信封公共字段）───

/**
 * @指派：leader 把（子）任务交给某 agent。
 * 替代：delegation-orchestrator handoff。
 */
const DelegateMsgSchema = z.object({
  ...Env,
  type: z.literal('delegate'),
  /** 被指派的 agentId（或 'capability:xxx' 由 Directory 解析） */
  to: z.string(),
  /** 子任务目标描述 */
  subTaskGoal: z.string(),
  /** 拆子板时新板 id（不拆则在本板内指派） */
  childTaskId: z.string().optional(),
  /** 继承/收窄的 active_scope（§5.5，allowTools/blockTools/allowPaths） */
  scope: z.record(z.string(), z.unknown()).optional(),
  /** 整任务交接（leader 转交 leadership，§12 注） */
  transferLeadership: z.boolean().optional(),
  /** 辩论模式（§5.7，leader 显式开启的板内辩论子区） */
  mode: z.literal('debate').optional(),
  /** 辩论收敛条件（mode='debate' 时必填） */
  debateConfig: z.object({
    rounds: z.number().optional(),
    converged: z.boolean().optional(),
    judge: z.string().optional(),
  }).optional(),
});

/**
 * 附成果：把产出贴到板（必经②产出审核专员，§4.4）。
 * 替代：review 上报 + conversation.result。
 */
const ReportMsgSchema = z.object({
  ...Env,
  type: z.literal('report'),
  /** 上报对象（@brain 协调 / @user 经助手 / @leader） */
  to: z.enum(['brain', 'user']).or(z.string()),
  /** 成果摘要（进 board thread） */
  summary: z.string(),
  /** 大成果文件引用（§10.5，artifact 存文件，板只存引用+摘要） */
  artifactRefs: z.array(z.string()).default([]),
  /** 成果状态：done=完成 / partial=部分 / blocked=受阻 / cant_split=拆不动降级上报（§10.3） */
  status: z.enum(['done', 'partial', 'blocked', 'cant_split']),
});

/**
 * 板上发言：知会 / 讨论（公开，非私聊）。
 * 替代：EventBus 陈述类事件。
 */
const TellMsgSchema = z.object({
  ...Env,
  type: z.literal('tell'),
  /** @某成员 或 @all 板内广播 */
  to: z.string().or(z.literal('all')),
  /** 发言内容 */
  text: z.string(),
});

/**
 * 求助：@peer 板内求助 / @brain 升级触发 escalate（§4.1）。
 * 替代：机制 B 4 escalation。
 * 判别 = to 字段：非 'brain' = peer 求助（不惊动治理硬闸）；'brain' = 升级。
 */
const AskMsgSchema = z.object({
  ...Env,
  type: z.literal('ask'),
  /** @peer(agentId) 或 @brain（升级） */
  to: z.string().or(z.literal('brain')),
  /** 求助问题 */
  question: z.string(),
  /** true=等回复才继续（peer 求助常 false，升级常 true） */
  blocking: z.boolean().default(false),
});

/**
 * 工具调用：撞①权限专员闸（§4.1）。
 * 替代：CapabilityBus permission-gate。
 */
const ToolRequestMsgSchema = z.object({
  ...Env,
  type: z.literal('tool_request'),
  /** 固定 'system'（工具由系统执行） */
  to: z.literal('system'),
  /** 工具名（如 shell / write_file / inspect_code） */
  toolName: z.string(),
  /** 工具入参（结构化对象） */
  input: z.record(z.string(), z.unknown()),
});

/**
 * 工具结果：回发起者 + 落板（§4.4，不再过闸）。
 * 结果是事实非动作，不再经任何审核。
 */
const ToolResultMsgSchema = z.object({
  ...Env,
  type: z.literal('tool_result'),
  /** 固定 'system'（工具结果由系统产出） */
  from: z.literal('system'),
  /** 配对的 tool_request callId（幂等定位） */
  callId: z.string(),
  /** 工具输出（结构化或原始文本） */
  output: z.unknown(),
  /** 是否成功 */
  ok: z.boolean(),
});

/**
 * ③brain 板上下令（§4.2.2 动作 3）。
 * 替代：机制 D brain.command。
 * 4 种 intent：redirect(掰方向) / stop(叫停) / inspect(问状态) / dispatch(补派)。
 */
const CommandMsgSchema = z.object({
  ...Env,
  type: z.literal('command'),
  /** 固定 'brain'（只有 brain 发 command） */
  from: z.literal('brain'),
  /** @目标 agent */
  to: z.string(),
  /** 指令意图 */
  intent: z.enum(['redirect', 'stop', 'inspect', 'dispatch']),
  /** 指令内容 */
  instruction: z.string(),
  /** intent=dispatch 时补派规格（§5.2.2） */
  dispatchSpec: z.object({
    agentRef: z.string(),
    goal: z.string(),
  }).optional(),
});

// ─── 完整信封判别联合 ───

/**
 * 板上发言/动作的完整 Zod 判别联合（type 为判别字段）。
 * 每 type 固定 schema，编译期类型安全，禁止自由 payload 的 god-object。
 *
 * 每个变体包含完整信封字段（id/from/to/taskId/ts + type-specific body），
 * 使 z.infer<BoardMessageSchema> 即可直接用于存储/读取/传输。
 */
export const BoardMessageSchema = z.discriminatedUnion('type', [
  DelegateMsgSchema,
  ReportMsgSchema,
  TellMsgSchema,
  AskMsgSchema,
  ToolRequestMsgSchema,
  ToolResultMsgSchema,
  CommandMsgSchema,
]);

/** 完整 BoardMessage（信封头字段 + body 字段的合并类型，由 Zod 推导） */
export type BoardMessage = z.infer<typeof BoardMessageSchema>;

// ─── variant 类型别名（consumer 用别名替代 Extract<BoardMessage, {type:...}> 样板）───

/** @指派信封（leader 把子任务交给某 agent） */
export type DelegateMessage = z.infer<typeof DelegateMsgSchema>;
/** @附成果信封（必经②产出审核专员） */
export type ReportMessage = z.infer<typeof ReportMsgSchema>;
/** @板上发言信封（知会/讨论） */
export type TellMessage = z.infer<typeof TellMsgSchema>;
/** @求助信封（@peer 板内求助 / @brain 升级） */
export type AskMessage = z.infer<typeof AskMsgSchema>;
/** @工具调用信封（撞①权限专员闸） */
export type ToolRequestMessage = z.infer<typeof ToolRequestMsgSchema>;
/** @工具结果信封（回发起者 + 落板，不再过闸） */
export type ToolResultMessage = z.infer<typeof ToolResultMsgSchema>;
/** @治理指令信封（③brain 板上下令：redirect/stop/inspect/dispatch） */
export type CommandMessage = z.infer<typeof CommandMsgSchema>;

// ─── 板状态机（§6.5.1）───

/** task board 的状态值 */
export type BoardStatus =
  | 'created'          // 助手刚建板、未派工
  | 'in_progress'      // 有 agent 在干（至少一条未完成子任务）
  | 'awaiting_review'  // 有 report 在②审核闸排队（阻塞中）
  | 'awaiting_user'    // 撞 L3 权限确认 或 brain ask 用户——等用户输入
  | 'completed'        // 终态：任务完成
  | 'failed'           // 终态：任务失败
  | 'interrupted';     // 终态：用户主动停

/** 板状态合法流转（§6.5.1 状态机，派发层按信封流推导） */
export const BOARD_STATUS_TRANSITIONS: Record<BoardStatus, BoardStatus[]> = {
  created: ['in_progress', 'interrupted'],
  in_progress: ['awaiting_review', 'awaiting_user', 'completed', 'failed', 'interrupted'],
  awaiting_review: ['in_progress', 'completed', 'failed'], // approve→completed / 打回→in_progress / reject→failed
  awaiting_user: ['in_progress', 'failed', 'interrupted'],  // 用户回复→in_progress / 用户拒绝→failed
  completed: [],
  failed: [],
  interrupted: [],
};

// ─── 板状态推导（§6.5.1 单一事实源，纯函数）───

/** 板状态流转的触发事件（经此一处推导，替代散落的硬编码 statusMap） */
export type BoardStatusEvent =
  | { kind: 'delegate' }                                      // 首次/再次指派 → in_progress
  | { kind: 'report'; status: 'done' | 'partial' | 'blocked' | 'cant_split' } // 附成果
  | { kind: 'enter_review' }                                  // report 进②审核闸
  | { kind: 'await_user' }                                    // 撞 L3 权限 / brain ask 用户
  | { kind: 'user_resumed' }                                  // 用户回复 → 继续干
  | { kind: 'user_rejected' }                                 // 用户拒绝 → 失败
  | { kind: 'interrupt' };                                    // 用户主动中断

/**
 * 按触发事件推导板的下一状态（§6.5.1 单一事实源，纯函数）。
 *
 * 替代 board-projection.postReportEnvelope 等处散落的硬编码 statusMap——所有板状态流转经此一处：
 *   - 校验 BOARD_STATUS_TRANSITIONS 合法流转，非法流转抛错（早暴露状态机 bug）；
 *   - 终态（completed/failed/interrupted）不再流转（防已完成板被迟到信封打回）；
 *   - 暴露 enter_review/await_user/interrupt 等事件，供 P3/P4 审核闸/权限/中断路径接入。
 *
 * @param cur   当前板状态
 * @param event 触发事件
 * @returns 新状态（合法流转且≠当前态）；null=终态或无变化（调用方不必 UPDATE）；抛错=非法流转
 */
export function nextBoardStatus(cur: BoardStatus, event: BoardStatusEvent): BoardStatus | null {
  // 终态不再流转（防迟到信封把已完成/已失败板打回）
  if (cur === 'completed' || cur === 'failed' || cur === 'interrupted') return null;
  let next: BoardStatus | null = null;
  switch (event.kind) {
    case 'delegate':
      next = 'in_progress';
      break;
    case 'report':
      // done→completed / blocked→failed / partial+cant_split→in_progress
      next = event.status === 'done' ? 'completed' : event.status === 'blocked' ? 'failed' : 'in_progress';
      break;
    case 'enter_review':
      next = 'awaiting_review';
      break;
    case 'await_user':
      next = 'awaiting_user';
      break;
    case 'user_resumed':
      next = 'in_progress';
      break;
    case 'user_rejected':
      next = 'failed';
      break;
    case 'interrupt':
      next = 'interrupted';
      break;
  }
  if (!next || next === cur) return null;
  // 校验合法流转（§6.5.1 状态机）——非法流转早抛错，防状态机被绕过
  if (!BOARD_STATUS_TRANSITIONS[cur].includes(next)) {
    throw new Error(`nextBoardStatus: 非法板状态流转 ${cur} → ${next}（事件 ${event.kind}）`);
  }
  return next;
}

// ─── 板元数据（§5.1，task 升级为板的附加字段）───

/** task board 的元数据（附加到现有 agent_tasks / mission 表） */
export interface BoardMeta {
  /** 板目标（用户需求或子任务目标） */
  goal: string;
  /** 板状态 */
  status: BoardStatus;
  /** 板 leader（谁拥有这块板谁就是 leader，递归角色） */
  leader: AgentRef;
  /** 成员花名册（被 delegate 拉入的 agent + 治理议会） */
  members: AgentRef[];
  /** 生成深度（0=顶层 leader，+1=被指派一层，封顶 3，§10.3） */
  spawnDepth: number;
  /** 发言计数（预算 maxTurns 用，§10.6） */
  turnCount: number;
  /** 预算：最大发言数软上限（默认 ~50，§10.6） */
  maxTurns: number;
  /** 预算：最大生成深度硬上限（默认 3，§10.3） */
  maxSpawnDepth: number;
  /** active_scope（板级权限，被指派 agent 继承，§5.5） */
  activeScope?: {
    allowTools?: string[];
    blockTools?: string[];
    allowPaths?: string[];
  };
}

// ─── 收敛映射（§3.3，文档参考，非运行时）───

/**
 * 板上动作 → 替代的现有机制（收敛证明，§3.3）：
 *
 * | 板上动作           | type            | 替代                          |
 * |-------------------|-----------------|-------------------------------|
 * | @指派 / 拆子任务   | delegate        | delegation-orchestrator handoff|
 * | 附成果             | report          | review 上报 + conversation.result|
 * | 板上讨论/辩论      | tell / ask      | EventBus 陈述类事件            |
 * | 升级求助           | ask(@brain)     | 机制 B 4 escalation            |
 * | brain 纠偏/指挥    | command         | 机制 D brain.command           |
 * | 工具调用           | tool_request    | CapabilityBus permission-gate  |
 * | 板（审计/可见性）   | board 本身      | tool_calls/brain_observations  |
 */
