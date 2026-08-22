/**
 * L1 session 单元测试——会话与存储篇语义面全覆盖：
 * append 七步流水线 / 事件词汇纪律 / 遮蔽校验 / 投影 / 恢复 / fork / 种子校验。
 */

import { describe, expect, it, vi } from 'vitest';
import { AppError, SESSION_EVENT_TOO_LARGE } from '../contracts/errors.js';
import type { SessionEvent } from '../contracts/events.js';
import { Session, deepFreeze, getSessionEventType, interruptedTurnClosers, registerSessionEventType } from './index.js';

/** 构造一个小会话的标准前缀：turn 0 = user + assistant 纯文本 */
function makeChatSession(): Session {
  const s = new Session();
  s.append('turn/start', {});
  s.append('user/message', { content: '你好' });
  s.append('assistant/message', {
    content: [{ type: 'text', text: '你好，有什么可以帮你？' }],
    stopReason: 'end_turn',
  });
  s.append('turn/end', { reason: 'completed' });
  return s;
}

/** 构造一个带工具调用的完整 turn（含守门与结果） */
function appendToolTurn(s: Session, opts: { gate?: 'allow' | 'block' | 'mutate'; withResult?: boolean } = {}): void {
  s.append('turn/start', {});
  s.append('user/message', { content: '列出文件' });
  s.append('assistant/message', { content: [], stopReason: 'tool_use' });
  s.append('tool/call', { toolCallId: 'tc-1', name: 'list_dir', arguments: '{"path":"."}' });
  if (opts.gate) {
    s.append('gate/decision', { toolCallId: 'tc-1', decision: opts.gate, reason: '默认策略' });
  }
  if (opts.withResult !== false) {
    s.append('tool/result', { toolCallId: 'tc-1', content: 'a.ts\nb.ts' });
    s.append('assistant/message', { content: [{ type: 'text', text: '共两个文件' }], stopReason: 'end_turn' });
    s.append('turn/end', { reason: 'completed' });
  }
}

describe('append 七步流水线', () => {
  it('seq 从 0 起强制连续；活体通知同步收到每个事件', () => {
    const emitted: SessionEvent[] = [];
    const s = new Session({ emit: (e) => emitted.push(e) });
    const e0 = s.append('turn/start', {});
    const e1 = s.append('user/message', { content: 'hi' });
    expect(e0.seq).toBe(0);
    expect(e1.seq).toBe(1);
    expect(s.events.map((e) => e.seq)).toEqual([0, 1]);
    // 活体通知同步（第⑥步）：追加即达，无需等待
    expect(emitted.map((e) => e.type)).toEqual(['turn/start', 'user/message']);
  });

  it('data 写入即深冻结：外部改不动日志内数据（含嵌套）', () => {
    const s = new Session();
    const payload = { list: [{ name: 'a' }] };
    s.append('todo/write', { items: payload.list });
    payload.list[0]!.name = 'tampered'; // 原对象后续被改
    const stored = s.events[0]!.data as { items: Array<{ name: string }> };
    expect(stored.items[0]!.name).toBe('a'); // 日志内是快照副本，不受影响
    expect(() => {
      stored.items[0]!.name = 'x';
    }).toThrowError(TypeError); // 且已冻结，直接改抛 TypeError
  });

  it('落盘为零：Session 不持有任何 I/O 句柄（emit 回调缺省即无副作用）', () => {
    const s = new Session(); // 无 emit 也能完整工作——事实源写入不依赖观察者
    s.append('user/message', { content: 'x' });
    expect(s.length).toBe(1);
  });
});

describe('data 快照校验（步骤①）', () => {
  const bad = (name: string, value: unknown): void =>
    it(`拒绝非 JSON 值：${name}`, () => {
      const s = new Session();
      expect(() => s.append('user/message', { value })).toThrowError(AppError);
    });

  bad('undefined', undefined);
  bad('function', () => 1);
  bad('symbol', Symbol('s'));
  bad('bigint', 10n);
  bad('NaN', Number.NaN);
  bad('Infinity', Number.POSITIVE_INFINITY);
  bad('Date 实例', new Date(0));
  bad('Map 实例', new Map());

  it('拒绝循环引用', () => {
    const s = new Session();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => s.append('user/message', loop)).toThrowError(/循环引用/);
  });

  it('合法纯 JSON 深嵌套通过', () => {
    const s = new Session();
    s.append('user/message', {
      content: [{ type: 'text', text: 'ok', extra: { n: [1, 2, { deep: true, nil: null }] } }],
    });
    expect(s.length).toBe(1);
  });
});

