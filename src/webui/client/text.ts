/**
 * 消息 content 的文本提取（纯函数）——pi-ai 块数组 → 纯文本。
 *
 * content 线格式两形态：字符串（user 直文本）或块数组（assistant——文本块
 * 之外的块〔思考/工具调用〕不进正文渲染，工具调用走投影 toolCalls 卡片）。
 */

/** 提取纯文本：字符串直出；块数组拼 text 块；其余形态空串（防御不改炸） */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') out += b.text;
  }
  return out;
}
