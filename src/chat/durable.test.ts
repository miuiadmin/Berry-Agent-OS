/**
 * L4 chat — durable 接线测试（映射顺序 + 投影回读 round-trip，真实 Session 无库）。
 */

import { describe, expect, it } from 'vitest';
import { Session } from '../session/session.js';
import { deriveMessages } from '../session/derive.js';
import type { AgentEvent } from '../agent/events.js';
import type { AssistantMessage, ToolResultMessage } from '../contracts/llm.js';
import { createDurableSinks, projectedToAgentMessages } from './durable.js';

/** 零用量 */
const NO_USAGE = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 };

/** 文本 assistant 终值 */
const textAssistant = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  usage: NO_USAGE,
  stopReason: 'stop',
  timestamp: 1,
});

/** 带工具调用块的 assistant 终值 */
const toolCallAssistant = (): AssistantMessage => ({
  role: 'assistant',
  content: [
    { type: 'text', text: '看一下' },
    { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'a.txt', content: 'x' } },
  ],
  usage: NO_USAGE,
  stopReason: 'toolUse',
  timestamp: 1,
});

/** 工具结果消息 */
const toolResult = (isError = false): ToolResultMessage => ({
  role: 'toolResult',
  toolCallId: 'call-1',
  toolName: 'write',
  content: [{ type: 'text', text: isError ? '失败：被遮罩' : '写入完成' }],
  isError,
  timestamp: 1,
});

/** 事件类型序列 */
const types = (events: readonly { type: string }[]) => events.map((e) => e.type);

