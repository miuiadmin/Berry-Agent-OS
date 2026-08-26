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
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AppError, TOOL_ARGUMENTS_INVALID, TOOL_BLOCKED, TOOL_GATE_FAILED, TOOL_TIMEOUT } from '../contracts/errors.js';
import { TOOL_EXECUTE_EVENT, TOOL_POST_EXECUTE_EVENT, TOOL_PRE_EXECUTE_EVENT } from '../contracts/tools.js';
import type {
  AgentToolResult,
  ExecuteInput,
  GateAction,
  GateInput,
  GateDecisionPayload,
  GateDecisionSink,
  TextContent,
  ToolCtx,
  ToolDefinition,
  ToolPipelineExecutor,
  ToolUpdateCallback,
} from '../contracts/tools.js';
import type { Context } from '../context/types.js';
import { runInCallerChain } from '../context/chain.js';
import { toolOwnerOf } from './registry.js';

// 类型真身已安家 contracts（Ring 1 行树化批——服务面 executor 携带，宿主消费方
// 只依赖契约层）；此处再导出维持本模块既有导入面
export type { ToolPipelineExecutor } from '../contracts/tools.js';

/** 管道选项（createToolPipeline 一次性注入，app 装配层负责） */
export interface ToolPipelineOptions {
  /** gate/decision durable 落点（接线 session.append；缺省不记录——测试/无会话场景） */
  onGateDecision?: GateDecisionSink;
  /** 默认执行预算毫秒（缺省 60s；def.timeoutMs 逐工具覆盖；0 = 不设预算） */
  defaultTimeoutMs?: number;
  /**
   * 后处理段挂起时钟（毫秒，缺省 5000——契约篇 §1.6 时钟族，2026-08-27 刀〇a）：
   * post 段监听器挂起视为故障，超时抛 TOOL_TIMEOUT 走「错误是数据」现径（loop
   * catch 编码 isError 结果）。测试面注小值验证超时路径；生产面用缺省。
   */
  postTimeoutMs?: number;
}

/** 组装 `[CODE] message` 形态的错误文本（码随 message 进入工具结果） */
function codedMessage(code: string, message: string): string {
  return `[${code}] ${message}`;
}

/**
 * 缺省输出护栏预算（64KiB——对齐会话护栏；契约篇 §3.1 后处理段承诺、
 * §6.6 冷读 #8 裁决随 mcp 第一刀兑现：护栏是管道属性，全部工具受益）。
 */
export const OUTPUT_GUARD_BYTES = 64 * 1024;

/** spill 文件序号（模块级自增——文件名在 tmpdir 内唯一即可） */
let spillSeq = 0;

/**
 * 单工具调用进度流硬帽（契约篇 §1.6 资源护栏族 #11，2026-08-27 刀〇b）：
 * onUpdate 累计 10^4 条为帽，超帽丢弃后续进度 + 首条丢弃单条 warn（计数进
 * 文案不逐条刷屏）。执法点在管道 onUpdate 包装层（管道有 logger；loop 的
 * accepting/结算后 ignoring 语义零改动）。数据面丢弃非插件错误面——工具本体
 * 照常结算，结果不受影响。合法触帽预期：流式工具（exec 逐 chunk onUpdate）
 * 长命令单次调用即可超帽——渐进冻结（TUI 实时输出停滞）是预期行为非 bug，
 * 10^4 ≈ 60ms/块 × 100 分钟级 chunk 流，超出者接受冻结。
 */
const PROGRESS_UPDATE_LIMIT = 10_000;

/**
 * 取字节缓冲尾部至多 maxBytes 字节（UTF-8 安全：起点落在多字节字符中间则
 * 前移过续字节——与 exec 件 tailUtf8 同纪律，tools 不 import exec〔方向反〕）。
 */
