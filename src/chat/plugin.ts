/**
 * L4 chat — 对话应用官方件（契约篇 §5.4 应用面第一纵切：`builtin:chat` 显式化；铭牌批件聚落 src/chat/）。
 *
 * 官方默认层**首行**（Ring 2 真·可卸——overlay 禁用即首启无对话循环，宿主照启：
 * 装/守/存职能与 /plugins、/reload 壳命令完好；命题 §3.5「对话是应用不是内核」
 * 的运行时证明）。
 *
 * 2026-08-26 S1 durable 键控总根因刀（多应用并行第一纵切，骨架篇 §9.3 机制定案
 * / 契约篇 §5.4 第 6 条 S1 射面）：factory 级单驱动退役为**注册表**——
 * - `DriverRegistry`：`Map<sessionId, DriverEntry>` + 前台聚焦指针 focus。
 *   注册表由组合根分配（createChatPlugin 产物）、**本件负责填充与消费**（单真相：
 *   会话选择→durable 直连→session_start→盖章→header 差分→驱动构造一条龙全在
 *   `open()` 内化）；`/new` = open 新条目 + 切 focus + 旧条目退役（entry 的
 *   session/durable 保留——迟到结算继续落原会话账，防 seq 撞号）。
 * - `FrontHost` 前台宿主 façade：submit/requestQuit/settle 随前台聚焦路由，
 *   quit = 退出聚合 promise（任一驱动 requestQuit 即 resolve——/new 换驱动不断流），
 *   display 经 façade 注册（open 新驱动全量转接，退役驱动迟到事件仍可见=审计面）。
 * - ctx.agent 路由 façade：sendUserMessage 三级解析序（显式键 → 调用链 → 前台
 *   聚焦）+ 两码执法（AGENT_SESSION_INACTIVE / AGENT_SESSION_KEY_REQUIRED）；
 *   dispatch/subscribers/face 工厂级（跨 /reload 存续），/reload 重装载只重
 *   provide 服务面（驱动与时间线存续——重装载是插件面变更，不是会话变更）。
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
import type { AgentEvent, AgentEventSink } from '../agent/events.js';
import type { AgentTool } from '../contracts/tools.js';
import type { BuiltinPluginModule, PluginContext } from '../contracts/plugin.js';
import type { ContextScope, Disposer } from '../context/types.js';
import { chainSessionId } from '../context/chain.js';
import type { Session } from '../session/session.js';
import type { Persistence } from '../persist/index.js';
import type { ToolsService } from '../tools/registry.js';
import type { SandboxMode } from '../safety/index.js';
import type { DurableSinks } from './durable.js';
import { createDurableSinks, projectedToAgentMessages } from './durable.js';
import { createFsTools } from '../tools/fs.js';
import type { ConversationDriver, RunSettled } from './conversation.js';
import { ConversationDriver as ConversationDriverClass } from './conversation.js';

/**
 * 对话应用 id（apps/chat.app.yaml 清单的 id——会话域打标、resume 域查询、
 * request/header 载荷腿共用同一字面量；默认入口期 chat 兼任默认应用，第十七批）。
 */
export const CHAT_APP_ID = 'chat';

/* ------------------------------------------------------------------ */
/* ctx.agent 服务面（自 agent-service.ts 迁入——attach 退役后服务与     */
/* 驱动同件构造，无游离态；类型面公开导出不变，消费方局部结构面免改动） */
/* ------------------------------------------------------------------ */

