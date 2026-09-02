/**
 * L4 chat — 对话应用官方件（契约篇 §5.4 应用面第一纵切：`builtin:chat` 显式化；铭牌批件聚落 src/chat/）。
 *
 * 官方默认层**首行**（Ring 2 真·可卸——overlay 禁用即首启无对话循环，宿主照启：
 * 装/守/存职能与 /apps、/reload 壳命令完好；命题 §3.5「对话是应用不是内核」
 * 的运行时证明）。
 *
 * 2026-08-26 S1 durable 键控总根因刀（多应用并行第一纵切，骨架篇 §9.3 机制定案
 * / 契约篇 §5.4 第 6 条 S1 射面）：factory 级单驱动退役为**注册表**——
 * - `DriverRegistry`：`Map<sessionId, DriverEntry>` + 前台聚焦指针 focus。
 *   注册表由组合根分配（createChatApp 产物）、**本件负责填充与消费**（单真相：
 *   会话选择→durable 直连→session_start→盖章→header 差分→驱动构造一条龙全在
 *   `open()` 内化）；`/new` = open 新条目 + 切 focus + 旧条目退役（entry 的
 *   session/durable 保留——迟到结算继续落原会话账，防 seq 撞号）。
 * - `FrontHost` 前台宿主 façade：submit/requestQuit/settle 随前台聚焦路由，
 *   quit = 退出聚合 promise（任一驱动 requestQuit 即 resolve——/new 换驱动不断流），
 *   display 经 façade 注册（open 新驱动全量转接，退役驱动迟到事件仍可见=审计面）。
 * - ctx.agent 路由 façade：sendUserMessage 三级解析序（显式键 → 调用链 → 前台
 *   聚焦）+ 两码执法（AGENT_SESSION_INACTIVE / AGENT_SESSION_KEY_REQUIRED）；
 *   dispatch/subscribers/face 工厂级（跨 /reload 存续），/reload 重装载只重
 *   provide 服务面（驱动与时间线存续——重装载是装载面变更，不是会话变更）。
 *
 * 2026-08-26 S3 TUI 多会话呈现刀（契约篇 §5.4 S3 射面，冷读 12 条回写后形态）：
 * - **展示信封**：front.addDisplay 收 `{sessionId, event}` 信封——转接层补本会话
 *   键（驱动面 AgentEventSink 保持裸事件），信封在宿主壳接线处即拆开分流。
 * - **切换程序面**：registry.switchTo（活条目即切、零准入拒）+ onFocusChange
 *   （通知机制落 registry=focus 指针所在处；三写点通知：open 新开/open 幂等命中/
 *   switchTo，同值写零通知）。
 * - **退出扇出**：requestQuit 从「只路由聚焦驱动」扩为 abort 扇出全部活驱动
 *   （/app new 使「退出时有后台 run」成常态——settle/shutdown 必达不挂死）；
 *   settle 同步扇出（等全部活驱动 run 结算）。
 *
 * 会话选择属对话应用（无对话运行则无会话——「哪段对话续接」是应用行为，事件
 * 日志机制才是内核）；sandbox 档事实是宿主守门面，盖章函数由组合根注入、件在
 * 会话边界时点调用（内核有数据，应用有时点）。
 */

import {
  AppError,
  AGENT_DELIVER_AS_UNSUPPORTED,
  AGENT_SESSION_INACTIVE,
  AGENT_SESSION_KEY_REQUIRED,
  describeError,
} from '../contracts/errors.js';
import type { AssistantMessage, UserMessage, MessageSource, Message, StreamFn } from '../contracts/llm.js';
import type { AgentMessage } from '../contracts/messages.js';
import type { AgentEvent } from '../agent/events.js';
import type { PreStepDecision } from '../agent/loop.js';
import type { AgentTool } from '../contracts/tools.js';
import type { BuiltinAppModule, AppContext } from '../contracts/app.js';
import type { AppManifest } from '../contracts/app.js';
import type { ContextScope, Disposer } from '../context/types.js';
import { chainSessionId } from '../context/chain.js';
import { createContext } from '../context/context.js';
import type { Session } from '../session/session.js';
import type { Persistence } from '../persist/index.js';
import type { ToolsService } from '../tools/registry.js';
import { createToolPipeline } from '../tools/pipeline.js';
import type { ToolPipelineExecutor } from '../contracts/tools.js';
import type { SandboxMode, SandboxService } from '../safety/index.js';
import type { AllowlistDraft, ApprovalPolicyMode, ApprovalRequest } from '../safety/types.js';
import { APPROVAL_ANSWER_EVENT, bridgeApprovalSignal, createApprovalService } from '../safety/approval.js';
import { conductGateLines, installSafetyGate, type GateRowFilter } from '../safety/gate.js';
import type { AllowlistEntry } from '../safety/allowlist.js';
import { createBashTool, type CommandProcessLog } from '../exec/tool.js';
import { hostInjectRecord } from '../exec/env.js';
import { createTodoTool, foldCurrentTodo, registerTodoInjection } from './todo.js';
import type { TodoEnforcement, TodoItem } from './todo.js';
import { GATE_COMMAND_TIMEOUT_MS } from './todo-gates.js';
import type { DiagnosticsGateQuery, TodoGoalScope } from './todo-gates.js';
import type { DurableSinks } from './durable.js';
import { createDurableSinks, projectedToAgentMessages } from './durable.js';
import { createFsTools } from '../tools/fs.js';
import type { ConversationDriver, OverflowCompactionFace, RunSettled } from './conversation.js';
import { ConversationDriver as ConversationDriverClass } from './conversation.js';

/**
 * 审批弹窗文本（S5 契约篇审批归属行）：归属标签 + approvalId 短形 + 优先级
 * 标记（background 时）——多驱动单输入框下的防串答锚点。根 approval（exec/fetch
 * 服务路）无 ownership，调用方自行拼朴素文本（v1 已知形态）。
 */
function formatApprovalPrompt(req: ApprovalRequest): string {
  const parts: string[] = [];
  if (req.ownership !== undefined) {
    const app = req.ownership.appId ?? 'app';
    parts.push(`[${app}·${req.ownership.sessionId.slice(0, 8)}]`);
  }
  if (req.approvalId !== undefined) parts.push(`#${req.approvalId.slice(0, 4)}`);
  if (req.priority === 'background') parts.push('〔后台〕');
  parts.push(req.summary);
  if (req.reason !== undefined && req.reason !== '') parts.push(req.reason);
  return `${parts.join(' ')}\n批准？`;
}

/**
 * 审批应答三态归一（§8.4 增补 2 落码形态③⑥）：select 原语在场且载荷带推荐
 * 规则草案 → 三选（F10 文案纪律：明示条目内容与永久性）；否则降级 confirm
 * 两态（降级通道无法表达三选时「始终允许」不呈现——呈现纪律）。'' 无效答案
 * 保守 reject：授权面宁可重问不可放行（fail-closed 同判）。导出供回归锁直测。
 *
 * channels 批刀 A：primitives 面扩可选 signal（与 UiService 同型——chat 件
 * 不 import channels 类型面，结构同型即可）——转发给 confirm/select 的撤销
 * 信号；abort 收场值（confirm→false / select→''）走既有保守分支（false→
 * reject、''→降级 confirm 两态），零新词汇。
 *
 * interrupt 小刀：保守收场值 **且** opts.signal.aborted → 返回 'cancel'
 * （诚实落账：run 打断收场非用户拒绝；waterfall 落 'cancel' → outcome
 * 'cancelled' → decided 'cancel'，零新词）。正向答案先胜照常（用户真答了
 * 就认）；竞速败腿同判但值被 race 丢弃，无污染。
 */
export async function answerApproval(
  req: ApprovalRequest,
  primitives: {
    readonly confirm: (text: string, opts?: { readonly signal?: AbortSignal }) => Promise<boolean>;
    readonly select?: (
      message: string,
      choices: readonly { value: string; label: string }[],
      opts?: { readonly signal?: AbortSignal },
    ) => Promise<string>;
  },
  opts?: { readonly signal?: AbortSignal },
): Promise<'approve' | 'reject' | 'always' | 'cancel'> {
  const { select } = primitives;
  if (req.suggestedEntry !== undefined && select !== undefined) {
    const entry = req.suggestedEntry;
    const answer = await select(
      formatApprovalPrompt(req),
      [
        { value: 'approve', label: '仅批准本次' },
        {
          value: 'always',
          label: `始终允许（条目 ${entry.tool} ${entry.pattern}——跨会话永久生效，可经 /allowlist 移除）`,
        },
        { value: 'reject', label: '拒绝' },
      ],
      opts,
    );
    if (answer === 'approve' || answer === 'always') return answer;
    if (answer === 'reject') return 'reject';
    // ''（撤销收场保守值）且 signal 已 abort：run 打断/竞速败腿收场——'cancel'，
    // 不再降级发第二条 confirm（预置 aborted 的 confirm 同步收场 false，只会
    // 把 'cancel' 换皮成 'reject'——撤销面在主路面复活的时序洞）
    if (opts?.signal?.aborted) return 'cancel';
    // ''（通道无法表达三选或输入无效）：**降级 confirm 两态**——「始终允许」
    // 不呈现（呈现纪律），但 approve/reject 决不因降级丢失（宁可重问不可静默拒）
  }
  const confirmed = await primitives.confirm(formatApprovalPrompt(req), opts);
  if (confirmed) return 'approve';
  // false 保守值 + 撤销信号已 abort：'cancel'（同判据——打断非拒绝）
  return opts?.signal?.aborted ? 'cancel' : 'reject';
}

/**
 * 对话应用 id（apps/chat.app.yaml 清单的 id——回落链锚点 + 字面量共用源）。
 * 组装批（2026-08-30）起默认应用 = berrycode（清单 default 键解析，契约篇 §5.4
 * 默认应用键条款）；chat 保持回落链第二跳锚点——卸默认应用后系统仍有可对话入口。
 */
export const CHAT_APP_ID = 'chat';

/**
 * 审批超时预算（daemon 刀一·P2 A2 案缺省值）：无 TUI 应答腿形态（daemon）ask
 * 30min fail-closed 落 'unavailable'——「明早接着批」止于首个夜间审批的诚实
 * 语义（run 吊死更糟）；测试经 ChatAppDeps.approvalTimeoutMs 收短注入。
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* ctx.agent 服务面（自 agent-service.ts 迁入——attach 退役后服务与     */
/* 驱动同件构造，无游离态；类型面公开导出不变，消费方局部结构面免改动） */
/* ------------------------------------------------------------------ */

