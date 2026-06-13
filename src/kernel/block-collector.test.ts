import { describe, it, expect, beforeEach } from 'vitest';
import {
  BlockCollector,
  getOrCreateBlockCollector,
  disposeBlockCollector,
  _clearBlockCollectorsForTest,
  type BlockEmitter,
} from './block-collector.js';
import type { StreamBlockPayload } from '../contracts/message-blocks.js';

/**
 * BlockCollector 单测 —— 钉死对话内联事件归一的不变量。
 *
 * 注入捕获式 emit（不依赖全局 EventBus），断言 stream.block payload 的形状：
 *   - text/reasoning delta：blockType + delta + 稳定派生 blockId
 *   - tool（task.telemetry 路径）：出生即终态，携带完整初始 Block（name/input/output/state）
 *   - registry：同 taskId 复用同一 collector（messageId 稳定）；dispose 移除
 */
describe('BlockCollector（对话内联事件归一）', () => {
  let emitted: StreamBlockPayload[];
  const emit: BlockEmitter = (p) => emitted.push(p);

  beforeEach(() => {
    emitted = [];
    _clearBlockCollectorsForTest();
  });

  it('text delta：emit blockType=text + delta，blockId 由 messageId 派生且稳定', () => {
    const c = new BlockCollector('s1', 't1', 'c1', emit);
    c.onTextDelta('你');
    c.onTextDelta('好');
    expect(emitted).toHaveLength(2);
    expect(emitted.every((e) => e.blockType === 'text')).toBe(true);
    expect(emitted.every((e) => e.delta !== undefined)).toBe(true);
    // 同 collector 的 text blockId 稳定（前端据此聚到同一块）
    expect(emitted[0].blockId).toBe(`${c.messageId}#text`);
    expect(emitted[1].blockId).toBe(emitted[0].blockId);
    expect(emitted[0].messageId).toBe(c.messageId);
    expect(emitted[0].sessionId).toBe('s1');
    expect(emitted[0].taskId).toBe('t1');
  });

  it('reasoning delta：emit blockType=thinking', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onReasoningDelta('分析中');
    expect(emitted[0].blockType).toBe('thinking');
    expect(emitted[0].blockId).toBe(`${c.messageId}#thinking`);
    expect(emitted[0].delta).toBe('分析中');
  });

  it('tool（task.telemetry 路径）：出生即终态 completed，携带完整初始 Block', () => {
    const c = new BlockCollector('s1', 't1', 'c1', emit);
    c.onToolCall({
      toolName: 'shell',
      input: '{"cmd":"ls"}',
      result: '{"files":["a"]}',
      isError: false,
      durationMs: 42,
    });
    expect(emitted).toHaveLength(1);
    const e = emitted[0];
    expect(e.blockType).toBe('tool');
    expect(e.state).toBe('completed');
    const block = e.block;
    expect(block?.type).toBe('tool');
    expect(block?.name).toBe('shell');
    expect(block?.state).toBe('completed');
    // input/result 是 JSON 串 → 规整为对象
    expect(block?.input).toEqual({ cmd: 'ls' });
    expect(block?.output).toEqual({ files: ['a'] });
    expect(block?.durationMs).toBe(42);
  });

  it('tool isError：出生即 failed，error 字段填充', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onToolCall({ toolName: 'shell', input: '{}', result: '命令未找到', isError: true });
    const block = emitted[0].block;
    expect(block?.type).toBe('tool');
    expect(block?.state).toBe('failed');
    expect(block?.error).toBe('命令未找到');
  });

  it('同名工具多次调用：blockId 序号递增（task.telemetry 无 callId，用序号合成稳定 id）', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onToolCall({ toolName: 'shell', input: '1', result: 'r1', isError: false });
    c.onToolCall({ toolName: 'shell', input: '2', result: 'r2', isError: false });
    expect(emitted[0].blockId).toBe(`${c.messageId}#tool#shell#1`);
    expect(emitted[1].blockId).toBe(`${c.messageId}#tool#shell#2`);
  });

  it('非 JSON 的 input/result 保留为字符串', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onToolCall({ toolName: 'note', input: '纯文本入参', result: '纯文本结果', isError: false });
    const block = emitted[0].block;
    expect(block?.input).toBe('纯文本入参');
    expect(block?.output).toBe('纯文本结果');
  });

  it('空 delta 不 emit（噪音过滤）', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onTextDelta('');
    c.onReasoningDelta('');
    expect(emitted).toHaveLength(0);
  });
});

