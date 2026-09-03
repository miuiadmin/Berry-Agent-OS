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
    agg.ingest(env('s2', 1, 'request/header', { app: 'berrycode', reason: 'initial' }));
    agg.ingest(env('s2', 2, 'user/message', { content: '晚' }));
    [turn] = ofTable(take(agg), 'turn');
    expect(turn?.dims).toEqual(['berrycode']);
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

describe('obs 聚合核：基建大扫 20260901 #13/#26/#50 扩列（失败信号 / llm 耗时 / turn 配对）', () => {
  it('#13 turn_failures：turn/end reason≠completed 计 1（五值）、completed 不计', () => {
    const agg = createAggregator();
    agg.ingest(env('s10', 0, 'request/header', { app: 'chat' }));
    agg.ingest(env('s10', 1, 'turn/end', { reason: 'completed' }));
    // 五失败值各计 1（error/aborted/blocked/max-tokens/interrupted——TurnEndReason 闭集）
    for (const [seq, reason] of [
      [2, 'error'],
      [3, 'aborted'],
      [4, 'blocked'],
      [5, 'max-tokens'],
      [6, 'interrupted'],
    ] as const) {
      agg.ingest(env('s10', seq, 'turn/end', { reason }));
    }
    const [turn] = ofTable(take(agg), 'turn');
    expect(turn?.cols).toMatchObject({ turns: 6, turn_failures: 5 });
  });

  it('#13 exhausted 独立成列：phase=exhausted 计 exhausted、retries 仍只计 scheduled、aborted 依旧零计', () => {
    const agg = createAggregator();
    agg.ingest(env('s11', 0, 'request/header', { app: 'chat' }));
    agg.ingest(env('s11', 1, 'llm/retry', { phase: 'scheduled', attempt: 1 }));
    agg.ingest(env('s11', 2, 'llm/retry', { phase: 'scheduled', attempt: 2 }));
    agg.ingest(env('s11', 3, 'llm/retry', { phase: 'exhausted', attempt: 3 }));
    agg.ingest(env('s11', 4, 'llm/retry', { phase: 'aborted', attempt: 3 }));
    const [llm] = ofTable(take(agg), 'llm');
    expect(llm?.cols).toMatchObject({ retries: 2, exhausted: 1 });
  });

  it('#26 llm/usage elapsedMs：dur_ms_sum/max 聚合；载荷缺席不计', () => {
    const agg = createAggregator();
    agg.ingest(env('s12', 0, 'request/header', { app: 'chat' }));
    agg.ingest(
      env('s12', 1, 'llm/usage', {
        callId: 'c1',
        model: 'm',
        priority: 'foreground',
        usage: { input: 1, output: 1 },
        elapsedMs: 800,
      }),
    );
    agg.ingest(
      env('s12', 2, 'llm/usage', {
        callId: 'c2',
        model: 'm',
        priority: 'foreground',
        usage: { input: 1, output: 1 },
        elapsedMs: 300,
      }),
    );
    // 旧载荷形态（elapsedMs 缺席——写点缺席容错）：calls 照计、时长不计
    agg.ingest(
      env('s12', 3, 'llm/usage', { callId: 'c3', model: 'm', priority: 'foreground', usage: { input: 1, output: 1 } }),
    );
    const [llm] = ofTable(take(agg), 'llm');
    expect(llm?.cols).toMatchObject({ calls: 3, dur_ms_sum: 1_100, dur_ms_max: 800 });
  });

  it('#50 turn 配对：时长落 start 时刻小时桶（延迟归因发起时点）、turns 落 end 桶；孤儿 start 天然不计', () => {
    const agg = createAggregator();
    const hour = Math.floor(T0 / 3_600_000) * 3_600_000;
    agg.ingest(env('s13', 0, 'request/header', { app: 'chat' }));
    // start 在整点后 10 分钟、end 在下一小时的 :30——跨小时轮且全程 < 1h 配对窗
    // （> 1h 属老化弃配——由「老化 2h 晚到 end」一测锁死，两口径互不侵占）
    agg.ingest(env('s13', 1, 'turn/start', {}, hour + 600_000));
    agg.ingest(env('s13', 2, 'turn/end', { reason: 'completed' }, hour + 3_900_000));
    // 孤儿 start（无 end——崩溃截断形态）：不产时长
    agg.ingest(env('s13', 3, 'turn/start', {}, hour + 7_200_000));
    const rows = ofTable(take(agg), 'turn');
    const startBucket = rows.find((r) => r.hourTs === hour);
    expect(startBucket?.cols).toMatchObject({ dur_ms_sum: 3_300_000, dur_ms_max: 3_300_000 });
    const endBucket = rows.find((r) => r.hourTs === hour + 3_600_000);
    expect(endBucket?.cols).toMatchObject({ turns: 1 }); // turns/turn_failures 维持落 end 时刻桶
    // 只有 start 桶携带时长（孤儿 start 的空桶不产任何 dur 键）
    expect(rows.filter((r) => r.cols['dur_ms_sum'] !== undefined)).toHaveLength(1);
  });

  it('#50 遮蔽回退联动：surfaceOp 盖住 turn/end → turns + turn_failures + 配对时长齐回退（同 seq 两笔 delta 合并 undo）', () => {
    const agg = createAggregator();
    agg.ingest(env('s14', 0, 'request/header', { app: 'chat' }));
    agg.ingest(env('s14', 1, 'turn/start', {}));
    agg.ingest(env('s14', 2, 'turn/end', { reason: 'error' }, T0 + 4_000));
    // 遮蔽 seq 2（turn/end 自身）：同 seq 关联的两笔增量（end 桶计数 + start 桶时长）
    // 必须一笔登记齐回退——只回退计数不回退时长 = 残账
    agg.ingest(env('s14', 3, 'user/message', { content: '摘要' }, T0 + 60_000, { op: 'replace', start: 2, end: 2 }));
    const hour = Math.floor(T0 / 3_600_000) * 3_600_000;
    const rows = ofTable(take(agg), 'turn').filter((r) => r.hourTs === hour);
    // 同桶合并后的总账：turns/turn_failures 归零、dur_ms_sum 归零（dur_ms_max 水印不回退——既定例外）
    const merged = rows.reduce<Record<string, number>>((acc, r) => {
      for (const [col, v] of Object.entries(r.cols)) acc[col] = (acc[col] ?? 0) + v;
      return acc;
    }, {});
    expect(merged['turns']).toBe(0);
    expect(merged['turn_failures']).toBe(0);
    expect(merged['dur_ms_sum']).toBe(0);
  });

  it('#50 配对老化：start 落后最新事件 > 1h 的晚到 end 按孤儿容错——不计时长只计 turns（R-4③ 同律）', () => {
    const agg = createAggregator();
    agg.ingest(env('s15', 0, 'request/header', { app: 'chat' }));
    agg.ingest(env('s15', 1, 'turn/start', {}));
    agg.ingest(env('s15', 2, 'turn/end', { reason: 'completed' }, T0 + 2 * 3_600_000));
    const rows = ofTable(take(agg), 'turn');
    const endBucket = rows.find((r) => r.hourTs === Math.floor((T0 + 2 * 3_600_000) / 3_600_000) * 3_600_000);
    expect(endBucket?.cols).toMatchObject({ turns: 1 });
    expect(rows.every((r) => r.cols['dur_ms_sum'] === undefined)).toBe(true); // 老化弃配——零时长
  });
});

