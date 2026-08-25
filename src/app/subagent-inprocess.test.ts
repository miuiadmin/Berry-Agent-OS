/**
 * in-process provider 全栈路测试（骨架篇 §6.1 落码注记，subagent 纵切二）。
 *
 * 放 app/ 而非 subagent/：工厂回调是 app 侧 seam（拉真 tools/safety 装配——
 * 超出 subagent 模块拓扑白名单，组合根测试天然全模块可 import）。测试本地
 * 工厂镜像 app 侧形态（每子独立装配 dsh-10——真 createContext + 真三段管道 +
 * 真守门行 + 审批 never + 真 Session fork origin='delegation' + 真 startRun）；
 * **mock 只停在模型层**（脚本化 streamFn），其余全真。锁行为面：结算映射
 * （output=末条非空 assistant 文本 / usage 累计 / id=子会话 id / 深度+1）、
 * token 预算帽（触帽 abort → max-tokens 改判）、深度执法（SUBAGENT_DEPTH_
 * EXCEEDED + 子即刻销毁）、dispose 幂等、中间过程不进父会话。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '../context/context.js';
import { createLogger } from '../context/logger.js';
import type { AssistantMessage, AssistantStream, AssistantStreamEvent, Message, Usage } from '../contracts/llm.js';
import type { AgentMessage } from '../contracts/messages.js';
import { startRun, type AgentEvent, type StreamFn } from '../agent/index.js';
import { Session } from '../session/session.js';
import { createToolPipeline } from '../tools/pipeline.js';
import { registerToolsService } from '../tools/registry.js';
import { createApprovalService } from '../safety/approval.js';
import { installSafetyGate } from '../safety/gate.js';
import { SUBAGENT_DEPTH_EXCEEDED } from '../contracts/errors.js';
import { createInProcessProvider, type InProcessChildFactory } from '../subagent/inprocess.js';

/* ---------------- 测试基建：消息 / 合成流（与 loop.test 同款契约） ---------------- */

/** 造带真实用量的 assistant 文本终值（预算帽/累计断言需要非零 usage） */
function textWithUsage(text: string, usage: Usage): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], usage, stopReason: 'stop', timestamp: 2 };
}

/** 造带真实用量的 assistant 工具调用终值 */
function toolCallWithUsage(usage: Usage): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'call-1', name: 'echo', arguments: { text: '查' } }],
    usage,
    stopReason: 'toolUse',
    timestamp: 2,
  };
}

/** 终态错误/中止 assistant */
function terminalWithUsage(stopReason: 'error' | 'aborted', errorMessage: string, usage: Usage): AssistantMessage {
  return { role: 'assistant', content: [], usage, stopReason, errorMessage, timestamp: 2 };
}

/** 合成流（start → text_delta → done/error；result() 恒返回最终消息） */
function syntheticStream(message: AssistantMessage): AssistantStream {
  const partial: AssistantMessage = { ...message, content: [] };
  const isTerminal = message.stopReason === 'error' || message.stopReason === 'aborted';
  const events: AssistantStreamEvent[] = [
    { type: 'start', partial },
    { type: 'text_delta', contentIndex: 0, delta: '', partial },
    isTerminal
      ? { type: 'error', reason: message.stopReason as 'error' | 'aborted', error: message }
      : { type: 'done', reason: message.stopReason as 'stop' | 'toolUse' | 'length', message },
  ];
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: (): Promise<IteratorResult<AssistantStreamEvent>> =>
          index < events.length
            ? Promise.resolve({ value: events[index++]!, done: false })
            : Promise.resolve({ value: undefined, done: true }),
      };
    },
    result: async () => message,
  };
}

/** 直通转换（AgentMessage 联合与 LLM Message 结构兼容——测试免拉 app 转换器） */
const passthroughConvert = (messages: AgentMessage[]): Message[] => messages.slice() as Message[];

/* ---------------- 测试本地工厂：镜像 app 侧每子独立装配（dsh-10） ---------------- */

/** 子记录：测试观测面（子会话/事件/装配 dispose 计数） */
interface ChildRecord {
  readonly session: Session;
  readonly events: AgentEvent[];
  /** 子装配 dispose 调用次数（幂等断言面——工厂半边真实计数） */
  disposedTimes: () => number;
}

