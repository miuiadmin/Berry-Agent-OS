/**
 * L1 persist — per-session 键域 LRU 有界表（会话篇 §6「per-session 键域长跑有界性」
 * 统策件，遗漏大扫 20260902-c #9/#10）。
 *
 * daemon 常驻下 per-session 键随会话开张只增不减（jobs 终态帽 / compaction 分账
 * 空闲保留帽同族）。可无损重种的账面（登记元数据 sessionMeta / 自有提交边界
 * ownBoundaries / memory 件 epochs 纪元表）统一走本件：touch-on-use——get/set
 * 即续驻，超帽逐最旧闲置键。
 * 被逐键的统一后果语义 = 重种（各消费面自身既有路径：首队重登记 / 保守全批
 * 保留 / 懒初始化重派生）——本件只管逐出次序，不承担重种责任。
 */

/** 会话键域统一帽（家族值：jobs 终态帽 / compaction 分账帽同款 256） */
export const SESSION_KEY_CAP = 256;

/**
 * LRU 有界 Map（Map 迭代序 = 插入序即闲置序——首位恒为最旧闲置键）。
 * get 命中即 touch（删后重插续驻）；set 恒 touch；超帽逐迭代器首位。
 */
export class LruBoundedMap<K, V> {
  private readonly entries = new Map<K, V>();

  /** @param cap 键数上限（超帽逐最旧闲置键） */
  constructor(private readonly cap: number) {}

  /** 读 + touch（命中续驻；未命中返回 undefined 零副作用） */
  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  /** 写（恒 touch——已存键覆写并续驻）+ 超帽逐出 */
  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** 当前键数（诊断/测试面） */
  get size(): number {
    return this.entries.size;
  }
}
