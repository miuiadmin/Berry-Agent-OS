/**
 * L0 contracts — Job 注册表类型（运行时骨架篇 §6.2 落码注记，2026-08-24 subagent 纵切一）。
 *
 * Job = 后台任务/一次性后台委派的进程内登记项（地基篇词汇「任务」）：
 * - **进程内词汇不持久**（会话篇 §5「fork 不继承」）——重启即消，跨会话可见性走结算副作用；
 * - 状态机 `running →（可选 stopping）→ 唯一终态 completed/killed/failed`，first-wins 结算；
 * - `done` promise **永不 reject**（executor 侧 reject 一律转 failed 终态）；
 * - kind 词汇显式注册（'subagent'/'process' 为内置 kind，插件自定义走 registerKind）。
 */

/** Job 唯一终态（状态机终点；first-wins——第一个落定的终态胜出） */
export type JobTerminal = 'completed' | 'killed' | 'failed';

/** Job 全程状态（stopping = 已收到取消请求但 executor 尚未落终态） */
export type JobStatus = 'running' | 'stopping' | JobTerminal;

/** 建 Job 选项（ownerSessionId 缺省 = 无主——operator 直控面（TUI 等宿主侧） */
export interface JobCreateOptions {
  /** 任务类别（须已注册；内置 'subagent'/'process'，插件自定义经 registerKind） */
  readonly kind: string;
  /** 归属会话 id（围栏鉴权：带主 Job 的 cancel/查询须同会话；缺省 = 无主） */
  readonly ownerSessionId?: string;
  /** 人读标签（诊断/清单显示，不参与语义） */
  readonly label?: string;
}

/** 结算明细（终态附带的人类/模型可读信息；output 与 error 互斥于成功/失败路） */
export interface JobSettleDetail {
  /** 成功产物摘要（subagent 结算 = output；process = 尾行输出等） */
  readonly output?: string;
  /** 失败原因（describeError 口径——错误码进文本，不裸抛） */
  readonly error?: string;
}

/** Job 只读快照（list/get 返回；活状态经 handle 读） */
export interface JobView {
  readonly id: string;
  readonly kind: string;
  readonly label?: string;
  readonly ownerSessionId?: string;
  /** 当前状态（终态后恒定） */
  readonly status: JobStatus;
  /** 结算明细（终态后填；running/stopping 期 undefined） */
  readonly settled?: Readonly<{ terminal: JobTerminal } & JobSettleDetail>;
}

/** Job 活句柄（创建方持有 = 直接处置权；间接访问走服务面围栏） */
export interface JobHandle extends JobView {
  /** 结算 promise（永不 reject——resolve 值即终态；拒绝语义由 executor 转 failed） */
  readonly done: Promise<JobTerminal>;
  /** 请求停止：running→stopping + abort signal；终态/重复调用幂等 no-op。
   * 注意这是**请求非结算**——终态仍由 executor 经 settle 落（first-wins 保持 executor 侧）。 */
  cancel(): void;
}

/** 手动结算面（provider 自持生命周期的形态——subagent/process 两 kind用） */
export interface JobController {
  /** 活句柄（同 create 返回） */
  readonly handle: JobHandle;
  /** 取消信号（cancel 即 abort；executor 观察它落 killed 或提前收工） */
  readonly signal: AbortSignal;
  /** 落终态（first-wins：首次调用生效，后续 no-op 仅 debug 日志） */
  settle(terminal: JobTerminal, detail?: JobSettleDetail): void;
}

/** ctx.jobs 服务面（subagent 模块提供；骨架篇 §9.2 落码形态） */
export interface JobsServiceFace {
  /** JobKind 显式注册（未注册 kind 创建即 JOB_KIND_UNKNOWN——与事件词汇同纪律）；返回注销 Disposer */
  registerKind(kind: string): () => void;
  /** 糖入口：fn resolve→completed（携带 output）/ reject→failed（describeError）；
   * signal 已 abort 时无论 resolve/reject 一律落 killed（取消意图胜出——auto-wire 即 executor 侧适配） */
  run(opts: JobCreateOptions, fn: (signal: AbortSignal) => Promise<string | void>): JobHandle;
  /** 手动入口（provider 自持生命周期）：subagent 映射 aborted→killed / error→failed、
   * process 映射进程退出码——终态语义归 executor，注册表不代答 */
  create(opts: JobCreateOptions): JobController;
  /** 按 id 查快照（不存在 undefined；带主 Job 须同 session id 视角查——围栏与 cancel 同规） */
  get(id: string, as?: { sessionId?: string }): JobView | undefined;
  /** 清单（ownerSessionId 过滤 = 会话视角；缺省全量 = operator 视角） */
  list(opts?: { ownerSessionId?: string }): readonly JobView[];
  /** 按 id 请求取消（围栏：带主 Job 须以同 session id 请求，否则 JOB_OWNER_MISMATCH；
   * 无 as 视角 = operator 直控） */
  cancel(id: string, as?: { sessionId?: string }): void;
  /** 取消全部（或指定 owner 的）Job 并 await 全部结算落定——owner dispose /
   * 作用域回卷的排空面（「取消并 await 其全部 Job 结算」，骨架篇 §6.2） */
  drain(ownerSessionId?: string): Promise<void>;
}