/** sendUserMessage 可选项（骨架篇 §9.3 签名） */
export interface SendUserMessageOptions {
  /** 注入归因（会话篇 §3.1 dsh-8 词汇——如 'plugin:goal'）；缺省不落字段（读侧视为 'user'） */
  readonly source?: MessageSource;
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

/** ctx.agent 服务面（provide('agent') 的形状——插件经 inject 'agent' 结构性取得） */
export interface AgentServiceFace {
  /** 三通道注入（构造 UserMessage 经三级解析序路由到目标驱动；返回 void——steer 入队语义下 run 边界模糊，§9.3 ask 是等待结果的另一面 ⏳） */
  sendUserMessage(content: string | UserMessage['content'], opts?: SendUserMessageOptions): void;
  /** 订阅 run 结算（每个 run 终结派发一次；载荷含归属 sessionId——多驱动下订阅方按其路由；Disposer 注销——挂 ctx.effect 即随插件回卷） */
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
  /** 本会话 durable 三路 sink（直连——handle 半边不经任何转发壳，随条目生死） */
  readonly durable: DurableSinks;
  /** 本条目是否续接既有会话（boot resume 判定——goal 降级触发器等消费） */
  readonly resumed: boolean;
  /** 会话驱动（run 编排 + 通道宿主面） */
  readonly driver: ConversationDriver;
  /** 件控制面（writeHeader 落账 + refreshTools/rematerialize 两刷新口——组合根 ⑧ 接线遍历调用） */
  readonly controls: ChatControls;
  /**
   * 本条目域层工具注销器集合（S2 fs 迁域：fs 四名带本会话域键注册进 tools
   * 注册表域层；retire 回卷——「退役即停摆」的工具面半边，防注册表域层随
   * /new 泄漏累积）
   */
  readonly disposeDomainTools: () => void;
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
   */
  open(options?: { readonly resume?: boolean | string }): DriverEntry | undefined;
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
  readonly module: BuiltinPluginModule;
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
   * 重算本条目 loop 工具快照（S2 per-entry——`listFor(本会话)` 原位刷新）。
   * tools_change 载荷带域键 = 只该域条目刷新；缺省 = 全局层变更全部条目刷新
   */
  refreshTools(): void;
  /**
   * 重物化本条目系统提示词（S2 per-entry——prompts/skills 变更与 /reload 时点，
   * 全部非退役条目各自重物化；/new 不再全局 rebuild——open 即新纪元）
   */
  rematerialize(): void;
}

/** 件构造依赖（装配期活闭包——官方件 = 宿主装配特权，不新开 ctx 服务名） */
export interface ChatPluginDeps {
  /** 启动会话策略原样透传（true = 按 cwd 续接最新；string = 显式 id；缺省 = 新建） */
  readonly resumeSession?: boolean | string;
  /** 持久层（缺省 = persist:false 诊断面——件降级空转，不起驱动不供 agent） */
  readonly persistence?: Persistence;
  /** 根作用域（S1：open 运行于 /new 等任意时点——插件 apply ctx 已随 /reload 回卷，Ring 1 服务/总线 emit/logger 恒走根） */
  readonly rootCtx: ContextScope;
  /** 工作区根（latestSessionId 归属键 / 会话 cwd） */
  readonly workspace: string;
  /** 模型标识（loop 配置 + request/header 快照腿） */
  readonly model: string;
  /** 沙箱档（request/header 快照 config 腿） */
  readonly sandboxMode: SandboxMode;
  /** streamFn（loop 配置——组合根 ④ 产物） */
  readonly streamFn: StreamFn;
  /**
   * 瞬态错误判定（S4 前置债批——llm/recovery 桶表 transient 位经装配注入：
   * chat 拓扑边不含 llm，判定器走 ctx.llm.classifyError 服务面）。缺省恒
   * false（驱动 auto-retry 关闭——诊断装配/旧装配形态直通）。
   */
  readonly isTransientError?: (message: AssistantMessage) => boolean;
  /** convertToLlm（loop 配置——组合根 convert 产物） */
  readonly convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  /**
   * context_transform 桥（经根总线 waterfall——插件监听随 /reload 更替，桥本体用
   * 根 ctx 恒存活）。双参（S1，契约篇 §2.2）：sessionId 随批穿透给 handler——
   * 差分/检索等 handler 可按归属会话路由落账
   */
  readonly transformContext: (messages: AgentMessage[], sessionId: string) => Promise<AgentMessage[]>;
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
  /** sandbox 档事实盖章（内核守门面实现——dedup 内建；件在每次会话边界调用） */
  readonly stampSandboxFacts: (session: Session) => void;
  /**
   * 本进程主 loop 花销记账道（缺省 'foreground'）。tick 唤起入口（argv
   * --background）声明 'background'——席 13 第二刀 blocker 修：tick 子进程
   * 轮入 background 道，canAfford 读的账才收到 tick 烧的钱。进程会话级声明
   * （详见 chat/durable.ts createDurableSinks 同名参数注记）
   */
  readonly usagePriority?: 'background' | 'foreground';
}

/**
 * 构造 chat 官方件 bundle（builtins 注册表 `builtin:chat` 行 + 注册表 + 前台宿主）。
 *
 * 注册表/订阅表/服务面全为 factory 级（跨 /reload 存续）：/reload 销锚只回卷
 * provide 注册（apply 重跑即重挂），驱动条目与结算接线不动——重装载是插件面
 * 变更，不是会话变更。
 */
export function createChatPlugin(deps: ChatPluginDeps): ChatRuntime {
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

      /* -- 会话选择（技术栈篇 §5：显式 id / 按 cwd 最新 → 续接；回落新建） -- */
      const targetId =
        typeof options.resume === 'string'
          ? options.resume
          : options.resume === true
            ? // chat 域含 NULL 存量回退（契约篇 §5.4 冷读裁决）：NULL = builtin:chat 落地前
              // 的存量会话，默认入口的域含历史全量（存量不回填但续接不弃养）
              persistence.latestSessionId(deps.workspace, { app: CHAT_APP_ID, includeNullApp: true })
            : undefined;
      // 幂等防御：目标 id 已是注册表条目（活/退役）即不重开——返回既有 + 切 focus。
      // 重开同 id 会造出第二个 Session 实例（单写者护栏/seq 连续性全破），结构上必须挡
      if (targetId !== undefined && entries.has(targetId)) {
        const existing = entries.get(targetId)!;
        setFocus(existing.session.header.sessionId); // S3 写点之二：幂等命中也是 focus 写点（同值零通知）
        return existing;
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
        }
        // 目标不存在回落新建：启动策略是「续接优先」不是「必须续接」
      }
      // 新建会话打标 chat 域（默认启动即 app='chat'——血缘显式打标，不做投影推断）
      session ??= persistence.createSession({ cwd: deps.workspace, profile: 'default', app: CHAT_APP_ID });

