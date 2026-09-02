/**
 * L0 contracts — 工具族契约（内核篇模块表 #7：管道接口在 contracts，
 * 实现可换但不得绕过 pre-execute；应用契约篇 §3.1 三段 waterfall）。
 *
 * 本文件收两类词汇：
 * 1. AgentTool 族——loop 可执行的工具面（原定义于 agent 模块，因 tools 模块
 *    （L2）与 agent（L1）都需引用，唯一会合点上移契约层；先例：llm 的
 *    StreamFn 三类型上移 contracts/llm.ts）；
 * 2. 工具管道契约——defineTool 注册面（ToolDefinition/ToolCtx）与三段
 *    waterfall 的段间载荷（GateInput/GateAction/ExecuteInput/PostInput）。
 */

import type { ImageContent, TextContent, Usage } from './llm.js';

/* 内容块类型再导出（AgentToolResult.content 的构成件——工具件层组结果用；
 * 2026-08-26 随 64KiB 输出护栏接线导出：tools/pipeline 组截断注记块引用） */
export type { TextContent, ImageContent };

/* ------------------------------------------------------------------ */
/* 一、AgentTool 族（loop 执行面；agent/tools.ts 再出口保持兼容）        */
/* ------------------------------------------------------------------ */

/**
 * 工具批执行策略（骨架篇 §2.2 toolExecution 回调的取值）。
 * - sequential：逐个「准备 → 执行 → 收尾」后下一个才开始（默认，拍板值）；
 * - parallel：全部先顺序预检，允许并行的工具并发执行，end 事件按完成序、
 *   结果消息按 assistant 源序。
 */
export type ToolExecutionMode = 'sequential' | 'parallel';

/** 工具执行结果（最终或部分） */
export interface AgentToolResult<TDetails = unknown> {
  /** 回给模型的文本/图片内容 */
  content: (TextContent | ImageContent)[];
  /** 供日志/UI 的结构化明细（不进主上下文） */
  details?: TDetails;
  /**
   * 本结果携带错误身份（2026-08-23 生态读码补钉 pi-10/dsh-1）：
   * true = 结果是错误（失败/拒绝/超时），模型与投影按错误对待；
   * 缺省 false = 正常结果。此前错误身份只活在 loop 局部变量与 ToolResultMessage
   * 上，管道合成的错误结果（TOOL_TIMEOUT/TOOL_BLOCKED 等）无法在 result 自身
   * 声明——durable 持久化与 UI 投影只能靠文本嗅探，是 pi 生态同款病。
   */
  isError?: boolean;
  /** 工具执行自身的用量（若可得上报） */
  usage?: Usage;
  /** 本结果引入且自此可用的工具名（契约篇 §3.3：结果驱动的工具挂载） */
  addedToolNames?: string[];
  /** 批级早停提示（整批一致才生效） */
  terminate?: boolean;
}

/** 工具进度回调（partial 结果流式上报；promise 结算后的调用被忽略） */
export type ToolUpdateCallback = (partialResult: AgentToolResult) => void;

/**
 * loop 可执行的工具定义。
 * execute 抛错 = 工具失败（loop 编码为 isError 结果，错误是数据）；
 * 参数 schema 校验由 tools 模块守门段承担（见下方管道契约）。
 */
export interface AgentTool {
  name: string;
  description: string;
  /** UI 展示标签（缺省用 name） */
  label?: string;
  /** JSON Schema 参数描述（TypeBox 产物；loop 不校验，守门段校验） */
  parameters: object;
  /** 工具级执行策略覆盖（缺省随 loop 配置；sequential 强制整批串行） */
  executionMode?: ToolExecutionMode;
  /** 原始参数兼容垫片（schema 校验前整形，须返回符合 parameters 的对象） */
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  /** 执行（失败直接 throw；进度经 onUpdate 上报；应对齐 signal 取消） */
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<AgentToolResult>;
}

/* ------------------------------------------------------------------ */
/* 二、工具管道契约（应用契约篇 §3.1——工具执行唯一合法路径）            */
/* ------------------------------------------------------------------ */

/**
 * 管道执行器（三段管道的包装面——Ring 1 行树化批 2026-08-26 类型安家 contracts：
 * 服务面携带它，宿主消费方〔exec 服务等〕与行替换件同源同过守门）。
 * 类型单一来源在此，tools/pipeline 再导出（实现注释见彼处）。
 * 第 6 参 origin（2026-08-27 P1-2，契约篇 §2.2 增补 7③ + §3.1 callOrigin 条）：
 * 调用面类别闭集——'model'（loop 模型工具路，toAgentTool 包装显式传）/
 * 'service'（宿主服务面复入——exec/web fetch 服务两调用点传）；缺省 undefined
 * = 未知面（诊断形态等），三 Input 的 callOrigin 随之缺席。**是调用面类别而非
 * 调用者身份**——不触 GateInput caller 禁令（§3.1 dsh-10 + 第二十三批终裁）。
 */
