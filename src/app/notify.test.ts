/**
 * L5 app — 子代理结算通知器单元测试（骨架篇 §6.4 落码注记，subagent 纵切三）。
 *
 * 真件：真 Session（append 落事件即观测面）+ formatSettlementNotice 纯函数；
 * driver 用记录替身（通知器的端口半边——三通道路由行为由 deliver.test.ts 锁）。
 * 锁行为面：结算折叠（llm/usage 形状/跳过条件）/ 通知路由（background·owner·
 * 会话在位三条件）/ 通知文案结构（label 兜底/失败族正文/截断）。
 */
import { describe, expect, it } from 'vitest';
import { Session } from '../session/session.js';
import type { SubagentExecution, SubagentRequest, SubagentResult, SubagentSettlement } from '../contracts/subagent.js';
import type { ConversationDriver, DeliverChannel, DeliverOptions } from './assembly.js';
import { createSubagentNotifier, formatSettlementNotice } from './notify.js';

/* ---------------- 测试基建 ---------------- */

/** deliver 调用记录（消息 + 选项——通知器的全部可观测输出） */
interface DeliverCall {
  readonly content: string;
  readonly source?: string;
  readonly backgroundWake: boolean;
}

/** 记录型 driver 替身（通知器只用 deliver 一个面） */
function recordingDriver(): { driver: ConversationDriver; calls: DeliverCall[] } {
  const calls: DeliverCall[] = [];
  const driver = {
    deliver(message: { content: string; source?: string }, opts?: DeliverOptions): DeliverChannel {
      calls.push({
        content: message.content,
        source: message.source,
        backgroundWake: opts?.backgroundWake === true,
      });
      return 'followUp';
    },
  } as unknown as ConversationDriver;
  return { driver, calls };
}

/** 结算载荷构造（缺省 = 后台 + 有用量 + 无主） */
function settlement(
  overrides: Partial<{ result: Partial<SubagentResult>; background: boolean; ownerSessionId?: string }> = {},
): SubagentSettlement {
  const request: SubagentRequest = {
    provider: 'in-process',
    prompt: '审读这份设计',
    label: '委派-审读',
    background: overrides.background ?? true,
    ...(overrides.ownerSessionId !== undefined ? { ownerSessionId: overrides.ownerSessionId } : {}),
  };
  const execution: SubagentExecution = {
    id: 'child-session-1',
    result: Promise.resolve({ output: '', stopReason: 'completed' }),
    dispose: () => {},
  };
  const result: SubagentResult = {
    output: '审毕，无阻塞项',
    stopReason: 'completed',
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
    ...overrides.result,
  };
  return { request, execution, result };
}

/** 组装通知器（session 为活引用——测试内直改闭包变量模拟 /new 热切换） */
function makeNotifier(session: Session | undefined) {
  const { driver, calls } = recordingDriver();
  const notifier = createSubagentNotifier({ driver, getSession: () => session, model: 'test/model' });
  return { notifier, calls };
}

/* ---------------- 用例 ---------------- */

describe('结算折叠（llm/usage 计量事件）', () => {
  it('有用量：并入当前会话一条 background 道 llm/usage（callId = execution.id）', () => {
    const session = new Session();
    const { notifier } = makeNotifier(session);
    notifier(settlement());
    const usageEvents = session.events.filter((e) => e.type === 'llm/usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]!.data).toEqual({
      callId: 'child-session-1',
      model: 'test/model',
      priority: 'background',
      usage: { input: 100, output: 50 },
    });
  });

  it('无用量（外部 provider 报不上）：折叠跳过，不落空事件', () => {
    const session = new Session();
    const { notifier } = makeNotifier(session);
    notifier(settlement({ result: { usage: undefined } }));
    expect(session.events.filter((e) => e.type === 'llm/usage')).toHaveLength(0);
  });

  it('无会话（persist:false 诊断面）：折叠跳过不抛', () => {
    const { notifier } = makeNotifier(undefined);
    expect(() => notifier(settlement())).not.toThrow();
  });
});

describe('三通道通知路由', () => {
  it('background + owner 匹配（或缺省无主）：投递 source=subagent-settled 的 user 消息（backgroundWake 计自激预算）', () => {
    const session = new Session();
    const { notifier, calls } = makeNotifier(session);
    notifier(settlement({ ownerSessionId: session.header.sessionId }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.source).toBe('subagent-settled');
    expect(calls[0]!.backgroundWake).toBe(true);
    // 正文含 label 与终态（文案结构锁 formatSettlementNotice 用例，此处只锚点）
    expect(calls[0]!.content).toContain('委派-审读');
    expect(calls[0]!.content).toContain('completed');
  });

  it('owner 不匹配（/new 已切走）：通知丢弃——折叠仍落（记账不随路由丢）', () => {
    const session = new Session();
    const { notifier, calls } = makeNotifier(session);
    notifier(settlement({ ownerSessionId: 'sess-旧会话' }));
    expect(calls).toHaveLength(0);
    expect(session.events.filter((e) => e.type === 'llm/usage')).toHaveLength(1);
  });

  it('前台委派：不通知（父正 await result——注入即重复）；折叠仍落', () => {
    const session = new Session();
    const { notifier, calls } = makeNotifier(session);
    notifier(settlement({ background: false }));
    expect(calls).toHaveLength(0);
    expect(session.events.filter((e) => e.type === 'llm/usage')).toHaveLength(1);
  });

  it('无会话：不通知（无路由键也无投递意义）', () => {
    const { notifier, calls } = makeNotifier(undefined);
    notifier(settlement());
    expect(calls).toHaveLength(0);
  });
});

describe('formatSettlementNotice 文案结构', () => {
  it('完成族：label + stopReason + tokens + output 正文', () => {
    const text = formatSettlementNotice(settlement());
    expect(text).toContain('「委派-审读」');
    expect(text).toContain('已完成');
    expect(text).toContain('150 tokens');
    expect(text).toContain('审毕，无阻塞项');
  });

  it('失败族：正文载 diagnostic（无条件纪律——没机会 report 的场景更要通知）', () => {
    const text = formatSettlementNotice(
      settlement({ result: { output: '', stopReason: 'error', diagnostic: '子代理超时', usage: undefined } }),
    );
    expect(text).toContain('已结算');
    expect(text).toContain('error');
    expect(text).toContain('子代理超时');
    expect(text).not.toContain('tokens');
  });

  it('label 缺省兜底：prompt 前 40 字符，超长加尾标记', () => {
    const long = 'x'.repeat(60);
    const s = settlement();
    const text = formatSettlementNotice({ ...s, request: { ...s.request, label: undefined, prompt: long } });
    expect(text).toContain(`「${'x'.repeat(40)}…」`);
  });

  it('output 超摘录上限截断加尾标记（通知是唤醒线索非产物载体）', () => {
    const s = settlement({ result: { output: 'y'.repeat(5000), stopReason: 'completed' } });
    const text = formatSettlementNotice(s);
    expect(text).toContain('y'.repeat(4000));
    expect(text).toContain('…[截断]');
    expect(text.length).toBeLessThan(5000);
  });
});
