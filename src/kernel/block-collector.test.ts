import { describe, it, expect, beforeEach } from 'vitest';
import {
  BlockCollector,
  getOrCreateBlockCollector,
  disposeBlockCollector,
  peekBlockCollector,
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

  it('getToolBlocks 返回已终态 tool（替代旧 pending.toolCalls 双真相源）', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onToolStart({ callId: 'c1', toolName: 'shell', input: { cmd: 'ls' }, ts: 1000 });
    // 仅 start：running 态不进 toolBlocks
    expect(c.getToolBlocks()).toHaveLength(0);
    c.onToolComplete({ callId: 'c1', output: '{"ok":true}', success: true, ts: 1100 });
    // complete 后：终态 tool 进 toolBlocks，携带完整字段
    const tools = c.getToolBlocks();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('shell');
    expect(tools[0].state).toBe('completed');
    expect(tools[0].durationMs).toBe(100);
  });
});

/**
 * 委派块路径（runtime / 外部 driver：Brain 委派给子 agent）。
 * 钉死 onDelegationStart/onDelegationComplete 的状态机推进 + 幂等 + 容错 + 落库序不变量——
 * 这是 doc-22 委派卡持久化（刷新后保留「委派给 X agent」表头）所依赖的核心归一逻辑。
 */
describe('BlockCollector 委派块（onDelegationStart/onDelegationComplete）', () => {
  let emitted: StreamBlockPayload[];
  const emit: BlockEmitter = (p) => emitted.push(p);

  beforeEach(() => {
    emitted = [];
    _clearBlockCollectorsForTest();
  });

  it('start → running delegation block，blockId = ${messageId}#delegation，携带 targetAgent', () => {
    const c = new BlockCollector('s1', 't1', 'c1', emit);
    c.onDelegationStart({ targetAgent: 'code' });
    expect(emitted).toHaveLength(1);
    const e = emitted[0];
    expect(e.blockType).toBe('delegation');
    expect(e.state).toBe('running');
    expect(e.blockId).toBe(`${c.messageId}#delegation`);
    expect(e.block?.type).toBe('delegation');
    expect(e.block?.state).toBe('running');
    expect(e.block?.targetAgent).toBe('code');
  });

  it('start + complete：emit running 再 emit 终态，同 blockId，state 推进到 completed', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onDelegationStart({ targetAgent: 'code' });
    c.onDelegationComplete({ state: 'completed' });
    expect(emitted).toHaveLength(2);
    // 两次同 blockId（前端 upsert 原地替换 running→completed）
    expect(emitted[0].blockId).toBe(emitted[1].blockId);
    const terminal = emitted[1];
    expect(terminal.state).toBe('completed');
    expect(terminal.block?.state).toBe('completed');
    expect(terminal.block?.targetAgent).toBe('code');
  });

  it('complete 可选回填 summary；failed/interrupted 同机制', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onDelegationStart({ targetAgent: 'skills' });
    c.onDelegationComplete({ state: 'failed', summary: '插件构建失败' });
    const terminal = emitted[1];
    expect(terminal.block?.state).toBe('failed');
    expect(terminal.block?.summary).toBe('插件构建失败');
  });

  it('fail-open：complete 先于 start（孤儿）→ no-op，不凭空造 block', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onDelegationComplete({ state: 'completed' });
    expect(emitted).toHaveLength(0);
  });

  it('childSessionId 透传到 delegation block', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onDelegationStart({ targetAgent: 'code', childSessionId: 'ses-child-1' });
    expect(emitted[0].block?.childSessionId).toBe('ses-child-1');
  });

  it('buildBlocks：delegation 置于最前（表头），先于 thinking/tools/text', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onDelegationStart({ targetAgent: 'code' });
    c.onToolStart({ callId: 'c1', toolName: 'shell', input: {}, ts: 1000 });
    c.onToolComplete({ callId: 'c1', output: '{"ok":true}', success: true, ts: 1100 });
    const blocks = c.buildBlocks({ reasoning: '思考', draftResponse: '结果' });
    // 顺序：delegation → thinking → tool → text
    expect(blocks[0].type).toBe('delegation');
    expect(blocks[1].type).toBe('thinking');
    expect(blocks[2].type).toBe('tool');
    expect(blocks[3].type).toBe('text');
    expect(blocks[0].type === 'delegation' && blocks[0].targetAgent).toBe('code');
  });

  it('buildBlocks：无委派时不含 delegation（纯对话 / module 路径不受影响）', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    const blocks = c.buildBlocks({ draftResponse: 'hi' });
    expect(blocks.filter((b) => b.type === 'delegation')).toHaveLength(0);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
  });
});