describe('体积护栏（步骤③）', () => {
  /** 捕获 append 抛错并断言其错误码（错误码是唯一判据，不匹配文案） */
  function expectCode(fn: () => unknown, code: string): void {
    try {
      fn();
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(code);
    }
  }

  it('超 64KiB 默认护栏拒绝', () => {
    const s = new Session();
    const big = 'x'.repeat(64 * 1024 + 100);
    expectCode(() => s.append('user/message', { content: big }), SESSION_EVENT_TOO_LARGE);
  });
  it('护栏可配（测试用小值）', () => {
    const s = new Session({ maxEventBytes: 64 });
    expectCode(() => s.append('user/message', { content: 'x'.repeat(100) }), SESSION_EVENT_TOO_LARGE);
    s.append('user/message', { content: 'ok' });
    expect(s.length).toBe(1);
  });
});

describe('事件词汇纪律', () => {
  it('未注册类型写入即拒（写侧早拦，读侧同码）', () => {
    const s = new Session();
    expect(() => s.append('nope/thing', {})).toThrowError(/未知事件类型/);
  });

  it('registerSessionEventType 显式注册后可写；重复注册拒绝', () => {
    registerSessionEventType({ type: 'test/custom-event', category: 'log-only' });
    const s = new Session();
    s.append('test/custom-event', { k: 1 });
    expect(s.length).toBe(1);
    expect(() => registerSessionEventType({ type: 'test/custom-event', category: 'log-only' })).toThrowError(
      /重复注册/,
    );
  });

  it('核心 13 类词汇全在注册表且格式合规', () => {
    for (const type of [
      'turn/start',
      'turn/end',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'todo/write',
      'request/header',
      'session/end-seed',
      'approval/asked',
      'approval/decided',
      'gate/decision',
      'sandbox/mode',
    ]) {
      expect(getSessionEventType(type), type).toBeDefined();
    }
  });
});

describe('surfaceOp 遮蔽校验', () => {
  it('合法 replace：溯源覆盖区间 + 引用更早 seq → 通过', () => {
    const s = makeChatSession();
    s.append(
      'user/message',
      { content: '改口：其实帮我看下 b.ts' },
      {
        surfaceOp: { op: 'replace', start: 1, end: 1 },
        sourceEventSeqs: [1],
      },
    );
    expect(s.length).toBe(5);
  });

  it('溯源缺一个 seq 拒绝', () => {
    const s = makeChatSession();
    expect(() =>
      s.append(
        'user/message',
        { content: 'x' },
        {
          surfaceOp: { op: 'replace', start: 1, end: 2 },
          sourceEventSeqs: [1], // 缺 2
        },
      ),
    ).toThrowError(/溯源不完整/);
  });

  it('引用未来 seq 拒绝', () => {
    const s = makeChatSession();
    expect(() =>
      s.append(
        'user/message',
        { content: 'x' },
        {
          surfaceOp: { op: 'replace', start: 1, end: 1 },
          sourceEventSeqs: [1, 99], // 99 尚不存在
        },
      ),
    ).toThrowError(/非法 seq/);
  });

  it('区间越界拒绝', () => {
    const s = makeChatSession();
    expect(() =>
      s.append(
        'user/message',
        { content: 'x' },
        {
          surfaceOp: { op: 'replace', start: 1, end: 99 },
          sourceEventSeqs: [1, 2],
        },
      ),
    ).toThrowError(/区间非法/);
  });

  it('tool/result 的 replace：只改 content 通过，动 toolCallId 拒绝', () => {
    const s = new Session();
    appendToolTurn(s);
    const resultSeq = s.events.findIndex((e) => e.type === 'tool/result');
    // 只改 content：其余字段与被遮蔽事件一致
    s.append(
      'tool/result',
      { toolCallId: 'tc-1', content: '重写后的清单' },
      {
        surfaceOp: { op: 'replace', start: resultSeq, end: resultSeq },
        sourceEventSeqs: [resultSeq],
      },
    );
    expect(s.length).toBe(8);
    // 动 toolCallId = 越界改写，拒绝
    expect(() =>
      s.append(
        'tool/result',
        { toolCallId: 'tc-other', content: 'y' },
        {
          surfaceOp: { op: 'replace', start: resultSeq, end: resultSeq },
          sourceEventSeqs: [resultSeq],
        },
      ),
    ).toThrowError(/只能改 content/);
  });
});