export type ToolPipelineExecutor = (
  def: ToolDefinition,
  toolCallId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: ToolUpdateCallback,
  origin?: ToolCallOrigin,
  /** 发起会话 id（驱动 per-entry 绑定注入；落 ToolCtx.sessionId——契约篇 §6.10，第四十九批） */
  sessionId?: string,
) => Promise<AgentToolResult>;

/**
 * 工具调用面类别（P1-2 增补 7③——§3.1「callOrigin 调用面类别」条的值域）：
 * - 'model'：模型工具调用（loop 经 toAgentTool 包装进管道）；
 * - 'service'：宿主服务面复入（exec 服务/web fetch 服务在同一管道执行——
 *   守门行按面别分叉〔如服务路不按模型工具面审批〕的显式判别词，取代
 *   对合成 def 名的字符串嗅探）。
 * 同一会话同一 agent 的服务复入同样走 'service'——面别差异，非主体差异。
 */
export type ToolCallOrigin = 'model' | 'service';

/**
 * ctx.tools 服务面（契约篇 §1.5 服务行 + §1.2 注记④——类型单一来源住 contracts，
 * 2026-08-25 Hermes 探针 #11 落码；tools 模块实现之，第三方经
 * `ctx.get<ToolsService>('tools')` 取全类型）。
 */
export interface ToolsService {
  /**
   * 管道执行器（三段管道包装面——Ring 1 行树化批：件 apply 构造并随服务携带）。
   * undefined = 无管道诊断形态（toAgentTool 的执行响亮失败——装配缺陷不留静默）。
   * bash 工具与 ctx.exec 服务两层并存时经它同源：行替换件换了管道，两层一起换。
   */
  readonly executor: ToolPipelineExecutor | undefined;
  /**
   * 注册工具（即时生效；返回注销器，幂等）。同名注册 = TOOL_DUPLICATE 响亮失败——
   * 替换唯一合法路径是组合树行级操作。
   *
   * 三层注册表（域键升级批，契约篇 §5.4「域键升级（appId 批）射面细化」）：
   * - 缺省注册进**全局层**（caller 无关纯机制，全部会话可见）；
   * - 携 `domain` 键注册进**应用域层**（键 = appId——组合域 = 应用清单声明的工具
   *   工具面运行时投影的本义归宿；首批住客随清单投影批到达，v1 空层）；
   * - 携 `driver` 键注册进**驱动层**（键 = sessionId——fs 四名 + bash 的归宿：
   *   它们不是应用清单声明的，是驱动基建〔观察态 per-driver + 升权闭包绑本驱动
   *   approval〕）。**驱动层注册须双键同携**（`driver` + `domain`=本驱动 appId）——
   *   碰撞域界定需要；缺 domain = APP_INVALID 响亮拒。
   * - 域归属**装配期定型、禁调用链推断**（dsh-10 边界三判）。查重碰撞域三层推广
   *   （「任何单一组合面内不得双名」——组合面 = 一个 toolView 的组成集）：全局层
   *   注册查全局 ∪ 全部应用域 ∪ 全部活驱动层；应用域[A] 注册查全局 ∪ 应用域[A] ∪
   *   app=A 的活驱动层；驱动层注册查全局 ∪ 应用域[本 app] ∪ 驱动层[本 sessionId]。
   *   跨应用同名合法（永不同面）。
   */
  register(def: ToolDefinition, opts?: { readonly domain?: string; readonly driver?: string }): () => void;
  /** 按名查找（**全局层同口径**——只查全局层；未注册返回 undefined，调用方决定 fail 形态） */
  get(name: string): ToolDefinition | undefined;
  /** 全局层全量快照（次序 = 注册序；诊断面/无会话语境的消费方用） */
  list(): ToolDefinition[];
  /**
   * 应用域视角全量快照 = 全局层 ∪ 该应用域层（次序 = 全局注册序在前、应用域注册序
   * 在后；键 = appId——域键升级批键义升级，参数从 sessionId 改 appId）。子装配
   * 派生（子代理工具面）即此面——驱动层内容（fs 四名 + bash）结构上不在本面，
   * 「−内核固定词五名」排除集随之退役。未知应用键 = 空应用域层，只返回全局层。
   */
  listFor(app: string): ToolDefinition[];
  /**
   * 驱动组成面 = 全局层 ∪ 本驱动应用域层 ∪ 本驱动层（域键升级批新增——组成面不能
   * 只活在 chat 件 open 的局部算式里，goal 续跑 wakeToolFilter 等运行期消费方需要
   * 同一投影）。键 = sessionId（注册表自持「驱动层条目 → 双键」登记，消费方只传
   * 一个键）。未知 sessionId（子代理会话/退役条目/persist:false 诊断形态）= 无
   * 驱动语境，返回全局层（与 list() 同口径的诚实回落）。
   */
  compositionFor(sessionId: string): ToolDefinition[];
  /**
   * loop 面适配：包一层三段管道的 AgentTool（薄适配器，无状态）。
   *
   * 执行绑定面（S5 契约篇 §5.4 第 6 条④冷读闸 F2 修死）：缺省绑服务构造时的
   * 全局管道；驱动侧传 `{pipeline}` 显式绑**本驱动管道**（fresh 作用域三段——
   * per-driver 守门/审批/落账的执行入口）。toAgentTool 仍是唯一包装位，执法点不裂。
   *
   * `{sessionId}`（2026-08-31 第四十九批，冷读 B2）：驱动侧 per-entry 绑定时携带——
   * 传入管道第 7 参并落 ToolCtx.sessionId（per-session 语境工具的路由键，契约篇 §6.10）。
   */
  toAgentTool(
    def: ToolDefinition,
    opts?: { readonly pipeline?: ToolPipelineExecutor; readonly sessionId?: string },
  ): AgentTool;
  /**
   * 注册面打点（B2 P5 打点先行，2026-08-27 刀〇a）：registered = 现存件数
   * （全局层 + 全部域层）；totalAdds/totalRemoves = 开机以来累计注册/注销次数
   * （高频注册武器化监控的数据源——阈值执法随护栏族另批，本面只出数）。
   */
  stats(): { registered: number; totalAdds: number; totalRemoves: number };
}

