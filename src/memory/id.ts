/**
 * L3 memory — uuid v7 生成器（memories 主键：时间有序，排序免索引——记忆篇 §3）。
 *
 * 形态：48 位 Unix 毫秒时间戳 + 4 位版本号(0111) + 12 位随机 a 位 + 2 位变体(10)
 * + 62 位随机 b 位，共 128 位标准 UUID v7 字符串。Node 内建 randomUUID 只有 v4，
 * 此处自带 ~20 行实现（无第三方依赖）。
 */

/** 随机字节源（独立小函数——测试不可注入也无需注入：随机性不进断言面） */
function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

/**
 * 生成 uuid v7 字符串（小写十六进制带连字符）。
 * 同毫秒内排序不保证严格递增（随机位无计数器）——但跨毫秒严格有序，
 * 「时间近似有序」对记忆条目排序已足够（排序免索引的本意）。
 */
export function uuidV7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  // 48 位时间戳写入前 6 字节（高位在前）
  const ts = BigInt(nowMs);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  // version 7（高 4 位 = 0111）+ 随机 a 位
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // variant 10 + 随机 b 位
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 条目完整 id → 稳定短 id（首段 8 位十六进制——uuid v7 首段恰为 8 字符）。
 * 用途：引用标记 `[m:短id]`（记忆篇 §6 引用回写——注入面携带、assistant 文本
 * 解析回写）。500 条/owner 量级下碰撞概率 ~3e-5，且解析侧「多命中即歧义忽略」
 * 兜底（idsByPrefix），碰撞不产生错误归属。
 */
export function shortIdOf(id: string): string {
  return id.slice(0, 8);
}
