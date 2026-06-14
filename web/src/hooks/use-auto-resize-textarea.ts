/**
 * useAutoResizeTextarea — textarea 自适应高度 hook。
 *
 * 核心 pattern：每次内容变化时先 `height = "auto"`（让浏览器按内容重算 scrollHeight），
 * 再 `height = scrollHeight`（撑到内容真实高度）。直接从当前高度缩到新高度会算不准
 * （删字时 scrollHeight 不会缩），必须先 reset 成 auto。
 *
 * 抽成 hook 的原因：chat-input（发送框，封顶 MAX_HEIGHT）和 message-bubble-parts
 * 的 EditableMessage（编辑气泡，不封顶自然增长）两处各写一份相同的"reset → set"逻辑，
 * 且都附带挂载时初次撑开。统一到这里避免漂移（例如漏掉挂载初次撑开）。
 *
 * @param maxHeight 可选高度上限（px）。超过后内容滚动而非继续撑高。
 *                  不传则不封顶（编辑气泡场景）。
 * @returns `{ textareaRef, resize }`：
 *   - textareaRef：挂在 <textarea> 上
 *   - resize：手动触发重算（清空内容 / 外部 setValue 后调用）
 */

import { useCallback, useRef } from "react";

export function useAutoResizeTextarea(maxHeight?: number) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * 重算高度：读当前 scrollHeight，应用 maxHeight 封顶（若传了）。
   * 对 null ref 安全（组件未挂载时 no-op）。
   */
  const resize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const target = maxHeight !== undefined
      ? Math.min(ta.scrollHeight, maxHeight)
      : ta.scrollHeight;
    ta.style.height = `${target}px`;
  }, [maxHeight]);

  return { textareaRef, resize };
}