describe('createDurableSinks：事件 → session.append 映射', () => {
  it('一个完整 turn 落 turn/start → user/message → assistant/message → tool/call → tool/result → turn/end', () => {
    const session = new Session();
    const sinks = createDurableSinks(session);
    const events: AgentEvent[] = [
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'message_start', message: { role: 'user', content: '写文件', timestamp: 1 } },
      { type: 'message_end', message: { role: 'user', content: '写文件', timestamp: 1 } },
      { type: 'message_start', message: toolCallAssistant() },
      { type: 'message_end', message: toolCallAssistant() },
      { type: 'message_start', message: toolResult() },
      { type: 'message_end', message: toolResult() },
      { type: 'turn_end', message: toolCallAssistant(), toolResults: [toolResult()] },
      { type: 'agent_end', status: 'completed', messages: [] },
    ];
    for (const event of events) sinks.handle(event);

    expect(types(session.events)).toEqual([
      'turn/start',
      'user/message',
      'assistant/message',
      // 底账统一（契约篇 §5.4）：主循环前台道折叠——usage 落账紧跟 assistant 终值
      'llm/usage',
      'tool/call',
      'tool/result',
      'turn/end',
    ]);
    // tool/call 的 arguments 落原始字符串（未解析态）
    const call = session.events[4]!.data as { arguments: string };
    expect(call.arguments).toBe('{"path":"a.txt","content":"x"}');
    // turn/end 终态映射：toolUse → completed
    expect((session.events[6]!.data as { reason: string }).reason).toBe('completed');
  });

  it('底账统一不双计：delegation 会话不自折前台道（子会话花销只经结算折叠进父账）', () => {
    // delegation 子会话：assistant 用量不落 llm/usage——它的账由父会话的
    // subagent 结算折叠（background 道，callId = 'delegation:' 前缀 + 子运行
    // id——复盘 R-1 判别式同源）统一入账，
    // 自折一道 + 结算一道 = 双计，守卫在 origin 上（契约篇 §5.4 底账统一）
    const delegation = new Session({ origin: 'delegation' });
    createDurableSinks(delegation).handle({ type: 'message_end', message: textAssistant('子跑完') });
    expect(delegation.events.filter((e) => e.type === 'llm/usage')).toHaveLength(0);
    // 对照：非 delegation 会话（主循环/独立跑）自折前台道
    const normal = new Session({ origin: 'user' });
    createDurableSinks(normal).handle({ type: 'message_end', message: textAssistant('主循环答') });
    const folds = normal.events.filter((e) => e.type === 'llm/usage');
    expect(folds).toHaveLength(1);
    const data = folds[0]!.data as {
      priority: string;
      usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
    };
    expect(data.priority).toBe('foreground');
    // NO_USAGE 夹具零 cache——四桶齐落（P1-5 全桶入账后 usage 恒四桶起）
    expect(data.usage).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it('底账全桶入账（P1-5 修偏回归锁）：cache 桶必落、上报桶随行、派生/折算桶滤除', () => {
    // 修偏前写点手写 {input,output}——cacheRead/cacheWrite 被裁，读侧 /usage 面板
    //（四桶总和）与底账两张皮（挖矿 B3）；归一函数 usageLedgerBuckets 是单一事实源
    const session = new Session({ origin: 'user' });
    createDurableSinks(session).handle({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '带缓存的轮' }],
        usage: {
          input: 100,
          output: 50,
          cacheRead: 1200,
          cacheWrite: 80,
          cacheWrite1h: 30,
          reasoning: 12,
          totalTokens: 1430,
          cost: { total: 0.01 },
        },
        stopReason: 'stop',
        timestamp: 1,
      },
    });
    const data = session.events.find((e) => e.type === 'llm/usage')!.data as { usage: Record<string, unknown> };
    expect(data.usage).toEqual({
      input: 100,
      output: 50,
      cacheRead: 1200,
      cacheWrite: 80,
      cacheWrite1h: 30,
      reasoning: 12,
    });
  });

  it('底账 model 口径统一（P1-5）：实录 provider+model 拼全形优先于装配缺省', () => {
    // 修偏前落裸 message.model（无 provider 前缀）——与 complete 写点的请求全形
    // 两种口径混在同一底账（挖矿即刻批②观察项）
    const session = new Session({ origin: 'user' });
    createDurableSinks(session, { model: 'anthropic/default-model' }).handle({
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        content: [{ type: 'text', text: '实录模型' }],
        usage: NO_USAGE,
        stopReason: 'stop',
        timestamp: 1,
      },
    });
    const data = session.events.find((e) => e.type === 'llm/usage')!.data as { model: string };
    expect(data.model).toBe('anthropic/claude-sonnet-5');
  });

  it('usagePriority 落账：background 会话声明 → llm/usage priority=background（tick 链路回归锁）', () => {
    // tick 子进程经 run --background → RuntimeOptions.usagePriority → 本参数——
    // 花销必须落 background 道才能被 canAfford('background') 的闸门读到（席 13 第二刀 blocker 修）
    const session = new Session({ origin: 'user' });
    createDurableSinks(session, { usagePriority: 'background' }).handle({
      type: 'message_end',
      message: textAssistant('无人值守轮'),
    });
    const data = session.events.find((e) => e.type === 'llm/usage')!.data as { priority: string };
    expect(data.priority).toBe('background');
    // 对照：缺省（不声明）仍是前台道——宿主前台轮与 tick 轮天然分流
    const foreground = new Session({ origin: 'user' });
    createDurableSinks(foreground).handle({ type: 'message_end', message: textAssistant('有人值守轮') });
    const fdata = foreground.events.find((e) => e.type === 'llm/usage')!.data as { priority: string };
    expect(fdata.priority).toBe('foreground');
  });

  it('stopReason → TurnEndReason 映射四分支', () => {
    const session = new Session();
    const sinks = createDurableSinks(session);
    const cases: Array<[AssistantMessage['stopReason'], string]> = [
      ['stop', 'completed'],
      ['toolUse', 'completed'],
      ['length', 'max-tokens'],
      ['error', 'error'],
      ['aborted', 'aborted'],
    ];
    for (const [stopReason] of cases) {
      sinks.handle({ type: 'turn_start' });
      sinks.handle({
        type: 'turn_end',
        message: { ...textAssistant('x'), stopReason },
        toolResults: [],
      });
    }
    const reasons = session.events
      .filter((e) => e.type === 'turn/end')
      .map((e) => (e.data as { reason: string }).reason);
    expect(reasons).toEqual(['completed', 'completed', 'max-tokens', 'error', 'aborted']);
  });

  it('isError 工具结果携带错误码与首段文本说明', () => {
    const session = new Session();
    const sinks = createDurableSinks(session);
    sinks.handle({ type: 'message_end', message: toolResult(true) });
    const data = session.events[0]!.data as { error?: { code: string; message?: string } };
    expect(data.error?.code).toBe('TOOL_ERROR');
    expect(data.error?.message).toBe('失败：被遮罩');
  });

  it('token 级与生命周期边界不落 durable（分层纪律）', () => {
    const session = new Session();
    const sinks = createDurableSinks(session);
    sinks.handle({ type: 'agent_start' });
    sinks.handle({ type: 'message_start', message: textAssistant('hi') });
    sinks.handle({
      type: 'message_update',
      message: textAssistant('h'),
      streamEvent: { type: 'text_delta', contentIndex: 0, delta: 'h', partial: textAssistant('h') },
    });
    sinks.handle({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'write', args: {} });
    sinks.handle({
      type: 'tool_execution_end',
      toolCallId: 'c',
      toolName: 'write',
      result: { content: [] },
      isError: false,
    });
    sinks.handle({ type: 'agent_end', status: 'completed', messages: [] });
    expect(session.events).toHaveLength(0);
  });

  it('elapsedMs 前台段耗时（基建大扫 #26）：message_start(assistant)→message_end 差入 llm/usage；无 start 缺席不造值、用后即清', () => {
    // 正路：先 message_start 再 message_end——elapsedMs = 本段 LLM 流耗时
    // （performance.now 差，口径不含 tool 执行；非负有限即行为锁）
    const withStart = new Session({ origin: 'user' });
    const sinks = createDurableSinks(withStart);
    sinks.handle({ type: 'message_start', message: textAssistant('流起点') });
    sinks.handle({ type: 'message_end', message: textAssistant('流终点') });
    const data = withStart.events.find((e) => e.type === 'llm/usage')!.data as { elapsedMs?: number };
    expect(typeof data.elapsedMs).toBe('number');
    expect(data.elapsedMs!).toBeGreaterThanOrEqual(0);
    // 用后即清：同 sinks 第二段 assistant message_end 无先行 start——不携旧值
    sinks.handle({ type: 'message_end', message: textAssistant('第二段无起点') });
    const second = withStart.events.filter((e) => e.type === 'llm/usage')[1]!.data as { elapsedMs?: number };
    expect(second.elapsedMs).toBeUndefined();
    // 缺席容错：全新 sinks 直接 message_end（恢复/旧 harness 形态）——不造字段
    const noStart = new Session({ origin: 'user' });
    createDurableSinks(noStart).handle({ type: 'message_end', message: textAssistant('无起点') });
    const ndata = noStart.events.find((e) => e.type === 'llm/usage')!.data as { elapsedMs?: number };
    expect(ndata.elapsedMs).toBeUndefined();
    // message_start 本身不落 durable（分层纪律不变——elapsedMs 只是闭包计时）
    expect(withStart.events.some((e) => (e.type as string) === 'message_start')).toBe(false);
  });

  it('gate 与审批 sink 分别落对应事件', () => {
    const session = new Session();
    const sinks = createDurableSinks(session);
    sinks.gate({ toolCallId: 'c1', decision: 'block', reason: 'carve-out' });
    sinks.approval.asked({ approvalId: 'a1', summary: '写入 .git/config' });
    sinks.approval.decided({ approvalId: 'a1', decision: 'unavailable' });
    expect(types(session.events)).toEqual(['gate/decision', 'approval/asked', 'approval/decided']);
  });

  it('超大 tool/result 内容截断到 durable 预算内：append 不抛、尾标记显式（#9 修复 a）', () => {
    const session = new Session();
    const sinks = createDurableSinks(session);
    // 70KiB 文本结果（fs read 上限 256KiB 的现实形状）：> 60KiB durable 预算、
    // < 64KiB 会话护栏——若无写侧截断，append 抛 SESSION_EVENT_TOO_LARGE 沿 emit
    // 上抛炸掉整个 run（fs.ts:94 与 session.ts 护栏的矛盾，宿主侧单点解）
    const big = 'x'.repeat(70 * 1024);
    expect(() =>
      sinks.handle({ type: 'message_end', message: { ...toolResult(), content: [{ type: 'text', text: big }] } }),
    ).not.toThrow();
    const data = session.events[0]!.data as { content: { type: string; text: string }[] };
    // 截断后带尾标记（读侧可识别语义损失）
    expect(data.content[0]!.text.endsWith('[truncated for durable log]')).toBe(true);
    // 整事件序列化字节在 64KiB 护栏内
    expect(Buffer.byteLength(JSON.stringify(session.events[0]!), 'utf8')).toBeLessThan(64 * 1024);
  });

  it('超大 user 纯文本与 image 块同样走截断（字符串整串截 / image 换文本占位）', () => {
    const session = new Session();
    const sinks = createDurableSinks(session);
    // user 纯字符串形态：整串截断
    sinks.handle({
      type: 'message_end',
      message: { role: 'user', content: 'y'.repeat(70 * 1024), timestamp: 1 },
    });
    const user = session.events[0]!.data as { content: string };
    expect(user.content.endsWith('[truncated for durable log]')).toBe(true);
    // image 块超预算：换文本占位（像素不进 durable——审计面非媒体库）
    sinks.handle({
      type: 'message_end',
      message: {
        role: 'user',
        content: [{ type: 'image', data: 'z'.repeat(70 * 1024), mimeType: 'image/png' }],
        timestamp: 1,
      },
    });
    const image = session.events[1]!.data as { content: { type: string; text?: string }[] };
    expect(image.content[0]!.type).toBe('text');
    expect(image.content[0]!.text).toBe('[image omitted: durable budget]');
  });
});

