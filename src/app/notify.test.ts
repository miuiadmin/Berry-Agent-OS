/**
 * L5 app — 子代理结算通知器单元测试（骨架篇 §6.4 落码注记，subagent 纵切三；S1 键控随迁）。
 *
 * 真件：真 Session（append 落事件即观测面）+ formatSettlementNotice 纯函数；
 * driver 用记录替身（通知器的端口半边——三通道路由行为由 deliver.test.ts 锁）。
 * 锁行为面：归属解析（ownerSessionId 显式键 → 调用链 → 无处即跳）/ 结算折叠
 * （llm/usage 形状/跳过条件）/ 通知路由（background·条目在位两条件）/ 通知
 * 文案结构（label 兜底/失败族正文/截断）。
 */
import { describe, expect, it } from 'vitest';
import { Session } from '../session/session.js';
import type { SubagentExecution, SubagentRequest, SubagentResult, SubagentSettlement } from '../contracts/subagent.js';
import type { ConversationDriver, DeliverChannel, DeliverOptions, DriverEntry } from '../chat/index.js';
import { runInSessionChain } from '../context/chain.js';
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

/** 注册表替身（entries 直查——与 assembly 接线 resolveEntry: entries.get 同款） */
function makeRegistry(): { notifier: (s: SubagentSettlement) => void; entries: Map<string, DriverEntry> } {
  const entries = new Map<string, DriverEntry>();
  const notifier = createSubagentNotifier({ resolveEntry: (sessionId) => entries.get(sessionId), model: 'test/model' });
  return { notifier, entries };
}

/** 建一条已注册条目（记录 driver + 真 session——折叠/投递两个观测面都齐） */
function registerEntry(entries: Map<string, DriverEntry>): { entry: DriverEntry; calls: DeliverCall[] } {
  const { driver, calls } = recordingDriver();
  const entry = { session: new Session(), driver, retired: false } as unknown as DriverEntry;
  entries.set(entry.session.header.sessionId, entry);
  return { entry, calls };
}

/** 结算载荷构造（缺省 = 后台 + 有用量 + 无显式键） */
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

/* ---------------- 用例 ---------------- */

describe('归属解析 + 结算折叠（llm/usage 计量事件）', () => {
  it('显式键命中：并入该会话一条 background 道 llm/usage（callId = execution.id）', () => {
    const { notifier, entries } = makeRegistry();
    const { entry } = registerEntry(entries);
    notifier(settlement({ ownerSessionId: entry.session.header.sessionId }));
    const usageEvents = entry.session.events.filter((e) => e.type === 'llm/usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]!.data).toEqual({
      callId: 'child-session-1',
      model: 'test/model',
      priority: 'background',
      usage: { input: 100, output: 50 },
    });
  });

  it('无显式键、调用链在场：折进链会话（in-process 结算回调运行于父 tool call 链）', () => {
    const { notifier, entries } = makeRegistry();
    const { entry } = registerEntry(entries);
    runInSessionChain(entry.session.header.sessionId, () => notifier(settlement()));
    expect(entry.session.events.filter((e) => e.type === 'llm/usage')).toHaveLength(1);
  });

  it('显式键优先于调用链（键 ≠ 链时随键走——归属不由调用语境僭越）', () => {
    const { notifier, entries } = makeRegistry();
    const owner = registerEntry(entries);
    const chained = registerEntry(entries);
    runInSessionChain(chained.entry.session.header.sessionId, () =>
      notifier(settlement({ ownerSessionId: owner.entry.session.header.sessionId })),
    );
    expect(owner.entry.session.events.filter((e) => e.type === 'llm/usage')).toHaveLength(1);
    expect(chained.entry.session.events.filter((e) => e.type === 'llm/usage')).toHaveLength(0);
  });

  it('无键无链：不折叠不投递不抛（测试面无 ALS 语境——结构性防御位）', () => {
    const { notifier, entries } = makeRegistry();
    registerEntry(entries);
    expect(() => notifier(settlement())).not.toThrow();
  });

  it('键查无条目（会话未开/已整体卸载）：折叠跳过（无处落账）', () => {
    const { notifier, entries } = makeRegistry();
    const { entry } = registerEntry(entries);
    notifier(settlement({ ownerSessionId: 'sess-不在表' }));
    expect(entry.session.events.filter((e) => e.type === 'llm/usage')).toHaveLength(0);
  });

  it('无用量（外部 provider 报不上）：折叠跳过，不落空事件', () => {
    const { notifier, entries } = makeRegistry();
    const { entry } = registerEntry(entries);
    notifier(settlement({ ownerSessionId: entry.session.header.sessionId, result: { usage: undefined } }));
    expect(entry.session.events.filter((e) => e.type === 'llm/usage')).toHaveLength(0);
  });
});

describe('三通道通知路由', () => {
  it('background + 归属命中：投递 source=subagent-settled 的 user 消息（backgroundWake 计自激预算）', () => {
    const { notifier, entries } = makeRegistry();
    const { entry, calls } = registerEntry(entries);
    notifier(settlement({ ownerSessionId: entry.session.header.sessionId }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.source).toBe('subagent-settled');
    expect(calls[0]!.backgroundWake).toBe(true);
    // 正文含 label 与终态（文案结构锁 formatSettlementNotice 用例，此处只锚点）
    expect(calls[0]!.content).toContain('委派-审读');
    expect(calls[0]!.content).toContain('completed');
  });

  it('前台委派：不通知（父正 await result——注入即重复）；折叠仍落', () => {
    const { notifier, entries } = makeRegistry();
    const { entry, calls } = registerEntry(entries);
    notifier(settlement({ background: false, ownerSessionId: entry.session.header.sessionId }));
    expect(calls).toHaveLength(0);
    expect(entry.session.events.filter((e) => e.type === 'llm/usage')).toHaveLength(1);
  });

  it('退役条目照折照投（通知器不判 retired——停摆降级 inject 是驱动侧语义，路由不断）', () => {
    const { notifier, entries } = makeRegistry();
    const { entry, calls } = registerEntry(entries);
    entry.retired = true;
    notifier(settlement({ ownerSessionId: entry.session.header.sessionId }));
    expect(calls).toHaveLength(1);
    expect(entry.session.events.filter((e) => e.type === 'llm/usage')).toHaveLength(1);
  });

  it('无归属（无键无链）：不通知（无处可投）', () => {
    const { notifier } = makeRegistry();
    expect(() => notifier(settlement())).not.toThrow();
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