/** 守门段活体事件名（dsh 借词，契约篇 §2.2 表钉死下划线形态） */
export const TOOL_PRE_EXECUTE_EVENT = 'tools_pre_execute';
/** 执行段活体事件名 */
export const TOOL_EXECUTE_EVENT = 'tools_execute';
/** 后处理段活体事件名 */
export const TOOL_POST_EXECUTE_EVENT = 'tools_post_execute';
/** 工具集变更活体事件名（动态注册/禁用后触发请求重组装） */
export const TOOLS_CHANGE_EVENT = 'tools_change';

/**
 * 装载面注册 timeoutMs 下限（毫秒——契约篇 §1.6 注册预算下限，2026-08-27
 * 刀〇a；定向复扫 20260902 第七轮 M-1 迁此单源）：正数过小钳至此值，<= 0
 * 拒绝（TOOL_TIMEOUT_INVALID）。原宿主位 = tools/registry.ts；分域声明面
 * （bridge worker makeToolsStub——双载体唯一声明面）同律钳位后过界，宿主
 * execute 闭包桥预算腿与 registry 存储副本腿两腿同值（「不换协议只换载体」
 * 等价性）。bridge 对 tools 无拓扑边，故常量落契约层两消费面同源。
 */
export const TOOL_TIMEOUT_FLOOR_MS = 1000;

/**
 * 工具执行上下文（ToolDefinition.execute 的第二参数）。
 * 与 AgentTool.execute 签名的关系：管道把 loop 侧 (toolCallId, signal,
 * onUpdate) 收拢为本对象后调工具实现。
 */
export interface ToolCtx {
  /** 本次调用的 id（审批/日志/gate 决策关联键） */
  toolCallId: string;
  /** 取消信号（用户中断/会话中止时 abort；长任务实现应对齐响应） */
  signal?: AbortSignal;
  /** partial 结果上报（promise 结算后的调用由管道侧忽略） */
  onUpdate?: ToolUpdateCallback;
  /**
   * 发起本次调用的会话 id（工具执行段创建处填值——执行恒发生在某驱动的 run 内）。
   * 可选：per-session 语境工具（首个消费者 = browser 件 context 路由，契约篇 §6.10）；
   * §3.1 禁令管守门按 caller/session 分叉，不管工具实现取会话语境——此字段不进守门面。
   * 2026-08-31 第四十九批契约面加法（冷读 B2 裁决）。
   */
  sessionId?: string;
}

/**
 * ctx.tools.register 的注册面（应用契约篇 §3.1 defineTool 形状，钉死）。
 * 与 AgentTool 的差异：应用只写「做什么」，管道补「怎么执行」
 * （schema 校验 → 三段 waterfall → 超时预算）。
 */
