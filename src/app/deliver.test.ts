/**
 * L5 app — ConversationDriver.deliver 三通道路由测试（骨架篇 §4.1/§6.4，subagent 纵切三）。
 *
 * 直接构造驱动（不经组合根——路由逻辑是驱动自有面，mock 只停在模型层脚本流）。
 * 锁行为面：闲时 followUp / 忙时 steer（turn 边界续跑）/ 拆卸中 inject（只落事件
 * 不开 run）/ 自激预算三连后退化为 inject / 用户手写消息恢复预算。
 */
import { describe, expect, it } from 'vitest';
import type { AssistantMessage, AssistantStream, AssistantStreamEvent, StreamFn } from '../contracts/llm.js';
import { ConversationDriver } from './assembly.js';
import { defaultConvertToLlm } from './convert.js';

/* ---------------- 测试基建 ---------------- */

/** 零用量 */
const NO_USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };

/** 文本 assistant 终值 */
const textMessage = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  usage: NO_USAGE,
  stopReason: 'stop',
  timestamp: 1,
});

/** 合成流：start → done */
function syntheticStream(message: AssistantMessage): AssistantStream {
  const events: AssistantStreamEvent[] = [
    { type: 'start', partial: { ...message, content: [] } },
    { type: 'done', reason: 'stop', message },
  ];
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: () =>
          index < events.length
            ? Promise.resolve({ value: events[index++]!, done: false as const })
            : Promise.resolve({ value: undefined, done: true as const }),
      };
    },
    result: async () => message,
  };
}

/** 用户的 user 消息（归因可选） */
const userMessage = (text: string): { role: 'user'; content: string; timestamp: number } => ({
  role: 'user',
  content: text,
  timestamp: 1,
});

/** 观测面：流调用序 + 事件面（display 扇出即 emit 序列的可观测半边） */
interface Harness {
  readonly driver: ConversationDriver;
  readonly calls: string[];
  readonly events: string[];
}

/** 建驱动：streamFn 每次调用回一条脚本文本（按调用序消费）；display 记录事件型 */
function makeDriver(responses: string[] = []): Harness {
  const calls: string[] = [];
  const events: string[] = [];
  const streamFn: StreamFn = () => {
    calls.push(`call-${calls.length + 1}`);
    const text = responses[Math.min(calls.length - 1, responses.length - 1)] ?? '答';
    return syntheticStream(textMessage(text));
  };
  const driver = new ConversationDriver({
    context: { systemPrompt: '', messages: [], tools: [] },
    loopConfig: { streamFn, model: 'test/model', convertToLlm: defaultConvertToLlm },
  });
  driver.addDisplay((event) => {
    events.push(event.type);
  });
  return { driver, calls, events };
}

/** 微任务自旋等待（条件真即返——纯 microtask 驱动的 run 编排观测用） */
async function spinUntil(condition: () => boolean): Promise<void> {
  while (!condition()) await Promise.resolve();
}

/* ---------------- 用例 ---------------- */

describe('deliver 三通道路由（§4.1 状态机）', () => {
  it('闲时投递 → followUp：开 run 消费该消息；非后台投递', async () => {
    const h = makeDriver(['答一']);
    const channel = h.driver.deliver(userMessage('第一句'));
    expect(channel).toBe('followUp');
    await h.driver.settle();
    expect(h.calls).toEqual(['call-1']);
  });

  it('忙时投递 → steer：入 steering 队列，turn 边界注入开第二个模型调用（同一 run 续跑）', async () => {
    // 首轮模型调用挂起（真实流「等待回包途中」形态）：deliver 必须发生在初始
    // steering 排空点之后、turn 边界之前——消息只能经 turn 边界注入
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    const timeline: string[][] = [];
    const streamFn: StreamFn = (context) => {
      calls.push(`call-${calls.length + 1}`);
      timeline.push(context.messages.map((m) => m.role));
      if (calls.length === 1) return gate.then(() => syntheticStream(textMessage('答一')));
      return syntheticStream(textMessage('答二'));
    };
    const driver = new ConversationDriver({
      context: { systemPrompt: '', messages: [], tools: [] },
      loopConfig: { streamFn, model: 'test/model', convertToLlm: defaultConvertToLlm },
    });
    const first = driver.submitOnce('首问');
    // 首轮模型调用已发出（初始 steering 排空点已过）
    await spinUntil(() => calls.length >= 1);
    expect(driver.deliver(userMessage('插话'), { backgroundWake: true })).toBe('steer');
    release();
    await first;
    await driver.settle();
    expect(calls).toEqual(['call-1', 'call-2']);
    // 第二个模型调用可见插话（turn 边界注入进了上下文——首答之后）
    expect(timeline[1]).toEqual(['user', 'assistant', 'user']);
  });

  it('拆卸中投递 → inject：只发 message_start/message_end，不开 run 不入队', async () => {
    const h = makeDriver();
    h.driver.requestQuit();
    const channel = h.driver.deliver(userMessage('收尾通知'), { backgroundWake: true });
    expect(channel).toBe('inject');
    expect(h.events).toEqual(['message_start', 'message_end']);
    expect(h.calls).toEqual([]); // 无模型调用
  });

  it('自激预算：连续 3 次后台唤醒 followUp，第 4 次降级 inject（只留记录不唤醒）', async () => {
    const h = makeDriver();
    // 三连后台唤醒（每次等 run 收尾再投——wakeCount 只在闲时投递累加）
    for (let i = 1; i <= 3; i++) {
      expect(h.driver.deliver(userMessage(`唤醒${i}`), { backgroundWake: true })).toBe('followUp');
      await h.driver.settle();
    }
    // 第 4 次：预算耗尽 → inject 降级（§6.4 maxConsecutiveWakes 默认 3）
    expect(h.driver.deliver(userMessage('唤醒4'), { backgroundWake: true })).toBe('inject');
    expect(h.calls).toHaveLength(3); // 第 4 次未开 run
  });

  it('用户手写消息恢复预算：预算耗尽后用户投递 → followUp 且预算清零，后台唤醒复通', async () => {
    const h = makeDriver();
    for (let i = 1; i <= 4; i++) {
      h.driver.deliver(userMessage(`唤醒${i}`), { backgroundWake: true });
      await h.driver.settle();
    }
    // 预算已耗尽（上一用例形态）：用户手写消息 → followUp + 清零
    expect(h.driver.deliver(userMessage('真人插话'))).toBe('followUp');
    await h.driver.settle();
    // 后台唤醒预算已恢复 → 再度 followUp
    expect(h.driver.deliver(userMessage('唤醒5'), { backgroundWake: true })).toBe('followUp');
    await h.driver.settle();
  });
});
