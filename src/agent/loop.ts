/**
 * L1 agent — loop 骨架（骨架篇 §2，内核件 Q5）。
 *
 * 双层 while 照 pi runLoop 实测蓝本。硬约束（骨架篇 §2.1 钉死）：
 * - runLoop 本体 ≤150 行、零 try/catch、零存储感知（不 import session/persist，
 *   不读盘不落盘——持久化与恢复由外层装配承担）；
 * - loop 层零重试：遇 error/aborted 收尾即终（重试分层归 provider/会话层，§3.2）；
 * - run 级异常兜底不在内核：回调违约抛错直接向上传播，由 app 装配层合成为
 *   assistant error 消息补齐完整事件序列（永不把 try/catch 塞进 loop）。
 * 工具执行辅助函数内的 catch 是「错误编码为数据」（error toolResult），不是异常控制流。
 */

import { AGENT_CONTINUE_INVALID, AppError, describeError } from '../contracts/errors.js';
import type {
  AssistantMessage,
  AssistantStream,
  ImageContent,
  LlmContext,
  LlmTool,
  Message,
  StopReason,
  StreamFn,
  TextContent,
  ThinkingLevel,
  ToolResultMessage,
  Usage,
} from '../contracts/llm.js';
import type { AgentEventSink, RunStatus } from './events.js';
import type { AgentMessage } from '../contracts/messages.js';
import type { AgentTool, AgentToolCall, AgentToolResult, ToolExecutionMode } from './tools.js';

// 模型层注入面三类型已上移 contracts/llm.ts（agent 与 llm 的唯一会合点——llm 模块
// 产出该签名却不可依赖 agent，类型必须住在契约层）；此处再出口保持 agent 消费方兼容
export type { StreamFn, StreamFnOptions, ThinkingLevel } from '../contracts/llm.js';

/* ---------------- 上下文与回调面 ---------------- */

/** loop 运行上下文快照（convertToLlm 前的 AgentMessage 级全量） */
export interface AgentContext {
  systemPrompt?: string;
  /** 会话转录（调用方持有的活数组；loop 在其尾部追加/替换流式消息） */
  messages: AgentMessage[];
  /** 本次 run 可用工具 */
  tools?: AgentTool[];
}

/** 下一轮替换项（prepareNextTurn 返回；换模型与压缩的唯一合法时机，骨架篇 §2.2） */
export interface AgentTurnUpdate {
  context?: AgentContext;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

/** turn 完成信息（shouldStopAfterTurn / prepareNextTurn 的入参） */
export interface TurnDoneInfo {
  /** 本 turn 完成的 assistant 消息 */
  message: AssistantMessage;
  /** 本 turn 的工具结果消息（空批 = 无工具调用） */
  toolResults: ToolResultMessage[];
  /** 当前上下文（assistant 消息与工具结果已追加） */
  context: AgentContext;
  /** 本次 run 新增的全部消息（prompt 注入含于 startRun，续跑不含既有上下文） */
  newMessages: AgentMessage[];
}

/** beforeToolCall 拦截结果（骨架篇 §2.2：block / terminate；整批 terminate 才早停） */
export interface BeforeToolCallResult {
  /** true = 阻止执行，loop 合成 isError 工具结果 */
  block?: boolean;
  /** 阻止时的结果说明（缺省用固定文案） */
  reason?: string;
  /** 批级早停提示（整批一致才生效） */
  terminate?: boolean;
}

/**
 * 进模型步前拦截结果（骨架篇 §6.8 刀三 T7-A ④——agent_pre_step 落码）：
 * 返回 { stop: true } = 不发起本次模型调用、run 正常收场（completed——
 * 「正在跑的轮跑完为止」仲裁纪律不破，状态面处置归回调方自身——停因分立）。
 */
export interface PreStepDecision {
  readonly stop: true;
}

/** afterToolCall 改写结果（字段级整体替换，无深合并；缺省字段保持原值） */
export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  usage?: Usage;
  terminate?: boolean;
}

/** beforeToolCall 入参 */
export interface BeforeToolCallInfo {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  /** prepareArguments 整形后的参数（schema 校验归 tools 模块守门段） */
  args: Record<string, unknown>;
  context: AgentContext;
}