export interface ToolDefinition {
  /** 工具名（模型调用词汇；注册表内唯一） */
  name: string;
  /** 给模型看的能力描述 */
  description: string;
  /** JSON Schema 参数描述（TypeBox 产物或等价 JSON Schema 对象） */
  parameters: object;
  /**
   * 读写性声明（2026-08-24 第十一批，契约篇 §3.1——loopx 读码启发 #4 最小版）：
   * 声明面供守门策略统一决策（只读模式拦全部 write、工具子集按 effect 过滤），
   * 不必逐工具理解 args；执行面强制不变（fence/沙箱/carve-out 照走）。
   * 注册时归一：缺省按 'write' 保守处理（未知工具不放过只读策略，fail-closed）。
   */
  effect?: 'read' | 'write';
  /** 执行时长预算毫秒（缺省用管道默认值；超时替换为结构化 TOOL_TIMEOUT 错误） */
  timeoutMs?: number;
  /** UI 展示标签（缺省用 name） */
  label?: string;
  /** 执行（失败直接 throw AppError；错误码是身份，见内核篇 §5.3） */
  execute(args: Record<string, unknown>, ctx: ToolCtx): Promise<AgentToolResult>;
}

/**
 * 守门段入参（可变对象——mutate 语义靠就地改写 args 实现）。
 * waterfall 链上 args 对整条链固定：守门者改 input.args 即改了执行段所见。
 */
export interface GateInput {
  /** 目标工具定义（只读参考） */
  tool: ToolDefinition;
  /** 调用参数（可变：mutate 决策就地改写本对象字段） */
  args: Record<string, unknown>;
  /** 调用 id（审批/日志关联） */
  callId: string;
  /** 链上已有守门者改写过 args（管道汇总 mutate 决策用，守门者置 true） */
  mutated: boolean;
  /**
   * 放行来源标注（可变：守门者免问放行时置——如 `allowlist:<条目序>`；
   * 第二十四批题1a：免问仍可审计，gate/decision 的 reason 不再统一 'ok'。
   * 缺省不置 = 无标注（pipeline 落 'ok'）。
   */
  allowReason?: string;
  /**
   * 调用面类别（P1-2 增补 7③——管道从执行器第 6 参透传；'model' 模型工具
   * 调用 / 'service' 宿主服务面复入，缺省 undefined = 未知面）。守门按它
   * 分叉是面别差异（合法），按 caller/session 分叉是主体差异（§3.1 禁令）。
   */
  callOrigin?: ToolCallOrigin;
  /**
   * 发起 run 的取消信号（interrupt 小刀：管道从执行器第 4 参透传）——调用方
   * 语境字段，与 callId 同性质：safety gate 建 ask 载荷时携带进
   * ApprovalRequest.signal，由 answerer 桥接消费（run abort 即撤销在身审批
   * 提问）；守门者不按它分支（dsh-10 同界）。
   */
  signal?: AbortSignal;
}

/** 守门决策（守门监听器的返回值） */
export type GateAction =
  /** 放行（继续链上后续守门者） */
  | { decision: 'allow' }
  /** 拒绝（短路：结构化拒绝结果直接返回模型，不进执行段） */
  | { decision: 'block'; reason: string }
  /** 改参（就地改写 input.args 后继续；须同步置 input.mutated = true） */
  | { decision: 'mutate' };

/** 执行段入参（可变对象；around-dispatch 接管者读它执行替换逻辑） */
export interface ExecuteInput {
  tool: ToolDefinition;
  /** 守门后的最终参数（可能已被 mutate） */
  args: Record<string, unknown>;
  callId: string;
  signal?: AbortSignal;
  onUpdate?: ToolUpdateCallback;
  /** 调用面类别（P1-2 增补 7③——同 GateInput.callOrigin，管道透传） */
  callOrigin?: ToolCallOrigin;
}

/** 后处理段入参（可变对象——改写 result 靠就地改写字段） */
export interface PostInput {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  callId: string;
  /** 工具结果（可变：裁剪/spill/usage 改写就地作用于本对象） */
  result: AgentToolResult;
  /** 调用面类别（P1-2 增补 7③——同 GateInput.callOrigin，管道透传） */
  callOrigin?: ToolCallOrigin;
}

/**
 * gate/decision durable 载荷（结构同形于 session 模块 GateDecisionData——
 * 会话篇 §1.1；tools 不依赖 session，装配层把本回调接线到 session.append）。
 * 不变式：任何 tool/result 前序（同 turn 内、对应 toolCallId）必含一条。
 */
export interface GateDecisionPayload {
  readonly toolCallId: string;
  readonly decision: 'allow' | 'block' | 'mutate';
  readonly reason: string;
}

/** 管道侧 gate/decision 回调（app 装配层注入，写 durable 事件；抛错 = 装配错误上抛） */
export type GateDecisionSink = (payload: GateDecisionPayload) => void;
