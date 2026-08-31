/**
 * L3 obs — 聚合核口径锁（契约篇 §6.9 刀一测试面；纯函数单测——冷读闸
 * 回写的全量口径逐条锁死：分桶/配对分类/遮蔽回退/合成特判/retries 过滤/
 * app 映射/小时边界）。
 */
import { describe, expect, it } from 'vitest';
import { createAggregator, type EventEnvelope } from './rollup.js';

/** 测试时基（整点毫秒——小时桶边界可控） */
const T0 = 1_800_000_000_000; // 2026-09-25T13:20:00Z 附近的整段（可整除性由用例内控）
/** 信封构造便利 */
const env = (
  sessionId: string,
  seq: number,
  type: string,
  data: unknown,
  time = T0,
  surfaceOp?: unknown,
): EventEnvelope => ({
  sessionId,
  event: { type, seq, time, data, ...(surfaceOp === undefined ? {} : { surfaceOp: surfaceOp as never }) },
});
/** 单次取全量增量（drain 清零——一测一取，逐表过滤在本地做） */
const take = (agg: ReturnType<typeof createAggregator>) => agg.drain();
const ofTable = (all: ReturnType<typeof take>, table: string) => all.filter((d) => d.table === table);

describe('obs 聚合核：口径锁（契约篇 §6.9 冷读回写全量）', () => {
  it('llm/usage 分桶：app/model/priority 维 + token 四桶', () => {
    const agg = createAggregator();
    agg.ingest(env('s1', 0, 'request/header', { app: 'chat', reason: 'initial' }));
    agg.ingest(
      env('s1', 1, 'llm/usage', {
        callId: 'c1',
        model: 'anthropic/claude-sonnet-5',
        priority: 'foreground',
        usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 30 },
      }),
    );
    const [llm] = ofTable(take(agg), 'llm');
    expect(llm).toMatchObject({
      hourTs: Math.floor(T0 / 3_600_000) * 3_600_000,
      dims: ['chat', 'anthropic/claude-sonnet-5', 'foreground'],
      cols: { calls: 1, tokens_in: 100, tokens_out: 50, cache_read: 200, cache_write: 30 },
    });
  });

  it('app 维自事件流推导：request/header 缺席 = host 桶；晚到 header 只影响其后事件（B2 口径）', () => {
    const agg = createAggregator();
    // header 未到：先落 host 桶
    agg.ingest(env('s2', 0, 'user/message', { content: '早' }));
    let [turn] = ofTable(take(agg), 'turn');
    expect(turn?.dims).toEqual(['host']);
    // header 到达：其后事件归 app 桶（此前已计贡献不回改——口径注记）
    agg.ingest(env('s2', 1, 'request/header', { app: 'coder', reason: 'initial' }));
    agg.ingest(env('s2', 2, 'user/message', { content: '晚' }));
    [turn] = ofTable(take(agg), 'turn');
    expect(turn?.dims).toEqual(['coder']);
  });

  it('tool 配对分类五桶：成功/守门拦截/失败/超时 + 时长归调用时刻小时桶（M4）', () => {
    const agg = createAggregator();
    agg.ingest(env('s3', 0, 'request/header', { app: 'chat' }));
    // 成功（计时长）
    agg.ingest(env('s3', 1, 'tool/call', { toolCallId: 't1', name: 'read', arguments: '{}' }));
    agg.ingest(env('s3', 2, 'tool/result', { toolCallId: 't1', content: 'ok' }, T0 + 150));
    // 守门拦截（不计时长）
    agg.ingest(env('s3', 3, 'tool/call', { toolCallId: 't2', name: 'bash', arguments: '{}' }));
    agg.ingest(
      env('s3', 4, 'tool/result', { toolCallId: 't2', content: '', error: { code: 'TOOL_BLOCKED' } }, T0 + 50),
    );
    // 超时（计时长——预算真实消耗）
    agg.ingest(env('s3', 5, 'tool/call', { toolCallId: 't3', name: 'bash', arguments: '{}' }));
    agg.ingest(
      env('s3', 6, 'tool/result', { toolCallId: 't3', content: '', error: { code: 'TOOL_TIMEOUT' } }, T0 + 10_000),
    );
    // 普通失败（计时长）
    agg.ingest(env('s3', 7, 'tool/call', { toolCallId: 't4', name: 'grep', arguments: '{}' }));
    agg.ingest(
      env('s3', 8, 'tool/result', { toolCallId: 't4', content: '', error: { code: 'EXEC_SPAWN_FAILED' } }, T0 + 300),
    );
    const rows = ofTable(take(agg), 'tool');
    const tool = rows.find((r) => r.dims[1] === 'bash');
    expect(tool?.dims).toEqual(['chat', 'bash']); // t2 拦截 + t3 超时同归 bash 桶
    expect(tool?.cols).toMatchObject({ calls: 2, blocked: 1, timeouts: 1, dur_ms_sum: 10_000, dur_ms_max: 10_000 });
    const read = rows.find((r) => r.dims[1] === 'read');
    expect(read?.cols).toMatchObject({ calls: 1, dur_ms_sum: 150, dur_ms_max: 150 }); // 无 failures 键 = 零
    const grep = rows.find((r) => r.dims[1] === 'grep');
    expect(grep?.cols).toMatchObject({ calls: 1, failures: 1, dur_ms_sum: 300, dur_ms_max: 300 });
  });

  it('恢复合成事件特判：TOOL_NOT_STARTED 计失败不计时长（M8）', () => {
    const agg = createAggregator();
    agg.ingest(env('s4', 0, 'request/header', { app: 'chat' }));
    agg.ingest(env('s4', 1, 'tool/call', { toolCallId: 't9', name: 'write', arguments: '{}' }));
    agg.ingest(
      env('s4', 2, 'tool/result', { toolCallId: 't9', content: '', error: { code: 'TOOL_NOT_STARTED' } }, T0 + 5_000),
    );
    const [tool] = ofTable(take(agg), 'tool');
    expect(tool?.cols).toMatchObject({ calls: 1, failures: 1 }); // 合成事件：时长键结构性缺席
    expect(tool?.cols['dur_ms_sum']).toBeUndefined();
  });

  it('配对丢失（崩溃孤儿）容错：无 result 的 call 只计 turn.tool_calls 不炸（口径三条）', () => {
    const agg = createAggregator();
    agg.ingest(env('s5', 0, 'tool/call', { toolCallId: 'orphan', name: 'read', arguments: '{}' }));
    // 无 tool/result；孤立 result（无 call）同样跳过
    agg.ingest(env('s5', 1, 'tool/result', { toolCallId: 'ghost', content: 'x' }));
    const all = take(agg);
    expect(ofTable(all, 'tool')).toHaveLength(0);
    const [turn] = ofTable(all, 'turn');
    expect(turn?.cols).toMatchObject({ tool_calls: 1 });
  });

  it('遮蔽回退：surfaceOp 覆盖区间内已计指标按 seq 回退——压缩后不双计（M5）', () => {
    const agg = createAggregator();
    agg.ingest(env('s6', 0, 'request/header', { app: 'chat' }));
    agg.ingest(env('s6', 1, 'user/message', { content: '旧问题' }));
    agg.ingest(env('s6', 2, 'assistant/message', { content: '旧回答' }));
    agg.ingest(
      env('s6', 3, 'llm/usage', { callId: 'c1', model: 'm', priority: 'foreground', usage: { input: 10, output: 5 } }),
    );
    // 遮蔽 seq 1-3，载体（seq 4）随后照常计数
    agg.ingest(env('s6', 4, 'user/message', { content: '摘要替换' }, T0 + 60_000, { op: 'replace', start: 1, end: 3 }));
    const all = take(agg);
    const turn = ofTable(all, 'turn').find((r) => r.hourTs === Math.floor(T0 / 3_600_000) * 3_600_000);
    expect(turn?.cols).toMatchObject({ user_msgs: 1, assistant_msgs: 0 }); // 旧 user 被回退，载体计入
    const [llm] = ofTable(all, 'llm');
    expect(llm?.cols).toMatchObject({ calls: 0, tokens_in: 0 }); // llm/usage 被回退（零值桶仍在——回退证据）
  });

  it('retries 只计 phase=scheduled（M3）；approval decision 五值全桶（M2）', () => {
    const agg = createAggregator();
    agg.ingest(env('s7', 0, 'request/header', { app: 'chat' }));
    agg.ingest(env('s7', 1, 'llm/retry', { phase: 'scheduled', attempt: 1, delayMs: 500 }));
    agg.ingest(env('s7', 2, 'llm/retry', { phase: 'aborted', attempt: 1 }));
    agg.ingest(env('s7', 3, 'llm/retry', { phase: 'exhausted', attempt: 3 }));
    const [llm] = ofTable(take(agg), 'llm');
    expect(llm?.cols).toMatchObject({ retries: 1 });
    expect(llm?.dims[1]).toBe('(retry)');
    agg.ingest(env('s7', 4, 'approval/asked', { approvalId: 'a1', summary: 's' }));
    for (const [seq, decision] of [
      [5, 'approve'],
      [6, 'reject'],
      [7, 'cancel'],
      [8, 'unavailable'],
      [9, 'always'],
    ] as const) {
      agg.ingest(env('s7', seq, 'approval/decided', { approvalId: 'a1', decision }));
    }
    const [approval] = ofTable(take(agg), 'approval');
    expect(approval?.cols).toEqual({ asked: 1, approved: 1, rejected: 1, always: 1, cancel: 1, unavailable: 1 });
  });

  it('小时桶边界：调用时刻跨小时 = 分桶锚取调用时刻（时长归发起时点）', () => {
    const agg = createAggregator();
    const hour = Math.floor(T0 / 3_600_000) * 3_600_000;
    agg.ingest(env('s8', 0, 'request/header', { app: 'chat' }));
    // 调用在小时末前 1ms，结果落在下一小时
    agg.ingest(env('s8', 1, 'tool/call', { toolCallId: 'x', name: 'read', arguments: '{}' }, hour + 3_600_000 - 1));
    agg.ingest(env('s8', 2, 'tool/result', { toolCallId: 'x', content: 'ok' }, hour + 3_600_000 + 100));
    const [tool] = ofTable(take(agg), 'tool');
    expect(tool?.hourTs).toBe(hour); // 归调用时刻的小时桶
  });

  it('drain 后清零：二次 drain 为空（增量不重复）', () => {
    const agg = createAggregator();
    agg.ingest(env('s9', 0, 'user/message', { content: 'x' }));
    expect(agg.drain()).toHaveLength(1);
    expect(agg.drain()).toHaveLength(0);
  });
});