function tailBytes(buf: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let start = Math.max(0, buf.length - maxBytes);
  while (start > 0 && start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

/**
 * 缺省后处理链尾：输出护栏（64KiB 保尾截断 + 超限 spill 全文外溢临时文件）。
 * - 只钳文本 content；图片等其余 content 原样保留（自有界）；
 * - spill 写 tmpdir（OS 回收，无 GC 面积），写失败降级为仅截断（不 throw——
 *   护栏自身故障不该炸掉正常结果）；
 * - 监听器若已改写 result（本段是链尾缺省，waterfall 语义下监听器先于链尾），
 *   链尾对改写后结果同样执法。
 */
async function applyDefaultOutputGuard(result: AgentToolResult, callId: string): Promise<void> {
  const textParts = result.content.filter((part): part is TextContent => part.type === 'text');
  const full = textParts.map((part) => part.text).join('\n');
  const totalBytes = Buffer.byteLength(full, 'utf8');
  if (totalBytes <= OUTPUT_GUARD_BYTES) return;

  // spill 全文（尽力而为）：文件名只留安全字符，防 callId 形态未知的路径注入
  spillSeq += 1;
  const safeCallId = callId.replace(/[^A-Za-z0-9_-]/g, '_');
  const spillPath = `${tmpdir()}/spill-${safeCallId}-${spillSeq}.txt`;
  let spilled = true;
  try {
    await writeFile(spillPath, full, 'utf8');
  } catch {
    spilled = false; // tmp 满等故障：截断照做，路径不承诺
  }
  const tail = tailBytes(Buffer.from(full, 'utf8'), OUTPUT_GUARD_BYTES);
  const note = `\n\n[输出 ${totalBytes} 字节超 64KiB 上限，已保尾截断${spilled ? `；全文外溢至 ${spillPath}` : ''}]`;
  result.content = [...result.content.filter((part) => part.type !== 'text'), { type: 'text', text: `${tail}${note}` }];
}

/**
 * 创建工具执行管道（每 ctx 一份；注册表把每个 ToolDefinition 的执行接到本管道）。
 *
 * 注意：守门段的 mutate 语义依赖「可变入参就地改写」——waterfall 链上
 * gateInput 对象对整条链固定，守门者改 gateInput.args 即改了执行段所见参数。
 */
export function createToolPipeline(ctx: Context, opts: ToolPipelineOptions = {}): ToolPipelineExecutor {
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
  const postTimeoutMs = opts.postTimeoutMs ?? 5_000;
  const recordGate: GateDecisionSink = opts.onGateDecision ?? (() => {});

  return async function runToolPipeline(def, toolCallId, args, signal, onUpdate, origin) {
    /* ---- 前置步：进度流护栏包装（#11——两消费面同源：executeInput 与 toolCtx） ---- */
    const guardedUpdate: ToolUpdateCallback | undefined =
      onUpdate === undefined
        ? undefined
        : (() => {
            let count = 0;
            let warned = false;
            return (update: AgentToolResult) => {
              if (count >= PROGRESS_UPDATE_LIMIT) {
                // 首条丢弃单条 warn（不逐条刷屏）——数据面渐进冻结，结果不受影响
                if (!warned) {
                  warned = true;
                  ctx.logger.warn(
                    `工具 ${def.name} 进度流达上限 ${PROGRESS_UPDATE_LIMIT} 条，后续 onUpdate 丢弃` +
                      `（结果不受影响；长命令流式输出接受渐进冻结，契约篇 §1.6 #11）`,
                    { callId: toolCallId },
                  );
                }
                return;
              }
              count += 1;
              onUpdate(update);
            };
          })();

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
    // callOrigin 随执行器第 6 参透传（P1-2 增补 7③——面别判别词，undefined = 未知面不置键）
    const gateInput: GateInput = {
      tool: def,
      args,
      callId: toolCallId,
      mutated: false,
      ...(origin !== undefined ? { callOrigin: origin } : {}),
    };
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
    // 放行来源透传（第二十四批题1a）：守门者免问放行时标注（如 allowlist:<序>），
    // 否则 'ok'——免问仍可审计（骨架篇 §8.4 粘性第 4 条：只有免问放行、无静默放行）
    recordGate({
      toolCallId,
      decision: gateInput.mutated ? 'mutate' : 'allow',
      reason: gateInput.allowReason ?? 'ok',
    });

    /* ---- 第二段：执行（around-dispatch；链尾默认实现 = 超时预算 + execute） ---- */
    // callOrigin 透传（P1-2 增补 7③——三段同词，执行段接管者可按面别替换逻辑）
    const executeInput: ExecuteInput = {
      tool: def,
      args,
      callId: toolCallId,
      signal,
      onUpdate: guardedUpdate,
      ...(origin !== undefined ? { callOrigin: origin } : {}),
    };
    // caller 链写点之二（会话篇 §5.1 导入者归因，P1-1）：工具体按注册归属包裹——
    // 插件工具体内的一切共享服务面调用（如 createSession 的 importer 落账）归注册
    // 插件。宿主/builtin 工具无归属不包（链保持无身份，读点 'host' 兜底——不造
    // 假身份链）。两处调用点共用同一 execOwned，包裹点唯一不分裂
    const owner = toolOwnerOf(def);
    const timedExecute = async (): Promise<AgentToolResult> => {
      const timeoutMs = def.timeoutMs ?? defaultTimeoutMs;
      const toolCtx: ToolCtx = { toolCallId, signal, onUpdate: guardedUpdate };
      const execOwned = () =>
        owner === undefined ? def.execute(args, toolCtx) : runInCallerChain(owner, () => def.execute(args, toolCtx));
      if (!timeoutMs || timeoutMs <= 0) {
        return execOwned(); // 0 = 显式不设预算（少数长任务工具自管取消）
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
        return await Promise.race([execOwned(), timeoutPromise]);
      } finally {
        clearTimeout(timer);
      }
    };
    const result = await ctx.waterfall<AgentToolResult>(TOOL_EXECUTE_EVENT, executeInput, timedExecute);

    /* ---- 第三段：后处理（可就地改写 result：裁剪/spill/usage）----
     * 挂起时钟（§1.6 时钟族，2026-08-27 刀〇a）：post 段监听器挂起视为故障，
     * 整段竞速 postTimeoutMs（缺省 5s）——超时抛 TOOL_TIMEOUT 走「错误是数据」
     * 现径（loop runAndFinalizeToolCall catch 编码 isError 结果返回模型；监听器
     * 迟到 reject 挂 catch 兜底不进 unhandledRejection）。守门/执行段不设此钟：
     * 守门 fail-closed 依赖抛错穿透（语义已足），执行段预算归 def.timeoutMs。 */
    // callOrigin 透传（P1-2 增补 7③——后处理段同词：审计/裁剪可按面别分叉）
    const postInput = {
      tool: def,
      args,
      callId: toolCallId,
      result,
      ...(origin !== undefined ? { callOrigin: origin } : {}),
    };
    let postTimer: ReturnType<typeof setTimeout> | undefined;
    const postClock = new Promise<never>((_, reject) => {
      postTimer = setTimeout(
        () =>
          reject(
            new AppError(
              TOOL_TIMEOUT,
              codedMessage(TOOL_TIMEOUT, `工具 ${def.name} 后处理段挂起超 ${postTimeoutMs}ms（post 监听器或输出护栏）`),
            ),
          ),
        postTimeoutMs,
      );
    });
    const postPromise = ctx.waterfall<undefined>(TOOL_POST_EXECUTE_EVENT, postInput, async () => {
      // 链尾缺省 = 输出护栏（§3.1/§6.6：64KiB 保尾 + spill——管道属性，全部工具受益）
      await applyDefaultOutputGuard(postInput.result, toolCallId);
    });
    postPromise.catch(() => {}); // 竞速败方迟到 reject 兜底
    try {
      await Promise.race([postPromise, postClock]);
    } finally {
      clearTimeout(postTimer);
    }
    return postInput.result;
  };
}