/** sendUserMessage 可选项（骨架篇 §9.3 签名） */
export interface SendUserMessageOptions {
  /** 注入归因（会话篇 §3.1 dsh-8 词汇——如 'app:goal'）；缺省不落字段（读侧视为 'user'） */
  readonly source?: MessageSource;
  /**
   * 归因键值对（骨架篇 §6.8 刀三轮身份）：source 之外的机器可读归因
   * （goal 续跑轮的 goalId/wakeId/wakePath）。durable 原样落账、驱动 launch
   * 定型为 run 归因（chat 通道 wake 查询面据此路由）——帽投影（wakeGate）
   * 扫描的就是这面。缺省不落字段。
   */
  readonly attribution?: Readonly<Record<string, string>>;
  /** true = 自激唤醒（计入自激预算 maxConsecutiveWakes——闲时 followUp 前 check、超帽降级 inject）；缺省 false（用户手写语义恢复预算） */
  readonly backgroundWake?: boolean;
  /**
   * 显式会话键（S1 三级解析序之首——多驱动路由的目标会话 id）。backgroundWake
   * 投递**必带**（结构性执法——后台触发不依赖调用链语境，缺键即 AGENT_SESSION_KEY_REQUIRED）；
   * 键查无活驱动（未开或已退役）即 AGENT_SESSION_INACTIVE（「退役即停摆」，调用方按码容错跳过）
   */
  readonly session?: string;
  /**
   * run 级工具白名单（第二十四批题3a——无人值守收窄投影，仅 backgroundWake 投递
   * 携带才有意义）：实际开起的 run 批全为 wake 消息时生效，多源取交集；用户消息
   * 混批不收窄。见 ConversationDriver.DeliverOptions.toolFilter。
   */
  readonly toolFilter?: readonly string[];
  /** 定向投递（'steer'/'inject'）——M2+ 预留位，显式携带即 AGENT_DELIVER_AS_UNSUPPORTED */
  readonly deliverAs?: 'steer' | 'inject';
}

/** ctx.agent 服务面（provide('agent') 的形状——应用经 inject 'agent' 结构性取得） */
export interface AgentServiceFace {
  /** 三通道注入（构造 UserMessage 经三级解析序路由到目标驱动；返回 void——steer 入队语义下 run 边界模糊，§9.3 ask 是等待结果的另一面 ⏳） */
  sendUserMessage(content: string | UserMessage['content'], opts?: SendUserMessageOptions): void;
  /** 订阅 run 结算（每个 run 终结派发一次；载荷含归属 sessionId——多驱动下订阅方按其路由；Disposer 注销——挂 ctx.effect 即随应用回卷） */
  onRunSettled(cb: (settled: RunSettled) => void): Disposer;
  /**
   * 闲时重播种（compaction 纵切装配缺口第 4 件——会话篇 §2 增补 3）：以当前
   * 投影重建目标会话驱动时间线（resetTimeline 原位原语）。驱动时间线是内存活
   * 数组（open/resume 仅播种一次），遮蔽生效必须显式重播种——「投影天然生效」
   * 是虚假前提（冷读 B-1）。run 进行中 / 条目缺位 / 已退役返回 false（调用方
   * 记账 pendingReseed 下次 run 边界重试）。
   */
  reseedTimeline(sessionId: string): boolean;
}

/* ------------------------------------------------------------------ */
/* S1 注册表面（DriverEntry / DriverRegistry / FrontHost / ChatRuntime） */
/* ------------------------------------------------------------------ */

/**
 * 展示信封（S3 契约篇 §5.4：归属是宿主展示层概念，不进 loop 契约）——
 * 驱动裸事件 + 本会话键。FrontHost 转接驱动时内部包一层补键；信封在宿主壳
 * 接线处即拆开分流（聚焦者全渲染 / 非聚焦者摘要行），channels 层不见此类型。
 */
export interface SessionEventEnvelope {
  /** 事件归属会话（转接层补键——驱动 emit 裸事件无归属概念） */
  readonly sessionId: string;
  /** loop 活体事件（十型零动） */
  readonly event: AgentEvent;
}

/** 前台展示消费者（S3：收信封——驱动面 `AgentEventSink` 保持裸事件，两界在转接层缝合） */
export type FrontDisplaySink = (envelope: SessionEventEnvelope) => void;

/**
 * 注册表条目：一个已开驱动 + 它的全部会话资产。
 * retired 后 session/durable **保留**（迟到结算继续落原会话账——防新会话
 * 接管后旧结算写错账/seq 撞号），驱动仅停摆（投递降 inject 只留审计）。
 */
export interface DriverEntry {
  /** 归属会话（活对象——事件活日志/投影读数共用） */
  readonly session: Session;
  /**
   * 本条目应用域键（域键升级批，契约篇 §5.4「域键升级（appId 批）射面细化」）：
   * open 时从 open({app}) 定型（缺省 chat 域；存量 NULL 会话 resume 按投影入 chat
   * 域）。tools_change 应用键路由比对与 fs+bash 驱动层注册的第二键同源此字段。
   */
  readonly appId: string;
  /** 本会话 durable 三路 sink（直连——handle 半边不经任何转发壳，随条目生死） */
  readonly durable: DurableSinks;
  /** 本条目是否续接既有会话（boot resume 判定——goal 降级触发器等消费） */
  readonly resumed: boolean;
  /** 会话驱动（run 编排 + 通道宿主面） */
  readonly driver: ConversationDriver;
  /** 件控制面（writeHeader 落账 + refreshTools/rematerialize 两刷新口——组合根 ⑧ 接线遍历调用） */
  readonly controls: ChatControls;
  /**
   * 本条目域层工具注销器集合（S2 fs 迁域 + S5 bash 迁域：fs 四名 + bash 五名带
   * 本会话域键注册进 tools 注册表域层；retire 回卷——「退役即停摆」的工具面
   * 半边，防注册表域层随 /new 泄漏累积）
   */
  readonly disposeDomainTools: () => void;
  /**
   * 本条目 fresh 装配作用域回卷器（S5：审批/守门行/管道/answerer 四件挂 fresh
   * ctx——retire 时 dispose 一次回卷；session/durable 保留的原语义不变）
   */
  readonly disposeScope: () => void;
  /** request/header 落账状态（per-entry——差分基线与首快照名分互不串档） */
  readonly headerState: { last?: string; next: 'initial' | 'resume' | 'change' };
  /** 是否已退役（true = 停摆：投递降 inject、续跑 INACTIVE、open 同 id 幂等返回） */
  retired: boolean;
}

/**
 * 会话驱动注册表（S1 单真相——组合根分配、chat 件填充与消费）。
 * 三个取数口对应骨架篇 §9.3 读点解析序的三个前缀段：
 * - `chained()`：仅调用链（onUsage 计量「无链不落账只 debug」的取数口）；
 * - `routed()`：链 → 注册表 → 前台聚焦（ctx.sessions 缺省路由 / 子代理 fork 源 / goal 工具命令面）；
 * - `focused()`：仅前台聚焦（TUI 命令路由 / runtime 投影 getters）。
 */
export interface DriverRegistry {
  /** 全部条目（含退役保留者——关停遍历/审计面；顺序 = 开启序） */
  readonly entries: ReadonlyMap<string, DriverEntry>;
  /** 前台聚焦指针（唯一可变路由状态——open 切换；只读视图） */
  readonly focus: { readonly sessionId: string | undefined };
  /** 前台聚焦条目活取值（未开过/聚焦点缺位 undefined） */
  focused(): DriverEntry | undefined;
  /** 调用链命中条目（无链/未命中 undefined——不做 focus 回退） */
  chained(): DriverEntry | undefined;
  /** 路由解析条目（链 → 注册表 → 前台聚焦——缺省路由的完整序） */
  routed(): DriverEntry | undefined;
  /**
   * 开一个驱动（一条龙：会话选择→durable 直连→session_start→盖章→header 名分→
   * 驱动构造→前台转接→切 focus）。同 id 活条目幂等返回（防 Map.set 覆盖泄漏
   * 订阅/双写者）；无持久层返回 undefined（persist:false 防御位）。
   * @param options.resume true = 按 cwd 续接最新；string = 显式 id 续接；缺省 = 新建
   * @param options.app 应用清单（第三纵切进入面——/app <id> 进入与 CLI --app 两路；
   *   缺省 = chat 域。生效面 = 会话打标 / 严格域续接 / agent 装配默认位 / 审批预设）
   */
  open(options?: { readonly resume?: boolean | string; readonly app?: AppManifest }): DriverEntry | undefined;
  /**
   * 退役条目（/new 换新后的旧条目停摆）：retired=true + driver.retire()（仅
   * abort——quit promise 不 resolve，防误触前台退出聚合）。聚焦驱动 run 中拒绝
   * （防御位——/new 编排已先行准入判据）；查无/已退役返回 false。不动 focus
   * （切换是 open 的职责，调用方编排先后序）。
   */
  retire(sessionId: string): boolean;
  /**
   * 切前台（S3 契约篇 §5.4）：活条目在场即切 focus（通知订阅者）；退役/查无
   * false。**零准入拒**——不 abort 不动 run，run 中切入切出均合法（与 /new 的
   * busy 拒对照：切换纯展示路由，run 各自时间线不受影响）。
   */
  switchTo(sessionId: string): boolean;
  /**
   * 订阅 focus 变化（S3：通知机制落 registry——focus 指针所在处，FrontHost 纯
   * 委托）。三写点各通知恰一次：open 新开 / open 幂等命中既有条目 / switchTo；
   * **同值写零通知**（切到已聚焦会话 = 无变化，防无谓清屏重画）。Disposer 注销。
   */
  onFocusChange(cb: (sessionId: string) => void): Disposer;
  /**
   * 订阅条目集变化（daemon 刀一·契约篇 §6.8：daemon.json heldSessions 租约
   * 登记的驱动面）。两写点各通知恰一次：open 新条目入表 / retire 条目退役；
   * 幂等命中（open 同 id）/ 查无不通知。订阅者收到信号后自行从 entries 派生
   * 持有集（非退役条目 ∪ 退役在飞条目——retire 拒绝 run 中条目，故该派生式
   * 的变化点恰为 open/retire 两处，isRunning 迁移不改持有集）。违约隔离同
   * onFocusChange。Disposer 注销。
   */
  onEntriesChange(cb: () => void): Disposer;
}

/**
 * 前台宿主 façade（S1——通道宿主面 + 展示/结算/退出三腿的聚焦路由；S3 信封化
 * + 退出扇出）：TUI 起屏持它一次即跨 /new 稳定（不随驱动对象更替断流）；无驱动
 * 形态（overlay 禁用/persist:false）submit 静默、requestQuit 直接聚合退、settle 即回。
 */