/**
 * 建测试工厂：每子 createContext + 管道 + 注册表 + echo 工具 + 审批 never +
 * 守门行 + 父会话 fork(origin='delegation') + startRun（emit 观测 + assistant
 * usage → onUsage——镜像真实工厂的 message_end 观测接线）。
 */
function makeFactory(parent: Session, script: StreamFn): { factory: InProcessChildFactory; children: ChildRecord[] } {
  const children: ChildRecord[] = [];
  const factory: InProcessChildFactory = ({ request, signal, onUsage }) => {
    // 每子独立 ctx（dsh-10：不共享根管道，杜绝调用期识别 caller）
    const childCtx = createContext({ logger: createLogger({ module: 'child', level: 'silent' }) });
    const pipeline = createToolPipeline(childCtx);
    const tools = registerToolsService(childCtx, { pipeline });
    tools.register({
      name: 'echo',
      description: '回声测试工具（只读——过守门行用）',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: [] },
      effect: 'read',
      execute: async (args) => ({
        content: [{ type: 'text', text: String((args as { text?: string }).text ?? '回声') }],
      }),
    });
    // 审批 never（子代理无人值守：升权确定性拒绝）+ 守门行（read-only 档过 read 工具）
    const approval = createApprovalService(childCtx, { policy: 'never' });
    installSafetyGate(childCtx, {
      approval,
      workspace: mkdtempSync(join(tmpdir(), 'subagent-')),
      mode: () => 'read-only',
    });

    // 子会话：fork origin='delegation'——header.delegationDepth 自动 +1
    const session = parent.fork({ origin: 'delegation' });

    // 活体事件观测（真实工厂此处接 durable 持久化——测试只记录）
    const events: AgentEvent[] = [];
    let disposeCount = 0;
    const record: ChildRecord = { session, events, disposedTimes: () => disposeCount };
    children.push(record);

    return {
      session,
      run: () =>
        startRun(
          [{ role: 'user', content: request.prompt, timestamp: 1 }],
          { messages: [], tools: tools.list().map((def) => tools.toAgentTool(def)) },
          { streamFn: script, model: 'test/child', convertToLlm: passthroughConvert },
          {
            signal,
            emit: (event) => {
              events.push(event);
              // assistant 消息结算即上报用量（provider 预算帽的唯一数据源）
              if (event.type === 'message_end' && event.message.role === 'assistant') {
                const usage = (event.message as AssistantMessage).usage;
                if (usage) onUsage(usage);
              }
            },
          },
        ),
      dispose: () => {
        disposeCount += 1;
        childCtx.dispose(); // 作用域 LIFO 回卷（真实工厂还含子会话 flush/shutdown——纵切三）
      },
    };
  };
  return { factory, children };
}

/** 用量工厂（测试数值面一眼可读） */
function usageOf(totalTokens: number, input: number, output: number): Usage {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens };
}

/* ---------------- 用例 ---------------- */

describe('in-process provider — completed 正常路（结算契约全字段）', () => {
  it('output=末条非空 assistant 文本；usage 逐次累计；id=子会话 id；子深度=父+1；工具真过管道', async () => {
    const parent = new Session();
    const script: StreamFn = (() => {
      // 两次模型调用：toolUse（真走管道执行 echo）→ 收口文本
      const responses = [
        toolCallWithUsage(usageOf(150, 100, 50)),
        textWithUsage('子代理完工报告', usageOf(150, 120, 30)),
      ];
      let call = 0;
      const fn: StreamFn = (_context, _options, signal) => {
        void signal;
        const message = responses[Math.min(call, responses.length - 1)]!;
        call += 1;
        return syntheticStream(message);
      };
      return fn;
    })();
    const { factory, children } = makeFactory(parent, script);
    const provider = createInProcessProvider({ factory });

    const execution = provider.start({ prompt: '查一遍并汇报' });
    const result = await execution.result;

    // 结算契约：output = 最后一条非空 assistant 文本
    expect(result.output).toBe('子代理完工报告');
    expect(result.stopReason).toBe('completed');
    // usage = 两次 assistant 用量字段级累计（100+120 / 50+30 / 150+150）
    expect(result.usage).toEqual(usageOf(300, 220, 80));
    // id = 子会话 id（结算折叠/Job 关联的稳定标识）
    expect(execution.id).toBe(children[0]!.session.header.sessionId);
    // 深度执法数据面：子 header.delegationDepth = 父 + 1
    expect(children[0]!.session.header.delegationDepth).toBe(1);
    // 工具真过三段管道（echo 真执行——非 mock 断言）
    type MessageEnd = Extract<AgentEvent, { type: 'message_end' }>;
    const toolResults = children[0]!.events.filter(
      (e): e is MessageEnd => e.type === 'message_end' && e.message.role === 'toolResult',
    );
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0]!.message as { content: { type: string; text: string }[] }).content[0]).toMatchObject({
      type: 'text',
      text: '查',
    });
    // 中间过程不进父会话（父日志零增长——子事件只进子装配观测面）
    expect(parent.length).toBe(0);
  });
});