/**
 * 审核块路径（conversation agent final.response：Brain 审核 modify/reject）。
 * 钉死 onReview 的出生即终态 + 落库序（review 置于末尾）—— 这是 doc-22 审核裁决持久化
 * （刷新后 Brain 徽章保留）所依赖的核心归一逻辑。ReviewBlock 无状态机、无 id（同 text/thinking）。
 */
describe('BlockCollector 审核块（onReview）', () => {
  let emitted: StreamBlockPayload[];
  const emit: BlockEmitter = (p) => emitted.push(p);

  beforeEach(() => {
    emitted = [];
    _clearBlockCollectorsForTest();
  });

  it('onReview(modify) → review block，blockId = ${messageId}#review，携带 verdict/reason/originalDraft', () => {
    const c = new BlockCollector('s1', 't1', 'c1', emit);
    c.onReview({ verdict: 'modify', reason: '补充安全提示', originalDraft: '初稿...' });
    expect(emitted).toHaveLength(1);
    const e = emitted[0];
    expect(e.blockType).toBe('review');
    expect(e.blockId).toBe(`${c.messageId}#review`);
    expect(e.block?.type).toBe('review');
    expect(e.block?.verdict).toBe('modify');
    expect(e.block?.reason).toBe('补充安全提示');
    expect(e.block?.originalDraft).toBe('初稿...');
  });

  it('onReview(reject)：仅 verdict + reason（originalDraft 可选）', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onReview({ verdict: 'reject', reason: '涉及危险操作' });
    expect(emitted[0].block?.verdict).toBe('reject');
    expect(emitted[0].block?.originalDraft).toBeUndefined();
  });

  it('buildBlocks：review 置于末尾（delegation→thinking→tools→text→review）', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    c.onDelegationStart({ targetAgent: 'code' });
    c.onToolStart({ callId: 'c1', toolName: 'shell', input: {}, ts: 1000 });
    c.onToolComplete({ callId: 'c1', output: '{"ok":true}', success: true, ts: 1100 });
    c.onReview({ verdict: 'modify', reason: 'r' });
    const blocks = c.buildBlocks({ reasoning: '思考', draftResponse: '正文' });
    // 顺序：delegation → thinking → tool → text → review
    expect(blocks.map((b) => b.type)).toEqual(['delegation', 'thinking', 'tool', 'text', 'review']);
    const last = blocks[blocks.length - 1];
    expect(last.type === 'review' && last.verdict).toBe('modify');
  });

  it('buildBlocks：无审核时不含 review（纯对话 / approve 不落 review block）', () => {
    const c = new BlockCollector('s1', 't1', undefined, emit);
    const blocks = c.buildBlocks({ draftResponse: 'hi' });
    expect(blocks.filter((b) => b.type === 'review')).toHaveLength(0);
  });
});

describe('BlockCollector registry', () => {
  beforeEach(() => _clearBlockCollectorsForTest());

  it('同 key 复用同一 collector（messageId 稳定）', () => {
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

  it('peekBlockCollector 窥取但不移除（落库 peek 模式：取 collector 做落库，registry 保留）', () => {
    const a = getOrCreateBlockCollector('t1', 's1', undefined);
    // peek 返回同一实例，不从 registry 移除
    expect(peekBlockCollector('t1')).toBe(a);
    expect(peekBlockCollector('t1')).toBe(a);
    // registry 仍持有：dispose 仍能取到（peek 未释放生命周期）
    expect(disposeBlockCollector('t1')).toBe(a);
    expect(peekBlockCollector('t1')).toBeUndefined();
  });

  it('peekBlockCollector 未注册的 key 返回 undefined', () => {
    expect(peekBlockCollector('never')).toBeUndefined();
  });
});