      /* -- durable 接线（S1 直连：handle/gate/approval 三路全绑本会话——不经转发壳；model 腿供 llm/usage 前台折叠回退值；usagePriority = tick 入口记账道声明） -- */
      const durable = createDurableSinks(session, {
        model: deps.model,
        ...(deps.usagePriority !== undefined ? { usagePriority: deps.usagePriority } : {}),
      });
      // session_start（契约篇 §2.2 session 层 emit 行）：会话建立/恢复闭合后必发
      // 一次——经根 ctx emit（总线 runtime 共享，插件锚 on 互通；装载序上 boot 路
      // 本事件先于一切消费方插件的 plugin/activated，与组合根直发形态等价）。
      // origin 对齐首张 header 的 reason 语义（resume = 恢复闭合含崩溃修复，initial = 新建）
      deps.rootCtx.emit('session_start', {
        sessionId: session.header.sessionId,
        origin: resumed ? 'resume' : 'initial',
      });
      // sandbox 档事实盖章（内核守门面数据 + 应用会话边界时点；dedup 内建——
      // 续接同档不重复落，事件序稳定：session_start → sandbox/mode）
      deps.stampSandboxFacts(session);
      // 首张 header 名分（续接会话 resume / 新会话 initial——此后变化 change）
      const headerState: { last?: string; next: 'initial' | 'resume' | 'change' } = {
        next: resumed ? 'resume' : 'initial',
      };

      /* -- fs 工具族域注册（S2 契约篇 §3.2：观察态 per-driver——每驱动一套
         createFsTools 带本会话域键注册进 tools 注册表**域层**；dispose 挂
         本条目由 retire 回卷。可写根推导器随迁本件 deps（与守门行同源产物） -- */
      const fsTools = createFsTools({ writableRoots: deps.writableRoots, workspace: () => deps.workspace });
      const sessionId = session.header.sessionId;
      const fsDisposers = fsTools.tools.map((def) => tools.register(def, { domain: sessionId }));
      const disposeDomainTools = (): void => {
        for (const dispose of fsDisposers) dispose();
      };

      /* -- per-entry loop 工具快照（S2：`listFor(本会话)` = 全局层 ∪ 本域 fs 四名；
         活数组原位刷新（length=0 + push）即达 loop，含 run 中途；组合根 ⑧
         tools_change 订阅按载荷域键路由到 refreshTools -- */
      const toolView: AgentTool[] = [];
      const refreshTools = (): void => {
        const fresh = tools.listFor(sessionId).map((def) => tools.toAgentTool(def));
        toolView.length = 0;
        toolView.push(...fresh);
      };
      refreshTools();