describe('in-process provider — token 预算帽（pi-5：v1 有帽）', () => {
  it('累计触帽即 abort → 终止改判 max-tokens（裸 loop 无此终态）+ diagnostic 载触帽说明', async () => {
    const parent = new Session();
    const script: StreamFn = (() => {
      const first = toolCallWithUsage(usageOf(250, 200, 50)); // 单条即超 200 帽
      const fn: StreamFn = (_context, _options, signal) => {
        // 第二次调用发生在帽触发 abort 之后——真实 streamFn 编码 aborted 终态
        if (signal?.aborted) return syntheticStream(terminalWithUsage('aborted', '取消', usageOf(0, 0, 0)));
        return syntheticStream(first);
      };
      return fn;
    })();
    const { factory } = makeFactory(parent, script);
    const provider = createInProcessProvider({ factory, tokenBudget: 200 });

    const execution = provider.start({ prompt: '跑' });
    const result = await execution.result;

    expect(result.stopReason).toBe('max-tokens');
    expect(result.diagnostic).toContain('token 预算帽触顶');
    // 累计 usage 照报（触帽那一条也计入——250 ≥ 200）
    expect(result.usage).toEqual(usageOf(250, 200, 50));
  });

  it('最后一条消息才触帽且 run 就此收束：诚实 completed（帽不追改已完成的收口）', async () => {
    const parent = new Session();
    const script: StreamFn = (() => {
      const message = textWithUsage('收口', usageOf(300, 200, 100)); // 单条收尾即触帽
      const fn: StreamFn = () => syntheticStream(message);
      return fn;
    })();
    const { factory } = makeFactory(parent, script);
    const provider = createInProcessProvider({ factory, tokenBudget: 200 });

    const result = await provider.start({ prompt: '一步到位' }).result;
    // run 无第二轮——abort 无从干预，结算诚实记 completed
    expect(result.stopReason).toBe('completed');
  });
});

describe('in-process provider — 深度执法（§6.5 单调下界）', () => {
  it('子 delegationDepth 超默认帽 3 → SUBAGENT_DEPTH_EXCEEDED + 子装配即刻销毁', () => {
    const parent = new Session({ delegationDepth: 3 }); // 子 fork 后 = 4 > 3
    const { factory, children } = makeFactory(parent, () => {
      throw new Error('不应到达模型层');
    });
    const provider = createInProcessProvider({ factory });

    expect(() => provider.start({ prompt: '再委一层' })).toThrowError(
      expect.objectContaining({ code: SUBAGENT_DEPTH_EXCEEDED }),
    );
    // 不留半活子：装配已销毁（恰一次）
    expect(children[0]!.disposedTimes()).toBe(1);
  });

  it('request.maxDepth 更紧时按其执法（min(请求, 装配默认)）', () => {
    const parent = new Session({ delegationDepth: 1 }); // 子 = 2
    const { factory, children } = makeFactory(parent, () => {
      throw new Error('不应到达模型层');
    });
    const provider = createInProcessProvider({ factory });

    expect(() => provider.start({ prompt: 'x', maxDepth: 1 })).toThrowError(
      expect.objectContaining({ code: SUBAGENT_DEPTH_EXCEEDED }),
    );
    expect(children[0]!.disposedTimes()).toBe(1);
  });

  it('未超帽放行（父 2 → 子 3 = 默认帽边界，含边界不拒）', async () => {
    const parent = new Session({ delegationDepth: 2 }); // 子 = 3 ≤ 3
    const message = textWithUsage('三楼完工', usageOf(10, 5, 5));
    const script: StreamFn = () => syntheticStream(message);
    const { factory } = makeFactory(parent, script);
    const provider = createInProcessProvider({ factory });

    const result = await provider.start({ prompt: 'x' }).result;
    expect(result.stopReason).toBe('completed');
  });
});

