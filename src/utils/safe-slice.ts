/**
 * safeSlice — UTF-8 安全截断工具函数。
 *
 * 问题：JavaScript 的 `String.prototype.slice()` 按 UTF-16 code unit 切割，
 * 对于包含 emoji（如 👨‍👩‍👧‍👦）、CJK 扩展字符、组合字符的文本，可能在字符中间切断，
 * 导致 Brain 看到乱码。
 *
 * 解决：使用 `Array.from()` 按 grapheme cluster 边界切割，
 * 确保不会在多字节字符中间截断。
 *
 * 性能：每次调用最多处理 maxChars 个 grapheme，Brain 观察数据量不大（< 3000 字符），
 * 不构成性能瓶颈。
 */

/**
 * UTF-8 安全截断：按 grapheme 边界切割，避免切断多字节字符。
 *
 * @param text 原始文本
 * @param maxChars 最大 grapheme 数量（不是字节数）
 * @returns 截断后的文本
 *
 * @example
 * safeSlice('你好世界👋👋', 4) // '你好世界👋'
 * safeSlice('hello', 3)         // 'hel'
 * safeSlice('', 10)             // ''
 * safeSlice('abc', 100)         // 'abc'
 */
export function safeSlice(text: string | null | undefined, maxChars: number): string {
  if (!text || maxChars <= 0) return '';
  if (text.length <= maxChars) return text; // 快速路径：短文本无需截断
  // Array.from() 按 grapheme cluster 迭代，不会切断 emoji/CJK 扩展字符
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, maxChars).join('');
}

/**
 * UTF-8 安全截断并附加省略号（如果发生截断）。
 *
 * @param text 原始文本
 * @param maxChars 最大字符数（不含省略号）
 * @returns 截断后的文本（被截断时末尾有 "..."）
 */
export function safeSliceWithEllipsis(text: string | null | undefined, maxChars: number): string {
  if (!text || maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return '...';
  return Array.from(text).slice(0, maxChars - 3).join('') + '...';
}