export interface FrontHost {
  /** 普通用户消息（路由前台聚焦驱动的 submit；无驱动 no-op） */
  submit(text: string): void;
  /**
   * 前台聚焦指针只读视图（S3：registry focus 的纯委托——宿主壳信封分流判据
   * `envelope.sessionId === front.focus.sessionId` 读这里，不经手 registry）
   */
  readonly focus: { readonly sessionId: string | undefined };
  /**
   * 请求退出（S3 退出扇出：聚焦驱动 requestQuit + **其余活驱动直接 abort**——
   * /app new 使「退出时有后台 run」成常态，abort 扇出后 settle/shutdown 必达；
   * 无驱动直接 resolve 聚合 promise——壳照启可退）。
   */
  requestQuit(): void;
  /**
   * 用户中断分档路由（S6 形态④：Ctrl+C 多驱动语义——骨架篇 §1.3 S6 段）：
   * 判活（非退役）条目数 N≥2 → 聚焦驱动 `interrupt()`（abort 在飞 run、不退
   * OS；idle 时 no-op **不回落 requestQuit**）；N≤1 → `requestQuit()`（单驱动
   * 维持原语义：首次 SIGINT = 优雅退出全序列）。分档单点在此——channels 薄层
   * 与外部信号入口不知驱动数，两路同汇本面。
   * @returns 被打断 run 的结算 promise（idle/单驱动路即回——外部 SIGINT 路
   *          旗标「了结」判据，形态⑥）
   */
  interrupt(): Promise<void>;
  /** 退出聚合 promise（任一驱动 requestQuit 即 resolve——/quit 命令路/TUI 信号路同汇） */
  readonly quit: Promise<void>;
  /**
   * 注册展示消费者（S3 信封化：收 `{sessionId, event}` 信封——记入转接表 + 当前
   * 聚焦驱动即时转接；后续 open 的新驱动全量转接。非聚焦条目〔后台活/退役迟到〕
   * 的事件照达——宿主壳拆信封分流，摘要行即审计面）。
   */
  addDisplay(sink: FrontDisplaySink): void;
  /** 等待**全部活驱动**在跑的 run 结算（S3 扇出：退出序列收尾等所有活 run；无活条目即回） */
  settle(): Promise<void>;
}

/** chat 件构造产物（S1 bundle：件模块 + 注册表 + 前台宿主——三者同工厂同生命周期） */
export interface ChatRuntime {
  /** 件模块（builtins 注册表 `builtin:chat` 行） */
  readonly module: BuiltinAppModule;
  /** 会话驱动注册表（组合根侧路由/遍历消费） */
  readonly registry: DriverRegistry;
  /** 前台宿主 façade（TUI 入口消费——恒在，无驱动时 no-op 形） */
  readonly front: FrontHost;
}

/* ------------------------------------------------------------------ */
/* 件 ↔ 组合根 控制面                                                   */
/* ------------------------------------------------------------------ */

/**
 * 件暴露给组合根的控制面（per-entry——组合根 tools_change/prompts_change 等
 * 装配接线遍历非退役条目调用；/new 各复位全随 open() 新条目内化，控制面收窄）。
 */
export interface ChatControls {
  /** 落 request/header 快照（diff 语义内建——仅组装参数变化才落；/reload 收口与窗口外变更走此口） */
  writeHeader(): void;
  /**
   * 重算本条目 loop 工具快照（S2 per-entry——**组成面** `compositionFor(本会话)`
   * 原位刷新；域键升级批从 listFor 改组成面读）。tools_change 载荷带 driver 键 =
   * 只该驱动条目刷新；带 domain 键 = 该应用全部条目刷新；缺省 = 全局层变更全部
   * 条目刷新
   */
  refreshTools(): void;
  /**
   * 重物化本条目系统提示词（S2 per-entry——prompts/skills 变更与 /reload 时点，
   * 全部非退役条目各自重物化；/new 不再全局 rebuild——open 即新纪元）
   */
  rematerialize(): void;
}

