/**
 * L3 obs — 聚合核（纯增量账 + 遮蔽回退；契约篇 §6.9 刀一，2026-08-31 观测复盘批）。
 *
 * 口径全录（规范钉死 + 冷读闸回写）：
 * - **只吃 session/event 总线信封**（durable 入队镜像——write-behind 前沿，
 *   非落库回执；契约篇 §6.9 摄取纪律）；
 * - **app 维自事件流推导**：request/header.app → sessionId→app 映射（缺 =
 *   'host' 桶——冷读 B2 的事件流自足路径，零跨库零新 API）；
 * - **遮蔽回退**：surfaceOp 覆盖区间内已计指标按 seq 精确回退（与 derive
 *   occludedSeqs 同判据）——压缩后不双计、与重建路同一结果；例外 =
 *   dur_ms_max 单调水印不回退（被遮蔽的极值不降——近似注记，规范允许）；
 * - **恢复合成事件特判**：TOOL_NOT_STARTED / TOOL_OUTCOME_UNKNOWN → 计失败
 *   不计时长（合成 time 复用最后真实事件 time，时长语义无效——冷读 M8）；
 * - **配对**：tool/call × tool/result 按 (sessionId, toolCallId)；丢失（崩溃
 *   孤儿）容错跳过，重建路补齐；时长分桶锚 = **调用时刻的小时桶**；
 *   turn/start × turn/end 按 sessionId（基建大扫 #50——同构配对：孤儿/老化
 *   弃配零时长、时长分桶锚 = start 时刻、turns/turn_failures 仍落 end 桶）；
 * - **retries 只计 phase='scheduled'**（每次真实退避排定一次；aborted/
 *   exhausted 是排定的结局不双计——冷读 M3）；**exhausted 独立成列**（phase=
 *   'exhausted' 计 1——退避排定后真耗尽的失败信号，基建大扫 #13）；模型维
 *   缺源（llm/retry 载荷无 model）→ '(retry)' 哨兵桶；
 * - **approval 按 decision 五值全桶**（approve/reject/cancel/unavailable/
 *   always——durable 载荷无 via 字段，分桶只按 decision——冷读 M2）；
 * - hour_ts = **UTC 小时地板**（毫秒）。
 *
 * 回退面有界：贡献登记表（seq → 逆增量闭包）上限 50 万条，超限剪最旧一万个
 * （被遮蔽区间远小于此界——截断后极旧跨度的回退缺席是可接受近似）。
 *
 * 内存有界三律（2026-09-01 复盘 R-4）：①dur_ms_max 单调水印随 drain 清零
 * （DB 侧 MAX 合并兜底——重发安全）；②sessionId→app 映射空窗修剪（7 日无
 * 事件会话的归因回落 host 桶——归因近似窗）；③tool 配对老化（调用时刻落后
 * 最新事件 > 1h 的在飞对按配对丢失容错跳过）。时钟基准 = 事件钟（见过的
 * 最大 event.time——非墙钟，回放/测试确定性友好）。
 *
 * 回退落空计数（2026-09-01 复盘 D-3）：ingest 返回 surfaceOp 区间内回退落空
 * 条数（无登记〔重启/全量 reload 窗〕或登记在而增量已 drain〔drain 窗〕两
 * 形同族）——近似族显式留痕（调用方 warn + /obs-rebuild 判据信号），不炸摄取。
 */

/** 总线信封事件的结构子集（宿主派发点载荷——SessionEvent 消费面收窄） */
export interface EnvelopeEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
  readonly surfaceOp?: { readonly op: 'replace'; readonly start: number; readonly end: number };
}

/** session/event 信封（宿主派发形态：{ sessionId, event }） */
export interface EventEnvelope {
  readonly sessionId: string;
  readonly event: EnvelopeEvent;
}

/** 五张 rollup 表名（alerts 规则表不是 metric——冷读 M1；v3 增 deprecation） */
export type RollupTable = 'llm' | 'tool' | 'turn' | 'approval' | 'deprecation';

/** 单桶度量增量（列可负 = 回退）；dur_ms_max 例外——单调水印绝对值只升不降 */
export interface BucketDelta {
  readonly table: RollupTable;
  readonly hourTs: number;
  /** 依表维度（llm=[app,model,priority] / tool=[app,tool] / turn=[app] / approval=[app] / deprecation=[app,dep]） */
  readonly dims: readonly string[];
  /** 度量列增量（dur_ms_max 除外——绝对水印，落库走 MAX 合并） */
  readonly cols: Readonly<Record<string, number>>;
}