describe('obs 聚合核：复盘 20260901 R-4/D-3 回归锁（内存有界三律 + 回退落空计数）', () => {
  it('R-4① 水印随 drain 清零——安全前提：同桶低值再发不落 DB（MAX 合并幂等契约）', () => {
    // 水印清除本身无行为差（DB 侧 MAX 合并兜底）——本锁钉死的是「清除安全」的
    // 前提契约：清除后再发的低值增量不得让 DB 侧 dur_ms_max 回落
    const agg = createAggregator();
    agg.ingest(env('r1', 0, 'request/header', { app: 'chat' }));
    agg.ingest(env('r1', 1, 'tool/call', { toolCallId: 'a', name: 'bash', arguments: '{}' }));
    agg.ingest(env('r1', 2, 'tool/result', { toolCallId: 'a', content: 'ok' }, T0 + 9_000));
    const first = agg.drain(); // dur_ms_max = 9000（此后水印已清——R-4①）
    agg.ingest(env('r1', 3, 'tool/call', { toolCallId: 'b', name: 'bash', arguments: '{}' }));
    agg.ingest(env('r1', 4, 'tool/result', { toolCallId: 'b', content: 'ok' }, T0 + 9_100));
    const second = agg.drain();
    // 两次增量各自携带当时水印（9000 / 9100）——单调升序天然安全；
    // 反序才是险情：先 9100 后 9000，DB MAX 合并必须兜住
    const reversed = createAggregator();
    reversed.ingest(env('r1', 0, 'request/header', { app: 'chat' }));
    reversed.ingest(env('r1', 1, 'tool/call', { toolCallId: 'a', name: 'bash', arguments: '{}' }));
    reversed.ingest(env('r1', 2, 'tool/result', { toolCallId: 'a', content: 'ok' }, T0 + 9_100));
    const hi = reversed.drain();
    reversed.ingest(env('r1', 3, 'tool/call', { toolCallId: 'b', name: 'bash', arguments: '{}' }));
    reversed.ingest(env('r1', 4, 'tool/result', { toolCallId: 'b', content: 'ok' }, T0 + 9_000));
    const lo = reversed.drain(); // 清零后重发 9000——不得高于已落 9100
    // 断言在 store 侧 MAX 合并（rollup 层只保证增量形状——ofTable 过滤出 tool 行，
    // .at(0) 会抓到 header 产生的 turn 增量）
    const toolRow = (all: ReturnType<typeof take>) => ofTable(all, 'tool').at(0);
    expect(toolRow(first)?.cols['dur_ms_max']).toBe(9_000);
    expect(toolRow(second)?.cols['dur_ms_max']).toBe(9_100);
    expect(toolRow(hi)?.cols['dur_ms_max']).toBe(9_100);
    expect(toolRow(lo)?.cols['dur_ms_max']).toBe(9_000); // 清零后低值重发——MAX 合并的输入
  });

  it('R-4③ 配对老化：调用时刻落后最新事件 > 1h 的晚到结果按孤儿容错——不产畸形时长', () => {
    const agg = createAggregator();
    agg.ingest(env('r2', 0, 'request/header', { app: 'chat' }));
    agg.ingest(env('r2', 1, 'tool/call', { toolCallId: 'late', name: 'bash', arguments: '{}' }));
    // 结果晚到 2h（跨 drain 窗的陈旧在飞对）——HEAD 直配对出 7.2M ms 畸形时长
    agg.ingest(env('r2', 2, 'tool/result', { toolCallId: 'late', content: 'ok' }, T0 + 2 * 3_600_000));
    const all = take(agg);
    expect(ofTable(all, 'tool')).toHaveLength(0); // 按配对丢失容错跳过
    const [turn] = ofTable(all, 'turn');
    expect(turn?.cols).toMatchObject({ tool_calls: 1 }); // call 侧计数不受累
  });

  it('R-4② 会话归因空窗修剪：7 日无事件会话的 app 归因回落 host 桶（归因近似窗）', () => {
    const agg = createAggregator();
    agg.ingest(env('ra', 0, 'request/header', { app: 'berrycode' }));
    agg.ingest(env('ra', 1, 'user/message', { content: '活跃期' }));
    expect(ofTable(take(agg), 'turn')[0]?.dims).toEqual(['berrycode']);
    // 会话 B 8 日后活跃 → drain 时修剪 A（空窗 > 7 日）
    agg.ingest(env('rb', 0, 'user/message', { content: '八日后' }, T0 + 8 * 24 * 3_600_000));
    expect(ofTable(take(agg), 'turn')[0]?.dims).toEqual(['host']);
    // A 复活：归因已修剪 → 回落 host 桶（设计取舍：长空窗归因近似，规范近族并列）
    agg.ingest(env('ra', 2, 'user/message', { content: '复活' }, T0 + 8 * 24 * 3_600_000 + 1));
    const rows = ofTable(take(agg), 'turn');
    const revived = rows.find((r) => r.hourTs === Math.floor((T0 + 8 * 24 * 3_600_000) / 3_600_000) * 3_600_000);
    expect(revived?.dims).toEqual(['host']);
  });

  it('D-3 回退落空计数：重启/全量 reload 窗（贡献登记空）——ingest 返回落空数供 warn 留痕', () => {
    // 新聚合器 = 重启后形态：贡献登记表空，surfaceOp 到达全落空
    const agg = createAggregator();
    const misses = agg.ingest(
      env('rd', 5, 'user/message', { content: '摘要' }, T0 + 60_000, { op: 'replace', start: 1, end: 3 }),
    );
    expect(misses).toBe(3); // seq 1-3 全无登记——落空计数即 /obs-rebuild 判据信号
    // 对照：登记在场的回退零落空
    const warm = createAggregator();
    warm.ingest(env('rd', 1, 'user/message', { content: '旧' }));
    const warmMisses = warm.ingest(
      env('rd', 4, 'user/message', { content: '摘要' }, T0 + 60_000, { op: 'replace', start: 1, end: 1 }),
    );
    expect(warmMisses).toBe(0);
  });
});

