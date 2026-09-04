/**
 * API 治理公开产物的「实验面」节共享标记（契约篇 §6.13.8 查 5 / §6.13.9——
 * API 治理体系进化批 2026-09-04 刀 E）。
 *
 * 单源缘由（查 5 × 查 8 互锁死结的统一解）：查 8 要求两生成物字节等于生成器
 * 真值（experimental 符号必须进文档），查 5 要求稳定文档零实验符号（experimental
 * 符号禁入 docs）——两查互锁，首个实验键落地日恒红。解法 = 实验面专属披露位：
 * 两生成器把 experimental 符号单列本节，查 5 判据改「豁免节之外零实验符号」。
 * 豁免界的标记常量必须生成器与查 5 单源共享——本模块即该单源（tools/ 侧共享
 * 件，三消费方全在 tools/*.mjs：两生成器 + check-api 查 5；不入模块 DAG）。
 *
 * 空节纪律（§6.13.8 查 5 判据精化）：实验符号集为空则节整体不渲染——无永久
 * 空节（查 8 字节等值会把空节锁死在两文档直到首个实验键；零实验符号时查 5
 * 无需豁免区、语义不变）。
 */

/**
 * 实验面节标题行——两生成器原样落盘的节头（`##` 级），查 5 以它在文档中定位
 * 豁免节（标题行起、下一 `##` 级标题或文末止）。
 */
export const EXPERIMENTAL_SECTION_HEADING = '## 实验面（experimental）';

/**
 * 剥除正文中的实验面节（查 5 的豁免预处理——判据「豁免节之外零实验符号」）。
 *
 * 语义：标题行在场时自其起点剥到下一个 `##` 级标题（行首锚定——`###` 子节不
 * 断节，属于豁免区内部）或文末；标题行不在场时原文返回（零实验符号态——
 * 生成器未渲染本节）。扫描期变换，不做尾形修饰（残余空行不含符号、无执法面）。
 *
 * @param {string} text 待扫描的文档全文
 * @returns {string} 剥除豁免节后的正文（实验符号只可能在豁免节内合法出现）
 */
export function stripExperimentalSection(text) {
  // 行首锚定匹配标题行（防手写文档里 `### 实验面…` 尾两 # 被子串匹配误中——
  // 转义防标题将来引入正则特殊字符）
  const headingRe = new RegExp(`^${EXPERIMENTAL_SECTION_HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
  const hit = headingRe.exec(text);
  if (hit === null) return text;
  const after = text.slice(hit.index + EXPERIMENTAL_SECTION_HEADING.length);
  const next = after.search(/^## /m);
  return next === -1 ? text.slice(0, hit.index) : text.slice(0, hit.index) + after.slice(next);
}