describe('deriveMessages 投影（单一转换源）', () => {
  it('完整工具 turn：user → assistant(toolCall 内联) → toolResult → assistant', () => {
    const s = new Session();
    appendToolTurn(s, { gate: 'allow' });
    const msgs = s.deriveMessages();
    expect(msgs.map((m) => m.type)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    // 工具调用内联合成进 assistant 消息
    const assistant = msgs[1]!;
    expect(assistant.type).toBe('assistant');
    if (assistant.type === 'assistant') {
      expect(assistant.toolCalls).toHaveLength(1);
      expect(assistant.toolCalls[0]!.toolName).toBe('list_dir');
    }
    // 工具结果消息带配对信息与输出
    const tr = msgs[2]!;
    if (tr.type === 'toolResult') {
      expect(tr.toolCallId).toBe('tc-1');
      expect(tr.toolName).toBe('list_dir');
      expect(tr.output).toBe('a.ts\nb.ts');
      expect(tr.isError).toBe(false);
    }
    // turn 边界 / gate / log-only 不进模型历史
    const flat = JSON.stringify(msgs);
    expect(flat).not.toContain('turn/start');
    expect(flat).not.toContain('gate/decision');
  });

  it('被遮蔽节点不出现在投影里', () => {
    const s = makeChatSession();
    s.append(
      'user/message',
      { content: '替换后的新指令' },
      {
        surfaceOp: { op: 'replace', start: 1, end: 1 },
        sourceEventSeqs: [1],
      },
    );
    const contents = s
      .deriveMessages()
      .filter((m) => m.type === 'user')
      .map((m) => (m as { content: unknown }).content);
    expect(contents).toEqual(['替换后的新指令']);
  });

  it('缓存复用：未追加时两次调用返回同一引用，追加后失效重算', () => {
    const s = makeChatSession();
    const first = s.deriveMessages();
    expect(s.deriveMessages()).toBe(first); // 同一引用 = 缓存命中
    s.append('user/message', { content: '再问一句' });
    const second = s.deriveMessages();
    expect(second).not.toBe(first);
    expect(second).toHaveLength(first.length + 1);
  });
});

describe('interruptedTurnClosers 恢复（纯函数）', () => {
  it('未配对 tool/call 且无守门 → TOOL_NOT_STARTED（可重试）', () => {
    const s = new Session();
    appendToolTurn(s, { withResult: false }); // 崩溃在工具执行前
    const closers = interruptedTurnClosers(s.events);
    expect(closers.map((c) => c.type)).toEqual(['tool/result', 'turn/end']);
    const data = closers[0]!.data as { error?: { code: string } };
    expect(data.error?.code).toBe('TOOL_NOT_STARTED');
    expect((closers[1]!.data as { reason: string }).reason).toBe('interrupted');
  });

  it('守门已放行（gate allow）→ TOOL_OUTCOME_UNKNOWN（须核验外部状态）', () => {
    const s = new Session();
    appendToolTurn(s, { gate: 'allow', withResult: false }); // 崩溃在工具执行中
    const closers = interruptedTurnClosers(s.events);
    const data = closers[0]!.data as { error?: { code: string } };
    expect(data.error?.code).toBe('TOOL_OUTCOME_UNKNOWN');
  });

  it('合成 time 复用最后真实事件；完整会话 closers 为空', () => {
    const s = new Session();
    appendToolTurn(s, { gate: 'allow' });
    expect(interruptedTurnClosers(s.events)).toEqual([]);
    // 崩溃会话：合成事件 time = 尾事件 time
    const s2 = new Session();
    appendToolTurn(s2, { withResult: false });
    const lastTime = s2.events[s2.length - 1]!.time;
    for (const closer of interruptedTurnClosers(s2.events)) {
      expect(closer.time).toBe(lastTime);
    }
  });

  it('Session.recoverFromInterruption 幂等：第二遍不再追加', () => {
    const s = new Session();
    appendToolTurn(s, { gate: 'allow', withResult: false });
    const first = s.recoverFromInterruption();
    expect(first.map((e) => e.type)).toEqual(['tool/result', 'turn/end']);
    expect(s.recoverFromInterruption()).toEqual([]); // 闭合后幂等
    // 恢复后投影可正常重建（工具结果为错误终态）
    const tr = s.deriveMessages().find((m) => m.type === 'toolResult');
    expect(tr).toBeDefined();
    if (tr?.type === 'toolResult') {
      expect(tr.isError).toBe(true);
    }
  });
});

describe('fork 种子（前缀 + end-seed 边界）', () => {
  it('快照式 fork：共享冻结种子、seedLength = boundary+1、新事件从活区续写', () => {
    const parent = makeChatSession();
    const child = parent.fork();
    expect(child.header.parentSession).toBe(parent.header.sessionId);
    expect(child.header.origin).toBe('fork');
    // 种子 = 4 条源事件 + 1 条 end-seed
    expect(child.header.seedLength).toBe(5);
    expect(child.length).toBe(5);
    expect(child.events[4]!.type).toBe('session/end-seed');
    // 种子共享引用（不可变零拷贝）
    expect(child.events[0]).toBe(parent.events[0]);
    // 新事件从种子之后续写，seq 连续
    child.append('turn/start', {});
    expect(child.events[5]!.seq).toBe(5);
  });

  it('fork 子会话默认不继承父 emit：子事件不触发父观察者（接线由持久化门面注入）', () => {
    const emitted: SessionEvent[] = [];
    const parent = new Session({ emit: (e) => emitted.push(e) });
    parent.append('turn/start', {});
    parent.append('turn/end', { reason: 'completed' });
    emitted.length = 0; // 排除构造期事件
    parent.fork().append('turn/start', {});
    expect(emitted).toEqual([]); // 父 emit 闭包捕获父实例，继承会让子事件写进父队列
  });

  it('指定边界 fork：消费侧 slice(seedLength) 只见活区', () => {
    // 双 turn 会话：turn1（纯文本）seq 0-3 已闭合，turn2 从 seq 4 起
    const parent = makeChatSession();
    appendToolTurn(parent, { gate: 'allow' });
    const child = parent.fork({ boundary: 4 }); // 种子 = 恰好第一个 turn
    expect(child.header.seedLength).toBe(5);
    const live = child.events.slice(child.header.seedLength);
    expect(live).toHaveLength(0); // 尚无活区事件
    child.append('user/message', { content: '子会话第一句' });
    expect(child.events.slice(child.header.seedLength).map((e) => e.type)).toEqual(['user/message']);
  });

  it('边界落在敞开 turn 内拒绝', () => {
    const s = new Session();
    s.append('turn/start', {});
    s.append('user/message', { content: 'x' }); // turn 未闭合
    expect(() => s.fork({ boundary: 2 })).toThrowError(/敞开 turn/);
  });

  it('delegation origin：深度 +1', () => {
    const parent = makeChatSession();
    const child = parent.fork({ origin: 'delegation' });
    expect(child.header.delegationDepth).toBe(1);
    expect(child.header.origin).toBe('delegation');
  });
});

describe('种子注入（恢复 loadStored 的会话侧半边）', () => {
  it('合法日志构造成功且可继续续写', () => {
    const stored = makeChatSession().events;
    const s = new Session({ seed: stored, origin: 'resume' });
    expect(s.length).toBe(4);
    expect(s.header.origin).toBe('resume');
    s.append('user/message', { content: '恢复后继续' });
    expect(s.events[4]!.seq).toBe(4);
  });

  it('seq 断裂拒绝', () => {
    const stored = [...makeChatSession().events];
    (stored[2] as { seq: number }).seq = 9; // 篡改制造断裂
    expect(() => new Session({ seed: stored })).toThrowError(/断裂/);
  });

  it('未知类型且非 ignorable 整体拒绝（读侧语义）', () => {
    const bogus: SessionEvent = {
      type: 'mystery/thing',
      seq: 0,
      time: 1,
      data: {},
    };
    expect(() => new Session({ seed: [bogus] })).toThrowError(/未知事件类型/);
    // ignorable 未知类型放行（向前兼容：新版本写入、旧版本可读）
    const forward: SessionEvent = { type: 'future/thing', seq: 0, time: 1, data: {}, ignorable: true };
    expect(() => new Session({ seed: [forward] })).not.toThrow();
  });
});

describe('deepFreeze 基元', () => {
  it('嵌套冻结 + 环形安全', () => {
    const obj: Record<string, unknown> = { a: { b: [{ c: 1 }] } };
    obj.self = obj; // 环形
    deepFreeze(obj);
    expect(Object.isFrozen(obj)).toBe(true);
    expect(Object.isFrozen(obj.a as object)).toBe(true);
    expect(Object.isFrozen((obj.a as { b: object[] }).b[0]!)).toBe(true);
  });
});

describe('活体通知隔离（第⑥步契约）', () => {
  it('emit 回调抛错会向上传播（隔离责任在 ctx.emit per-handler catch，本层不吞装配错误）', () => {
    const boom = vi.fn(() => {
      throw new Error('observer bug');
    });
    const s = new Session({ emit: boom });
    expect(() => s.append('user/message', { content: 'x' })).toThrowError('observer bug');
    // 事件已入库：事实源写入不因通知失败回滚
    expect(s.length).toBe(1);
  });
});
