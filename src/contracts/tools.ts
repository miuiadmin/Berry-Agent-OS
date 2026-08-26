/**
 * L0 contracts — 工具族契约（内核篇模块表 #7：管道接口在 contracts，
 * 实现可换但不得绕过 pre-execute；插件契约篇 §3.1 三段 waterfall）。
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
/* 二、工具管道契约（插件契约篇 §3.1——工具执行唯一合法路径）            */
/* ------------------------------------------------------------------ */

/**
 * 管道执行器（三段管道的包装面——Ring 1 行树化批 2026-08-26 类型安家 contracts：
 * 服务面携带它，宿主消费方〔exec 服务等〕与行替换件同源同过守门）。
 * 类型单一来源在此，tools/pipeline 再导出（实现注释见彼处）。
 */
export type ToolPipelineExecutor = (
  def: ToolDefinition,
  toolCallId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: ToolUpdateCallback,
) => Promise<AgentToolResult>;

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
   * 两层注册表（S2 契约篇 §3.2）：缺省注册进**全局层**（全部会话可见）；携带
   * `domain` 键注册进**域层**（仅该域会话经 listFor 可见——组合域 = 应用清单声明
   * 的工具面运行时投影，v1 域键 = sessionId）。域键**装配期定型、禁调用链推断**
   * （dsh-10 边界三判）。查重**双向对称**：域层注册查全局层 ∪ 本域；全局层注册查
   * 全局层 ∪ **全部活域**（防 mcp 异步后到同名与域层工具在 listFor 面出双名）。
   */
  register(def: ToolDefinition, opts?: { readonly domain?: string }): () => void;
  /** 按名查找（**全局层同口径**——只查全局层；未注册返回 undefined，调用方决定 fail 形态） */
  get(name: string): ToolDefinition | undefined;
  /** 全局层全量快照（次序 = 注册序；诊断面/无会话语境的消费方用） */
  list(): ToolDefinition[];
  /**
   * 域视角全量快照 = 全局层 ∪ 该域层（次序 = 全局注册序在前、域注册序在后；
   * S2 契约篇 §3.2）。会话侧消费方（驱动工具面/续跑收窄/子装配派生）一律走
   * 此口——域键 v1 = sessionId。未知域键 = 空域层，只返回全局层（合法形态）。
   */
  listFor(domain: string): ToolDefinition[];
  /** loop 面适配：包一层三段管道的 AgentTool（薄适配器，无状态） */
  toAgentTool(def: ToolDefinition): AgentTool;
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
}

/**
 * ctx.tools.register 的注册面（插件契约篇 §3.1 defineTool 形状，钉死）。
 * 与 AgentTool 的差异：插件只写「做什么」，管道补「怎么执行」
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
}

/** 后处理段入参（可变对象——改写 result 靠就地改写字段） */
export interface PostInput {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  callId: string;
  /** 工具结果（可变：裁剪/spill/usage 改写就地作用于本对象） */
  result: AgentToolResult;
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