      /* -- per-entry 系统提示词（S2：open 物化新纪元——串与记忆基线同时点同面
         冻结；rematerialize 是 prompts/skills 变更与 /reload 的重物化口） -- */
      let systemPrompt = deps.materializeSystemPrompt(sessionId);
      const rematerialize = (): void => {
        systemPrompt = deps.materializeSystemPrompt(sessionId);
      };

      /* -- request/header 差分化闭包（会话篇 §1.3：仅组装参数变化才落新快照） -- */
      // 落账直用本条目 session（S1 per-entry——不再读全局活槽，条目间基线互不串档）；
      // 两腿读本条目面（S2）：systemPrompt = 本条目物化串；toolSchemas = listFor
      //（域视角——含本会话 fs 四名）
      const writeHeader = (): void => {
        const payload = {
          config: { model: deps.model, sandbox: deps.sandboxMode },
          systemPrompt,
          toolSchemas: tools.listFor(sessionId).map((def) => ({ name: def.name, parameters: def.parameters })),
        };
        const serialized = JSON.stringify(payload);
        if (serialized === headerState.last) return; // 组装参数未变——不落新快照
        // app 腿在序列化基线之外追加（会话域打标的载荷腿——会话内恒定，不参与 diff；
        // 与 sessions.app 同源，血缘显式打标的证据腿，契约篇 §5.4）
        session.append('request/header', { ...payload, app: CHAT_APP_ID, reason: headerState.next });
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
          model: deps.model,
          convertToLlm: deps.convertToLlm,
          // context_transform 桥（契约篇 §2.2 增补 5② + S1 双参）：loop 私有配置
          // 回调桥为根总线瀑布，sessionId 随批穿透给 handler（差分/检索按会话路由）
          transformContext: (batch) => deps.transformContext(batch, session.header.sessionId),
        },
        durable, // 直连本会话（S1——转发壳只剩组合根侧 gate/approval 两路）
        // S4 会话层 auto-retry 三注入：session（倒扫/重播种/落账三消费位——
        // 无持久层件面 session 缺席时重试自动关闭）、transient 判定器（桶表
        // transient 位——缺省恒 false 直通）、策略（缺省 enabled/3/1s）
        session,
        isTransientError: deps.isTransientError,
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
        durable,
        resumed,
        driver,
        controls: { writeHeader, refreshTools, rematerialize },
        disposeDomainTools,
        headerState,
        retired: false,
      };
      entries.set(session.header.sessionId, entry);
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
      // 域层工具回卷（S2：fs 四名从 tools 注册表域层撤出——退役即停摆的工具面
      // 半边；session/durable 保留的原语义不变，迟到结算照落原会话账）
      entry.disposeDomainTools();
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
  };

  /* ---- 件模块（boot 全量接线；/reload 重装载走复用支线） ---- */
  const module: BuiltinPluginModule = {
    name: 'chat',
    // Ring 1 行树化批（2026-08-26）：tools 服务 apply 期经根取（ring1Anchor 先装载
    // 必居值）——装载序由 inject 声明驱动，Kahn 轮次自然排后，不再按值闭包注入
    inject: ['tools'],
    apply: async (ctx: PluginContext) => {
      // persist:false 降级：无持久层即无会话可续、无驱动可起（dump-config 诊断面
      // 不起驱动——件空转 warn；goal 等消费方经 optionalInject 降级，启动断言不响）
      if (!deps.persistence) {
        ctx.logger.warn('无持久层（persist:false）——chat 官方件空转：不建会话、不起驱动、不供 agent 服务');
        return;
      }
      // /reload 重装载支线：注册表非空（驱动条目跨重装载存续——重装载是插件面
      // 变更不是会话变更），只重挂服务面（旧 provide 已随锚回卷）
      if (entries.size > 0) {
        ctx.provide('agent', face);
        return;
      }
      // boot 全量：开首个驱动（会话策略经 deps 透传）+ 挂服务面
      registry.open({ resume: deps.resumeSession });
      ctx.provide('agent', face);
    },
  };

  return { module, registry, front };
}
