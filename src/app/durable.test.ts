/**
 * L5 app — durable 接线测试（映射顺序 + 投影回读 round-trip，真实 Session 无库）。
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
      'tool/call',
      'tool/result',
      'turn/end',
    ]);
    // tool/call 的 arguments 落原始字符串（未解析态）
    const call = session.events[3]!.data as { arguments: string };
    expect(call.arguments).toBe('{"path":"a.txt","content":"x"}');
    // turn/end 终态映射：toolUse → completed
    expect((session.events[5]!.data as { reason: string }).reason).toBe('completed');
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
    const call = session.events[1]!.data as { arguments: string };
    expect(call.arguments.endsWith('[truncated for durable log]')).toBe(true);
    // 整事件序列化字节在 64KiB 护栏内
    expect(Buffer.byteLength(JSON.stringify(session.events[1]!), 'utf8')).toBeLessThan(64 * 1024);
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
});
