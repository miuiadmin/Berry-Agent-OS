/**
 * L1 context — 令牌桶频率护栏（契约篇 §1.6 时钟族/资源护栏族共用机制）。
 *
 * 两消费面同一机制（2026-08-27 刀〇b 抽出共用件）：
 * - emit 侧：per-**作用域**桶（ContextRuntime——应用作用域派发频率，root 免计费）；
 * - sessions 侧：per-**会话**桶（app 装配层 ctx.sessions 写面——应用落 durable
 *   事件按目标会话归因）。
 * 两面同抛 APP_EVENT_RATE 但文案与键不同（面名 + 键 + 两阈值可分辨——码族
 * 随语义族走，不因消费面分裂）。
 */

/** 令牌桶参数 */
export interface RateLimitParams {
  /** 突发容量（桶内令牌上限 = 单次可连续扣费次数） */
  readonly capacity: number;
  /** 每分钟回填速率（持续供给上限 = 长时段允许的平均频率） */
  readonly perMinute: number;
}

/** 单桶状态：当前令牌数 + 上次回填时点（墙上钟毫秒） */
interface RateBucketState {
  tokens: number;
  last: number;
}

/** 摊销清扫节拍：每 256 次 tryCharge 全表扫一次（不逐次扫——摊销后均价 O(1)） */
const SWEEP_EVERY = 256;

/**
 * per-key 令牌桶（缺省满桶起算）：tokens 按墙上钟以 perMinute 速率回填夹
 * capacity；每次扣 1，桶空返回 false。「桶空 ≠ 拒绝一切」——等回填即可再发，
 * 速率护栏语义而非总量帽。
 */
export class RateLimiter {
  private readonly buckets = new Map<string, RateBucketState>();
  /** 参数只读暴露（调用方错误文案需要两阈值——面/键/阈值三件套可分辨） */
  readonly params: RateLimitParams;
  /**
   * 桶闲置过期阈值（毫秒）= 回填满桶所需时长（capacity/perMinute 分钟）。
   * 闲置超阈的桶与新建桶同为满额态——删键零损（遗漏大扫 20260902-c #11——
   * 会话篇 §6 键域有界性统策：sessions 消费面 per-会话桶随会话开张只增不减，
   * daemon 常驻无界累积）。零回填档（perMinute=0）为 Infinity：桶空即永空是
   * 语义本身，删空桶 = 白送突发容量，结构性免扫。
   */
  private readonly staleMs: number;
  /** tryCharge 累计计数（摊销清扫节拍器——每 SWEEP_EVERY 次触发全表扫） */
  private charges = 0;

  constructor(params: RateLimitParams) {
    this.params = params;
    this.staleMs = params.perMinute > 0 ? (params.capacity / params.perMinute) * 60_000 : Infinity;
  }

  /**
   * 尝试扣一枚令牌。
   * @param key 计费键（emit 侧 = 作用域名；sessions 侧 = 目标会话 id）
   * @returns true = 扣费成功；false = 桶空（执法与文案归调用方——fail-loud 抛错
   *   在各消费面组装，保持两面包可分辨）
   */
  tryCharge(key: string): boolean {
    const now = Date.now();
    // 摊销清扫：闲置 ≥ staleMs 的桶删除零损（惰性回填本会在下次扣费时补满，
    // 删后重建 = 满桶同态）——emit 侧作用域键少而热，清扫对其无副作用
    if (++this.charges % SWEEP_EVERY === 0) this.sweepStale(now);
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: this.params.capacity, last: now };
      this.buckets.set(key, bucket);
    } else {
      // 按流逝时间回填令牌（夹在 capacity——突发余量语义）
      const refill = ((now - bucket.last) / 60_000) * this.params.perMinute;
      bucket.tokens = Math.min(this.params.capacity, bucket.tokens + refill);
      bucket.last = now;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** 全表扫删闲置过期桶（摊销路径——迭代中删当前键是 Map 迭代器安全操作） */
  private sweepStale(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.last >= this.staleMs) this.buckets.delete(key);
    }
  }
}
