/**
 * 会话事件预算刀（第九轮 #7/#12 修死迁入）：durable 落账前的内容预算截断。
 *
 * 原籍 chat/durable.ts（模块私有），第九轮全面复盘 #7/#12 判定预算刀是
 * 「写侧预算 = 护栏矛盾的宿主单点解」——不专属对话件：compaction 五步摘要、
 * goal 轮间沉淀三件套、assembly appendWithSurfaceOp 宿主代写面、todo 序列化
 * 预算共用同一把刀。迁入 session（护栏 session.append 所在模块——刀与护栏
 * 同居一域，会话篇 §1.2 预算刀章）。chat 经 '../session/index.js' 公开面
 * 导入（禁深挖——契约篇 §6.3#2）。
 *
 * 度量单位 = JSON 转义后体积（遗漏大扫 20260903 fix-code D3-1 修死）：护栏
 * session.append 量的是 jsonBytes(snapshot)（JSON.stringify 后体积），预算刀
 * 若量原文字节即两把尺子不同单位——引号/换行每字符转义 2x、控制字符 6x，
 * 转义密集文本 raw ≤60KiB 穿透预算刀后转义 >64KiB，护栏 SESSION_EVENT_TOO_
 * LARGE 上抛炸整个 run。预算刀与护栏必须同一把尺。
 */

import type { ImageContent, TextContent, ThinkingContent } from '../contracts/llm.js';

/**
 * durable 内容预算（字节）：session 事件护栏 64KiB 扣除事件元数据（type/seq/
 * toolCallId/error 头部）后的内容可用上限。写侧截断是护栏矛盾的宿主单点解——
 * fs read 上限 256KiB > 会话护栏 64KiB，若不在落账前截断，读大文件必在
 * append 抛 SESSION_EVENT_TOO_LARGE 并沿 emit 上抛炸掉整个 run
 * （独立重读轮 #9 复核坐实，2026-08-23 修）。
 */
export const DURABLE_CONTENT_BUDGET_BYTES = 60 * 1024;

/**
 * error 腿错误说明预算（字节）：定向复扫 20260902 第七轮 H-2 修死。error.message
 * 与 content 腿同源（首文本块）但**独立小帽**——不帽则同源双载重复计入事件体积
 * （append 量的是整个 data JSON），首文本 > ~32.6KiB 时 content 腿（60KiB 预算内
 * 不截）+ error 腿原文 ≈ 2×文本，破 64KiB 护栏 → SESSION_EVENT_TOO_LARGE 上抛
 * 炸整个 run 且该 tool/result 及其后审计全丢（exec/pipeline 的 60-64KiB 输出预算
 * 都不拦错误文本）。错误说明是归因线索非全文：保头 2KiB + 截断标记足够。
 */
export const DURABLE_ERROR_MESSAGE_BUDGET_BYTES = 2 * 1024;

/** 截断尾标记（读侧可识别「内容被 durable 预算裁过」——投影/模型侧语义损失显式化） */
export const TRUNCATED_MARKER = '\n…[truncated for durable log]';

/**
 * durable 内容块类型（截断器覆盖三种载荷块：user=text/image、
 * assistant=text/thinking、toolResult=text/image）。toolCall **不在其列**：
 * content 腿不内联 toolCall 块（tool/call 事件是唯一承载腿，双载必在投影
 * 回读时拼出重复块——会话篇 §1.1，2026-08-23 修）。
 */
export type DurableBlock = TextContent | ThinkingContent | ImageContent;

/** 单块护栏同尺度量（截断预算的计量单位；image 按 base64 字符串长度近似——
 * base64 字母表无转义字符，转义前后等长） */
export function blockBytes(block: DurableBlock): number {
  switch (block.type) {
    case 'text':
      return escapedBytes(block.text);
    case 'thinking':
      return escapedBytes(block.thinking);
    case 'image':
      return block.data.length;
  }
}

/** 字符串的护栏同尺体积（与 session.jsonBytes 同式：JSON.stringify 加一对
 * 引号 2B 恒定——并入事件信封余量，不另扣） */
export function escapedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8');
}

/**
 * 字符串按「护栏同尺」字节预算截断（超预算加尾标记；不超原样返回）。
 * user 纯文本整串、tool/call 的 arguments 字符串与 error 腿错误说明共用这一把刀
 * ——预算各别传入（content/arguments = 60KiB 内容预算；error 说明 = 2KiB 小帽）。
 * 度量与截断目标都是转义后体积（见模块头注——与护栏同一把尺）。
 */
export function budgetString(text: string, budget: number = DURABLE_CONTENT_BUDGET_BYTES): string {
  if (escapedBytes(text) <= budget) return text;
  // 转义只增不减：原文截到 budget 字节是安全上界（转义后 ≤ 原文 × 截点）
  let sliced = Buffer.from(text, 'utf8').subarray(0, budget).toString('utf8');
  // 收敛循环：截段+尾标记的转义体积压进预算。按超限比例收缩（几何收敛——
  // 控制字符 6x 形态一轮即近界），近界后逐字符兜底（subarray 可能切在多字节
  // 字符中间，toString 对坏尾替换 U+FFFD——可接受且不影响收敛）
  while (escapedBytes(sliced + TRUNCATED_MARKER) > budget) {
    const over = escapedBytes(sliced + TRUNCATED_MARKER);
    const next = Math.floor((sliced.length * budget) / over);
    sliced = sliced.slice(0, Math.max(Math.min(next, sliced.length - 1), 0));
    if (sliced.length === 0) return TRUNCATED_MARKER;
  }
  return sliced + TRUNCATED_MARKER;
}

/**
 * 内容截断到 durable 预算内（块数组形态：text/thinking 块按剩余预算截字节
 * 并加尾标记，image 块放不下时换文本占位——base64 动辄超预算，保留语义不保像素）。
 * 不超预算时原样返回（零成本快路径）。
 */
export function truncateForDurable(content: string | readonly DurableBlock[]): string | readonly DurableBlock[] {
  // 纯字符串形态（user 消息）：整串按字节截
  if (typeof content === 'string') {
    return budgetString(content);
  }
  // 快路径：总字节在预算内直接通过（绝大多数消息零开销）
  let total = 0;
  for (const block of content) {
    total += blockBytes(block);
  }
  if (total <= DURABLE_CONTENT_BUDGET_BYTES) return [...content];

  const out: DurableBlock[] = [];
  let budget = DURABLE_CONTENT_BUDGET_BYTES;
  for (const block of content) {
    if (block.type === 'image') {
      // 像素载荷放不进预算 → 文本占位（像素本就不进 durable——事件日志是审计面非媒体库）
      out.push({ type: 'text', text: '[image omitted: durable budget]' });
      continue;
    }
    // text / thinking：按剩余预算截字节（度量与判定同尺——转义后体积）
    const text = block.type === 'text' ? block.text : block.thinking;
    const size = escapedBytes(text);
    if (size <= budget) {
      out.push(block);
      budget -= size;
      continue;
    }
    if (budget > 0) {
      // 复用 budgetString 的收敛循环（截段+尾标记的转义体积压进剩余预算——
      // 与护栏同一把尺，见模块头注）
      const marked = budgetString(text, budget);
      out.push(block.type === 'text' ? { type: 'text', text: marked } : { type: 'thinking', thinking: marked });
      budget = 0;
    }
    // 预算耗尽后的剩余 text/thinking 块整块丢弃（尾标记已声明截断事实）
  }
  return out;
}