/**
 * 流式工具路径（daemon / 外部 driver：call 与 result 分离到达，按 callId 配对）。
 * 钉死 onToolStart/onToolComplete 的状态机推进 + 配对 + 容错不变量——
 * 这是期4 委派内联（外部 agent 工具卡片）所依赖的核心归一逻辑。
 */
describe('BlockCollector 流式工具（onToolStart/onToolComplete）', () => {
  let emitted: StreamBlockPayload[];
  const emit: BlockEmitter = (p) => emitted.push(p);

  beforeEach(() => {
    emitted = [];
    _clearBlockCollectorsForTest();
  });

  it('start → running block，blockId 由 callId 派生（跨 start/complete 幂等定位）', () => {
    const c = new BlockCollector('s1', 't1', 'c1', emit);
    c.onToolStart({ callId: 'call-1', toolName: 'shell', input: { cmd: 'ls' }, ts: 1000 });
    expect(emitted).toHaveLength(1);
    const e = emitted[0];
    expect(e.blockType).toBe('tool');
    expect(e.state).toBe('running');
    expect(e.blockId).toBe(`${c.messageId}#tool#call-1`);
    expect(e.block?.type).toBe('tool');
    expect(e.block?.state).toBe('running');
    expect(e.block?.name).toBe('shell');
    expect(e.block?.input).toEqual({ cmd: 'ls' });
  });

  it('start + complete 配对：emit running 再 emit 终态，同 blockId，durationMs = 时间差', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onToolStart({ callId: 'c1', toolName: 'shell', input: {}, ts: 1000 });
    c.onToolComplete({ callId: 'c1', output: '{"ok":true}', success: true, ts: 1250 });
    expect(emitted).toHaveLength(2);
    // 两次同 blockId（前端 upsert 原地更新 running→completed）
    expect(emitted[0].blockId).toBe(emitted[1].blockId);
    const terminal = emitted[1];
    expect(terminal.state).toBe('completed');
    expect(terminal.block?.state).toBe('completed');
    expect(terminal.block?.output).toEqual({ ok: true });
    // 1250 - 1000 = 250ms
    expect(terminal.block?.durationMs).toBe(250);
  });

  it('complete success=false：终态 failed，output 同时写 error', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onToolStart({ callId: 'c1', toolName: 'shell', input: {}, ts: 100 });
    c.onToolComplete({ callId: 'c1', output: '命令未找到', success: false, ts: 200 });
    const terminal = emitted[1];
    expect(terminal.block?.state).toBe('failed');
    expect(terminal.block?.error).toBe('命令未找到');
  });

  it('fail-open：complete 先于 start（孤儿 result）→ 降级 toolName=unknown、无 durationMs', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onToolComplete({ callId: 'orphan', output: 'r', success: true, ts: 500 });
    expect(emitted).toHaveLength(1);
    const e = emitted[0];
    expect(e.block?.name).toBe('unknown');
    expect(e.block?.state).toBe('completed');
    // 乱序孤儿无法计时
    expect(e.block?.durationMs).toBeUndefined();
  });

  it('buildBlocks 只含终态 tool（running 不落库，防崩溃幽灵 block）', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onToolStart({ callId: 'c1', toolName: 'shell', input: {}, ts: 1000 });
    // 未 complete 即 buildBlocks——只有 start 的 running 不应出现
    const blocks = c.buildBlocks({ draftResponse: 'hi' });
    expect(blocks.filter((b) => b.type === 'tool')).toHaveLength(0);
    // 文本 block 仍由 draftResponse 注入
    expect(blocks.some((b) => b.type === 'text' && b.text === 'hi')).toBe(true);
  });
});

describe('BlockCollector registry', () => {
  beforeEach(() => _clearBlockCollectorsForTest());

  it('同 taskId 复用同一 collector（messageId 稳定）', () => {
    const a = getOrCreateBlockCollector('t1', 's1', 'c1');
    const b = getOrCreateBlockCollector('t1', 's1', 'c1');
    expect(b).toBe(a);
    expect(b.messageId).toBe(a.messageId);
  });

  it('dispose 后再 getOrCreate 返回新实例（新 messageId）', () => {
    const a = getOrCreateBlockCollector('t1', 's1', undefined);
    const disposed = disposeBlockCollector('t1');
    expect(disposed).toBe(a);
    const b = getOrCreateBlockCollector('t1', 's1', undefined);
    expect(b).not.toBe(a);
    expect(b.messageId).not.toBe(a.messageId);
  });
});
