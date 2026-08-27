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
  | 'session_start'
  | 'session_shutdown'
  | 'tools_pre_execute'
  | 'tools_execute'
  | 'tools_post_execute'
  | 'tools_change'
  | 'approval/answer'
  | 'plugin/activated'
  | 'plugin/failed'
  | 'plugin/skipped'
  | 'plugin/uninstalled'
  | 'composition/reloaded'
  | 'worker/spawned'
  | 'worker/froze'
  | 'worker/oom'
  | 'echo/tick'
  | 'echo/par'
  | 'echo/ser'
  | 'echo/wf'
  | 'prompts_change'
  | 'skills_change'
  | 'user_input'
  | 'turn_stopping'
  | 'context_transform'
  | 'job_settled'
  | (string & {});

/**
 * 活体事件目录项（契约篇 §6.3 第 4 条——CI 双向断言的数据源）。
 * 目录即契约：`mode` 是事件的公开契约组成部分（插件订阅方式依赖它），
 * 派发点调用的方法必须与目录声明一致（check-events 机械校验）。
 */
export interface LiveEventDefinition {
  /**
   * 事件名（斜线 = 插件自定义域、无斜线 = 宿主自留地——命名空间分域规则，
   * 与 §1.5 prompt 段同款；与派发点字面量/常量值双向比对）。
   */
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
    name: 'session_start',
    mode: 'emit',
    note: '会话建立或恢复完成（含崩溃修复结果）/ delegation fork 建子会话 / 装载收口补播（契约篇 §2.2 session 层；载荷 { sessionId, origin?, replay? }——origin 建会维度 initial/resume/delegation、replay 投递维度补播标记，二十九批增补 8①；插件初始化会话级状态；骨架篇 §6.4 落码注记）',
  },
  {
    name: 'session_shutdown',
    mode: 'parallel',
    note: '优雅关闭广播，宿主 bounded 等待全部清理器（单条目 2s 上限、超时 warn 后继续——契约篇 §2.2 session 层二十九批增补 8②；载荷 { sessionId }）',
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
    name: 'plugin/uninstalled',
    mode: 'emit',
    note: '插件行卸载完成（契约篇 §3.4 第二刀，2026-08-27 刀 2；载荷 { id, source, dataAction, affected? }——四段执行成功尾的总线广播与 durable 落账双落地；复数域 = 管理面词汇〔与 plugins_* 工具族同源命名〕，单数 plugin/ 族是装载管线结果词——两族刻意分域）',
  },
  {
    name: 'composition/reloaded',
    mode: 'emit',
    note: '组合树重载完成（契约篇 §1.3/§2.2 增补 1；载荷 CompositionReloadedPayload = activated/failed/skipped 三份行 id 清单 + 可选 ring1RestartRequired〔Ring 1 行变更需重启生效——行树化批〕。2026-08-27 P1-2：boot 与 /reload 两时点同发——boot 路在装载收口重物化后派发，boot 时点插件 apply 期已订阅故能听到；观测/工作树类插件可作「组合树就绪」信号）',
  },
  {
    name: 'worker/spawned',
    mode: 'emit',
    note: 'worker 域 spawn 即派发（契约篇 §1.7 观测锚⑩ 装机计数事件面，第二十七批刀三；载荷 { rowId, workerId }——每行一域，fleet 在装载锚总线派发；订阅方据此计量装机/运维面板）',
  },
  {
    name: 'worker/froze',
    mode: 'emit',
    note: 'worker 域心跳冻结判定（契约篇 §1.7 观测锚⑨ 心跳超时事件面，第二十七批刀三；载荷 { rowId, workerId, missed }——watchdog kill 前派发；CPU 燃烧如实收窄不可判，本事件只覆盖事件循环冻结族）',
  },
  {
    name: 'worker/oom',
    mode: 'emit',
    note: 'worker 域内存超限死亡归因（契约篇 §1.7 观测锚⑤ 内存超限事件面，第二十七批刀三；载荷 { rowId, workerId, diagnostic }——resourceLimits.maxOldGenerationSizeMb 超限死的 error 事件签名命中时随域死结算派发；diagnostic = 原始错误消息）',
  },
  {
    name: 'echo/tick',
    mode: 'emit',
    reserved: true,
    note: 'Echo 金样事件词汇（契约篇 §1.7 金样应用，第二十七批刀三——测试资产：宿主/测试侧 emit、echo.ts 行内订阅；双拓扑 parity 测试的事件往返载荷。reserved 声明依据：派发点在测试面〔echo.test.ts〕非产品宿主——check-events 扫描面排除 .test.ts，产品 src 恒无派发点，豁免显式不静默）',
  },
  {
    name: 'echo/par',
    mode: 'parallel',
    note: 'Echo 金样收窄面探针词·parallel（契约篇 §1.7 金样应用，第二十七批刀三——测试资产：echo.ts 收窄探针以正确模式派发，主域真跑通〔ok〕vs worker 桩 BRIDGE_SURFACE_NARROWED 的差分判据；零订阅者，载荷无语义）',
  },
  {
    name: 'echo/ser',
    mode: 'serial',
    note: 'Echo 金样收窄面探针词·serial（同 echo/par——测试资产：收窄清单 v1 逐项核的差分判据；零订阅者，载荷无语义）',
  },
  {
    name: 'echo/wf',
    mode: 'waterfall',
    note: 'Echo 金样收窄面探针词·waterfall（同 echo/par——测试资产：收窄清单 v1 逐项核的差分判据；零订阅者，链尾 next 原样透传）',
  },
  {
    name: 'prompts_change',
    mode: 'emit',
    note: 'systemPrompt 段集合变更通知（契约篇 §2.2 增补 5 pi-4(a)；载荷 = 现行段 id 清单 id 字典序；与 tools_change 同族——装配层订阅重建提示词 + header reason=change，观测/UI 插件订阅刷新）',
  },
  {
    name: 'skills_change',
    mode: 'emit',
    note: '技能提供方链变更通知（契约篇 §2.2 增补 6，2026-08-25 探矿轮六 #17；载荷 = 现行 provider id 清单注册序；registerProvider/注销即广播——与 tools_change/prompts_change 同族第 3 件：装配层订阅重建系统提示词，插件技能热可见）',
  },
  {
    name: 'context_transform',
    mode: 'waterfall',
    note: 'LLM 请求组装最后关口的消息变换瀑布（契约篇 §2.2 message 层；载荷 = contracts 标准 AgentMessage[]，逐 handler 变换传播——loop transformContext 由组合根桥接到此钩子，按需检索注入走它。S1 双参：第二参 = 归属会话 id（transformContext 桥随批传入），handler 须 next(messages, sessionId) 逐参透传——waterfall 兜底仅保首参，单参调用丢键）',
  },
  {
    name: 'user_input',
    mode: 'waterfall',
    note: '用户输入进模型 run 前的消息级变换瀑布（契约篇 §2.2 message 层增补 7②，2026-08-27 P1-2 兑现：斜杠展开/模板替换/技能命令扩展；载荷双参 (message, sessionId)——与 context_transform 同款多驱动归属参数，handler 须 next(message, sessionId) 逐参透传。派发点 = 全部批消费位（run 入口/followUp drain/重试 drain/turn 边界 steer 注入），凡不进 run 批的 inject 审计路不过；消费点竞速挂起钟 5s）',
  },
  {
    name: 'turn_stopping',
    mode: 'serial',
    note: '模型 run 结算后逐个征询是否续跑（契约篇 §2.2 turn 层增补 7①，2026-08-27 P1-2 兑现：载荷 { sessionId, stopReason }；每次 runWithRetry 结算后、followUp 循环复查前派发，全部 stopReason 都发、dismantled 跳过；续跑 = handler 内经会话面 deliver 投递（running 走 steer 由循环消费——零新返回值）；消费点竞速挂起钟 5s）',
  },
  {
    name: 'job_settled',
    mode: 'emit',
    note: '后台任务到达终态（契约篇 §2.2 应用层；载荷 {id, kind, terminal, label?, output?, error?}——结算副作用广播，订阅方据此决定三通道唤醒）',
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
  /**
   * Ring 1 行合成结果变化清单（Ring 1 行树化批，契约篇 §5.1 /reload 语义）：
   * Ring 1 行挂独立装载锚、/reload 不回卷不重装载（仅 boot 生效）——行引用/
   * 配置/禁用状态变了只能报告「需重启生效」，不静默吞。空/缺省 = 无 Ring 1 变化
   */
  readonly ring1RestartRequired?: readonly string[];
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

/* ---------------- 跨会话有界查询（会话篇 §3.4，2026-08-27 刀 1） ---------------- */

/**
 * 组合游标 = 上页最旧一行的排序键三元组（[会话与存储]篇 §3.4 分页协议）。
 * 序 = time DESC、tie-break (sessionId, seq) DESC（最新优先往回翻）；下一页
 * 取排序意义上严格更旧者——新事件落在已翻过侧，天然不漂。
 */
export interface EventQueryCursor {
  /** 上页最旧一行的 time（毫秒 epoch） */
  readonly time: number;
  /** 上页最旧一行的会话 id */
  readonly sessionId: string;
  /** 上页最旧一行的会话内序号 */
  readonly seq: number;
}

/**
 * queryEvents 过滤与分页参数（挂 ctx.sessions 插件面，单原语）。
 * 判定句（与 eventsOfType 刻意相反）：types 在本面是**数据条件**——查未注册
 * 或已消失的词返回空不抛（uninstall 受影响会话数反查的恰是「已不在注册表
 * 里的词」）；词作**类型**（eventsOfType 读法）撞未注册才是断言错必抛。
 */
export interface EventQueryOptions {
  /** 时间窗下界（毫秒 epoch，含端点闭区间）；缺省无下界 */
  readonly sinceMs?: number;
  /** 时间窗上界（毫秒 epoch，含端点闭区间）；缺省无上界 */
  readonly untilMs?: number;
  /** 事件类型过滤维（数据条件非词汇断言——空集合法，见类型注释） */
  readonly types?: readonly string[];
  /** 应用维：过滤 sessions.app 列（存储层 JOIN sessions 实现） */
  readonly app?: string;
  /** 会话维：单会话细查 = 同一原语的退化用法，不开第二原语 */
  readonly sessionId?: string;
  /** 页大小：缺省 200、硬帽 1000（超帽钳到帽且 truncated 置真） */
  readonly limit?: number;
  /** 分页游标 = 上页最旧一行（向更旧方向翻页） */
  readonly cursor?: EventQueryCursor;
  /**
   * true = 服务内先 flush 屏障再查询（缺省 false）。读的是物理库——write-behind
   * 批落未 flush 的尾部不可见；需要含最新尾部的精确查询置 true（迟滞披露条，
   * 会话篇 §3.4——屏障以参数内嵌，不新开插件面 flush API）。
   */
  readonly flushFirst?: boolean;
}

/** 查询结果行（物理事实表行的直读形态；data 原样 JSON、服务面不截断——呈现截断归工具层） */
export interface EventQueryRow {
  /** 所属会话 id */
  readonly sessionId: string;
  /** 会话内连续序号 */
  readonly seq: number;
  /** 事件类型词汇 */
  readonly type: string;
  /** 毫秒时间戳 */
  readonly time: number;
  /** 载荷（JSON 反序列化原样） */
  readonly data: unknown;
}

/** queryEvents 返回形 */
export interface EventQueryResult {
  /** 本页行（按 time DESC、(sessionId, seq) DESC 稳定序） */
  readonly rows: readonly EventQueryRow[];
  /** 下一页游标（还有更旧行可翻时给出 = 本页最旧一行；无更旧页缺省） */
  readonly nextCursor?: EventQueryCursor;
  /**
   * 「本页不是全部」总标注：请求 limit 超硬帽被钳制、或本页之外仍有更旧行
   * （即 nextCursor 在场）任一成立即 true——模型面的粗粒度提示位。
   */
  readonly truncated: boolean;
}
