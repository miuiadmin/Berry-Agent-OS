/**
 * L0 contracts — 事件词汇基型（内核篇 §5 词汇表 / 会话篇 §1.1 唯一权威信封）。
 *
 * 两类「事件」严格区分（内核篇词汇：活体事件 vs durable 事件）：
 * - ctx.on/emit 上的**活体事件**：进程内广播，不落库，传输层订阅转发给 UI；
 * - **durable 事件**：SessionEvent 信封 append 进会话事件日志，是唯一事实源。
 */

/**
 * 活体事件名。统一小写斜线式 `'<域>/<动作>'`（如 session/event、tool/finished、
 * approval/decided）。
 *
 * 收口形态（契约篇 §1.1，2026-08-23 M2 /reload 纵切）：目录字面量联合 +
 * `(string & {})` 自定义事件逃生口——目录字面量给插件作者 IDE 自动补全与
 * 拼写校验，`(string & {})` 保住「自定义事件须显式注册」的字符串面；
 * 运行时裁判是 context 的事件注册表（目录 ∪ 装载期 customs），未注册名
 * 在 on/emit/waterfall/parallel/serial 五面抛 EVENT_UNKNOWN。
 * 联合与 LIVE_EVENT_CATALOG 名集由 check-events 第四族双向断言——
 * 目录新增名忘进联合（或反之）CI 即红，两处永不漂移。
 */
export type EventName =
  | 'session/event'
  | 'session_shutdown'
  | 'tools_pre_execute'
  | 'tools_execute'
  | 'tools_post_execute'
  | 'tools_change'
  | 'approval/answer'
  | 'plugin/activated'
  | 'plugin/failed'
  | 'plugin/skipped'
  | 'composition/reloaded'
  | 'prompts_change'
  | 'context_transform'
  | (string & {});

/**
 * 活体事件目录项（契约篇 §6.3 第 4 条——CI 双向断言的数据源）。
 * 目录即契约：`mode` 是事件的公开契约组成部分（插件订阅方式依赖它），
 * 派发点调用的方法必须与目录声明一致（check-events 机械校验）。
 */
export interface LiveEventDefinition {
  /** 事件名（小写斜线式；与派发点字面量/常量值双向比对） */
  readonly name: string;
  /** 分派模式——事件的公开契约部分（契约篇 §1「@mode」纪律：dsh 衍生） */
  readonly mode: 'emit' | 'waterfall' | 'parallel' | 'serial';
  /** 载荷与语义一句话（含出处标注，供目录生成与插件作者查阅） */
  readonly note: string;
  /**
   * 预留词汇：当前无宿主派发点、但属已拍板词汇表的预留项。
   * CI「每目录项 ≥1 派发点」方向据此显式豁免——豁免必须声明，不静默
   * （对应 session 侧 SessionEventTypeDefinition.reserved 同款语义）。
   */
  readonly reserved?: boolean;
}

/**
 * 总线活体事件目录（契约篇 §2.2 已落码面的全集；SessionEvent durable 词汇
 * 归 session 模块运行时注册表，两族分开断言）。
 *
 * 维护纪律：新增总线事件 = 先在此登记（含 mode/note），再写派发点——
 * check-events 双向断言保证目录与 src 派发点永不漂移。
 */