describe('投影回读 round-trip（append → derive → projectedToAgentMessages）', () => {
  it('durable 序列投影回 AgentMessage 与原始消息形状一致', () => {
    const session = new Session();
    const sinks = createDurableSinks(session);
    const user = { role: 'user' as const, content: '写文件', timestamp: 1 };
    const assistant = toolCallAssistant();
    const result = toolResult();
    for (const event of [
      { type: 'turn_start' },
      { type: 'message_end', message: user },
      { type: 'message_end', message: assistant },
      { type: 'message_end', message: result },
    ] as AgentEvent[]) {
      sinks.handle(event);
    }

    const projected = deriveMessages(session.events);
    expect(projected.map((m) => m.type)).toEqual(['user', 'assistant', 'toolResult']);
    // 回读适配：assistant 内联工具调用块由 tool/call 事件还原
    const roundTrip = projectedToAgentMessages(projected);
    expect(roundTrip).toHaveLength(3);
    const back = roundTrip[1] as AssistantMessage;
    expect(back.role).toBe('assistant');
    expect(back.content[1]).toEqual({
      type: 'toolCall',
      id: 'call-1',
      name: 'write',
      arguments: { path: 'a.txt', content: 'x' },
    });
    expect(back.usage).toEqual(NO_USAGE);
    // toolResult 还原
    const backResult = roundTrip[2] as ToolResultMessage;
    expect(backResult.toolCallId).toBe('call-1');
    expect(backResult.isError).toBe(false);
  });

  it('toolCall 块不双载：写侧 content 滤除内联块，回读恰好出现一次（回归锁）', () => {
    const session = new Session();
    const sinks = createDurableSinks(session);
    for (const event of [
      { type: 'turn_start' },
      { type: 'message_end', message: toolCallAssistant() },
      { type: 'message_end', message: toolResult() },
    ] as AgentEvent[]) {
      sinks.handle(event);
    }

    // durable 侧：assistant/message 的 content 只剩 text（toolCall 唯一承载腿是 tool/call 事件）
    const assistantEvent = session.events.find((e) => e.type === 'assistant/message')!;
    const contentTypes = (assistantEvent.data as { content: { type: string }[] }).content.map((b) => b.type);
    expect(contentTypes).toEqual(['text']);

    // round-trip：回读 assistant 内联块序列 = [text, toolCall]——恰好一次。
    // 修复前 content 原样保留内联 toolCall + 事件腿再拼一次 = [text, toolCall, toolCall]，
    // 恢复续跑会把重复 tool_use 发给 provider（2026-08-23 遗漏检查实证）
    const roundTrip = projectedToAgentMessages(deriveMessages(session.events));
    const back = roundTrip.find((m) => m.role === 'assistant') as AssistantMessage;
    const backTypes = back.content.map((b) => b.type);
    expect(backTypes).toEqual(['text', 'toolCall']);
    expect(backTypes.filter((t) => t === 'toolCall')).toHaveLength(1);
  });

  it('旧形状日志防御：投影 content 混入内联 toolCall 时回读滤除（兼容修复前落库的日志）', () => {
    const session = new Session();
    // 手工构造修复前的旧形状：assistant/message content 内联 toolCall + tool/call 事件双载
    session.append('assistant/message', {
      content: [
        { type: 'text', text: '看一下' },
        { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'a.txt', content: 'x' } },
      ] as never,
    });
    session.append('tool/call', { toolCallId: 'call-1', name: 'write', arguments: '{"path":"a.txt"}' });
    const roundTrip = projectedToAgentMessages(deriveMessages(session.events));
    const back = roundTrip[0] as AssistantMessage;
    const calls = back.content.filter((b) => b.type === 'toolCall');
    expect(calls).toHaveLength(1); // 内联块被滤，只剩事件腿还原的块
    expect(calls[0]).toEqual({
      type: 'toolCall',
      id: 'call-1',
      name: 'write',
      arguments: { path: 'a.txt' },
    });
  });

  it('超大 tool/call arguments 截断：append 不抛、带尾标记、回读解析回空对象（call 侧同链护栏）', () => {
    const session = new Session();
    const sinks = createDurableSinks(session);
    // 70KiB arguments（写类工具无上限、模型单轮可输出 64k token 的现实形状）：
    // 无预算时 append 抛 SESSION_EVENT_TOO_LARGE 炸 run——#9 修 a 的对侧腿
    const big = { path: 'a.txt', content: 'w'.repeat(70 * 1024) };
    expect(() =>
      sinks.handle({
        type: 'message_end',
        message: {
          ...toolCallAssistant(),
          content: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: big }],
        },
      }),
    ).not.toThrow();
    const call = session.events.find((e) => e.type === 'tool/call')!.data as { arguments: string };
    expect(call.arguments.endsWith('[truncated for durable log]')).toBe(true);
    // 整事件序列化字节在 64KiB 护栏内
    const callEvent = session.events.find((e) => e.type === 'tool/call')!;
    expect(Buffer.byteLength(JSON.stringify(callEvent), 'utf8')).toBeLessThan(64 * 1024);
    // 截断产生的坏 JSON 回读降级为空对象（与首次落库解析失败对称）
    const roundTrip = projectedToAgentMessages(deriveMessages(session.events));
    const back = roundTrip[0] as AssistantMessage;
    expect(back.content[0]).toEqual({ type: 'toolCall', id: 'call-1', name: 'write', arguments: {} });
  });

  it('arguments 解析失败回空对象（与首次落库失败对称）', () => {
    const session = new Session();
    session.append('assistant/message', { content: [] });
    session.append('tool/call', { toolCallId: 'c', name: 'write', arguments: '{broken' });
    const roundTrip = projectedToAgentMessages(deriveMessages(session.events));
    const back = roundTrip[0] as AssistantMessage;
    expect(back.content[0]).toEqual({ type: 'toolCall', id: 'c', name: 'write', arguments: {} });
  });

  it('缺 usage/stopReason 的投影回读有兜底（不抛错）', () => {
    const session = new Session();
    session.append('assistant/message', { content: [{ type: 'text', text: 'hi' }] });
    const roundTrip = projectedToAgentMessages(deriveMessages(session.events));
    const back = roundTrip[0] as AssistantMessage;
    expect(back.stopReason).toBe('stop');
    expect(back.usage.totalTokens).toBe(0);
  });

  it('user source 归因全链往返：落库带字段 → 投影带字段 → 回读还原；缺省不落字段（§3.1 dsh-8）', () => {
    const session = new Session();
    const sinks = createDurableSinks(session);
    // 带 source（子代理结算通知形态）与不带 source（用户手写）各一条
    sinks.handle({
      type: 'message_end',
      message: { role: 'user', content: '子代理已结算', timestamp: 1, source: 'subagent-settled' },
    });
    sinks.handle({ type: 'message_end', message: { role: 'user', content: '手写', timestamp: 2 } });

    // 写侧：带则落、缺省不落（读侧视为 'user'——不落空字段占位）
    const events = session.events.filter((e) => e.type === 'user/message') as {
      data: { content: string; source?: string };
    }[];
    expect(events).toHaveLength(2);
    expect(events[0]!.data.source).toBe('subagent-settled');
    expect(events[1]!.data).not.toHaveProperty('source');

    // 投影 → 回读：source 还原进 UserMessage（恢复续跑后归因不丢）
    const projected = deriveMessages(session.events);
    expect(projected[0]).toMatchObject({ type: 'user', source: 'subagent-settled' });
    expect(projected[1]).not.toHaveProperty('source');
    const roundTrip = projectedToAgentMessages(projected);
    expect(roundTrip[0]).toMatchObject({ role: 'user', source: 'subagent-settled' });
    expect(roundTrip[1]).not.toHaveProperty('source');
  });

  it('错误 assistant 的 errorMessage 全链往返：落库带字段 → 投影带字段 → 回读还原（基建大扫 #43）', () => {
    const session = new Session();
    const sinks = createDurableSinks(session);
    // stopReason=error 的终值（错误即数据——进程日志之外唯一持久错误面）
    const failed: AssistantMessage = {
      ...textAssistant(''),
      stopReason: 'error',
      errorMessage: 'Provider is not configured: anthropic',
    };
    sinks.handle({ type: 'turn_start' });
    sinks.handle({ type: 'message_end', message: failed });

    // 写侧：errorMessage 随 assistant/message 落 durable（修前：schema 无此字段，
    // 错误文本进程结束即蒸发——重启后只见空 assistant，不知为何失败）
    const evt = session.events.find((e) => e.type === 'assistant/message')!;
    expect((evt.data as { errorMessage?: string }).errorMessage).toBe('Provider is not configured: anthropic');

    // 投影透传（TUI 历史重画 / webui 投影渲染的消费面）
    const projected = deriveMessages(session.events);
    const assistant = projected.find((m) => m.type === 'assistant') as { errorMessage?: string };
    expect(assistant.errorMessage).toBe('Provider is not configured: anthropic');

    // 回读还原（恢复续跑后 convertToLlm 前的 AgentMessage 面不丢）
    const back = projectedToAgentMessages(projected).find((m) => m.role === 'assistant') as AssistantMessage;
    expect(back.errorMessage).toBe('Provider is not configured: anthropic');
  });
});
