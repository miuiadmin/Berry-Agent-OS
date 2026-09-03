/**
 * L1 session 单元测试——会话与存储篇语义面全覆盖：
 * append 七步流水线 / 事件词汇纪律 / 遮蔽校验 / 投影 / 恢复 / fork / 种子校验。
 */

import { describe, expect, it, vi } from 'vitest';
import { AppError, SESSION_EVENT_TOO_LARGE } from '../contracts/errors.js';
import type { SessionEvent } from '../contracts/events.js';
import {
  Session,
  deepFreeze,
  getSessionEventType,
  interruptedTurnClosers,
  lastClosedTurnBoundary,
  registerSessionEventType,
} from './index.js';
import { deriveMessages as fullFold } from './derive.js';

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

  it('undefined 单列报文：报文带 path 定位与成因句（检查可选链/条件展开）', () => {
    const s = new Session();
    // 条件展开漏删键的典型形：{ ...(x && { a }) } 在 x 为 undefined 时展开进 undefined
    expect(() => s.append('user/message', { items: [1, 2, undefined] })).toThrowError(
      /items\[2\].*undefined（展开对象携带了未定义字段——检查可选链\/条件展开）/,
    );
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
    registerSessionEventType({ type: 'test/custom-event', tier: 'stable', category: 'log-only' });
    const s = new Session();
    s.append('test/custom-event', { k: 1 });
    expect(s.length).toBe(1);
    expect(() =>
      registerSessionEventType({ type: 'test/custom-event', tier: 'stable', category: 'log-only' }),
    ).toThrowError(/重复注册/);
  });

  // ignorable 盖章纪律（2026-08-23 生态读码补钉 dsh-1）：向前兼容位唯一生产者 = 注册项
  it('注册项声明 ignorable → append 盖章写入事件（调用者无法手填）', () => {
    registerSessionEventType({ type: 'test/ignorable-event', category: 'log-only', tier: 'stable', ignorable: true });
    const s = new Session();
    const event = s.append('test/ignorable-event', { k: 1 });
    expect(event.ignorable).toBe(true);
  });

  it('注册项未声明 ignorable → 事件不携带该位（缺省 = 读侧必须认识）', () => {
    registerSessionEventType({ type: 'test/plain-event', tier: 'stable', category: 'log-only' });
    const s = new Session();
    const event = s.append('test/plain-event', { k: 2 });
    expect(event.ignorable).toBeUndefined();
  });

  it('核心 14 类词汇全在注册表且格式合规', () => {
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
      'llm/usage',
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

  // 配对不切断断言回归锁（边缘纪律 1，compaction 纵切宿主执法——写测试构造
  // 场景时撞出「误杀 tool/result 单点自遮蔽特例」的真 bug，本组三测锁死）
  it('区间起点落在 tool/result 上（call 留区间外）= 切断配对拒绝', () => {
    const s = new Session();
    appendToolTurn(s);
    // 日志：0 turn/start / 1 user / 2 assistant / 3 tool/call / 4 tool/result / 5 assistant / 6 turn/end
    expect(() =>
      s.append(
        'user/message',
        { content: '压缩摘要' },
        { surfaceOp: { op: 'replace', start: 4, end: 5 }, sourceEventSeqs: [4, 5] },
      ),
    ).toThrowError(/切断了 tool 配对/);
  });

  it('区间终点落在 tool/call 上（result 留区间外）= 切断配对拒绝', () => {
    const s = new Session();
    appendToolTurn(s);
    expect(() =>
      s.append(
        'user/message',
        { content: '压缩摘要' },
        { surfaceOp: { op: 'replace', start: 2, end: 3 }, sourceEventSeqs: [2, 3] },
      ),
    ).toThrowError(/切断了 tool 配对/);
  });

  it('整体含入配对（call+result 都在区间内）通过——切点不在配对中间', () => {
    const s = new Session();
    appendToolTurn(s);
    // [3,4] = tool/call + tool/result 整对遮蔽：合法（起点非 tool/result、终点非 tool/call）
    s.append(
      'user/message',
      { content: '压缩摘要', source: 'app:compaction' },
      { surfaceOp: { op: 'replace', start: 3, end: 4 }, sourceEventSeqs: [3, 4, 5] },
    );
    expect(s.deriveMessages().map((m) => m.type)).not.toContain('toolResult');
  });

  // 配对完整性表检查回归锁（20260901-d #7 勘正）：真实事件流 tool/call 与
  // tool/result 恒隔 gate/decision（+审批流 approval/*）——压缩切界恒落夹层
  // 事件，原「区间首/末事件类型」边界近似两断言恒不命中（夹具必须带 gate
  // 构造真实形态，紧邻配对测不出盲区）。
  it('夹层形态：call 在区间内、result 在区间外（夹层掩住旧断言）= 切断配对拒绝', () => {
    const s = new Session();
    appendToolTurn(s, { gate: 'allow' });
    // 日志：0 turn/start / 1 user / 2 assistant / 3 tool/call / 4 gate/decision /
    // 5 tool/result / 6 assistant / 7 turn/end
    // [2,4] 遮 assistant+call+gate：result(5) 留区间外——旧边界断言（首=assistant
    // 末=gate）双双放行，投影产孤儿 call → 修死
    expect(() =>
      s.append(
        'user/message',
        { content: '压缩摘要' },
        { surfaceOp: { op: 'replace', start: 2, end: 4 }, sourceEventSeqs: [2, 3, 4] },
      ),
    ).toThrowError(/切断了 tool 配对/);
  });

  it('夹层形态反向：result 在区间内、call 在区间外 = 切断配对拒绝（孤儿 toolResult 400 修死）', () => {
    const s = new Session();
    appendToolTurn(s, { gate: 'allow' });
    // [4,6] 遮 gate+result+assistant：call(3) 留区间外——孤儿 toolResult 引用
    // 不存在的 tool_use id，provider 400 不可续聊
    expect(() =>
      s.append(
        'user/message',
        { content: '压缩摘要' },
        { surfaceOp: { op: 'replace', start: 4, end: 6 }, sourceEventSeqs: [4, 5, 6] },
      ),
    ).toThrowError(/切断了 tool 配对/);
  });

  it('整对含夹层（call+gate+result 全入区间）通过——真实压缩切界形态', () => {
    const s = new Session();
    appendToolTurn(s, { gate: 'allow' });
    // [3,5] = tool/call + gate/decision + tool/result：配对完整含入夹层，合法
    s.append(
      'user/message',
      { content: '压缩摘要', source: 'app:compaction' },
      { surfaceOp: { op: 'replace', start: 3, end: 5 }, sourceEventSeqs: [3, 4, 5] },
    );
    expect(s.deriveMessages().map((m) => m.type)).not.toContain('toolResult');
  });

  it('无对可切放行：孤儿 call（result 不存在于全日志）的伴生遮蔽通过', () => {
    const s = new Session();
    appendToolTurn(s, { gate: 'allow', withResult: false });
    // 日志：0 turn/start / 1 user / 2 assistant / 3 tool/call / 4 gate/decision（流中
    // 断终值——auto-retry 伴生组形态：call 无 result）。[2,4] 遮掉孤儿 call 组：
    // 另一半不存在于全日志 = 无对可切，放行（遮蔽只消灭既有孤儿不制造新孤儿）
    s.append(
      'user/message',
      { content: '压缩摘要', source: 'app:compaction' },
      { surfaceOp: { op: 'replace', start: 2, end: 4 }, sourceEventSeqs: [2, 3, 4] },
    );
    expect(s.deriveMessages().map((m) => m.type)).not.toContain('toolCall');
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

describe('增量投影缓存（§3.1 增量推进 / §10#5——遗漏大扫 20260901 O-6）', () => {
  /** 全阶段一致性互证：活体投影 ≡ 全量纯函数折算；字符账 ≡ stringify 实长 */
  function expectConsistent(s: Session): void {
    expect(s.deriveMessages()).toEqual(fullFold(s.events));
    expect(s.projectedJsonChars()).toBe(JSON.stringify(s.deriveMessages()).length);
  }

  it('多形态日志全阶段等价：增量步进 / surfaceOp 代际重建 / pending 缓冲发布全覆盖', () => {
    const s = new Session();
    expectConsistent(s); // 空日志：字符 = 2（「[]」）
    s.append('turn/start', {});
    s.append('user/message', { content: '第一问' });
    s.append('assistant/message', { content: [{ type: 'text', text: '第一答' }], stopReason: 'end_turn' });
    expectConsistent(s); // pending assistant 折进发布拷贝
    s.append('turn/end', { reason: 'completed' });
    appendToolTurn(s, { gate: 'allow' }); // 工具 turn：toolCalls 内联 + toolResult 配对
    expectConsistent(s);
    // 代际重建路径：遮蔽事件进新段（增量步进无法回溯摘除，整体重折）
    s.append(
      'user/message',
      { content: '压缩摘要' },
      { surfaceOp: { op: 'replace', start: 1, end: 3 }, sourceEventSeqs: [1, 2, 3] },
    );
    expectConsistent(s);
    // 重建后再增量（两路径交替）
    s.append('user/message', { content: '新的一轮' });
    expectConsistent(s);
    // 二次遮蔽（重建 → 重建）
    s.append(
      'user/message',
      { content: '再压一刀' },
      { surfaceOp: { op: 'replace', start: 5, end: 6 }, sourceEventSeqs: [5, 6] },
    );
    expectConsistent(s);
  });

  it('敞开 assistant 缓冲的发布拷贝不随活缓冲增长（toolCalls 拷贝切断共享）', () => {
    const s = new Session();
    s.append('turn/start', {});
    s.append('user/message', { content: '跑工具' });
    s.append('assistant/message', { content: [], stopReason: 'tool_use' });
    s.append('tool/call', { toolCallId: 'tc-1', name: 'read', arguments: '{}' });
    const held = s.deriveMessages();
    const heldTail = held.at(-1);
    expect(heldTail?.type).toBe('assistant');
    if (heldTail?.type !== 'assistant') return;
    // 缓冲迟到新调用后：旧发布物形状定格不变；新发布物可见新增
    s.append('tool/call', { toolCallId: 'tc-2', name: 'write', arguments: '{}' });
    expect(heldTail.toolCalls).toHaveLength(1);
    const freshTail = s.deriveMessages().at(-1);
    if (freshTail?.type !== 'assistant') throw new Error('新发布物尾条应为 assistant');
    expect(freshTail.toolCalls).toHaveLength(2);
  });

  it('字符账全等式逐步互证：长短内容交错 + 遮蔽重建后仍 === stringify 实长', () => {
    const s = new Session();
    const lines = ['短', '中等长度的句子'.repeat(3), JSON.stringify({ k: [1, 2, 3] }), 'x'.repeat(200), '尾句'];
    s.append('turn/start', {});
    for (const [i, line] of lines.entries()) {
      s.append('user/message', { content: line });
      s.append('assistant/message', { content: [{ type: 'text', text: `答 ${i}` }], stopReason: 'end_turn' });
      // 每步互证（pending 条目现算路径 + 已冲刷条目增量累计路径都被踩到）
      expect(s.projectedJsonChars()).toBe(JSON.stringify(s.deriveMessages()).length);
    }
    s.append('turn/end', { reason: 'completed' });
    s.append(
      'user/message',
      { content: '遮蔽前半' },
      { surfaceOp: { op: 'replace', start: 1, end: 4 }, sourceEventSeqs: [1, 2, 3, 4] },
    );
    expect(s.projectedJsonChars()).toBe(JSON.stringify(s.deriveMessages()).length);
  });

  it('引用稳定：遮蔽代际重建后未再推进的重复读仍同一引用（O(1) 读契约）', () => {
    const s = makeChatSession();
    s.append(
      'user/message',
      { content: '摘要' },
      { surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1] },
    );
    const first = s.deriveMessages();
    expect(s.deriveMessages()).toBe(first);
    expect(s.projectedJsonChars()).toBe(JSON.stringify(first).length);
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

  it('复合形状：孤儿 tool/call + 后续正常闭合 turn + 尾部敞开 turn → 孤儿穿透闭合不被吞（#9 修复 c）', () => {
    // 复刻 app 层回调违约的病态日志：turn1 的 tool/call 落账后 run 异常、
    // 无 tool/result 也无 turn/end；随后新 turn 正常闭合；最后又一个 turn 敞开崩溃
    const s = new Session();
    s.append('turn/start', {});
    s.append('tool/call', { toolCallId: 'tc-orphan', name: 'read', arguments: '{}' });
    // 后续正常 turn（旧实现 pending.clear() 在此吞掉孤儿——修复后须穿透）
    s.append('turn/start', {});
    s.append('tool/call', { toolCallId: 'tc-ok', name: 'write', arguments: '{}' });
    s.append('tool/result', { toolCallId: 'tc-ok', content: 'ok' });
    s.append('turn/end', { reason: 'completed' });
    // 尾部敞开 turn（崩溃点）
    s.append('turn/start', {});

    const closers = interruptedTurnClosers(s.events);
    expect(closers.map((c) => c.type)).toEqual(['tool/result', 'turn/end', 'turn/end']);
    // 孤儿拿到合成错误终态（TOOL_NOT_STARTED）——静默吞没 = 恢复协议失守
    const orphan = closers[0]!.data as { toolCallId: string; error?: { code: string } };
    expect(orphan.toolCallId).toBe('tc-orphan');
    expect(orphan.error?.code).toBe('TOOL_NOT_STARTED');
    // 两个 turn/end = 深度计数补足两个敞开 turn（turn1 + 尾部 turn）
    for (const closer of closers.slice(1)) {
      expect((closer.data as { reason: string }).reason).toBe('interrupted');
    }
    // 追加 closers 后幂等（一遍收敛——补 N 个不残留深度）
    for (const closer of closers) s.append(closer.type as never, closer.data);
    expect(interruptedTurnClosers(s.events)).toEqual([]);
  });
});

describe('lastClosedTurnBoundary（delegation fork 边界缺省，纯函数）', () => {
  it('尾部敞开 turn：边界 = 最后闭合 turn 末尾（敞开段事件未定性不进种子）', () => {
    const s = new Session();
    s.append('turn/start', {});
    s.append('user/message', { content: '第一问' });
    s.append('assistant/message', { content: '第一答' });
    s.append('turn/end', { reason: 'completed' }); // seq 0-3 闭合段
    s.append('turn/start', {}); // 委派发生处：turn 敞开
    s.append('user/message', { content: '第二问' });
    expect(lastClosedTurnBoundary(s.events)).toBe(4); // 前缀恰含闭合段
  });

  it('全闭合 / 无 turn 结构 / 空日志：全长（与快照式缺省同值）', () => {
    const closed = new Session();
    closed.append('turn/start', {});
    closed.append('turn/end', { reason: 'completed' });
    expect(lastClosedTurnBoundary(closed.events)).toBe(2);
    const noTurn = new Session();
    noTurn.append('sandbox/mode', { mode: 'workspace-write' });
    expect(lastClosedTurnBoundary(noTurn.events)).toBe(1);
    expect(lastClosedTurnBoundary([])).toBe(0);
  });

  it('病态嵌套（重复 start 半闭合）：余额法只认尾部真敞开段', () => {
    const s = new Session();
    s.append('turn/start', {}); // 外层 start 无 end（敞开）
    s.append('turn/start', {});
    s.append('turn/end', { reason: 'completed' }); // 内层闭合
    expect(lastClosedTurnBoundary(s.events)).toBe(0); // 外层起点即边界
  });

  it('与 fork 联动：敞开日志上 delegation fork 以闭合边界落子（修复前必红）', () => {
    const s = new Session();
    s.append('turn/start', {});
    s.append('user/message', { content: '问' });
    s.append('turn/end', { reason: 'completed' });
    s.append('turn/start', {}); // 敞开——委派时点
    // 修复前：缺省快照边界落在敞开 turn 内 → SESSION_FORK_BOUNDARY_INVALID
    const child = s.fork({ origin: 'delegation', boundary: lastClosedTurnBoundary(s.events) });
    expect(child.header.seedLength).toBe(4); // 3 闭合事件 + end-seed
    expect(child.header.origin).toBe('delegation');
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
