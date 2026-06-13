/**
 * 键盘快捷键 hook。
 *
 * 注册全局快捷键（支持 Meta/Ctrl 修饰键），卸载时自动清理监听器。
 * 快捷键定义：{ key, meta?, handler }。
 */

import { useEffect } from "react";

interface Shortcut {
  key: string;
  meta?: boolean;
  handler: () => void;
}

export function useKeyboardShortcuts(shortcuts: Shortcut[]) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      for (const s of shortcuts) {
        if (s.meta && !(e.metaKey || e.ctrlKey)) continue;
        if (e.key.toLowerCase() === s.key.toLowerCase()) {
          e.preventDefault();
          s.handler();
          return;
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [shortcuts]);
}