/** 聚合器面：ingest 累积纯内存增量，drain 取走（调用方负责持久化） */
export interface Aggregator {
  /**
   * 摄取一封信封。返回值 = surfaceOp 覆盖区间内**回退落空条数**（复盘 D-3，
   * 两形态同族计数）：①无贡献登记——重启/全量 reload 窗（登记表空）；
   * ②登记在而目标增量已 drain——drain 窗近似。非零即「live=重建」不变式
   * 在近似窗内被打破的信号，调用方 warn 留痕（不炸摄取）。
   */
  ingest(envelope: EventEnvelope): number;
  /** 取走累计增量并清零（失败语义归调用方——契约篇 §6.9 停摄取纪律） */
  drain(): readonly BucketDelta[];
}

/** 小时粒度（毫秒） */
const HOUR_MS = 3_600_000;
/** UTC 小时地板 */
const hourFloor = (t: number): number => Math.floor(t / HOUR_MS) * HOUR_MS;
/** 贡献登记上限（回退面有界——见文件头注记） */
const CONTRIBUTION_CAP = 500_000;
const CONTRIBUTION_PRUNE = 10_000;
/** 会话归因空窗上限（复盘 R-4②：7 日无事件 → 归因回落 host 桶） */
const SESSION_APP_TTL_MS = 7 * 24 * HOUR_MS;
/** tool 配对老化上限（复盘 R-4③：调用时刻落后最新事件 > 1h → 按孤儿容错） */
const TOOL_PAIR_TTL_MS = HOUR_MS;
/** turn 配对老化上限（基建大扫 #50——与 tool 配对同律 R-4③：start 时刻落后最新事件 > 1h 的晚到 end 弃配） */
const TURN_PAIR_TTL_MS = HOUR_MS;

/** 未知 app 的落桶哨兵（request/header 尚未到达/无 app 字段） */
export const HOST_BUCKET = 'host';

/** 恢复合成事件的错误码族（计失败不计时长——冷读 M8） */
const SYNTHETIC_RESULT_CODES = new Set(['TOOL_NOT_STARTED', 'TOOL_OUTCOME_UNKNOWN']);

/** approval.decision → rollup 列名（五值全桶——冷读 M2） */
const APPROVAL_COLUMNS: Readonly<Record<string, string>> = {
  approve: 'approved',
  reject: 'rejected',
  cancel: 'cancel',
  unavailable: 'unavailable',
  always: 'always',
};

/**
 * 创建聚合器（件内单实例——apply 期构造，随行作用域存续）。
 * 纯内存增量账：ingest 即记贡献 + 登记逆增量闭包；surfaceOp 到达时按 seq
 * 区间执行回退。drain 返回增量集（水印列 dur_ms_max 以绝对值随桶携带）。
 */