describe('obs 聚合核：apps/deprecation-used 废弃遥测（第八十七批批 3，契约篇 §6.13.7）', () => {
  it('载荷显式打标优先：payload app 在场即用 payload 值（与 request/header 同律取值序）', () => {
    const agg = createAggregator();
    agg.ingest(env('s1', 0, 'request/header', { app: 'chat', reason: 'initial' }));
    // 载荷显式打标 berrycode —— 会话血缘是 chat，但事件载荷说了算
    agg.ingest(env('s1', 1, 'apps/deprecation-used', { app: 'berrycode', dep: 'DEP-001' }));
    const [dep] = ofTable(take(agg), 'deprecation');
    expect(dep).toMatchObject({
      hourTs: Math.floor(T0 / 3_600_000) * 3_600_000,
      dims: ['berrycode', 'DEP-001'],
      cols: { uses: 1 },
    });
  });

  it('载荷 app 缺席回落会话血缘桶；header 亦缺席回落 host 桶', () => {
    const agg = createAggregator();
    agg.ingest(env('s2', 0, 'request/header', { app: 'chat', reason: 'initial' }));
    agg.ingest(env('s2', 1, 'apps/deprecation-used', { dep: 'DEP-002' }));
    agg.ingest(env('s3', 0, 'apps/deprecation-used', { dep: 'DEP-002' }));
    const rows = ofTable(take(agg), 'deprecation');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.dims).toEqual(['chat', 'DEP-002']); // 血缘桶
    expect(rows[1]?.dims).toEqual(['host', 'DEP-002']); // 血缘缺席兜底
  });

  it('dep 非字符串或空串防御跳过（不计不炸——与未知 decision 同律）', () => {
    const agg = createAggregator();
    agg.ingest(env('s4', 0, 'apps/deprecation-used', { app: 'chat' }));
    agg.ingest(env('s4', 1, 'apps/deprecation-used', { app: 'chat', dep: '' }));
    agg.ingest(env('s4', 2, 'apps/deprecation-used', { app: 'chat', dep: 42 }));
    expect(ofTable(take(agg), 'deprecation')).toHaveLength(0);
  });

  it('同 app×dep 多次使用累加 + surfaceOp 遮蔽回退（贡献登记走通用机制）', () => {
    const agg = createAggregator();
    agg.ingest(env('s5', 0, 'apps/deprecation-used', { app: 'chat', dep: 'DEP-001' }));
    agg.ingest(env('s5', 1, 'apps/deprecation-used', { app: 'chat', dep: 'DEP-001' }));
    // 遮蔽载体（seq 2 覆盖 0-1）：两笔贡献齐回退 + 载体自身照常计数 → 2 - 2 + 1 = 1
    const misses = agg.ingest(
      env('s5', 2, 'apps/deprecation-used', { app: 'chat', dep: 'DEP-001' }, T0, { op: 'replace', start: 0, end: 1 }),
    );
    expect(misses).toBe(0); // 回退时目标增量未 drain——登记落账零落空
    const [row] = ofTable(take(agg), 'deprecation');
    expect(row?.cols).toEqual({ uses: 1 });
  });
});
