/**
 * 流式面板「自动收起」钩子。
 *
 * thinking-process / tool-call-cards 两个流式面板共用同一段行为：
 * 初始展开态跟随 isActive；当 isActive 从 true 变 false（流式结束）时自动收起。
 *
 * 抽出后两处共用一份 wasActive 下降沿逻辑——这套 ref 时序较微妙，
 * 分散两份容易改一处漏一处（例如漏掉 wasActive.current = isActive 的回写）。
 */

import { useEffect, useRef, useState } from "react";

/**
 * @param isActive 当前是否处于流式活跃态
 * @returns [expanded, setExpanded] —— expanded 在 isActive 下降沿自动置 false，也可手动 toggle
 */
export function useAutoCollapse(isActive: boolean) {
  /** 当前展开态，初始跟随 isActive */
  const [expanded, setExpanded] = useState(isActive);
  /** 上一帧的 isActive，用于检测 true→false 的下降沿 */
  const wasActive = useRef(isActive);

  useEffect(() => {
    // 仅在「曾经活跃 → 不再活跃」时收起；流式过程中手动展开不被打断
    if (wasActive.current && !isActive) setExpanded(false);
    wasActive.current = isActive;
  }, [isActive]);

  return [expanded, setExpanded] as const;
}
