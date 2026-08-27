/**
 * L0 contracts — 子代理委派类型（运行时骨架篇 §6.1 钉死 + 纵切二落码注记，2026-08-24）。
 *
 * 子代理 = 一次性后台/前台委派的受控子运行（subagent 模块托管）：
 * - provider 契约：五布尔能力声明 + start → 执行体；能力协商 = **启动时布尔检查**
 *   （请求的能力 provider 未声明 → start 前 fail-loud，不做运行时协商）【dsh】；
 * - 子中间过程**永不进父上下文**：父只收到结算契约（SubagentResult）【dsh】；
 * - in-process provider 经工厂回调装配（每子独立装配 dsh-10——见 subagent/inprocess.ts）。
 */
import type { Usage } from './llm.js';
import type { JobHandle } from './jobs.js';

/**
 * provider 能力声明（五布尔，声明式——§6.1 钉死；context 位 = 第三十一批）。
 * 请求面携带对应字段而 provider 未声明 → start 前 SUBAGENT_CAPABILITY_UNSUPPORTED。
 */
export interface SubagentCapabilities {
  /** 支持结构化输出（请求 outputSchema；v1 in-process 不支持——pi-ai 无此腿） */
  readonly outputSchema: boolean;
  /** 支持委派深度上限执法（请求 maxDepth；in-process 声明并执法装配默认帽） */
  readonly depthLimit: boolean;
  /** 支持工具子集过滤（请求 toolFilter——include 名单） */
  readonly toolFilter: boolean;
  /** 支持自定义人格/系统提示（请求 persona） */
  readonly persona: boolean;
  /** 支持携带父会话尾轮投影上下文（请求 context——第三十一批 context 腿） */
  readonly context: boolean;
}

/**
 * 子运行终态（§6.1 显式注册可扩展——字面量联合 + 字符串逃生口）。
 * 枚举映射：裸 loop 只产 completed/aborted/failed→completed/aborted/error；
 * max-tokens 由预算帽包装层改判或外部 provider 上报；refusal 仅外部 provider。
 */
export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' | (string & {});

/** 子代理结算契约（父收到的全部——中间过程不进父上下文） */
export interface SubagentResult {
  /** 最后一条非空 assistant 文本（无则空串） */
  readonly output: string;
  /** 结构化输出（仅当声明 outputSchema 且请求携带——v1 in-process 不产生） */
  readonly structured?: unknown;
  /** 脱敏诊断信息（≤4096 字节；失败原因/截断说明等） */
  readonly diagnostic?: string;
  /** 子代理 token 用量（结算折叠并入父会话统计——外部 provider 报不上则省） */
  readonly usage?: Usage;
  /** 终态（§6.1 枚举映射点） */
  readonly stopReason: SubagentStopReason;
}

/** provider.start 的请求面（服务面已过能力协商；provider/background 字段已剥离） */
export interface SubagentStart {
  /** 任务指令（子首条用户消息） */
  readonly prompt: string;
  /** 人读标签（诊断/Job 显示） */
  readonly label?: string;
  /** 父会话 id（结算通知路由键；in-process 工厂侧闭包持父 Session，此字段供对账） */
  readonly ownerSessionId?: string;
  /** 结构化输出 schema（需 provider 声明 outputSchema） */
  readonly outputSchema?: unknown;
  /** 委派深度上限（需 provider 声明 depthLimit；in-process 与装配默认帽取 min） */
  readonly maxDepth?: number;
  /** 工具 include 名单（需 provider 声明 toolFilter） */
  readonly toolFilter?: readonly string[];
  /** 人格/系统提示覆盖（需 provider 声明 persona） */
  readonly persona?: string;
  /**
   * 子模型标识覆盖（声明式 agent frontmatter model——契约篇 §4.4 声明式子代理
   * 落码注记③）。**不进能力协商面**：v1 单实现族（in-process 家族）恒支持
   * （工厂兜底缺省模型）；外部 provider 收编件出现时再裁加能力位。
   * 格式与装配缺省模型同源（`provider/model-id`）。
   */
  readonly model?: string;
  /**
   * 携带父会话尾轮投影上下文（第三十一批 context 腿，需 provider 声明 context）：
   * in-process 实现 = fork 种子边界（lastClosedTurnBoundary）之内的投影裁尾
   * recentTurns 轮（user 消息边界），作子首请求 LLM 消息种子——durable 有上文、
   * 模型看见的豁口收口。缺省不携带（messages 仍空种子）。
   */
  readonly context?: { readonly recentTurns: number };
}