/** afterToolCall 入参 */
export interface AfterToolCallInfo {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  args: Record<string, unknown>;
  /** 执行结果（改写前） */
  result: AgentToolResult;
  isError: boolean;
  context: AgentContext;
}

/**
 * loop 回调面（骨架篇 §2.2 表逐行；全部策略的挂载点，内核不含任何策略）。
 * 契约纪律：所有回调不得 throw——违约即打断正常事件序列，由 app 装配层兜底。
 */
export interface AgentLoopConfig {
  /** 模型层整体注入（必备；loop 对模型层零 import） */
  streamFn: StreamFn;
  /** 初始模型 id（prepareNextTurn 可逐轮替换） */
  model: string;
  thinkingLevel?: ThinkingLevel;

  /** AgentMessage[] → LLM Message[]，仅在 LLM 调用边界调用一次（必备，骨架篇 §2.3 关口） */
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  /** convertToLlm 前的 AgentMessage 级变换（裁剪/外部注入）；不得 throw */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** 每次调用动态取凭证（短时 OAuth）；不得 throw，无 key 返回 undefined */
  getApiKey?: (model: string) => Promise<string | undefined> | string | undefined;

  /** turn 完成后优雅停（true → agent_end，当轮工具照常收尾） */
  shouldStopAfterTurn?: (info: TurnDoneInfo) => boolean | Promise<boolean>;
  /** 下一轮前替换 context/model/thinkingLevel（返回 undefined 保持现状） */
  prepareNextTurn?: (info: TurnDoneInfo) => AgentTurnUpdate | undefined | Promise<AgentTurnUpdate | undefined>;

  /**
   * 进模型步前拦截（骨架篇 §6.8 刀三——agent_pre_step 的 loop 落点位）：每个
   * 模型调用前（内层循环顶、turn_start 之后）调用一次，含 run 首步。返回
   * { stop: true } = 不发起本次调用、run 正常收场（completed）；undefined =
   * 放行。回调方自带状态处置（停因分立——loop 不写任何状态面）。抛错按回调
   * 违约传播（run failed 现径——loop 零 try/catch 纪律不变）。
   */
  beforeModelStep?: () => Promise<PreStepDecision | undefined>;

  /** steering 队列取数口（turn 结束边界注入；装配层接 PendingMessageQueue.drain） */
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  /** followUp 队列取数口（run 将停时捞起续跑） */
  getFollowUpMessages?: () => Promise<AgentMessage[]>;

