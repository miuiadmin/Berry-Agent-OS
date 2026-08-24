/**
 * L0 contracts — 插件与组合树契约类型（插件契约篇 §1/§5.1，2026-08-23 M2 加载器本体纵切）。
 *
 * 三个词汇族：
 * 1. 插件模块形状（PluginModule——§1.1 单形状钉死 + §1.2 named export 三件）；
 * 2. 组合树行（CompositionRow——§5.1 空根 + 官方默认层 + 用户 overlay）；
 * 3. 装载计划与生命周期载荷（PluginPlanRow / Plugin*Payload——§2.2 增补 1 事件组）。
 *
 * 注意：PluginModule.default 的 ctx 参数在此只做结构占位（contracts 不依赖
 * context 模块——拓扑零依赖层）；插件作者取完整类型经宿主公共面 `berryagent`
 * 的再导出（加载器虚拟注入），运行时校验只查形状（函数/字符串/schema）。
 */

import type { TSchema } from './typebox.js';
import type { LiveEventDefinition } from './events.js';

/**
 * 插件唯一合法形状（§1.1）：一种函数，钉死。
 * 同步或异步初始化均可；接收 ctx（作用域 fork 产物）与经 schema 校验后的只读配置。
 */
export type PluginApply = (ctx: never, config?: Readonly<Record<string, unknown>>) => void | Promise<void>;

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
}

/** plugin/activated 载荷：{ 组合树行 id, 插件声明名 } */
export interface PluginActivatedPayload {
  readonly id: string;
  readonly name: string;
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
