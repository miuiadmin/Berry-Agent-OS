/**
 * CopyButton 通用复制按钮组件。
 *
 * 点击写入剪贴板，1.5s 内显示 ✓ 反馈。失败时静默（剪贴板被拒 / 非安全上下文）。
 * 消除 message-bubble-parts 与 code-block 中的重复实现。
 *
 * 移动端硬规则：44×44 触控目标（min-h/min-w-[44px]），桌面端紧凑（md:min-h-0）。
 *
 * 用法：
 *   <CopyButton text={code} />
 *   <CopyButton text={url} className="text-foreground" />
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/** 共享移动端触控尺寸（44px / 桌面端紧凑） */
const BASE = "inline-flex items-center gap-1 rounded-md px-2 py-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground active:bg-accent min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 md:px-1.5 md:py-1";

export function CopyButton({ text, className }: { text: string; className?: string }) {
  /** 复制成功反馈态（1.5s 后自动复位） */
  const [copied, setCopied] = useState(false);
  const t = useT();
  /** 反馈态定时器引用，卸载时清除避免泄漏 */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      // 复位已有定时器再起新的，避免连续点击闪烁
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard access denied or insecure context */ });
  }, [text]);

  return (
    <button type="button" onClick={handleCopy} className={cn(BASE, className)} aria-label={t("chat.copy")}>
      {copied ? <Check className="size-3 animate-fade-scale" /> : <Copy className="size-3" />}
    </button>
  );
}