export const LIVE_EVENT_CATALOG: readonly LiveEventDefinition[] = [
  {
    name: 'session/event',
    mode: 'emit',
    note: 'SessionEvent 写入后的活体通知，载荷 { sessionId, event }（契约篇 §2.2；信封规则 dsh-11——多会话并存时订阅方可分辨归属）',
  },
  {
    name: 'session_shutdown',
    mode: 'emit',
    note: '优雅关闭广播（契约篇 §2.2 application 层；载荷 { reason }）',
  },
  {
    name: 'tools_pre_execute',
    mode: 'waterfall',
    note: '工具执行前守门瀑布（契约篇 §2.2 tool 层；入参 GateInput → 出参 GateAction）',
  },
  {
    name: 'tools_execute',
    mode: 'waterfall',
    note: '工具执行瀑布（契约篇 §2.2 tool 层；可整体替换执行体——M2 随插件加载器开放）',
  },
  {
    name: 'tools_post_execute',
    mode: 'waterfall',
    note: '工具执行后审计瀑布（契约篇 §2.2 tool 层；只观察不影响结果）',
  },
  {
    name: 'tools_change',
    mode: 'emit',
    note: '工具注册表变更通知（契约篇 §2.2 tool 层；装配层订阅刷新 loop 工具快照——骨架篇 §9.2 接线义务）',
  },
  {
    name: 'approval/answer',
    mode: 'waterfall',
    note: '审批应答瀑布（骨架篇 §8.3 ApprovalService 决议面；无应答者 fail-closed）',
  },
  {
    name: 'plugin/activated',
    mode: 'emit',
    note: '插件行激活成功（契约篇 §2.2 增补 1 生命周期组；载荷 { id, name }——组合树行 id + 插件声明名；加载器 boot 逐行必发）',
  },
  {
    name: 'plugin/failed',
    mode: 'emit',
    note: '插件行失败（载荷 { id, code, message }——PLUGIN_ 码族；启动断言据此响亮列出，不静默跳过）',
  },
  {
    name: 'plugin/skipped',
    mode: 'emit',
    note: '插件行跳过（载荷 { id, reason }——reason: disabled 静态禁用 / platform 平台门控；目录信任略过随信任门落地补）',
  },
  {
    name: 'composition/reloaded',
    mode: 'emit',
    note: '组合树 /reload 全量重载完成（契约篇 §1.3/§2.2 增补 1；载荷 CompositionReloadedPayload = activated/failed/skipped 三份行 id 清单）',
  },
  {
    name: 'prompts_change',
    mode: 'emit',
    note: 'systemPrompt 段集合变更通知（契约篇 §2.2 增补 5 pi-4(a)；载荷 = 现行段 id 清单 id 字典序；与 tools_change 同族——装配层订阅重建提示词 + header reason=change，观测/UI 插件订阅刷新）',
  },
  {
    name: 'context_transform',
    mode: 'waterfall',
    note: 'LLM 请求组装最后关口的消息变换瀑布（契约篇 §2.2 message 层；载荷 = contracts 标准 AgentMessage[]，逐 handler 变换传播——loop transformContext 由组合根桥接到此钩子，按需检索注入走它）',
  },
];

/** composition/reloaded 载荷：三态行 id 清单（/reload 后订阅方可对账「实际跑的是什么」） */
export interface CompositionReloadedPayload {
  /** 激活成功的行 id */
  readonly activated: readonly string[];
  /** 失败的行 id（/reload 逐行响亮报告、不杀进程——成功行照常运行） */
  readonly failed: readonly string[];
  /** 跳过的行 id */
  readonly skipped: readonly string[];
}

/** 目录查询：按名取定义（含判断某事件是否已知总线活体事件） */
export function findLiveEvent(name: string): LiveEventDefinition | undefined {
  return LIVE_EVENT_CATALOG.find((entry) => entry.name === name);
}

/** 遮蔽指令：改历史的唯一合法形态（会话篇 §2）——新事件携带，在派生表面遮蔽 [start, end] 区间旧节点 */
export interface SurfaceOp {
  op: 'replace';
  start: number;
  end: number;
}

/**
 * durable 事件信封（会话篇 §1.1 唯一权威）：会话事件日志的唯一条目形态。
 * 写入时经单遍 JSON 校验 + deepFreeze，任何持有者改不动。
 */
export interface SessionEvent<T = unknown> {
  /** 事件类型词汇（核心清单 + 插件显式注册扩展；未知且非 ignorable 读侧整体拒绝） */
  readonly type: string;
  /** 会话内连续序号，0 起、+1 递增（= 写入时 log.length，强制连续） */
  readonly seq: number;
  /** 毫秒时间戳；合成事件复用最后真实事件的 time（恢复确定性） */
  readonly time: number;
  /** 已冻结的 JSON 快照（载荷 schema 随事件类型定义方收口） */
  readonly data: T;
  /** true = 读侧可以不认识此类型（向前兼容）；缺省 = 必须认识 */
  readonly ignorable?: boolean;
  /** 遮蔽指令，仅改历史事件携带 */
  readonly surfaceOp?: SurfaceOp;
  /** 遮蔽溯源：被遮蔽节点 + 依据事件的完整 seq 列表（只能引用更早的 seq） */
  readonly sourceEventSeqs?: number[];
}