/** 件构造依赖（装配期活闭包——官方件 = 宿主装配特权，不新开 ctx 服务名） */
export interface ChatAppDeps {
  /**
   * 应用面解析器（组装批默认应用键，契约篇 §5.4 默认应用键条款）：open 缺省位
   * 的默认应用解析 + string resume 的归属域查表。组合根注入（resolveDefaultApp
   * 纯函数 + officialApps/appGaps 活闭包——per-open 活取：缺场随当下组合树
   * 投影，/reload 换件后即时反映于下一次 open）。
   */
  readonly resolveApps: {
    /**
     * 默认应用解析：在场带标清单 > 回落 chat；undefined = 默认解析无果
     * （兜底态——两跳皆断，open 防御降级不认领任意在册应用）。
     */
    readonly resolveDefault: () => AppManifest | undefined;
    /**
     * 按 id 查在场清单（缺场隔离的应用返回 undefined——string resume 取目标
     * 会话归属域用，契约篇 m4：查无 = 目标应用缺场，装配面维持解析域清单）。
     */
    readonly resolveById: (id: string) => AppManifest | undefined;
  };
  /** 启动会话策略原样透传（true = 按 cwd 续接最新；string = 显式 id；缺省 = 新建） */
  readonly resumeSession?: boolean | string;
  /**
   * CLI --app 解析产物（第三纵切进入面）：本进程启动即进入的非缺省应用清单。
   * boot 首驱动以此开域（会话打标/严格域续接/agent 装配默认位/审批预设）；
   * 运行期 /app <id> 进入与 /new 透传（D1-d：聚焦条目 app 同应用新开——组合根
   * startNewSession 查表传入）走 open({app}) per-open 路径（互不混用——/app new
   * 恒默认应用域：开新+驻留是另一动词，两动词 app 归属不同是字面事实非矛盾）
   */
  readonly app?: AppManifest;
  /** 持久层（缺省 = persist:false 诊断面——件降级空转，不起驱动不供 agent） */
  readonly persistence?: Persistence;
  /** 根作用域（S1：open 运行于 /new 等任意时点——应用 apply ctx 已随 /reload 回卷，Ring 1 服务/总线 emit/logger 恒走根） */
  readonly rootCtx: ContextScope;
  /**
   * 守门行传导判据（与 subagent 子代理装配共用组合根单件——safety/gate.ts
   * GateRowFilter）：S5 fresh 驱动作用域不 fork 根，根总线应用行（如 checkpoint
   * 快照监听）不传导就结构性进不了本驱动管道——open 内 fresh 装配时传导
   * pre+post 两段（会话开启时点冻结，详见接线处注释）。
   */
  readonly gateRowFilter: GateRowFilter;
  /** 工作区根（latestSessionId 归属键 / 会话 cwd） */
  readonly workspace: string;
  /** 模型标识（loop 配置 + request/header 快照腿） */
  readonly model: string;
  /** 沙箱档（request/header 快照 config 腿） */
  readonly sandboxMode: SandboxMode;
  /**
   * 沙箱档显式标记（第三纵切 grants.approval 优先序）：CLI/装配显式设档
   *（--read-only 等）时 true——应用审批预设**不覆盖**显式档（预设是申请不是
   * 夺权）。缺省 false = 档位来自全局缺省，应用预设可生效。
   */
  readonly sandboxModeExplicit?: boolean;
  /** streamFn（loop 配置——组合根 ④ 产物） */
  readonly streamFn: StreamFn;
  /**
   * 瞬态错误判定（S4 前置债批——llm/recovery 桶表 transient 位经装配注入：
   * chat 拓扑边不含 llm，判定器走 ctx.llm.classifyError 服务面）。缺省恒
   * false（驱动 auto-retry 关闭——诊断装配/旧装配形态直通）。
   */
  readonly isTransientError?: (message: AssistantMessage) => boolean;
  /**
   * 溢出错误判定（第四十五批溢出兜底——llm 服务面 isContextOverflowFor 经装配
   * 注入：chat 拓扑边不含 llm）。携模型参数——静默溢出/length 零输出两路依赖
   * contextWindow，窗口按当轮效值模型目录活取。缺省恒 false（溢出恢复关闭——
   * 诊断装配形态直通，与 isTransientError 同款语义）。
   */
  readonly isOverflowError?: (message: AssistantMessage, model: string) => boolean;
  /** convertToLlm（loop 配置——组合根 convert 产物） */
  readonly convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  /**
   * context_transform 桥（经根总线 waterfall——应用监听随 /reload 更替，桥本体用
   * 根 ctx 恒存活）。双参（S1，契约篇 §2.2）：sessionId 随批穿透给 handler——
   * 差分/检索等 handler 可按归属会话路由落账
   */
  readonly transformContext: (messages: AgentMessage[], sessionId: string) => Promise<AgentMessage[]>;
  /**
   * user_input 桥（契约篇 §2.2 增补 7②，2026-08-27 P1-2：经根总线 waterfall +
   * 挂起钟——桥本体用根 ctx 恒存活，与 transformContext 同款注入形态）。驱动
   * 在批消费位逐条调用；sessionId 由件闭包绑定给 handler（多驱动归属参数）
   */
  readonly transformInput: (message: AgentMessage, sessionId: string) => Promise<AgentMessage>;
  /**
   * turn_stopping 桥（契约篇 §2.2 增补 7①，2026-08-27 P1-2：经根总线 serial +
   * 挂起钟）：每次 runWithRetry 结算后派发（载荷 { sessionId, stopReason }）；
   * 续跑 = handler 内经会话面 deliver 投递（零新返回值）
   */
  readonly onTurnStopping: (payload: { sessionId: string; stopReason: string }) => Promise<void>;
  /**
   * 进模型步前复验桥（骨架篇 §6.8 刀三 T7-A）：装配层把根总线 agent_pre_step
   * waterfall + 挂起钟包装注入（组合根按 sessionId 桥接）。**可选**——缺省
   * 不复验直通（诊断装配/测试 fixture 零改动）；生产装配恒传。
   */
  readonly onPreModelStep?: (sessionId: string) => Promise<PreStepDecision | undefined>;
  /**
   * 系统提示词物化器（S2 per-entry 替换 getSystemPrompt 全局活视图——契约篇
   * §1.3 落码形态①）：`[基座, 技能渐进披露, 具名段]` 在**本条目时点**求值拼接。
   * 每条目 open 各自物化（新纪元）；prompts/skills 变更与 /reload 重物化全部
   * 非退役条目。sessionId 透传 prompts.materialize（会话键控段冻结该会话基线）；
   * 缺省 = 诊断物化（dump-config 等）
   */
  readonly materializeSystemPrompt: (sessionId?: string) => string;
  /**
   * 可写根推导器（S2 fs 迁域随迁 deps——safety/roots 同源产物宿主构造注入）：
   * 本条目 fs 族 fence 数据源。观察态 per-driver 语义：每驱动一套 createFsTools
   * （「读过什么」互不可见——A 读过不代表 B 盲写合法）
   */
  readonly writableRoots: () => string[];
  /** sandbox 档事实盖章（内核守门面实现——dedup 内建；件在每次会话边界调用；mode = 本驱动效值，缺省全局档） */
  readonly stampSandboxFacts: (session: Session, mode?: SandboxMode) => void;
  /**
   * 本进程主 loop 花销记账道（缺省 'foreground'）。tick 唤起入口（argv
   * --background）声明 'background'——席 13 第二刀 blocker 修：tick 子进程
   * 轮入 background 道，canAfford 读的账才收到 tick 烧的钱。进程会话级声明
   * （详见 chat/durable.ts createDurableSinks 同名参数注记）
   */
  readonly usagePriority?: 'background' | 'foreground';
  /**
   * 审批档（S5 契约篇审批归属行：组合根 `opts.approvalPolicy`〔CLI 旗标唯一
   * 来源〕同值经 deps 传入——v1 全驱动同档，per-app 档面挂应用面后续纵切）。
   */
  readonly approvalPolicy?: ApprovalPolicyMode;
  /**
   * 审批应答面（S5 冷读闸 F1：fresh 作用域 answerer 绑的 confirm——组合根
   * `opts.interactive` 时注入 ui.confirm；缺省不传 = 本驱动 ask 全线
   * unavailable〔fail-closed〕，与 headless 无 answerer 纪律同构）。刀 A：
   * 签名与 UiService.confirm 同型（含可选 signal——竞速败腿撤销透传；组合根
   * 注入闭包必须真转发 opts，非仅 arity 兼容）。
   */
  readonly confirm?: (text: string, opts?: { readonly signal?: AbortSignal }) => Promise<boolean>;
  /**
   * 三选原语（§8.4 增补 2 落码形态⑥——TUI 审批三态化的 select 面）：组合根
   * `opts.interactive` 时注入 ui.select（结构同 UiChoice——chat 件不依赖
   * channels 类型面，与 confirm 同注入风格）。缺省不传 = 载荷带草案也降级
   * confirm 两态（降级通道无法表达三选时「始终允许」不呈现——呈现纪律）。
   * 刀 A：同型扩可选 signal（同 confirm）。
   */
  readonly select?: (
    message: string,
    choices: readonly { value: string; label: string }[],
    opts?: { readonly signal?: AbortSignal },
  ) => Promise<string>;
  /**
   * web 应答腿（刀三 claim 竞速注入，契约篇 §6.8 刀三条）：answerer 在 TUI
   * 原语之外与 web 审批卡竞速——先胜者即裁决，败腿结算丢弃。组合根注入
   * （闭包读晚绑 holder：webui 行未开面/已卸载 = 返回 undefined = 纯 TUI 腿
   * 原语义）。chat 不 import webui——结构函数键（WebuiApprovalClaim 词面）。
   * 遗漏大扫 20260902-b #2：可选 signal 透传（run abort 与竞速败腿收束汇入
   * 的同一撤销面）——登记簿 abort 时以 'cancel' 结算本腿（daemon web-only
   * 形态的唯一打断收场路），返回值域相应并 'cancel'（宿主动作结算非用户应答）。
   */
  readonly webAnswer?: (
    req: ApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<'approve' | 'reject' | 'always' | 'cancel'> | undefined;
  /**
   * web 应答腿在场判据（daemon 刀一·M2：answerer 注册闸第二支——晚绑 holder
   * 在场即注册。闭包读组合根晚绑 approvalClaim holder（webui 行未开面/已卸载 =
   * false），**勿用 webAnswer 键存在性**（组合根恒传闭包，键恒在恒真）。闸扩
   * 的效果：daemon 形态（无 TUI confirm）也注册 answerer——审批不再全线
   * unavailable，web 卡可应答；根路（interactive）闸不动。
   */
  readonly webAnswerActive?: () => boolean;
  /**
   * 在场 SSE 连接计数（daemon 刀二·P2 armed 判据数据源，契约篇 §6.8）：
   * ask 时点活取——>0 = 有持 token 的活连接在场（attach/SPA/监控尾），超时
   * 降发腿不武装（人在场）；=0 = 无人在场才武装 30min fail-closed。组合根
   * 闭包 webui attachedCount（缺席 = 0 计）。chat 不 import webui——结构
   * 函数键，与 webAnswerActive 同族。
   */
  readonly webAttachedCount?: () => number;
  /**
   * per-ownership 未决审批帽判据（daemon 刀一：~10/owner 帽满即时收场
   * 'unavailable'——防无附着应答腿的形态被批量 ask 堆积未决卡）。组合根闭包
   * webui approvals 簿 pendingCountBy（缺席 = 无帽面恒 false）；ownerAppId
   * undefined = 宿主桶（根路/无域审批的归宿）。
   */
  readonly webApprovalCapExceeded?: (ownerAppId: string | undefined) => boolean;
  /**
   * 会话租约守卫（daemon 刀一·会话篇 §6.5 条：撞他进程持有会话拒开 + submit
   * 指引）。true = 该会话被**他进程**（活 daemon）持有 → open 拒（warn + 返回
   * undefined）；登记面非锁，第二防线 = 库 cursor/incarnation 护栏。组合根闭包
   * daemon.json heldSessions + 排自身 pid；非 daemon 形态不传 = 无守卫。
   */
  readonly heldElsewhere?: (sessionId: string) => boolean;
  /**
   * 审批超时预算毫秒（daemon 刀一·P2 A2 案：无 TUI 应答腿形态 ask 30min
   * fail-closed 落 'unavailable'——run 吊死更糟，这是设计语义）。缺省 30min；
   * 测试收短注入。仅 `confirm === undefined`（无 TUI 腿）时 armed——TUI 在场
   * 即人在场，不设钟。
   */
  readonly approvalTimeoutMs?: number;
  /**
   * 「始终允许」条目写入面（§8.4 增补 2 落码形态③织入位）：answerer 返回
   * always 且载荷带草案时经 approval 服务回调——组合根接 AllowlistStore.add
   * （幂等）。缺省不传 = 本驱动 always 面关闭（视同 approve，零副作用）。
   */
  readonly persistAllowlist?: (draft: AllowlistDraft) => void;
  /** 沙箱服务（S5 bash 迁域：def 构造原料——confine 纯包装面，与 ctx.exec 同源实例） */
  readonly sandbox: SandboxService;
  /**
   * 跨会话 allowlist 活数组取值器（S5：守门行 per-driver 同源——返回组合根
   * AllowlistStore 的同一活数组引用，/allowlist 命令原地改零重装；与根守门行
   * 同一数据源 = 「每份 gate 语义等价全局」的 v1 前提）。
   */
  readonly allowlist: () => readonly AllowlistEntry[];
  /**
   * 命令进程登记簿（契约篇 §6.6 子进程治理条 exec 腿，2026-08-29 critic #1）：
   * 透传给 bash 工具件——spawn 即登记、净退即删，宿主猝死后由启动期孤儿清扫
   * 认领树杀。组合根注 mcp ChildRegistry 适配器。
   */
  readonly commandLog?: CommandProcessLog;
  /**
   * goal↔chat↔lsp 组合根通道窄面（第三十九批刀二计划态跨轮/gates 条，冷读
   * CR-11）：goal 段查询（fold 边界 + gates 判段）+ todo fold 查询注册（goal
   * 件计划态投影消费）+ LSP 诊断查询（diagnostics gate 迟到注入）。chat 不
   * import goal——结构函数键（GoalChannel 的结构子集），组合根接线点编译期
   * 即验。缺省不传（诊断装配）= 通道面缺席：fold 恒 run-scoped、gates 判非
   * goal 段（扩字段申报即拒）、diagnostics gate 申报即拒——各消费方诚实降级。
   */
  readonly goalChannel?: {
    /** goal 段查询（miss = 非 goal 段——三态同面：件未装载/已卸/无 active 行） */
    readonly goalScopeFor: (sessionId: string) => TodoGoalScope | undefined;
    /** todo fold 查询注册（chat 件 → goal 件计划态投影/open 项否决的数据面） */
    readonly registerTodoFold: (query: (sessionId: string) => readonly TodoItem[] | null | undefined) => Disposer;
    /**
     * wake 归因查询注册（刀三轮身份反向腿——goal 件工具 currentWakeId / 续跑
     * 判定 attribution 直查消费）：sessionId → 本件驱动刚结算/在跑 run 的归因。
     */
    readonly registerWakeLookup: (
      query: (sessionId: string) => Readonly<Record<string, string>> | undefined,
    ) => Disposer;
    /** LSP 诊断查询（diagnostics gate 判据面——lsp 件 apply 期迟到注入） */
    readonly diagnosticsFor: DiagnosticsGateQuery;
  };
}

/**
 * 构造 chat 官方件 bundle（builtins 注册表 `builtin:chat` 行 + 注册表 + 前台宿主）。
 *
 * 注册表/订阅表/服务面全为 factory 级（跨 /reload 存续）：/reload 销锚只回卷
 * provide 注册（apply 重跑即重挂），驱动条目与结算接线不动——重装载是装载面
 * 变更，不是会话变更。
 */
export function createChatApp(deps: ChatAppDeps): ChatRuntime {
  /* ---- factory 级状态（进程生命周期） ---- */
  /** 驱动注册表本体（开启序保序——Map 插入序即遍历序） */
  const entries = new Map<string, DriverEntry>();
  /** 前台聚焦指针（可变属性槽——open 切换；类型面经 DriverRegistry.focus 只读暴露） */
  const focusState: { sessionId: string | undefined } = { sessionId: undefined };
  /**
   * focus 变化订阅表（S3：通知机制落 registry=focus 指针所在处，防跨 façade
   * 隐藏耦合——open 写点在 registry 内，订阅集也归 registry；工厂级跨 /reload 存续）
   */
  const focusListeners = new Set<(sessionId: string) => void>();
  /**
   * 条目集变化订阅表（daemon 刀一：heldSessions 租约登记的通知源——open/retire
   * 两写点通知；订阅者违约隔离与 focusListeners 同款）
   */
  const entriesListeners = new Set<() => void>();
  /** 条目集写点统一路（open 入表后 / retire 退役后各调恰一次） */
  const notifyEntriesChange = (): void => {
    for (const cb of [...entriesListeners]) {
      try {
        cb();
      } catch (err) {
        deps.rootCtx.logger.error('registry.onEntriesChange 订阅者违约（已隔离）', { error: describeError(err) });
      }
    }
  };
  /**
   * 审批归因台账（daemon 刀一·P2）：approvalId → asked 时点 + 胜出腿。
   * asked 时点 = 超时基准（A2 案：无 TUI 腿形态 30min fail-closed 从 ask 起算
   * ——durable 事件 time 同源）；胜出腿 = decided 载荷 via 注入源（'tui' |
   * 'web' | 'timeout'）。decided 读出即删——台账不随长命 daemon 累积。件级
   * 单份（approvalId 全局唯一，跨驱动共享无碰撞）。
   */
  const approvalLedger = new Map<string, { askedAt: number; via?: 'tui' | 'web' | 'timeout' }>();
  /**
   * focus 写点统一路（S3 三写点共用：open 新开 / open 幂等命中 / switchTo）——
   * **同值写零通知**（切到已聚焦会话 = 无变化，防 TUI 无谓清屏重画）；订阅者
   * 违约隔离（与 onRunSettled dispatch 同款——坏订阅不断通知链）。
   */
  const setFocus = (next: string): void => {
    if (focusState.sessionId === next) return;
    focusState.sessionId = next;
    for (const cb of [...focusListeners]) {
      try {
        cb(next);
      } catch (err) {
        deps.rootCtx.logger.error('registry.onFocusChange 订阅者违约（已隔离）', { error: describeError(err) });
      }
    }
  };

  /** onRunSettled 订阅表（工厂级——face 跨 /reload 存续，goal 等消费方重 apply 重订阅不重造表） */
  const subscribers = new Set<(settled: RunSettled) => void>();
  /** 单订阅者派发壳（违约隔离：抛错根 logger 吞掉，不断结算链——根 logger 恒活，不随锚回卷失效） */
  const dispatch = (settled: RunSettled): void => {
    for (const cb of [...subscribers]) {
      try {
        cb(settled);
      } catch (err) {
        deps.rootCtx.logger.error('agent.onRunSettled 订阅者违约（已隔离）', { error: describeError(err) });
      }
    }
  };
  /** ctx.agent 服务面（工厂级单份——provide 随锚回卷/重挂，face 本体与闭包状态存续） */
  const face: AgentServiceFace = {
    sendUserMessage(content, opts = {}) {
      // 预留位执法：定向投递不做半实现（缺省自适应即现行业务所需）
      if (opts.deliverAs !== undefined) {
        throw new AppError(
          AGENT_DELIVER_AS_UNSUPPORTED,
          `sendUserMessage 不支持显式 deliverAs=${opts.deliverAs}（三通道自适应缺省即现行业务所需；定向投递为 M2+ 预留位）`,
        );
      }
      const message: UserMessage = {
        role: 'user',
        content,
        timestamp: Date.now(),
        ...(opts.source !== undefined ? { source: opts.source } : {}),
        ...(opts.attribution !== undefined ? { attribution: opts.attribution } : {}),
      };
      const deliverOpts = { backgroundWake: opts.backgroundWake === true, toolFilter: opts.toolFilter };
      // 三级解析序之首——显式键：查无活驱动即 INACTIVE（退役即停摆；调用方按码容错跳过）
      if (opts.session !== undefined) {
        const entry = entries.get(opts.session);
        if (entry === undefined || entry.retired) {
          throw new AppError(
            AGENT_SESSION_INACTIVE,
            `会话 ${opts.session} 无活驱动（未开或已退役）——显式键指向的会话已停摆`,
          );
        }
        entry.driver.deliver(message, deliverOpts);
        return;
      }
      // 结构性执法（骨架篇 §9.3）：后台唤醒不依赖调用链语境——必须显式带键，
      // 缺即拒（防链/focus 兜底静默错投——后台任务唤醒错会话是审计级事故）
      if (opts.backgroundWake === true) {
        throw new AppError(
          AGENT_SESSION_KEY_REQUIRED,
          'backgroundWake 投递必须携带显式 session 键（后台触发无调用链语义——三级解析序不适用于无人值守路）',
        );
      }
      // 默认路由：调用链 → 前台聚焦（链/focus 命中退役条目照投——deliver 对已
      // abort 驱动自动降 inject，只留审计不开 run；两段全空 = 无任何会话可投，
      // 防御位响亮拒绝）
      const chained = chainSessionId();
      const entry = (chained !== undefined ? entries.get(chained) : undefined) ?? registry.focused();
      if (entry === undefined) {
        throw new AppError(AGENT_SESSION_INACTIVE, '无活会话可投递（注册表空——未开过驱动或 persist:false）');
      }
      entry.driver.deliver(message, deliverOpts);
    },
    onRunSettled(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    reseedTimeline(sessionId) {
      // 条目缺位 / 已退役：停摆会话无时间线可播（false = 调用方记账重试）
      const entry = entries.get(sessionId);
      if (entry === undefined || entry.retired) {
        return false;
      }
      // 投影 → AgentMessage 播种（与 open/resume 播种同一转换源——单一转换源纪律）；
      // resetTimeline 原位原语：run 进行中拒改（false），闲时活数组原位重置
      return entry.driver.resetTimeline(projectedToAgentMessages(entry.session.deriveMessages()));
    },
  };

  /* ---- 前台宿主 façade（工厂级——TUI 持有一次跨 /new 稳定） ---- */
  /**
   * 前台展示消费者转接表（S3 信封化：收信封的 sink；open 新驱动时全量转接——
   * 转接闭包补本会话键，退役驱动保留自己的一份，迟到事件仍达=审计面）
   */
  const frontDisplays: FrontDisplaySink[] = [];
  let resolveFrontQuit!: () => void;
  /** 前台退出聚合 promise：任一驱动 requestQuit 即 resolve（驱动 quit 挂接见 open） */
  const frontQuit: Promise<void> = new Promise((resolve) => {
    resolveFrontQuit = resolve;
  });
  const front: FrontHost = {
    submit: (text) => registry.focused()?.driver.submit(text),
    // registry 焦点指针的只读委托视图（壳分流判据读这里——对象同源，零拷贝）
    focus: focusState,
    requestQuit: () => {
      const focused = registry.focused();
      if (focused !== undefined) {
        focused.driver.requestQuit(); // 聚焦驱动：requestQuit 全语义（abort + resolve quit → 聚合 promise 随之 resolve）
      } else {
        resolveFrontQuit(); // 壳形态（无对话循环）：无驱动可等——直接聚合退
      }
      // S3 退出扇出（冷读 must-fix）：其余活驱动直接 abort——复用 driver.retire
      // 的「仅 abort 不 resolve quit」形态（退出聚合只认聚焦者 requestQuit）；
      // 不标 entry.retired（退出是进程收尾不是会话停摆，迟到结算照落原会话账）。
      // 扇出后 front.settle / shutdown 的 allSettled 必达——后台 run 不再被等成挂死
      for (const entry of entries.values()) {
        if (!entry.retired && entry !== focused) entry.driver.retire();
      }
    },
    // S6 形态④：Ctrl+C 分档——N≥2 打断聚焦驱动当前 run（不退 OS）、N≤1 维持
    // requestQuit 原语义。interrupt 返回被打断 run 的 settle（idle 即回）——
    // 外部 SIGINT 路拿它作旗标「了结」判据（形态⑥：了结即复位，二次 130 只在
    // run 未结算窗口内成立）
    interrupt: () => {
      const active = [...entries.values()].filter((e) => !e.retired);
      if (active.length >= 2) {
        const focused = registry.focused();
        // 分档条件成立但聚焦缺位（竞态窗口）/聚焦 idle：no-op 即回，不回落
        // requestQuit（形态④钉死——多驱动形态 Ctrl+C 永不退 OS）
        if (focused === undefined) return Promise.resolve();
        return focused.driver.interrupt();
      }
      // N≤1（含无驱动壳形态）：维持单驱动原语义（首次中断 = 优雅退出全序列；
      // requestQuit 壳形态直接聚合退）；了结语义上退出序列自会收尾，即回即可
      front.requestQuit();
      return Promise.resolve();
    },
    quit: frontQuit,
    addDisplay: (sink) => {
      frontDisplays.push(sink);
      // 即时转接当前聚焦驱动（转接闭包捕获当时聚焦 id——信封补键在转接层）
      const current = registry.focused();
      if (current !== undefined) {
        const sid = current.session.header.sessionId;
        current.driver.addDisplay((event) => sink({ sessionId: sid, event }));
      }
    },
    // S3 扇出：等全部活驱动的 run 结算（退出序列在 abort 后先等它们收尾再 flush）
    settle: async () => {
      await Promise.all([...entries.values()].filter((e) => !e.retired).map((e) => e.driver.settle()));
    },
  };

  /* ---- 注册表本体（open 一条龙 / retire / 三取数口） ---- */
  const registry: DriverRegistry = {
    entries,
    focus: focusState,
    focused: () => {
      const id = focusState.sessionId;
      return id === undefined ? undefined : entries.get(id);
    },
    chained: () => {
      const chained = chainSessionId();
      return chained === undefined ? undefined : entries.get(chained);
    },
    routed: () => registry.chained() ?? registry.focused(),
    open(options = {}) {
      // persist:false 防御位（apply 已先行判——程序面 open 同防）
      if (!deps.persistence) return undefined;
      const persistence = deps.persistence;
      // Ring 1 工具服务经根取（open 可能运行于 /new 等运行期时点——apply ctx 早随
      // /reload 回卷；ring1Anchor 永存，根 get 恒居值）
      const tools = deps.rootCtx.get<ToolsService>('tools');
      /* -- 应用域钉定（第三纵切进入面 + 组装批默认应用键）：per-open 显式清单
           优先（/app <id> 进入 / CLI --app / /new 透传聚焦条目）；显式缺席 =
           默认应用解析（per-open 活取——deps.resolveApps 闭包读组合根活值）。
           解析无果（兜底态）= 防御降级：warn + 返回 undefined（与无持久层同族
           ——TUI 无驱动起屏、run 退 1），不认领任意在册应用不静默换域。 -- */
      let app = options.app ?? deps.resolveApps.resolveDefault();
      if (app === undefined) {
        deps.rootCtx.logger.warn(
          '默认应用解析无果（带标应用与 chat 均缺场或缺席）——open 防御降级：不认领任意在册应用（dump-config 查诊断）',
        );
        return undefined;
      }
      let appId = app.id;
      /** 本次打开是否经默认位（显式 app 缺席）——域查询 NULL 认领判据（契约篇
       * §5.4：默认入口的域含历史全量；显式进入别家域不认领——判据随默认应用
       * 换人自动正确，非 chat 常量比对） */
      const fromDefault = options.app === undefined;

      /* -- 会话选择（技术栈篇 §5：显式 id / 按 cwd 最新 → 续接；回落新建） -- */
      const targetId =
        typeof options.resume === 'string'
          ? options.resume
          : options.resume === true
            ? // 域查询：默认域含 NULL 存量回退（契约篇 §5.4 默认应用键条款——NULL =
              // 打标机制落地前的存量会话，默认入口的域含历史全量；显式进入的
              // 应用严格域无回退——别家的会话不认领，血缘显式打标的读侧镜像）
              persistence.latestSessionId(deps.workspace, {
                app: appId,
                includeNullApp: fromDefault,
              })
            : undefined;
      // 幂等防御：目标 id 已是注册表条目（活/退役）即不重开——返回既有 + 切 focus。
      // 重开同 id 会造出第二个 Session 实例（单写者护栏/seq 连续性全破），结构上必须挡
      if (targetId !== undefined && entries.has(targetId)) {
        const existing = entries.get(targetId)!;
        setFocus(existing.session.header.sessionId); // S3 写点之二：幂等命中也是 focus 写点（同值零通知）
        return existing;
      }
      // 会话租约守卫（daemon 刀一·会话篇 §6.5 条）：目标被他进程（活 daemon）
      // 持有 → 拒开 + submit 指引（warn 面；完整 UX 指引随刀二）。本表未持有才
      // 判——注册表已持有的走上面幂等防御；登记面非锁，窄竞窗（登记滞后）由
      // 库 cursor/incarnation 护栏第二防线兜住。
      if (targetId !== undefined && deps.heldElsewhere?.(targetId) === true) {
        deps.rootCtx.logger.warn(
          `会话 ${targetId} 被 daemon 持有（heldSessions 租约）——本进程拒开防双写者；` +
            '改用该 daemon 的 submit 面（POST /api/sessions/:id/submit）投递',
        );
        return undefined;
      }
      // 恢复协议语义半边（会话篇 §4）：孤儿配对补 closer——append 即进 write-behind
      //（关停屏障保证落盘），日志闭合后投影才可安全续跑
      let session: Session | undefined;
      let resumed = false;
      if (targetId !== undefined) {
        const loaded = persistence.loadSession(targetId);
        if (loaded) {
          loaded.recoverFromInterruption();
          session = loaded;
          resumed = true;
          /* -- 显式 string resume 的域取目标会话自身归属（组装批冷读 m4，契约篇
               §5.4 默认应用键条款）：entry 打标与 header app 腿按目标会话
               sessions.app 标签（tick 会话投递注入 resumeSession 即此路），而非
               解析域——错标面〔解析域 ≠ 会话标签〕今日同值无实害，语义先钉死。
               标签在场且应用在场 → 改钉（装配面同换：persona 等随目标应用）；
               标签在场但应用缺场 → 打标记血缘（诚实）、装配面维持解析域清单
               （缺场应用给不出装配面，续接是会话层行为）；NULL 标签 → 保持默认
               投影不变。 -- */
          if (typeof options.resume === 'string') {
            const label = persistence.metaOf(targetId)?.app;
            if (label !== undefined) {
              appId = label;
              app = deps.resolveApps.resolveById(label) ?? app;
            }
          }
        }
        // 目标不存在回落新建：启动策略是「续接优先」不是「必须续接」
      }
      // 新建会话打标本应用域（血缘显式打标，不做投影推断——契约篇 §5.4 第 3 条）
      session ??= persistence.createSession({ cwd: deps.workspace, profile: 'default', app: appId });

      /* -- 应用装配默认位 + 审批预设（第三纵切）：进入即生效的静态半边 --
         优先序 = 显式旗标 > 应用预设 > 全局缺省（§5.4 第 4 条：预设是申请不是
         夺权——CLI --read-only 等显式档不被应用预设覆盖；approvalPolicy 的显式
         位即 deps.approvalPolicy 在场性，sandboxMode 因 deps 恒有值另走显式标记） */
      const preset = app?.grants?.approval;
      const effectiveSandboxMode: SandboxMode =
        deps.sandboxModeExplicit === true ? deps.sandboxMode : (preset?.sandboxMode ?? deps.sandboxMode);
      const effectiveApprovalPolicy: ApprovalPolicyMode = deps.approvalPolicy ?? preset?.approvalPolicy ?? 'ask';
      const effectiveModel = app?.agent?.model ?? deps.model;

      /* -- durable 接线（S1 直连：handle/gate/approval 三路全绑本会话——不经转发壳；model 腿供 llm/usage 前台折叠回退值；usagePriority = tick 入口记账道声明） -- */
      const durable = createDurableSinks(session, {
        model: effectiveModel,
        ...(deps.usagePriority !== undefined ? { usagePriority: deps.usagePriority } : {}),
      });
      // session_start（契约篇 §2.2 session 层 emit 行）：会话建立/恢复闭合后必发
      // 一次——经根 ctx emit（总线 runtime 共享，应用锚 on 互通；装载序上 boot 路
      // 本事件先于一切消费方应用的 app/activated，与组合根直发形态等价）。
      // origin 对齐首张 header 的 reason 语义（resume = 恢复闭合含崩溃修复，initial = 新建）
      deps.rootCtx.emit('session_start', {
        sessionId: session.header.sessionId,
        origin: resumed ? 'resume' : 'initial',
      });
      // sandbox 档事实盖章（内核守门面数据 + 应用会话边界时点；dedup 内建——
      // 续接同档不重复落，事件序稳定：session_start → sandbox/mode）。
      // 第三纵切：档值 = 本驱动效值（应用审批预设生效时按预设落事实——五点同源）
      deps.stampSandboxFacts(session, effectiveSandboxMode);
      // 首张 header 名分（续接会话 resume / 新会话 initial——此后变化 change）
      const headerState: { last?: string; next: 'initial' | 'resume' | 'change' } = {
        next: resumed ? 'resume' : 'initial',
      };

      const sessionId = session.header.sessionId;

      /* -- S5 fresh 装配作用域（契约篇 §5.4 第 6 条④形态钉死）：本驱动审批/
           守门行/管道/answerer 四件挂 fresh ctx——fresh 不 fork 根，fresh runtime
           的行表与服务表完全隔离（隔离即过滤的极限形态：本驱动管道的 waterfall
           只见本作用域行，与根全局三件〔exec/fetch 服务路〕各守各面无串台）；
           retire 经 dispose 一次回卷。subagent-factory 每子独立装配的驱动级推广 -- */
      const driverScope = createContext({ name: `chat-driver:${sessionId.slice(0, 8)}` });
      // 审批实例：ownership 闭包织入（装配期——answerer 标签渲染源）+ sink 直连
      // 本会话 durable（S1 直连三路的 approval 路随批收口）+ persistAllowlist
      // 织入（§8.4 增补 2 落码形态③：answerer 应答 always 时写 allowlist 条目，
      // 组合根接 AllowlistStore.add——幂等；缺省不传 = always 面关闭）
      const approval = createApprovalService(driverScope, {
        // 审批档 = 本驱动效值（应用预设 > 全局——显式旗标已在效值计算时胜出）
        // daemon 刀一 sink 包裹：asked 记台账（超时基准）；decided 注 via 归因
        //（answerer 胜出腿先写台账；帽满/双腿皆缺等无腿收场无 via 省字段）
        policy: effectiveApprovalPolicy,
        sink: {
          asked: (payload) => {
            approvalLedger.set(payload.approvalId, { askedAt: Date.now() });
            durable.approval.asked(payload);
          },
          decided: (payload) => {
            const meta = approvalLedger.get(payload.approvalId);
            approvalLedger.delete(payload.approvalId);
            durable.approval.decided(meta?.via === undefined ? payload : { ...payload, via: meta.via });
          },
        },
        ownership: { sessionId, appId },
        ...(deps.persistAllowlist !== undefined ? { persistAllowlist: deps.persistAllowlist } : {}),
      });
      // 守门行：同机制 / 同 allowlist 活数组同源 / 同推导器——「每份 gate 语义
      // 等价全局」的 v1 落地（per-session 换档面落地日须重新成立一次）；
      // 档值 = 本驱动效值（第三纵切：应用预设生效时本会话守门按预设档走）
      driverScope.effect(() =>
        installSafetyGate(driverScope, {
          approval,
          workspace: deps.workspace,
          mode: () => effectiveSandboxMode,
          allowlist: deps.allowlist(),
        }),
      );
      // 管道实例：onGateDecision 直连本会话 durable（gate 落账随驱动归属——
      // 不经组合根转发壳，两服务面〔exec/fetch〕继续走全局管道）
      const basePipeline = createToolPipeline(driverScope, { onGateDecision: durable.gate });
      // 守门行传导（与 subagent-factory ⑤b 同机制单源 safety/gate.ts——挖矿
      // B10「固定行进得了隔离管道、开放行进不去」不对称的**驱动面**收口）：
      // 根总线应用行 pre+post 传导进 fresh 驱动作用域。**首工具调用时点惰性
      // 传导**（非 open 时点）：boot 首驱动 open 发生于 chat 件装载期——早于
      // 后续行（memory/exec/checkpoint…）装载，open 时点快照恒空链；首工具
      // 调用必在 boot 完成后，届时链已全。传导 handler 引用非重注册（闭包仍
      // 捕根作用域、owner/rowId 保真；驱动 dispose 不回卷根行）；首次工具调用
      // 时点冻结：此后根链变化（/reload 等）不回灌本驱动，新会话取新链。
      // execute 段不传导（替换执行体风险大）。once 旗防重——重复传导即链上
      // 重复行（同监听器两拍）。
      let gateLinesConducted = false;
      const driverPipeline: ToolPipelineExecutor = (def, callId, args, signal, onUpdate, origin) => {
        if (!gateLinesConducted) {
          gateLinesConducted = true;
          conductGateLines(deps.rootCtx, driverScope, deps.gateRowFilter);
        }
        return basePipeline(def, callId, args, signal, onUpdate, origin);
      };
      // answerer（S5 冷读闸 F1 修死）：ask 的 waterfall 派发在传入 ctx 的 runtime
      // 上——fresh 作用域必须同作用域注册 answerer，否则本驱动 ask 全线
      // unavailable。ui.confirm 经 deps 注入；弹窗标签/approvalId 短形/优先级
      // 标记在 formatApprovalPrompt 内消费 ownership 载荷
      // 注册闸（daemon 刀一·M2 扩闸）：TUI 腿在场 ∪ web 腿晚绑 holder 在场
      //（webAnswerActive 闭包读组合根晚绑 approvalClaim——**勿用 webAnswer 键
      // 存在性**，组合根恒传闭包恒真）。根路闸（opts.interactive 注 confirm）
      // 不动——headless run 维持全线 unavailable 纪律；daemon 形态（无 TUI
      // confirm）因 web 腿在场获闸，审批不再无人应答。
      if (deps.confirm !== undefined || deps.webAnswerActive?.() === true) {
        const confirm = deps.confirm;
        const select = deps.select;
        const webAnswer = deps.webAnswer;
        driverScope.on(APPROVAL_ANSWER_EVENT, async (req: ApprovalRequest, _next: () => unknown) => {
          // per-ownership 未决审批帽（daemon 刀一）：~10/owner 帽满即时收场——
          // return undefined 走 ask 的 unavailable 路（fail-closed），不排队堆积
          //（防无附着形态被批量 ask 堆成未决山）。无腿收场无 via 归因。
          if (deps.webApprovalCapExceeded?.(req.ownership?.appId) === true) {
            return undefined;
          }
          // 三态归一（草案在场 + select 在场 → 三选；降级 confirm 两态）在
          // answerApproval 纯函数内——回归锁见 plugin.test.ts
          // 刀 A 竞速收束即撤销败腿：per-request controller——race 先胜后
          // finally abort TUI 腿（reason 承载撤销说明文案，经提问队列上撤销
          // 说明行收屏）；TUI 腿先胜时 abort 落在已结算提问 = no-op（任何
          // 结算路径摘监听）；三态降级链（select abort 回 '' → 降级再发
          // confirm）经预置 aborted 同步结算——无第二提问上屏
          const controller = new AbortController();
          // interrupt 小刀：req.signal（发起 run 的取消信号）桥进本 controller
          //（abort 同 reason）——run abort 与竞速败腿收束汇入同一撤销面，ask
          // 不再吊死 runPromise；监听随结算摘除（迟到 abort no-op）
          const detachRunSignal = bridgeApprovalSignal(req, controller);
          // 超时腿（daemon 刀一·P2 A2 案）：无 TUI 腿（daemon 形态）armed——
          // 30min fail-closed，到点 resolve undefined 走 ask 的 unavailable 路
          //（零新词汇）；基准 = asked durable 事件时点（台账侧记，同源）；TUI
          // 腿在场即人在场，不设钟。刀二精化（P2 armed ask 时点判据）：
          // **在场 SSE 连接 >0 也不武装**——有持 token 的活连接（attach/SPA/
          // 监控尾）即人在场，超时降发对在场腿是干扰；=0 才武装（无人应答时
          // 兜底收场）。判据 ask 时点活取（无运行期 arm/disarm 状态机）。
          // setTimeout 单调钟；到点前他腿胜出即 clear。
          const armed = confirm === undefined && (deps.webAttachedCount?.() ?? 0) === 0;
          const timeoutMs = deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
          // approvalId 服务 ask 织入恒在场（asked 载荷类型已非可选）——台账键
          const approvalId = req.approvalId as string;
          const askedAt = approvalLedger.get(approvalId)?.askedAt ?? Date.now();
          let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const tuiLeg =
              confirm !== undefined
                ? answerApproval(
                    req,
                    { confirm, ...(select !== undefined ? { select } : {}) },
                    { signal: controller.signal },
                  )
                : undefined;
            // web 腿（刀三 claim 竞速注入）：晚绑闭包——webui 行未开面/已卸载
            // 返回 undefined = 无此腿（/reload 卸 webui 后 confirm 缺席的注册
            // answerer 走双腿皆缺路）。signal 透传（#2 修死）：controller 是
            // run abort 与竞速败腿收束的同一撤销面——TUI 腿同款单源，web 腿
            // abort 时经登记簿以 'cancel' 结算（不再吊死 run）
            const webLeg = webAnswer?.(req, controller.signal);
            // 超时腿 Promise：胜出即记 via 'timeout'
            const timeoutLeg = armed
              ? new Promise<undefined>((resolve) => {
                  // Math.max 防御：asked 距今已超预算（回放/挂钟跳变）即刻到点
                  timeoutTimer = setTimeout(() => resolve(undefined), Math.max(0, askedAt + timeoutMs - Date.now()));
                })
              : undefined;
            // 腿装配空集（/reload 卸 webui 且无 TUI 腿）：无人可应——undefined
            // 走 unavailable（fail-closed 纪律不变）
            if (tuiLeg === undefined && webLeg === undefined && timeoutLeg === undefined) return undefined;
            // 竞速：各腿标注 via 后赛跑——先胜者的值即裁决、腿名即归因（记台账
            // 供 decided sink 注入）；败腿经 controller.abort 撤销（TUI 腿撤销
            // 说明行）或 durable decided 的丢弃性 resolve 收场（web 腿）
            const tagged: Promise<{
              via: 'tui' | 'web' | 'timeout';
              value: 'approve' | 'reject' | 'always' | 'cancel' | undefined;
            }>[] = [];
            if (tuiLeg !== undefined) tagged.push(tuiLeg.then((value) => ({ via: 'tui' as const, value })));
            if (webLeg !== undefined) tagged.push(webLeg.then((value) => ({ via: 'web' as const, value })));
            if (timeoutLeg !== undefined) tagged.push(timeoutLeg.then((value) => ({ via: 'timeout' as const, value })));
            const winner = await Promise.race(tagged);
            // 胜出腿记台账（保留原 askedAt——decided sink 读出注入 via 后即删）
            const prev = approvalLedger.get(approvalId);
            approvalLedger.set(approvalId, { askedAt: prev?.askedAt ?? askedAt, via: winner.via });
            return winner.value;
          } finally {
            if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
            detachRunSignal();
            // 败腿撤销：竞速已决，controller.abort 收 TUI 腿提问（no-op 场 = TUI
            // 腿先胜/无 TUI 腿）；文案取唯一可观察场景（web 腿先胜撤销 TUI 提问）
            controller.abort('该审批已在网页端应答');
          }
        });
      }

      /* -- fs + bash 工具族驱动层注册（S2 fs 四件 / S5 bash 迁域 + 域键升级批：
         域键解缠——fs+bash 落**驱动层**（键 = sessionId），不是应用清单声明的、
         是驱动基建〔观察态 per-driver + 升权闭包绑本驱动 approval〕；双键同携
         （driver + domain=本驱动 appId）界定碰撞域。升权两参数闭包绑**本驱动
         approval**〔多驱动下 bash 升权 ask 落发起 run 的会话，全局 def 闭包绑
         全局 approval 的归属错挂就此闭合〕；dispose 挂本条目由 retire 回卷。
         可写根推导器随迁本件 deps（与守门行同源产物） -- */
      const fsTools = createFsTools({ writableRoots: deps.writableRoots, workspace: () => deps.workspace });
      const bashDef = createBashTool({
        sandbox: deps.sandbox,
        approval,
        mode: () => effectiveSandboxMode,
        workspaceRoot: deps.workspace,
        // 同一活数组同源（与守门行 deps.allowlist() 同取值器——「始终允许」bash
        // 词干条目在升权裁决免问面消费，§8.4 增补 2 落码形态③）
        allowlist: deps.allowlist(),
        // 宿主主动注入（契约篇 §1.2 第四十四批）：bash 按会话装配即注入本会话
        // id——子进程 APP_SESSION_ID/AI_AGENT 身份披露，词表单源 hostInjectRecord
        hostEnv: () => hostInjectRecord(sessionId),
        // 命令进程登记簿透传（宿主猝死孤儿治理——见 ChatAppDeps.commandLog 注）
        ...(deps.commandLog !== undefined ? { commandLog: deps.commandLog } : {}),
      });
      /* -- 刀二执法依赖束（goal 段词汇/gates 的 todo 执行段执法面，骨架篇
         §6.8）：goal 段查询（组合根通道）+ files gate fence 锚（本条目工作区
         根）+ command gate 执行面（本驱动三段管道 + bash def——守门/审批/
         沙箱/durable 全执法）+ diagnostics 查询面（lsp 件迟到注入）。通道
         缺席（诊断装配）= undefined → 按「无 goal 段」执法（扩字段申报即拒
         ——一致性不因装配形态破缺） -- */
      const todoEnforcement: TodoEnforcement | undefined =
        deps.goalChannel === undefined
          ? undefined
          : {
              scope: () => deps.goalChannel!.goalScopeFor(sessionId),
              workspaceRoot: deps.workspace,
              runCommand: async (command, signal) => {
                // bash 三段管道全执法：origin 'model' 保持模型工具面完整审批/
                // 守门语义（spec「三段管道全执法」——service 面会绕开审批行）；
                // 30s 帽经 bash timeoutMs 参数携带（超上限自动钳制，帽内直通）；
                // 结果适配出 exitCode / isError / text 三信号（gates 分类面）
                const result = await driverPipeline(
                  bashDef,
                  'todo-gate',
                  { command, timeoutMs: GATE_COMMAND_TIMEOUT_MS },
                  signal,
                  undefined,
                  'model',
                );
                const details = result.details as { exitCode?: number } | undefined;
                const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
                return {
                  exitCode: typeof details?.exitCode === 'number' ? details.exitCode : undefined,
                  isError: result.isError === true,
                  text,
                };
              },
              diagnostics: deps.goalChannel.diagnosticsFor,
            };
      const domainDisposers = [...fsTools.tools, bashDef, createTodoTool(session, todoEnforcement)].map((def) =>
        tools.register(def, { driver: sessionId, domain: appId }),
      );
      const disposeDomainTools = (): void => {
        for (const dispose of domainDisposers) dispose();
      };

      /* -- per-entry loop 工具快照（S2：**组成面** = 全局层 ∪ 应用域[本 app] ∪
         驱动层[本会话]——域键升级批从 `listFor(本会话)` 改读 compositionFor（读面
         键义升级后 listFor 键是 appId，fs+bash 住驱动层）；S5 冷读闸 F2：toAgentTool
         显式绑本驱动管道——不传则绑死服务构造时全局管道、per-driver 三件零流量
         静默空转；活数组原位刷新即达 loop，含 run 中途；组合根 ⑧ tools_change
         订阅按载荷 driver/domain 两键路由到 refreshTools --
         应用工具白名单（第三纵切 agent.toolFilter）：include 名单过滤——与
         SubagentStart.toolFilter 同语义，应用声明它的工具面（不在名单即不暴露） */
      const appToolFilter = app?.agent?.toolFilter;
      /** 本驱动可见 def 清单（白名单过滤后）——loop 快照与 header 快照同一来源 */
      const visibleDefs = () =>
        appToolFilter === undefined
          ? tools.compositionFor(sessionId)
          : tools.compositionFor(sessionId).filter((def) => appToolFilter.includes(def.name));
      const toolView: AgentTool[] = [];
      const refreshTools = (): void => {
        // sessionId 绑定（第四十九批，契约篇 §6.10）：per-entry 携带 → 管道第 7 参 →
        // ToolCtx.sessionId——per-session 语境工具（browser 件 context 路由）的路由键
        const fresh = visibleDefs().map((def) => tools.toAgentTool(def, { pipeline: driverPipeline, sessionId }));
        toolView.length = 0;
        toolView.push(...fresh);
      };
      refreshTools();

      /* -- per-entry 系统提示词（S2：open 物化新纪元——串与记忆基线同时点同面
         冻结；rematerialize 是 prompts/skills 变更与 /reload 的重物化口） --
         应用人格追加段（第三纵切 agent.persona）：物化产物尾部追加——rematerialize
         边界后同样追加（应用人格不随 /reload 丢失；与 Profile 追加段同构形态） */
      const appPersona = app?.agent?.persona;
      const withAppPersona = (base: string): string =>
        appPersona === undefined ? base : base === '' ? appPersona : `${base}\n\n${appPersona}`;
      let systemPrompt = withAppPersona(deps.materializeSystemPrompt(sessionId));
      const rematerialize = (): void => {
        systemPrompt = withAppPersona(deps.materializeSystemPrompt(sessionId));
      };

      /* -- request/header 差分化闭包（会话篇 §1.3：仅组装参数变化才落新快照） -- */
      // 落账直用本条目 session（S1 per-entry——不再读全局活槽，条目间基线互不串档）；
      // 两腿读本条目面（S2）：systemPrompt = 本条目物化串；toolSchemas = 本驱动
      // 可见面（域视角含本会话 fs 四名；应用白名单过滤后——header 是「模型实际
      // 拿到什么」的证据快照，与 loop 快照同源，不记未过滤全集）
      const writeHeader = (): void => {
        const payload = {
          // 组装参数快照 = 本驱动效值（应用装配默认位/审批预设生效即如实落账）
          config: { model: effectiveModel, sandbox: effectiveSandboxMode },
          systemPrompt,
          toolSchemas: visibleDefs().map((def) => ({ name: def.name, parameters: def.parameters })),
        };
        const serialized = JSON.stringify(payload);
        if (serialized === headerState.last) return; // 组装参数未变——不落新快照
        // app 腿在序列化基线之外追加（会话域打标的载荷腿——会话内恒定，不参与 diff；
        // 与 sessions.app 同源，血缘显式打标的证据腿，契约篇 §5.4）
        session.append('request/header', { ...payload, app: appId, reason: headerState.next });
        headerState.last = serialized;
        headerState.next = 'change';
      };

      /* -- 驱动构造（活数组上下文 + steering/followUp 共用队列 + 调用链包裹） -- */
      // 续接会话：历史投影回读作时间线种子（恢复协议已补齐闭合——投影无敞开 turn）
      const messages: AgentMessage[] = resumed ? projectedToAgentMessages(session.deriveMessages()) : [];
      const driver = new ConversationDriverClass({
        sessionId,
        context: {
          // getter 活视图：rematerialize 重物化后 loop 每次模型请求取到新串
          get systemPrompt() {
            return systemPrompt;
          },
          messages,
          tools: toolView, // 本条目活数组（refreshTools 原位刷新）
        },
        loopConfig: {
          streamFn: deps.streamFn,
          model: effectiveModel,
          convertToLlm: deps.convertToLlm,
          // context_transform 桥（契约篇 §2.2 增补 5② + S1 双参）：loop 私有配置
          // 回调桥为根总线瀑布，sessionId 随批穿透给 handler（差分/检索按会话路由）
          transformContext: (batch) => deps.transformContext(batch, session.header.sessionId),
        },
        // user_input / turn_stopping 两钩子桥（增补 7①②，P1-2 兑现）：sessionId
        // 由件闭包绑定（与 transformContext 同款形态）——驱动的批消费位只管调
        transformInput: (message) => deps.transformInput(message, session.header.sessionId),
        onTurnStopping: (payload) => deps.onTurnStopping(payload),
        // 进模型步前复验桥（刀三 T7-A）：可选 deps（诊断装配缺省不复验——恒
        // Promise 形态，缺席 = resolve(undefined) 放行）；组合根注入的是根总线
        // agent_pre_step waterfall + 挂起钟包装
        onPreModelStep: async () => deps.onPreModelStep?.(session.header.sessionId),
        // durability 屏障面（刀三⑤）：后台 run 每模型步前 flush 本会话——无持久
        // 层形态不传（驱动侧缺省零屏障）
        ...(deps.persistence !== undefined ? { flushSession: (sid: string) => deps.persistence!.flush(sid) } : {}),
        durable, // 直连本会话（S1——转发壳只剩组合根侧 gate/approval 两路）
        // S4 会话层 auto-retry 三注入：session（倒扫/重播种/落账三消费位——
        // 无持久层件面 session 缺席时重试自动关闭）、transient 判定器（桶表
        // transient 位——缺省恒 false 直通）、策略（缺省 enabled/3/1s）
        session,
        isTransientError: deps.isTransientError,
        // 溢出兜底两注入（第四十五批）：窗口携带判定器（装配面——llm 服务面直通）
        // + 压缩面调用点惰性解析（件面——根作用域 tryGet 读链含系统区表；装载序
        // compaction 第九行晚于本件首行，boot 首驱动构造期 provide 未落，构造期
        // 解析恒空禁做——冷读 P1-4；件禁用/卸载形态 undefined 即降级直通）
        isOverflowError: deps.isOverflowError,
        resolveCompaction: () => deps.rootCtx.tryGet<OverflowCompactionFace>('compaction'),
        writeHeader,
        // 驱动面回调异常诊断（隔离案一第一刀 #4）：onRunSettled 逐条隔离上报——
        // 坏订阅不毒后续订阅与驱动本体，异常经根 logger 留痕（含栈）
        onCallbackError: (err, source) =>
          deps.rootCtx.logger.error(`驱动面回调异常已隔离（${source}）`, {
            error: err instanceof Error ? err.stack : String(err),
          }),
      });
      const entry: DriverEntry = {
        session,
        appId,
        durable,
        resumed,
        driver,
        controls: { writeHeader, refreshTools, rematerialize },
        disposeDomainTools,
        disposeScope: () => driverScope.dispose(),
        headerState,
        retired: false,
      };
      entries.set(session.header.sessionId, entry);
      // 条目集写点之一（daemon 刀一）：heldSessions 租约登记随之刷新
      notifyEntriesChange();
      // 结算派发接线（永久订阅——dispatch 工厂级恒活；退役条目的迟到结算照发，
      // 载荷带归属 sessionId，goal 等消费方按码容错跳过）
      driver.onRunSettled(dispatch);
      // 前台转接：既有展示消费者全量接入新驱动（S3 信封化——转接闭包补本会话键）
      // + 退出聚合挂接（任一驱动退即 resolve）
      for (const sink of frontDisplays) driver.addDisplay((event) => sink({ sessionId, event }));
      void driver.quit.then(() => resolveFrontQuit());
      // 前台聚焦切换（最后一步——此前一切就绪，聚焦后 TUI 路由即达新驱动；
      // S3 写点之一：open 新开，经 setFocus 通知订阅者）
      setFocus(sessionId);
      return entry;
    },
    retire(sessionId) {
      const entry = entries.get(sessionId);
      // 查无/已退役：无事可做（幂等语义——retire 不是创建）
      if (entry === undefined || entry.retired) return false;
      // run 中拒绝（防御位——/new 编排已先行聚焦驱动 isRunning 准入判据；
      // run 中退役=正被 loop 引用的时间线强行 abort，留给编排层显式抉择）
      if (entry.driver.isRunning) return false;
      entry.retired = true;
      // 条目集写点之二（daemon 刀一）：持有集失去本条目（retire 拒绝 run 中
      // 条目——此后 isRunning 恒 false，持有集变化点即本处）
      notifyEntriesChange();
      // 域层工具回卷（S2 fs + S5 bash：五名从 tools 注册表域层撤出——退役即停摆
      // 的工具面半边；session/durable 保留的原语义不变，迟到结算照落原会话账）
      entry.disposeDomainTools();
      // fresh 装配作用域回卷（S5：审批/守门行/管道/answerer 四件一次撤出——
      // 退役驱动的管道不再拦任何执行，作用域行表随 dispose 清空）
      entry.disposeScope();
      // 仅 abort 不 resolve quit（会话停摆≠进程退出——前台退出聚合只认 requestQuit）
      entry.driver.retire();
      return true;
    },
    switchTo(sessionId) {
      // 退役/查无 false（/app 清单只列活条目——这里守住同一判据）
      const entry = entries.get(sessionId);
      if (entry === undefined || entry.retired) return false;
      // 零准入拒：不动 run（切入正在跑的条目合法——TUI 侧在飞占位槽续流），
      // 切换纯展示路由；S3 写点之三：经 setFocus 通知（同值零通知）
      setFocus(sessionId);
      return true;
    },
    onFocusChange(cb) {
      focusListeners.add(cb);
      return () => {
        focusListeners.delete(cb);
      };
    },
    onEntriesChange(cb) {
      entriesListeners.add(cb);
      return () => {
        entriesListeners.delete(cb);
      };
    },
  };

  /* ---- 件模块（boot 全量接线；/reload 重装载走复用支线） ---- */
  const module: BuiltinAppModule = {
    name: 'chat',
    // Ring 1 行树化批（2026-08-26）：tools 服务 apply 期经根取（ring1Anchor 先装载
    // 必居值）——装载序由 inject 声明驱动，Kahn 轮次自然排后，不再按值闭包注入
    inject: ['tools'],
    apply: async (ctx: AppContext) => {
      // persist:false 降级：无持久层即无会话可续、无驱动可起（dump-config 诊断面
      // 不起驱动——件空转 warn；goal 等消费方经 optionalInject 降级，启动断言不响）
      if (!deps.persistence) {
        ctx.logger.warn('无持久层（persist:false）——chat 官方件空转：不建会话、不起驱动、不供 agent 服务');
        return;
      }
      // todo 注入件（骨架篇 §6.7 落码形态定稿④）：角色 + context_transform 瀑布
      // handler 装载面注册——必须挂在本早退**之前**：/reload 支线（下方）只重挂
      // 服务面不重跑 boot 段，而 ctx.on 注册随锚回卷——重装载后 apply 重入经此
      // 路重挂注入件（注册幂等：作用域 effect 栈各归各次装载）。
      // 刀二计划态跨轮：goal 段锚查询注入——goal active 期 fold 从激活锚折叠
      //（user/message 不再是边界）；通道 miss / 无 active 行 = run-scoped 现行为
      const goalChannel = deps.goalChannel;
      registerTodoInjection(
        ctx,
        registry,
        goalChannel === undefined
          ? undefined
          : // 每次注入时点活取（goal 激活/停掉后注入即时切段，无缓存陈旧性）
            (sessionId) => goalChannel.goalScopeFor(sessionId)?.activatedSeq,
      );
      // 刀二 todo fold 查询注册（通道反向腿——goal 件计划态投影 / open 项否决
      // 消费）：sessionId → 本件驱动 fold（goal 段锚查询期重查非注册期冻结）。
      // 挂 ctx.effect 随锚回卷，与注入件同位置同理（/reload 重入重挂）
      if (goalChannel !== undefined) {
        ctx.effect(() =>
          goalChannel.registerTodoFold((sessionId) => {
            const entry = registry.entries.get(sessionId);
            if (entry === undefined) return undefined; // 非本件会话（子代理等）——面缺席诚实降级
            const scope = goalChannel.goalScopeFor(sessionId);
            return foldCurrentTodo(entry.session.events, scope === undefined ? undefined : scope.activatedSeq);
          }),
        );
        // 刀三 wake 归因查询注册（通道反向腿——goal 件工具 currentWakeId / 续跑
        // 判定 attribution 直查消费）：sessionId → 本件驱动刚结算/在跑 run 的归因；
        // 退役/未知条目 = undefined（面缺席诚实降级）。挂 ctx.effect 随锚回卷
        ctx.effect(() =>
          goalChannel.registerWakeLookup((sessionId) => {
            const entry = registry.entries.get(sessionId);
            return entry === undefined ? undefined : entry.driver.currentAttribution;
          }),
        );
      }
      // /reload 重装载支线：注册表非空（驱动条目跨重装载存续——重装载是装载面
      // 变更不是会话变更），只重挂服务面（旧 provide 已随锚回卷）
      if (entries.size > 0) {
        ctx.provide('agent', face);
        return;
      }
      // boot 全量：开首个驱动（会话策略与应用域经 deps 透传——CLI --app 进入面）+ 挂服务面
      registry.open({
        ...(deps.resumeSession !== undefined ? { resume: deps.resumeSession } : {}),
        ...(deps.app !== undefined ? { app: deps.app } : {}),
      });
      ctx.provide('agent', face);
    },
  };

  return { module, registry, front };
}
