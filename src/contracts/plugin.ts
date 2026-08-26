/**
 * L0 contracts — 插件与组合树契约类型（插件契约篇 §1/§5.1，2026-08-23 M2 加载器本体纵切）。
 *
 * 三个词汇族：
 * 1. 插件模块形状（PluginModule——§1.1 单形状钉死 + §1.2 named export 三件）；
 * 2. 组合树行（CompositionRow——§5.1 空根 + 官方默认层 + 用户 overlay）；
 * 3. 装载计划与生命周期载荷（PluginPlanRow / Plugin*Payload——§2.2 增补 1 事件组）。
 *
 * PluginContext（§1.2 落码注记④，2026-08-25 Hermes 探针 #11 落码）：插件作者
 * 看到的 ctx 核心面在**此**声明（不再 never 占位）——第三方经 `berryagent`
 * 虚拟面取完整类型；宿主 context 模块的 Context 结构性覆盖本面（vitest
 * expect-type 编译期锁，漂移即红）。服务面（tools/prompts/…）不在 ctx 上，
 * 经 get<ToolsService>('tools') 等取用（接口同住 contracts）。
 */

import type { TSchema } from './typebox.js';
import type { LiveEventDefinition } from './events.js';
import type { MessageRoleDefinition } from './messages.js';
import type { SessionEventTypeDefinition } from './session-events.js';

/**
 * 插件面 logger 最小结构（context.Logger 的结构子集——contracts 零依赖层
 * 不引 context 模块；宿主 Logger 字段更宽，结构性可赋值到本面）。
 */
