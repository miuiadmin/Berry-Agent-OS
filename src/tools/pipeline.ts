/**
 * L2 tools — 三段 waterfall 管道（插件契约篇 §3.1，工具执行唯一合法路径）。
 *
 * 结构（每段都是 ctx.waterfall，监听者可追加；守门段由安全栈 prepend 占首位）：
 *
 *   1. 参数 schema 校验（前置步，不属钩子段）——不合法参数不进守门/执行段；
 *   2. tools_pre_execute 守门段——allow / block（短路）/ mutate（就地改参）；
 *      整段 fail-closed：监听器抛错视为 block（TOOL_GATE_FAILED）；
 *   3. tools_execute 执行段——around-dispatch，链尾默认实现 = timeoutMs 预算
 *      + 调工具 execute（超时替换为结构化 TOOL_TIMEOUT 错误）；
 *   4. tools_post_execute 后处理段——可就地改写 result（裁剪/spill/usage）。
 *
 * 失败统一 throw AppError（message 首缀 `[CODE]`——loop 侧 describeError 只留
 * message 文本，码进前缀保证 durable 结果里码可见，内核篇 §5.3 第 4 条精神）。
 * gate/decision durable 事件经注入的 sink 落日志（app 装配层接线 session.append；
 * tools 不依赖 session，DAG 单向）。
 */

import { Value } from 'typebox/value';
import { AppError, TOOL_ARGUMENTS_INVALID, TOOL_BLOCKED, TOOL_GATE_FAILED, TOOL_TIMEOUT } from '../contracts/errors.js';
import { TOOL_EXECUTE_EVENT, TOOL_POST_EXECUTE_EVENT, TOOL_PRE_EXECUTE_EVENT } from '../contracts/tools.js';
import type {
  AgentToolResult,
  ExecuteInput,
  GateAction,
  GateDecisionPayload,
  GateDecisionSink,
  ToolCtx,
  ToolDefinition,
  ToolUpdateCallback,
} from '../contracts/tools.js';
import type { Context } from '../context/types.js';

/** 管道选项（createToolPipeline 一次性注入，app 装配层负责） */
export interface ToolPipelineOptions {
  /** gate/decision durable 落点（接线 session.append；缺省不记录——测试/无会话场景） */
  onGateDecision?: GateDecisionSink;
  /** 默认执行预算毫秒（缺省 60s；def.timeoutMs 逐工具覆盖；0 = 不设预算） */
  defaultTimeoutMs?: number;
}

/** 管道执行器：包装一个 ToolDefinition 的执行全路径 */
export type ToolPipelineExecutor = (
  def: ToolDefinition,
  toolCallId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: ToolUpdateCallback,
) => Promise<AgentToolResult>;

/** 组装 `[CODE] message` 形态的错误文本（码随 message 进入工具结果） */
function codedMessage(code: string, message: string): string {
  return `[${code}] ${message}`;
}

/**
 * 创建工具执行管道（每 ctx 一份；注册表把每个 ToolDefinition 的执行接到本管道）。
 *
 * 注意：守门段的 mutate 语义依赖「可变入参就地改写」——waterfall 链上
 * gateInput 对象对整条链固定，守门者改 gateInput.args 即改了执行段所见参数。
 */
export function createToolPipeline(ctx: Context, opts: ToolPipelineOptions = {}): ToolPipelineExecutor {
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
  const recordGate: GateDecisionSink = opts.onGateDecision ?? (() => {});

  return async function runToolPipeline(def, toolCallId, args, signal, onUpdate) {
    /* ---- 前置步：参数 schema 校验（TypeBox Value；语法不合法不进守门） ---- */
    if (!Value.Check(def.parameters as Parameters<typeof Value.Check>[0], args)) {
      const problems = [...Value.Errors(def.parameters as Parameters<typeof Value.Check>[0], args)]
        .slice(0, 5)
        .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
        .join('；');
      throw new AppError(
        TOOL_ARGUMENTS_INVALID,
        codedMessage(TOOL_ARGUMENTS_INVALID, `工具 ${def.name} 参数校验失败：${problems}`),
      );
    }

    /* ---- 第一段：守门（fail-closed；block 短路不进执行段） ---- */
    // 可变入参：mutate 决策就地改写 args + 置 mutated；链尾 next 返回 undefined = 全链放行
    const gateInput = { tool: def, args, callId: toolCallId, mutated: false };
    let gateOutcome: GateAction | undefined;
    try {
      gateOutcome = await ctx.waterfall<GateAction | undefined>(TOOL_PRE_EXECUTE_EVENT, gateInput, () => undefined);
    } catch (err) {
      // fail-closed：守门监听器自身异常 = 视为 block，绝不放行；先落决策再抛
      const message = err instanceof Error ? err.message : String(err);
      recordGate({ toolCallId, decision: 'block', reason: codedMessage(TOOL_GATE_FAILED, message) });
      throw new AppError(
        TOOL_GATE_FAILED,
        codedMessage(TOOL_GATE_FAILED, `守门检查失败（fail-closed 拒绝）：${message}`),
        { cause: err },
      );
    }
    if (gateOutcome?.decision === 'block') {
      // block 短路：结构化拒绝（含 reason）经 throw 交 loop 编码为 isError 结果返回模型
      recordGate({ toolCallId, decision: 'block', reason: gateOutcome.reason });
      throw new AppError(TOOL_BLOCKED, codedMessage(TOOL_BLOCKED, gateOutcome.reason));
    }
    // 放行/改参：mutated 标志由改参的守门者维护，汇总进 durable 决策
    recordGate({ toolCallId, decision: gateInput.mutated ? 'mutate' : 'allow', reason: 'ok' });

    /* ---- 第二段：执行（around-dispatch；链尾默认实现 = 超时预算 + execute） ---- */
    const executeInput: ExecuteInput = { tool: def, args, callId: toolCallId, signal, onUpdate };
    const timedExecute = async (): Promise<AgentToolResult> => {
      const timeoutMs = def.timeoutMs ?? defaultTimeoutMs;
      const toolCtx: ToolCtx = { toolCallId, signal, onUpdate };
      if (!timeoutMs || timeoutMs <= 0) {
        return def.execute(args, toolCtx); // 0 = 显式不设预算（少数长任务工具自管取消）
      }
      // 预算竞速：超时先到即抛 TOOL_TIMEOUT（原 execute 继续跑但结果弃置——loop 侧
      // accepting 护栏会忽略其迟到 onUpdate；取消传播靠 signal，M1 不强杀 promise）
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AppError(TOOL_TIMEOUT, codedMessage(TOOL_TIMEOUT, `工具 ${def.name} 执行超时（>${timeoutMs}ms）`)),
            ),
          timeoutMs,
        );
      });
      try {
        return await Promise.race([def.execute(args, toolCtx), timeoutPromise]);
      } finally {
        clearTimeout(timer);
      }
    };
    const result = await ctx.waterfall<AgentToolResult>(TOOL_EXECUTE_EVENT, executeInput, timedExecute);

    /* ---- 第三段：后处理（可就地改写 result：裁剪/spill/usage） ---- */
    const postInput = { tool: def, args, callId: toolCallId, result };
    await ctx.waterfall<undefined>(TOOL_POST_EXECUTE_EVENT, postInput, () => undefined);
    return postInput.result;
  };
}