  /** 工具批级拦截：执行前（block/terminate） */
  beforeToolCall?: (info: BeforeToolCallInfo, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  /** 工具批级拦截：收尾前（结果改写/terminate） */
  afterToolCall?: (info: AfterToolCallInfo, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
  /** 工具批执行策略（默认 sequential，拍板值；默认实现应调 tools 三段管道） */
  toolExecution?: ToolExecutionMode;
}

/** run 运行选项（信号与活体事件出口） */
export interface RunHooks {
  /** 取消信号（StreamFn 编码 aborted；工具执行应对齐监听） */
  signal?: AbortSignal;
  /** 活体事件出口（缺省丢弃——纯 headless 消费可只看 RunResult） */
  emit?: AgentEventSink;
}

/** run 终值（终态三值 + 本次新增消息，骨架篇 §2.6） */
export interface RunResult {
  status: RunStatus;
  /** 本次 run 新增的消息（prompts + assistant/toolResult/注入，不含既有上下文） */
  messages: AgentMessage[];
  /** 最后一次 assistant 调用的 stopReason（无调用时缺省） */
  stopReason?: StopReason;
  /** failed/aborted 时的错误说明 */
  errorMessage?: string;
}

/** 静默事件出口（headless） */
const sink: AgentEventSink = () => undefined;

/** 零用量（进模型步前拦截的合成 turn_end 锚用——无模型调用即无计量） */
const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/* ---------------- run 入口两函数（骨架篇 §2.1） ---------------- */

/**
 * 以新输入开跑：prompts 追加上下文并开事件序列。
 * @param prompts 新输入消息（用户消息/注入消息，已由装配层组好 AgentMessage）
 */
export async function startRun(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  hooks: RunHooks = {},
): Promise<RunResult> {
  const emit = hooks.emit ?? sink;
  const newMessages: AgentMessage[] = [...prompts];
  // 活数组就地追加（AgentContext.messages 契约：调用方全程可见单一时间线）
  context.messages.push(...prompts);
  await emit({ type: 'agent_start' });
  await emit({ type: 'turn_start' });
  for (const prompt of prompts) {
    await emit({ type: 'message_start', message: prompt });
    await emit({ type: 'message_end', message: prompt });
  }
  return runLoop(context, newMessages, config, hooks.signal, emit);
}

/**
 * 从既有上下文续跑（不追加消息）——溢出恢复与 turn 级重试的续入点。
 * 末消息经 convertToLlm 后必须是 user 或 toolResult，否则拒绝
 * （AGENT_CONTINUE_INVALID；骨架篇 §2.1 对 continue 的入态要求）。
 */
export async function continueRun(
  context: AgentContext,
  config: AgentLoopConfig,
  hooks: RunHooks = {},
): Promise<RunResult> {
  const last = context.messages[context.messages.length - 1];
  if (!last) {
    throw new AppError(AGENT_CONTINUE_INVALID, '续跑拒绝：上下文为空');
  }
  // 以 convertToLlm 实际转换结果判定（自定义角色可能映射为 user）
  const converted = await config.convertToLlm([last]);
  const lastRole = converted[converted.length - 1]?.role;
  if (lastRole !== 'user' && lastRole !== 'toolResult') {
    throw new AppError(
      AGENT_CONTINUE_INVALID,
      `续跑拒绝：末消息经 convertToLlm 后角色为 ${lastRole ?? '（空）'}（须为 user 或 toolResult）`,
    );
  }
  const emit = hooks.emit ?? sink;
  await emit({ type: 'agent_start' });
  await emit({ type: 'turn_start' });
  return runLoop(context, [], config, hooks.signal, emit);
}

/* ---------------- 双层 while 本体（骨架篇 §2.1 钉死结构） ---------------- */

/**
 * 主循环（外层 followUp 续跑 × 内层工具批/steering）。
 * 终态来源：error/aborted 短路（零重试）、shouldStopAfterTurn 优雅停、
 * 内层自然停且 followUp 空。返回 RunResult 并发 agent_end。
 */
async function runLoop(
  initialContext: AgentContext,
  newMessages: AgentMessage[],
  initialConfig: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<RunResult> {
  let context = initialContext;
  let config = initialConfig;
  let firstTurn = true;
  // 最近一次 assistant 调用的 stopReason（自然收口时写进 RunResult）
  let lastStopReason: StopReason | undefined;
  // 启动即查 steering：等待期用户可能已插话（pi 蓝本细节）
  let pending: AgentMessage[] = (await config.getSteeringMessages?.()) ?? [];

  // 外层：本该停下时被 followUp 唤醒则续跑
  while (true) {
    let hasToolCalls = true;

    // 内层：还有工具调用要执行 || steering 队列非空
    while (hasToolCalls || pending.length > 0) {
      if (!firstTurn) {
        await emit({ type: 'turn_start' });
      } else {
        firstTurn = false; // 首个 turn_start 已由 startRun/continueRun 发出
      }

      // 注入 pending 消息（steering 到达点——不打断当前生成，只影响下一轮；
      // prompts 已由 startRun 注入并补齐事件，此处只覆盖 steering/followUp）
      for (const message of pending) {
        await emit({ type: 'message_start', message });
        await emit({ type: 'message_end', message });
        context.messages.push(message);
        newMessages.push(message);
      }
      pending = [];

      // 进模型步前复验/屏障（骨架篇 §6.8 刀三）：每个模型调用前一次——回调短路
      // { stop: true } = run 正常收场（completed，非 mid-run 硬断——「正在跑的轮
      // 跑完为止」不破，状态面处置归回调方即停因分立）。此刻 turn_start 已发
      // （startRun 预发或本迭代顶）——补合成 turn_end 锚防日志留敞开 turn：锚是
      // 空 content 的 assistant（不进 context/newMessages 时间线，纯事件面闭对；
      // durable turn/end 只读 stopReason——'stop' 映射 completed）。回调抛错照常
      // 上抛走 run failed 现径（loop 零 try/catch 不破——挂起钟在装配层桥上）。
      const pre = await config.beforeModelStep?.();
      if (pre?.stop === true) {
        const anchor: AssistantMessage = {
          role: 'assistant',
          content: [],
          usage: NO_USAGE,
          stopReason: 'stop',
          timestamp: Date.now(),
        };
        await emit({ type: 'turn_end', message: anchor, toolResults: [] });
        return endRun(emit, newMessages, 'stop', undefined);
      }

      // 流式取 assistant（transformContext → convertToLlm → StreamFn）
      const message = await streamAssistantResponse(context, config, signal, emit);
      lastStopReason = message.stopReason;
      newMessages.push(message);

      // 终态短路：error/aborted → turn_end + agent_end 即终（loop 零重试）
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        await emit({ type: 'turn_end', message, toolResults: [] });
        return endRun(emit, newMessages, message.stopReason, message.errorMessage);
      }

      // 提取工具批；length 截断 → 整批 fail 不执行（§2.4）；结果落上下文
      const toolCalls = message.content.filter((c): c is AgentToolCall => c.type === 'toolCall');
      const toolResults: ToolResultMessage[] = [];
      hasToolCalls = false;
      if (toolCalls.length > 0) {
        const batch =
          message.stopReason === 'length'
            ? await failTruncatedToolCalls(toolCalls, emit)
            : await executeToolBatch(context, message, toolCalls, config, signal, emit);
        toolResults.push(...batch.messages);
        hasToolCalls = !batch.terminate; // 整批一致 terminate 才早停（§2.2）
        for (const result of toolResults) {
          context.messages.push(result);
          newMessages.push(result);
        }
      }

      // turn_end（携带 message + toolResults）
      await emit({ type: 'turn_end', message, toolResults });

      // prepareNextTurn：换 context/model/thinkingLevel 的唯一合法时机
      const info: TurnDoneInfo = { message, toolResults, context, newMessages };
      const update = await config.prepareNextTurn?.(info);
      if (update) {
        if (update.context) {
          context = update.context;
        }
        config = {
          ...config,
          model: update.model ?? config.model,
          thinkingLevel: update.thinkingLevel ?? config.thinkingLevel,
        };
      }

      // 优雅停：true → agent_end，不再发下一次 LLM 请求
      if ((await config.shouldStopAfterTurn?.(info)) === true) {
        return endRun(emit, newMessages, message.stopReason, undefined);
      }

      // 轮询 steering 队列，回到内层循环条件
      pending = (await config.getSteeringMessages?.()) ?? [];
    }

    // 内层自然停 → 查 followUp：非空作为 pending 续跑；空 → agent_end 退出
    const followUp = (await config.getFollowUpMessages?.()) ?? [];
    if (followUp.length > 0) {
      pending = followUp;
      continue;
    }
    break;
  }
  return endRun(emit, newMessages, lastStopReason, undefined);
}

/** 收尾：agent_end + 终值（stopReason → RunStatus 映射：error→failed、aborted→aborted、其余→completed） */
function endRun(
  emit: AgentEventSink,
  newMessages: AgentMessage[],
  stopReason: StopReason | undefined,
  errorMessage: string | undefined,
): Promise<RunResult> {
  const status: RunStatus = stopReason === 'error' ? 'failed' : stopReason === 'aborted' ? 'aborted' : 'completed';
  const result: RunResult = { status, messages: newMessages };
  if (stopReason !== undefined) {
    result.stopReason = stopReason;
  }
  if (errorMessage !== undefined) {
    result.errorMessage = errorMessage;
  }
  return Promise.resolve(emit({ type: 'agent_end', status, messages: newMessages })).then(() => result);
}

/* ---------------- 流式取 assistant（AgentMessage 关口发生地，§2.3） ---------------- */

/**
 * 组装本轮 LLM 请求并消费流：transformContext → convertToLlm（自定义角色在此
 * 转换/过滤）→ getApiKey → StreamFn。partial 消息就地写 context.messages 尾部，
 * done/error 后以最终消息替换。LLM 面工具描述经 toLlmTools 降维（丢弃 label 等执行件字段）。
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<AssistantMessage> {
  // 变换（裁剪/外部注入）——不得 throw 的契约由回调方承担
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }
  // 关口：AgentMessage[] → LLM Message[]（自定义角色经注册的 toLlm 转换或过滤）
  const llmMessages = await config.convertToLlm(messages);
  const llmContext: LlmContext = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools?.map(toLlmTool),
  };
  const apiKey = config.getApiKey ? await config.getApiKey(config.model) : undefined;

  const stream = await config.streamFn(
    llmContext,
    { model: config.model, thinkingLevel: config.thinkingLevel, apiKey },
    signal,
  );

  let partial: AssistantMessage | null = null;
  let addedPartial = false;
  for await (const event of stream) {
    // 终止事件先判（done/error 不走 update 通道——update 只发内容块增量）
    if (event.type === 'done' || event.type === 'error') {
      return finalizeStreamMessage(stream, context, addedPartial, emit);
    }
    if (event.type === 'start') {
      partial = event.partial;
      context.messages.push(partial);
      addedPartial = true;
      await emit({ type: 'message_start', message: { ...partial } });
    } else if (partial) {
      // 内容块事件：partial 快照就地替换尾部并转推（token 级直推通道）
      partial = event.partial;
      context.messages[context.messages.length - 1] = partial;
      await emit({ type: 'message_update', message: { ...partial }, streamEvent: event });
    }
  }
  // 流未发终态事件即耗尽（StreamFn 违约的宽容路径）：仍以 result() 收口
  return finalizeStreamMessage(stream, context, addedPartial, emit);
}

/** 流收口：result() 取最终消息替换尾部快照，补发 start（若从未发过）与 end */
async function finalizeStreamMessage(
  stream: AssistantStream,
  context: AgentContext,
  addedPartial: boolean,
  emit: AgentEventSink,
): Promise<AssistantMessage> {
  const final = await stream.result();
  if (addedPartial) {
    context.messages[context.messages.length - 1] = final;
  } else {
    context.messages.push(final);
    await emit({ type: 'message_start', message: { ...final } });
  }
  await emit({ type: 'message_end', message: final });
  return final;
}

/** AgentTool → LLM 面工具描述（执行件字段不进模型视野） */
function toLlmTool(tool: AgentTool): LlmTool {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/* ---------------- 工具批执行（§2.2 批级拦截 + §2.4 截断防御） ---------------- */

/** 批执行产物：结果消息 + 整批早停判定 */
interface ToolBatch {
  messages: ToolResultMessage[];
  terminate: boolean;
}

/** 单工具终值（toolCall + 结果 + 错误标记——terminate 判定的输入） */
interface FinalizedCall {
  toolCall: AgentToolCall;
  result: AgentToolResult;
  isError: boolean;
}

/**
 * 截断防御（§2.4 钉死）：stopReason=length 的消息内整批工具调用直接 fail 不执行
 * ——截断消息的参数可能静默不完整，执行即隐性 bug。fail 结果带 isError 与说明。
 */
async function failTruncatedToolCalls(toolCalls: AgentToolCall[], emit: AgentEventSink): Promise<ToolBatch> {
  const finalized: FinalizedCall[] = [];
  for (const toolCall of toolCalls) {
    await emit({
      type: 'tool_execution_start',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
    const call: FinalizedCall = {
      toolCall,
      result: errorToolResult(
        `工具调用 "${toolCall.name}" 未执行：响应触及输出 token 上限，参数可能已截断。请以完整参数重新发起调用。`,
      ),
      isError: true,
    };
    finalized.push(call);
    await emitToolExecutionEnd(call, emit);
    await emitToolResultMessage(toolResultMessageOf(call), emit);
  }
  return { messages: finalized.map(toolResultMessageOf), terminate: false };
}

/** 工具批执行入口：任一工具 executionMode=sequential 即整批串行（pi 蓝本细节） */
async function executeToolBatch(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ToolBatch> {
  const forceSequential = toolCalls.some(
    (call) => context.tools?.find((t) => t.name === call.name)?.executionMode === 'sequential',
  );
  return (config.toolExecution ?? 'sequential') === 'sequential' || forceSequential
    ? executeSequentially(context, assistantMessage, toolCalls, config, signal, emit)
    : executeConcurrently(context, assistantMessage, toolCalls, config, signal, emit);
}

/** 串行：逐个「准备 → 执行 → 收尾」（end 事件在各终值助手内发出） */
async function executeSequentially(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ToolBatch> {
  const finalized: FinalizedCall[] = [];
  for (const toolCall of toolCalls) {
    await emit({
      type: 'tool_execution_start',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
    const preparation = await prepareToolCall(context, assistantMessage, toolCall, config, signal);
    const call =
      preparation.kind === 'immediate'
        ? await finalizeImmediateCall(toolCall, preparation, emit)
        : await runAndFinalizeToolCall(context, assistantMessage, preparation, config, signal, emit);
    finalized.push(call);
    await emitToolResultMessage(toolResultMessageOf(call), emit);
    if (signal?.aborted) {
      break; // 已中止：余下调用不再准备（StreamFn 下一轮即 aborted 终态）
    }
  }
  return { messages: finalized.map(toolResultMessageOf), terminate: shouldTerminate(finalized) };
}

/** 并行：全部先顺序预检，允许的工具并发执行；end 按完成序、结果消息按源序（pi 蓝本） */
async function executeConcurrently(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ToolBatch> {
  const entries: Array<FinalizedCall | (() => Promise<FinalizedCall>)> = [];
  for (const toolCall of toolCalls) {
    await emit({
      type: 'tool_execution_start',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
    const preparation = await prepareToolCall(context, assistantMessage, toolCall, config, signal);
    entries.push(
      preparation.kind === 'immediate'
        ? // 预检即终：同步落终值并即刻发 end（完成序最前）
          await finalizeImmediateCall(toolCall, preparation, emit)
        : // 可执行：延迟启动，并发执行在下方 Promise.all 一并开跑
          () => runAndFinalizeToolCall(context, assistantMessage, preparation, config, signal, emit),
    );
    if (signal?.aborted) {
      break;
    }
  }
  const finalized = await Promise.all(
    entries.map((entry) => (typeof entry === 'function' ? entry() : Promise.resolve(entry))),
  );
  for (const call of finalized) {
    // 结果消息按源序（end 已按完成序发出）
    await emitToolResultMessage(toolResultMessageOf(call), emit);
  }
  return { messages: finalized.map(toolResultMessageOf), terminate: shouldTerminate(finalized) };
}

/** 预检即终的调用收尾：合成终值并发 tool_execution_end（两条执行路径共用） */
async function finalizeImmediateCall(
  toolCall: AgentToolCall,
  preparation: Extract<PreparedCall, { kind: 'immediate' }>,
  emit: AgentEventSink,
): Promise<FinalizedCall> {
  const call: FinalizedCall = { toolCall, result: preparation.result, isError: preparation.isError };
  await emitToolExecutionEnd(call, emit);
  return call;
}

/** 预检结果：prepared=可执行；immediate=已有结果无须执行（未找到/被拦截/中止/预检抛错） */
type PreparedCall =
  | { kind: 'prepared'; tool: AgentTool; toolCall: AgentToolCall; args: Record<string, unknown> }
  | { kind: 'immediate'; result: AgentToolResult; isError: boolean };

/**
 * 工具调用预检：查找工具 → prepareArguments 整形 → beforeToolCall 批级拦截。
 * 此处 catch 把预检异常编码为 immediate 错误结果（错误是数据，§2.2 契约的宽容侧）。
 */
async function prepareToolCall(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<PreparedCall> {
  try {
    const tool = context.tools?.find((t) => t.name === toolCall.name);
    if (!tool) {
      return { kind: 'immediate', result: errorToolResult(`工具不存在：${toolCall.name}`), isError: true };
    }
    const args = tool.prepareArguments ? tool.prepareArguments(toolCall.arguments) : toolCall.arguments;
    const before = await config.beforeToolCall?.({ assistantMessage, toolCall, args, context }, signal);
    if (signal?.aborted) {
      return { kind: 'immediate', result: errorToolResult('已中止，工具未执行'), isError: true };
    }
    if (before?.block) {
      const result = errorToolResult(before.reason ?? '工具调用被拦截（beforeToolCall block）');
      result.terminate = before.terminate === true;
      return { kind: 'immediate', result, isError: true };
    }
    return { kind: 'prepared', tool, toolCall, args };
  } catch (error) {
    return { kind: 'immediate', result: errorToolResult(describeError(error)), isError: true };
  }
}

/**
 * 执行 + 收尾一个已预检调用：execute（进度转推 tool_execution_update）→
 * afterToolCall 字段级改写。执行/收尾抛错编码为 isError 结果（错误是数据）。
 */
async function runAndFinalizeToolCall(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  prepared: Extract<PreparedCall, { kind: 'prepared' }>,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<FinalizedCall> {
  const updates: Array<Promise<void>> = [];
  let accepting = true; // promise 结算后忽略迟到进度（pi 蓝本护栏）
  let result: AgentToolResult;
  let isError: boolean;
  try {
    result = await prepared.tool.execute(prepared.toolCall.id, prepared.args, signal, (partial) => {
      if (!accepting) {
        return;
      }
      updates.push(
        Promise.resolve(
          emit({
            type: 'tool_execution_update',
            toolCallId: prepared.toolCall.id,
            toolName: prepared.toolCall.name,
            args: prepared.args,
            partialResult: partial,
          }),
        ),
      );
    });
    isError = result.isError === true; // 工具/管道可在结果上自带错误声明（pi-10 补钉：execute 正常返回但声明 isError）
  } catch (error) {
    result = errorToolResult(describeError(error));
    isError = true;
  } finally {
    accepting = false;
  }
  await Promise.all(updates); // 进度事件先于 end 结算（顺序严格 start→update*→end）
  try {
    const after = await config.afterToolCall?.(
      { assistantMessage, toolCall: prepared.toolCall, args: prepared.args, result, isError, context },
      signal,
    );
    if (after) {
      result = {
        ...result,
        content: after.content ?? result.content,
        details: after.details ?? result.details,
        isError: after.isError ?? result.isError, // 改写后的结果身份同步（pi-10 补钉：isError 不在合并面时保留原值）
        usage: after.usage ?? result.usage,
        terminate: after.terminate ?? result.terminate,
      };
      isError = after.isError ?? isError;
    }
  } catch (error) {
    result = errorToolResult(describeError(error));
    isError = true;
  }
  const call: FinalizedCall = { toolCall: prepared.toolCall, result, isError };
  await emitToolExecutionEnd(call, emit); // 并行路径的 end=完成序（在此）；串行路径由调用方统一发
  return call;
}

/** 整批 terminate 判定：非空且全部 finalize 结果 terminate===true（骨架篇 §2.2） */
function shouldTerminate(finalized: FinalizedCall[]): boolean {
  return finalized.length > 0 && finalized.every((call) => call.result.terminate === true);
}

/** 合成错误工具结果（固定形态：单文本块 + 空明细；自带 isError 身份——pi-10 补钉） */
function errorToolResult(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: message }], details: {}, isError: true };
}

/** 终值 → toolResult 消息（content 空值归一，杜绝 null 进转录与 provider 载荷） */
function toolResultMessageOf(call: FinalizedCall): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.toolCall.id,
    toolName: call.toolCall.name,
    content: call.result.content ?? [],
    details: call.result.details,
    usage: call.result.usage,
    ...(call.result.addedToolNames?.length ? { addedToolNames: call.result.addedToolNames } : {}),
    isError: call.isError,
    timestamp: Date.now(),
  };
}

/** 工具执行 end 事件 */
async function emitToolExecutionEnd(call: FinalizedCall, emit: AgentEventSink): Promise<void> {
  await emit({
    type: 'tool_execution_end',
    toolCallId: call.toolCall.id,
    toolName: call.toolCall.name,
    result: call.result,
    isError: call.isError,
  });
}

/** 工具结果消息的 start/end 事件对（消息时间线收录） */
async function emitToolResultMessage(message: ToolResultMessage, emit: AgentEventSink): Promise<void> {
  await emit({ type: 'message_start', message });
  await emit({ type: 'message_end', message });
}