export interface PluginLogger {
  /** 最低优先级诊断（dev 缺省开；纪律红线：只在 debug 出现的行为必须另有 durable 面） */
  debug(message: string, fields?: Record<string, unknown>): void;
  /** 常规运行信息 */
  info(message: string, fields?: Record<string, unknown>): void;
  /** 异常但可继续（降级/回退路径） */
  warn(message: string, fields?: Record<string, unknown>): void;
  /** 失败留痕（不中断的回卷异常等） */
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 事件处理器：参数由事件发布方约定；返回值仅 waterfall 采用（与 context
 * 模块 EventHandler 同形——在此独立声明保持零依赖）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 处理器参数形态由各事件定义方收口
export type PluginEventHandler = (...args: any[]) => any;

/**
 * 插件运行时核心 API（骨架篇 §9.1 的插件视图——§1.2 注记④）。
 * 宿主 Context 结构性覆盖本面；服务解析后经 get<T>() 取具体服务接口。
 */
export interface PluginContext {
  /** 注册可逆副作用：立即执行 fn，其返回的清理函数入栈；作用域销毁按 LIFO 自动回卷 */
  effect(fn: () => () => void): () => void;
  /** 订阅事件；返回退订函数（随作用域卸载自动退订）；prepend 插队首位（守门拦截器用） */
  on(event: string, handler: PluginEventHandler, opts?: { prepend?: boolean }): () => void;
  /** 广播事件：全部监听器触发；单个失败隔离（记 error 日志，不中断其余） */
  emit(event: string, ...args: unknown[]): void;
  /** 并发触发全部监听器并等待完成；异常隔离同 emit */
  parallel(event: string, ...args: unknown[]): Promise<void>;
  /** 按注册序串行触发全部监听器；异常隔离（失败记日志、继续下一个） */
  serial(event: string, ...args: unknown[]): Promise<void>;
  /**
   * 瀑布链：末位参数 next 是链尾委托；每个监听器收到 (...args, next)，
   * 必须调用 next() 才继续下游——不调即短路（工具管道三段依赖此语义）。
   */
  waterfall<T>(event: string, ...argsWithNext: unknown[]): Promise<T>;
  /** 取服务实现；未注册抛 CONTEXT_SERVICE_NOT_FOUND（必需依赖——缺即装配错误） */
  get<T = unknown>(name: string): T;
  /** 软依赖探测取服务：未注册返回 undefined、不抛错（禁轮询/鸭子探测——缺即降级分支） */
  tryGet<T = unknown>(name: string): T | undefined;
  /** 注册自有具名服务供他插件 inject 消费；返回注销函数（随作用域回卷） */
  provide<T>(name: string, impl: T): () => void;
  /**
   * 注册自定义消息角色（骨架篇 §2.3——插件面）：角色名必含 `/` 域前缀
   * （`memory/recall` 式）；格式非法 AGENT_ROLE_INVALID、撞名/撞标准角色
   * AGENT_ROLE_EXISTS。挂作用域 effect 栈随卸载自动回卷（与 on/provide 同
   * 纪律）；返回值供提前手动注销。官方件同走此面（官方非特权）。
   */
  registerMessageRole(name: string, definition: MessageRoleDefinition): () => void;
  /**
   * 注册插件自有会话事件词汇（会话篇 §2.1——appendEvent 的钥匙）：type 小写
   * 斜线式 `<域>/<动作>`；核心词拒注册 SESSION_CORE_TYPE_FORBIDDEN（内核词
   * 写入权属宿主）；surface 类别词汇负有投影折叠形态声明义务（v1 规范钉死）。
   * 挂作用域 effect 栈随卸载自动回卷（/reload 重装重注册）；返回值供提前
   * 手动注销。注册成功后 ctx.sessions.appendEvent(type, data) 即可写。
   */
  registerSessionEventType(def: SessionEventTypeDefinition): () => void;
  /** 本作用域配置视图（只读快照；组合树行 config 经插件 schema 校验后冻结） */
  readonly config: Readonly<Record<string, unknown>>;
  /** 带作用域前缀的子 logger */
  readonly logger: PluginLogger;
  /** 生命周期信号：作用域销毁时 abort——长任务/定时器的取消依据 */
  readonly signal: AbortSignal;
}

/**
 * 插件唯一合法形状（§1.1）：一种函数，钉死。
 * 同步或异步初始化均可；接收 ctx（PluginContext——§1.2 注记④ 实类型面）与
 * 经 schema 校验后的只读配置。
 */
export type PluginApply = (ctx: PluginContext, config?: Readonly<Record<string, unknown>>) => void | Promise<void>;

/**
 * 插件模块的运行时契约（§1.2 named export 四件 + default）。
 * 加载器按此做形状校验（PLUGIN_SHAPE_INVALID），不做声明合并、不分派多形状。
 */
export interface PluginModule {
  /** 入口函数：注册自身贡献（一切注册走 ctx.effect/可逆注册 API——注册即 effect） */
  default: PluginApply;
  /** 行 id/日志归因标识（必填、非空字符串；与组合树行 id 可不同——不一致时告警不拒绝） */
  name: string;
  /** 硬依赖服务清单：声明即等待（轮次激活——全就绪才激活，无解响亮失败） */
  inject?: readonly string[];
  /** 软依赖服务清单：不阻塞激活、不超时失败；激活后经 ctx.tryGet 探测（缺省 undefined） */
  optionalInject?: readonly string[];
  /** 配置 JSON Schema（TypeBox 生成或手写）：组合树行 config 据此启动时一次性校验 */
  config?: TSchema;
  /**
   * 自定义活体事件声明（§1.1 逃生口，2026-08-23 M2 /reload 纵切）：name/mode/note
   * 三必填、name 小写含 `/`（防撞宿主词汇域）。加载器在装载阶段①（一切 apply 之前）
   * 统一登记——跨插件订阅无顺序洞；词汇集运行期恒定（boot//reload 两时点外不增不减）。
   */
  events?: readonly LiveEventDefinition[];
  /**
   * 插件自带技能目录清单（§1.2 第六件，2026-08-25 第二十二批即刻批① + 2026-08-26
   * 冷读闸回写）：相对**插件包根**（= 入口文件所在目录）的路径数组（如 `["./skills"]`，
   * 不用 glob）。加载器在行作用域 fork 后、apply 之前经注册回调桥接 skills 服务
   * package 层（context 不引 skills——组合根注入回调，拓扑 seam）；目录缺失产
   * `package-missing` warning 诊断不杀行。纯技能包 = 本字段 + name + default 空
   * 实现三件零逻辑即合法插件形态（superpowers 式技能生态直通）。
   */
  skills?: readonly string[];
}

/**
 * 官方件模块（§6.1 `builtin:` 前缀命名空间，2026-08-24 M2 记忆插件纵切）：
 * 与 PluginModule 同形，唯 apply 替位 default（宿主随包函数引用，不经 jiti、
 * 不受插件零 import 规则约束）。组合根官方件注册表按 `builtin:<name>` 收纳，
 * 装载管线与文件插件完全同轨（形状/config 校验、Kahn 轮次激活、三生命周期事件）。
 */
export interface BuiltinPluginModule extends Omit<PluginModule, 'default'> {
  /** 入口函数（与 PluginModule.default 同签名——命名差异只为「非模块导出」的语义清晰） */
  apply: PluginApply;
  /**
   * 包根锚点自述（2026-08-27 刀 1，契约篇 §3.4 第一刀细化段——builtin 件技能
   * 携带的桥接锚）：**仅 builtin 行生效的宿主侧扩展**——jiti 装载的文件插件
   * 模块对象上即使带此键也被加载器忽略（不入 validateModuleShape、不对第三方
   * 开放——包根可指插件目录外的暗道不存在），故挂本类型面而非 PluginModule
   * （named export 契约六件不动）。值由模块自身 `import.meta.url` 运行时求值
   * （dirname）——与文件插件的入口路径推导同为**位置事实而非声明**，结构上
   * 不可能漂；loader 技能桥优先取自述、无则回落入口推导（同一
   * PluginSkillsInfo.packageRoot 字段两来源，非两套机制）。
   */
  packageRoot?: string;
}

/** 组合树行（§5.1）：每行 = 一个插件实例，字段级后写胜出合成 */
export interface CompositionRow {
  /** 行 id：组合树中该插件实例的稳定标识（overlay 按 id 替换/insert/disable 的键） */
  id: string;
  /**
   * 插件引用：包名（装入 <数据目录>/plugins/node_modules 子树）或显式相对/绝对路径。
   * overlay 替换行省略 = 沿用官方层该 id 的引用只改其余字段；insert 行必须自带。
   */
  plugin?: string;
  /** 行配置（经插件声明 schema 校验后冻结注入 ctx.config；整体替换不做深合并） */
  config?: Record<string, unknown>;
  /**
   * 禁用：true = 静态禁用（行可见不激活）；平台字符串（'darwin'/'linux'/'win32'）
   * = 平台门控（命中当前平台才禁用）。fixed 行禁用 = 合成期即响。
   */
  disabled?: boolean | string;
  /** 官方默认层安全栈强制点标记：用户 overlay 不可 disable（仅官方层行可携带） */
  fixed?: boolean;
  /**
   * 运行域（契约篇 §1.7，2026-08-26 第二十七批刀二）：缺省 'main' = 同进程装载
   * （现行唯一路径）；'worker' = worker 分域装载（装载校验过界 + apply 在 worker
   * 域执行——**声明面零变化**：同一份插件代码/配置/事件声明，仅执行域不同，
   * 调用面允许异步收窄〔同步收窄清单见规范〕）。'external'（案三外部进程域）
   * 是预留词未开闸——值域校验只认 main/worker。
   */
  runtime?: 'main' | 'worker';
}

/** 跳过原因词汇（§2.2 增补 1：disabled 静态禁用 / platform 平台门控；目录信任略过随信任门补） */
export type PluginSkipReason = 'disabled' | 'platform';

/**
 * 装载计划行（组合树合成产物 → 加载器输入）：三态互斥——
 * 有 entry（文件插件）或 builtin（官方件）= 激活行；有 skip = 跳过行
 * （不 import，禁用不要求已装）；有 unresolved = 入口解析失败行。
 */
export interface PluginPlanRow {
  /** 组合树行 id */
  id: string;
  /**
   * 组合树行插件引用透传（装载身份串——组合树 `CompositionRow.plugin` 原样，
   * 含 `builtin:` 前缀串）。激活行与未解析行携带（归因完整）；skip 行不带。
   * 应用内存预算（budget.memoryMb）经它与清单 components 字面比对命中 worker 行（join 键）。
   */
  plugin?: string;
  /** 入口文件绝对路径（文件插件激活行必有；builtin 行无） */
  entry?: string;
  /** 官方件模块引用（`builtin:` 行激活时必有——注册表查得，不经 jiti） */
  builtin?: BuiltinPluginModule;
  /** 行配置（激活行可有；经插件 schema 校验后注入） */
  config?: Record<string, unknown>;
  /** 跳过原因（有值即不激活） */
  skip?: PluginSkipReason;
  /** 入口解析失败原因（加载器永不自动安装——进启动断言指引安装） */
  unresolved?: string;
  /**
   * 运行域（CompositionRow.runtime 透传——worker 行在加载器里走分域装载管线：
   * 装载校验过界 + apply 于 worker 域执行，契约篇 §1.7）
   */
  runtime?: 'main' | 'worker';
}

/**
 * plugin/activated 载荷：{ 组合树行 id, 插件声明名, apply 耗时打点 }。
 * applyMs（B2 P5 打点先行，2026-08-27 刀〇a）：装载器激活计时（fork→apply 返回
 * 的墙钟差）——诊断面（/plugins、dump-config）展示每插件启动开销，为后续阈值
 * 调校供数据，不参与任何控制流。
 */
export interface PluginActivatedPayload {
  readonly id: string;
  readonly name: string;
  /** apply 耗时（毫秒，含技能注册回调；不含 import/形状校验——那是装载期不是激活期） */
  readonly applyMs: number;
  /**
   * 本 boot 装载期声明的自定义事件词名清单（契约篇 §3.4 第二刀，2026-08-27
   * 刀 2——词表三档的 live 档来源）：装载阶段①登记词汇处顺带收割名字随载荷
   * 上行；undefined = 未声明任何自定义事件。uninstall 检视对 activated 行优先
   * 读本档（活词表优先于 data.json 账本——同一次装载的真值）。不参与控制流。
   */
  readonly events?: readonly string[];
}

/** plugin/failed 载荷：{ 组合树行 id, 错误码（PLUGIN_ 族）, 错误信息 } */
export interface PluginFailedPayload {
  readonly id: string;
  readonly code: string;
  readonly message: string;
}

/** plugin/skipped 载荷：{ 组合树行 id, 跳过原因 } */
export interface PluginSkippedPayload {
  readonly id: string;
  readonly reason: PluginSkipReason;
}

/** 加载结果（组合根启动断言与 ctx.plugins.list 的数据源） */
export interface PluginLoadResult {
  /** 激活成功的行（组合树行 id + 插件声明名） */
  readonly activated: readonly PluginActivatedPayload[];
  /** 失败的行（启动断言响亮列出——组合根据此拒绝启动） */
  readonly failed: readonly PluginFailedPayload[];
  /** 跳过的行（显式禁用/平台门控——可见但不激活） */
  readonly skipped: readonly PluginSkippedPayload[];
}