export function createAggregator(): Aggregator {
  /** 桶键 → 增量（drain 取走后清零；回退写入同键负值） */
  const pending = new Map<string, BucketDelta & { cols: Record<string, number> }>();
  /**
   * 桶键 → dur_ms_max 单调水印（绝对值；drain 合并进增量后**清零**——复盘
   * R-4①：DB 侧 MAX 合并兜底重发安全，内存水印不跨 drain 窗驻留）
   */
  const watermarks = new Map<string, number>();
  /** seq 贡献登记：`${sessionId}${seq}`（\u001f 分隔）→ 逆增量闭包（回退面） */
  const contributions = new Map<string, () => boolean>();
  /**
   * sessionId → { app, lastSeen }（源 = request/header.app；HOST_BUCKET 兜底；
   * lastSeen = 该会话最近事件时刻——drain 空窗修剪判据，复盘 R-4②）
   */
  const sessionApp = new Map<string, { app: string; lastSeen: number }>();
  /** 配对在飞：`${sessionId}${toolCallId}`（\u001f 分隔）→ { 调用名, 调用时刻 } */
  const toolPending = new Map<string, { name: string; time: number }>();
  /**
   * turn 配对在飞（基建大扫 #50）：sessionId → { start 时刻 }（一 turn = 一段
   * start→end 序列，会话内天然串行——键即 sessionId 无需配对 id）。drain 老化
   * 清扫同 toolPending（R-4③ 同律）
   */
  const turnPending = new Map<string, { time: number }>();
  /** 事件钟：见过的最大 event.time（修剪/老化判据基准——非墙钟，回放确定性友好） */
  let lastEventTime = Number.NEGATIVE_INFINITY;

  /**
   * 施加一笔增量并返回其逆操作闭包。
   * @param maxDur 时长水印（绝对值）——在场时更新单调水印且逆操作不改水印
   * @returns 逆操作闭包；执行返回是否落账（false = 目标增量已被 drain 取走
   *   ——drain 窗近似，复盘 D-3 计数面）
   */
  const apply = (
    table: RollupTable,
    hourTs: number,
    dims: readonly string[],
    cols: Readonly<Record<string, number>>,
    maxDur?: number,
  ): (() => boolean) => {
    const key = `${table}\u001f${hourTs}\u001f${dims.join('\u001f')}`;
    let bucket = pending.get(key);
    if (bucket === undefined) {
      bucket = { table, hourTs, dims: [...dims], cols: {} };
      pending.set(key, bucket);
    }
    for (const [col, value] of Object.entries(cols)) {
      bucket.cols[col] = (bucket.cols[col] ?? 0) + value;
    }
    if (maxDur !== undefined && maxDur > (watermarks.get(key) ?? -1)) {
      watermarks.set(key, maxDur);
    }
    return () => {
      const target = pending.get(key);
      if (target === undefined) return false; // 已被 drain 取走——逆操作落空（drain 窗近似）
      for (const [col, value] of Object.entries(cols)) {
        target.cols[col] = (target.cols[col] ?? 0) - value;
      }
      return true;
    };
  };

  /** 贡献登记（带回退面上界修剪） */
  const record = (seqKey: string, undo: () => boolean): void => {
    if (contributions.size >= CONTRIBUTION_CAP) {
      let pruned = 0;
      for (const key of contributions.keys()) {
        contributions.delete(key);
        if (++pruned >= CONTRIBUTION_PRUNE) break;
      }
    }
    contributions.set(seqKey, undo);
  };

  /**
   * 账记一封信封的事件面（按 event.type 分派——被 ingest 包装，遮蔽回退在包装层）。
   */
  const account = ({ sessionId, event }: EventEnvelope): void => {
    const hour = hourFloor(event.time);
    // 归因取值 + 空窗判据刷新（会话每来一事件 lastSeen 前移——drain 修剪用）
    const tracked = sessionApp.get(sessionId);
    const app = tracked?.app ?? HOST_BUCKET;
    if (tracked !== undefined) tracked.lastSeen = event.time;
    if (event.time > lastEventTime) lastEventTime = event.time;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const seqKey = `${sessionId}\u001f${event.seq}`;

    switch (event.type) {
      case 'request/header': {
        // app 维唯一来源（血缘显式打标——冷读 B2）
        const declared = data['app'];
        if (typeof declared === 'string' && declared !== '') {
          sessionApp.set(sessionId, { app: declared, lastSeen: event.time });
        }
        return;
      }
      case 'user/message':
        record(seqKey, apply('turn', hour, [app], { user_msgs: 1 }));
        return;
      case 'assistant/message':
        record(seqKey, apply('turn', hour, [app], { assistant_msgs: 1 }));
        return;
      case 'turn/start':
        // 在飞登记（基建大扫 #50）：start→end 配对的时长锚点；turns 计数锚仍 =
        // turn/end（孤儿 turn/start 天然不计——时长与计数同口径）
        turnPending.set(sessionId, { time: event.time });
        return;
      case 'turn/end': {
        // 计数面（turns + turn_failures——基建大扫 #13）：失败口径 = reason≠
        // 'completed' 计 1（TurnEndReason 五失败值 error/aborted/blocked/
        // max-tokens/interrupted——失败率告警的度量底座）
        const countCols: Record<string, number> = { turns: 1 };
        if (data['reason'] !== 'completed') countCols.turn_failures = 1;
        const countUndo = apply('turn', hour, [app], countCols);
        // 配对面（基建大扫 #50）：时长 = start→end 差，落 **start 时刻小时桶**
        // （延迟归因到发起时点——与 tool 配对同律）；孤儿 end（无 start 登记）
        // 与老化弃配（> 1h）只计零时长；dur_ms_max 单调水印同 tool 机制
        const start = turnPending.get(sessionId);
        turnPending.delete(sessionId);
        if (start === undefined || event.time - start.time > TURN_PAIR_TTL_MS) {
          record(seqKey, countUndo);
          return;
        }
        const dur = event.time - start.time;
        const durUndo = apply('turn', hourFloor(start.time), [app], { dur_ms_sum: dur }, dur);
        // 同 seq 两笔 delta（end 桶计数 + start 桶时长）合并登记一笔 undo——
        // surfaceOp 盖住 turn/end 时齐回退，只回退一侧即残账
        record(seqKey, () => countUndo() && durUndo());
        return;
      }
      case 'tool/call': {
        const call = data as { toolCallId?: unknown; name?: unknown };
        if (typeof call.toolCallId === 'string' && typeof call.name === 'string') {
          toolPending.set(`${sessionId}\u001f${call.toolCallId}`, { name: call.name, time: event.time });
        }
        record(seqKey, apply('turn', hour, [app], { tool_calls: 1 }));
        return;
      }
      case 'tool/result': {
        const result = data as { toolCallId?: unknown; error?: { code?: unknown } | null };
        if (typeof result.toolCallId !== 'string') return;
        const pairKey = `${sessionId}\u001f${result.toolCallId}`;
        const call = toolPending.get(pairKey);
        if (call === undefined) return; // 配对丢失（崩溃孤儿）——容错跳过，重建路补齐
        toolPending.delete(pairKey);
        // 配对老化（复盘 R-4③）：调用时刻落后最新事件 > 1h 的晚到结果按孤儿
        // 容错跳过——防跨 drain 窗的陈旧在飞对配出畸形时长（小时级 ms 假象）
        if (event.time - call.time > TOOL_PAIR_TTL_MS) return;
        const code = typeof result.error?.code === 'string' ? result.error.code : undefined;
        const cols: Record<string, number> = { calls: 1 };
        if (code === 'TOOL_BLOCKED') {
          cols.blocked = 1; // 守门拦截——「没让跑」（与工具失败分列——冷读 M4）
        } else if (code === 'TOOL_TIMEOUT') {
          cols.timeouts = 1;
        } else if (code !== undefined) {
          cols.failures = 1;
        }
        // 时长口径：成功/普通失败/超时计真实 elapsed（超时也是真实预算消耗）；
        // blocked（没跑）与合成事件（合成 time 无时长语义）不计——冷读 M4/M8
        let maxDur: number | undefined;
        const synthetic = code !== undefined && SYNTHETIC_RESULT_CODES.has(code);
        if (!synthetic && code !== 'TOOL_BLOCKED') {
          const dur = event.time - call.time;
          cols.dur_ms_sum = dur;
          maxDur = dur;
        }
        // 分桶锚 = 调用时刻的小时（延迟归因到发起时点）
        record(seqKey, apply('tool', hourFloor(call.time), [app, call.name], cols, maxDur));
        return;
      }
      case 'llm/usage': {
        const usage = (data['usage'] ?? {}) as Record<string, unknown>;
        const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
        // 耗时聚合（基建大扫 #26）：载荷 elapsedMs 在场才计 dur_ms_sum/max
        // （写点缺席容错——旧事件/恢复合成无此字段不炸不造值）；dur_ms_max
        // 单调水印与 tool 表同机制（llm 表 v2 扩列）
        const elapsed = data['elapsedMs'];
        const hasDur = typeof elapsed === 'number' && Number.isFinite(elapsed);
        record(
          seqKey,
          apply(
            'llm',
            hour,
            [app, String(data['model'] ?? '(unknown)'), String(data['priority'] ?? 'foreground')],
            {
              calls: 1,
              tokens_in: num(usage['input']),
              tokens_out: num(usage['output']),
              cache_read: num(usage['cacheRead']),
              cache_write: num(usage['cacheWrite']),
              ...(hasDur ? { dur_ms_sum: elapsed as number } : {}),
            },
            hasDur ? (elapsed as number) : undefined,
          ),
        );
        return;
      }
      case 'llm/retry': {
        // scheduled = 每次真实退避排定（retries 口径）；exhausted = 排定后真
        // 耗尽（失败信号独立成列——基建大扫 #13，与 retries 不双计）；aborted
        // 仍零计（排定的结局两形态：耗尽是失败信号、取消不是——M3 口径延伸）
        if (data['phase'] === 'scheduled') {
          record(seqKey, apply('llm', hour, [app, '(retry)', '(retry)'], { retries: 1 }));
        } else if (data['phase'] === 'exhausted') {
          record(seqKey, apply('llm', hour, [app, '(retry)', '(retry)'], { exhausted: 1 }));
        }
        return;
      }
      case 'approval/asked':
        record(seqKey, apply('approval', hour, [app], { asked: 1 }));
        return;
      case 'approval/decided': {
        const column = APPROVAL_COLUMNS[String(data['decision'])];
        if (column === undefined) return; // 未知 decision（防御位）——不计不炸
        record(seqKey, apply('approval', hour, [app], { [column]: 1 }));
        return;
      }
      case 'apps/deprecation-used': {
        // 废弃遥测（§6.13.7，批 3）：载荷 { app, dep }——app 维载荷显式打标优先，
        // 缺席回落会话血缘桶（与 request/header 同律的取值序）；dep 非字符串或
        // 空即防御跳过（宿主写点批 4 才落，现役零派发——本 case 先建聚合位）
        const dep = data['dep'];
        if (typeof dep !== 'string' || dep === '') return;
        const declaredApp = data['app'];
        const owner = typeof declaredApp === 'string' && declaredApp !== '' ? declaredApp : app;
        record(seqKey, apply('deprecation', hour, [owner, dep], { uses: 1 }));
        return;
      }
      default:
        return; // 其余核心词（gate/decision、sandbox/mode、todo/write 等）刀一无聚合面
    }
  };

  /**
   * 摄取入口：遮蔽指令先行回退（载体事件自身随后照常计数——derive 同判据：
   * 载体可见），再账记事件面。返回回退落空条数（复盘 D-3——两窗同族计数）。
   */
  const ingest = ({ sessionId, event }: EventEnvelope): number => {
    let misses = 0;
    if (event.surfaceOp !== undefined) {
      for (let seq = event.surfaceOp.start; seq <= event.surfaceOp.end; seq++) {
        const seqUndoKey = `${sessionId}\u001f${seq}`;
        const undo = contributions.get(seqUndoKey);
        if (undo !== undefined) {
          const landed = undo();
          contributions.delete(seqUndoKey);
          // 登记在而目标已 drain——drain 窗近似，同族计数（规范：落空一律留痕）
          if (!landed) misses++;
        } else {
          misses++; // 登记缺席——重启/全量 reload 窗（贡献登记表空）
        }
      }
    }
    account({ sessionId, event });
    return misses;
  };

  const drain = (): readonly BucketDelta[] => {
    const out: BucketDelta[] = [];
    for (const [key, bucket] of pending) {
      const cols: Record<string, number> = { ...bucket.cols };
      const watermark = watermarks.get(key);
      if (watermark !== undefined) cols['dur_ms_max'] = watermark;
      out.push({ table: bucket.table, hourTs: bucket.hourTs, dims: bucket.dims, cols });
    }
    pending.clear();
    watermarks.clear(); // R-4①：内存水印随窗清零（DB 侧 MAX 合并兜底——低值重发安全）
    // R-4②：会话归因空窗修剪——7 日无事件会话的归因回落 host 桶（归因近似窗）
    for (const [sid, entry] of sessionApp) {
      if (lastEventTime - entry.lastSeen > SESSION_APP_TTL_MS) sessionApp.delete(sid);
    }
    // R-4③：配对老化清扫——调用时刻落后最新事件 > 1h 的在飞对按孤儿弃置
    for (const [pairKey, call] of toolPending) {
      if (lastEventTime - call.time > TOOL_PAIR_TTL_MS) toolPending.delete(pairKey);
    }
    // turn 配对同律清扫（基建大扫 #50——start 时刻落后最新事件 > 1h 弃置）
    for (const [sid, start] of turnPending) {
      if (lastEventTime - start.time > TURN_PAIR_TTL_MS) turnPending.delete(sid);
    }
    return out;
  };

  return { ingest, drain };
}