describe('in-process provider — 失败映射与 dispose', () => {
  it('loop failed（error 终态）→ stopReason=error + diagnostic 载上游错误', async () => {
    const parent = new Session();
    const script: StreamFn = () => syntheticStream(terminalWithUsage('error', '上游 529', usageOf(5, 5, 0)));
    const { factory } = makeFactory(parent, script);
    const provider = createInProcessProvider({ factory });

    const result = await provider.start({ prompt: 'x' }).result;
    expect(result.stopReason).toBe('error');
    expect(result.diagnostic).toContain('上游 529');
    expect(result.output).toBe('');
  });

  it('子 run 抛错（工厂违约路）→ 兜底 error 结算（result 永不 reject）', async () => {
    const parent = new Session();
    const { factory } = makeFactory(parent, () => {
      throw new Error('不应被调（run 自抛覆盖）');
    });
    // 覆写 run 抛错——验证 provider 的 async 兜底路
    const throwingFactory: InProcessChildFactory = (opts) => {
      const child = factory(opts);
      return { ...child, run: () => Promise.reject(new Error('子装配崩溃')) };
    };
    const provider = createInProcessProvider({ factory: throwingFactory });

    const result = await provider.start({ prompt: 'x' }).result;
    expect(result.stopReason).toBe('error');
    expect(result.diagnostic).toContain('子装配崩溃');
  });

  it('dispose 幂等（多次调用工厂半边恰释放一次）', async () => {
    const parent = new Session();
    const message = textWithUsage('完工', usageOf(10, 5, 5));
    const script: StreamFn = () => syntheticStream(message);
    const { factory, children } = makeFactory(parent, script);
    const provider = createInProcessProvider({ factory });

    const execution = provider.start({ prompt: 'x' });
    await execution.result;
    execution.dispose();
    execution.dispose();
    execution.dispose();
    // provider 的释放挂在 result 微任务后（run 结算后才拆装配）——让一拍微任务走完
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(children[0]!.disposedTimes()).toBe(1);
  });

  it('run 中途 dispose：abort 传导 loop → aborted 结算（未触帽不改判）', async () => {
    const parent = new Session();
    // 第二轮模型调用挂起（真实流「取消落在等待回包途中」形态）：dispose 触发
    // abort 才解出 aborted 终态——避免自由轮转脚本把预算刷爆干扰断言
    const script: StreamFn = (() => {
      let call = 0;
      const fn: StreamFn = (_context, _options, signal) => {
        call += 1;
        if (call > 1) {
          return new Promise((resolve) => {
            signal?.addEventListener(
              'abort',
              () => resolve(syntheticStream(terminalWithUsage('aborted', '收工', usageOf(0, 0, 0)))),
              { once: true },
            );
          });
        }
        return syntheticStream(toolCallWithUsage(usageOf(10, 5, 5)));
      };
      return fn;
    })();
    const { factory, children } = makeFactory(parent, script);
    const provider = createInProcessProvider({ factory, tokenBudget: 1_000_000 });

    const execution = provider.start({ prompt: 'x' });
    // 首轮（toolUse+echo）完成、run 挂在第二轮回包处再取消
    await new Promise((resolve) => setTimeout(resolve, 5));
    execution.dispose();
    const result = await execution.result;
    expect(result.stopReason).toBe('aborted');
    // 取消也走释放路（工厂半边恰一次）
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(children[0]!.disposedTimes()).toBe(1);
  });
});
