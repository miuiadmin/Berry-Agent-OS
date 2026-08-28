/**
 * L3 memory — 引用回写（记忆篇 §6 效用闭环，2026-08-24 第十二批拍板题一）。
 *
 * 注入条目（常驻简报与按需检索）在框架句式中携带稳定短 id；提示词要求模型
 * 「使用记忆作答时以固定标记标注引用」。本模块定义标记格式与解析件：
 *
 * - 标记格式（落码定稿）：`[m:0a1b2c3d]` —— m=memory + 冒号 + 8 位十六进制短 id
 *   （条目 uuid v7 首段，稳定、无额外存储；短 id 由 id.ts shortIdOf 派生）；
 * - 解析 = 对 assistant 消息文本跑正则、尽力而为（非法/未知/歧义短 id 一律忽略
 *   ——解析失败不产生任何可观察副作用，回写语义见 store.markUsed）；
 * - 零内核改动：解析住在应用内（session/event 事件流消费侧），不回写事件日志。
 */

import { shortIdOf } from './id.js';

/** 引用标记的正则源（8 位十六进制短 id；全局匹配逐处命中） */
const CITATION_PATTERN = /\[m:([0-9a-f]{8})\]/g;

/**
 * 引用指令句（注入框架句式的第二行——随短 id 一起进常驻简报与按需检索注入，
 * 告知模型标注格式；示例 id 为全零占位，不对应任何真实条目）。
 */
export const CITATION_INSTRUCTION =
  '若使用上述记忆作答，请在回答文本中以条目短 id 标注引用，格式如 [m:00000000]（可标注多条）。';

/**
 * 构造条目的引用标记（注入面渲染用——简报行/检索行/工具读出行统一形态）。
 * @param id 记忆条目完整 id（uuid v7）
 */
export function citationMarker(id: string): string {
  return `[m:${shortIdOf(id)}]`;
}

/**
 * 从 assistant 消息文本解析引用标记（尽力而为纯函数）。
 * 同一短 id 多次出现计一次（一条消息对一条记忆 = 一次引用）；标记外的
 * 方括号文本（如普通 Markdown 链接）不误伤——正则钉死 `[m:hex8]` 形态。
 * @returns 去重后的短 id 列表（保出现序；空文本/无标记返回空数组）
 */
export function parseCitationShortIds(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(CITATION_PATTERN)) {
    const short = match[1];
    if (short !== undefined) seen.add(short);
  }
  return [...seen];
}

/**
 * 事件载荷 content → 纯文本（assistant/message 的 text 块拼接；与 review.ts
 * 同语义的模块内副本——各消费件自持小函数，不跨文件抽公共面）。
 */
export function textOfAssistantContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = block as { type?: unknown; text?: unknown };
      return b?.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .filter((t) => t !== '')
    .join('\n');
}