/** provider 执行体（start 产物——dispose 幂等；服务面包装为 SubagentRun） */
export interface SubagentExecution {
  /** 子运行 id（in-process = 子会话 id；外部 = provider 自铸） */
  readonly id: string;
  /** 结算 promise（永不 reject——异常一律转 stopReason='error' 的结算契约） */
  readonly result: Promise<SubagentResult>;
  /** 幂等收工请求：abort 子运行 + 释放子所有权（§6.2 dispose 序列） */
  dispose(): void;
}

/** 子代理 provider 契约（§6.1 钉死；实现见 subagent/inprocess.ts 与外部收编插件） */
export interface SubagentProvider {
  /** provider 名（ctx.subagents.register 撞名即拒） */
  readonly name: string;
  /** 人读描述（声明式 agent = 文件 frontmatter description；披露段清单行用。
   * 内建 provider 缺省 undefined——清单段只列名+能力位） */
  readonly description?: string;
  /** 能力声明（五布尔——协商数据源） */
  readonly capabilities: SubagentCapabilities;
  /** 启动一次性子运行（请求已过服务面能力协商检查） */
  start(request: SubagentStart): SubagentExecution;
}

/** 服务面请求（SubagentStart 全字段 + 路由/形态两字段） */
export interface SubagentRequest extends SubagentStart {
  /** 目标 provider 名（SUBAGENT_PROVIDER_NOT_FOUND） */
  readonly provider: string;
  /** true = 注册进 Job 注册表（kind='subagent'）立即返回 job 句柄（§6.2）；
   * 缺省 false = 前台等待结算 */
  readonly background?: boolean;
}

/** 服务面启动产物（SubagentExecution + provider 名 + 后台模式的 Job 句柄） */
export interface SubagentRun extends SubagentExecution {
  /** 实际承载的 provider 名 */
  readonly provider: string;
  /** background:true 时注册的 Job 句柄（cancel 即子收工；前台模式 undefined） */
  readonly job?: JobHandle;
}

/** list() 只读清单项（委派工具披露面：名 + 能力声明） */
export interface SubagentProviderInfo {
  readonly name: string;
  readonly capabilities: SubagentCapabilities;
  /** 人读描述（声明式 agent 披露依据；内建 provider 缺省） */
  readonly description?: string;
}

/**
 * 结算回调载荷（§6.4 落码注记——service opts.onSettle 的入参）：
 * background 链 = Job settle → onSettle → execution.dispose（通知先于子所有权释放）；
 * foreground 链 = onSettle 后 dispose 归调用方。装配层据此做结算折叠（llm/usage）
 * 与三通道通知（app/notify.ts）。
 */
export interface SubagentSettlement {
  /** 原始请求（background/ownerSessionId 路由键在此） */
  readonly request: SubagentRequest;
  /** provider 执行体（id = 幂等身份/callId 候选） */
  readonly execution: SubagentExecution;
  /** 结算契约（父收到的全部） */
  readonly result: SubagentResult;
  /** background:true 时的 Job 句柄（终态已落；前台 undefined） */
  readonly job?: JobHandle;
}

/**
 * ctx.subagents 服务面（骨架篇 §9.2 落码形态；实现见 subagent/service.ts）。
 * 能力协商/Job 映射在服务面统一持有——provider 只见已协商的 SubagentStart。
 */
export interface SubagentsServiceFace {
  /** 注册 provider（撞名 SUBAGENT_PROVIDER_DUPLICATE）；返回注销 Disposer */
  register(provider: SubagentProvider): () => void;
  /** 已注册 provider 清单（注册序） */
  list(): readonly SubagentProviderInfo[];
  /** 启动一次性委派：查 provider → 能力协商布尔检查 → provider.start；
   * background:true 经 ctx.jobs 注册（stopReason→Job 终态映射见落码注记） */
  start(request: SubagentRequest): SubagentRun;
}
