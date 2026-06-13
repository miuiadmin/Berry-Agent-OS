/**
 * CodeBlock — Markdown 代码块渲染组件。
 *
 * 支持 Shiki 语法高亮（异步加载主题）、行数统计、一键复制。
 * 流式模式下跳过高亮（避免闪烁），降级为纯文本渲染。
 */

import { useState, useEffect, useRef, type ReactNode } from "react";
import { useTheme } from "@/lib/theme";
import { highlight } from "@/lib/highlighter";
import { CopyButton } from "@/components/ui/copy-button";
import { useT } from "@/lib/i18n";

interface CodeBlockProps {
  /** 编程语言标识（如 "typescript"、"python"） */
  lang: string | null;
  /** 代码文本内容 */
  children?: ReactNode;
  /** 是否在流式输出中（跳过高亮） */
  isStreaming?: boolean;
}

/**
 * 代码块组件。
 *
 * - 有 lang 时：Shiki 异步高亮，加载中降级为等宽文本
 * - 无 lang 时：行内 `<code>` 渲染
 * - 超过 10 行时显示行数统计
 * - 复制按钮使用共享 ui/copy-button.tsx（与 message-bubble-parts 共用）
 */
export function CodeBlock({ lang, children, isStreaming }: CodeBlockProps) {
  const t = useT();
  /** 去掉末尾换行的纯代码文本 */
  const code = String(children).replace(/\n$/, "");
  const { resolvedTheme } = useTheme();
  /** Shiki 高亮后的 HTML（空字符串 = 未高亮） */
  const [highlightedHtml, setHighlightedHtml] = useState("");

  useEffect(() => {
    /** 无语言或流式中跳过高亮 */
    if (!lang || isStreaming) { setHighlightedHtml(""); return; }
    let cancelled = false;
    const theme = resolvedTheme === "dark" ? "dark" : "light";
    highlight(code, lang, theme)
      .then((html) => { if (!cancelled) setHighlightedHtml(html); })
      .catch(() => { /* 高亮失败，降级为纯文本 */ });
    return () => { cancelled = true; };
  }, [code, lang, resolvedTheme, isStreaming]);

  /* 无语言标识 → 行内 code 渲染 */
  if (!lang) {
    return (
      <code className="rounded bg-muted/80 px-1.5 py-0.5 text-[13px] font-mono text-foreground">
        {children}
      </code>
    );
  }

  /** 代码行数（用于判断是否显示行数统计） */
  const lineCount = code.split("\n").length;

  return (
    <div className="group/code relative my-3 overflow-hidden rounded-lg border border-border bg-muted/30">
      {/* 标题栏：语言名 + 行数 + 复制按钮 */}
      <div className="flex items-center justify-between border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground md:text-[10px]">
          {lang}
        </span>
        <div className="flex items-center gap-2">
          {lineCount > 10 && (
            <span className="text-[11px] text-muted-foreground/60 md:text-[10px]">
              {t("codeBlock.lineCount", { count: lineCount })}
            </span>
          )}
          <CopyButton text={code} />
        </div>
      </div>
      {/* 高亮结果或纯文本降级 */}
      {highlightedHtml ? (
        <div
          className="overflow-x-auto p-3 text-[13px] md:text-xs [&_code]:!font-mono [&_code]:!text-[13px] md:[&_code]:!text-xs [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre className="!m-0 !rounded-none !border-0 !bg-transparent p-3 overflow-x-auto">
          <code className="text-[13px] font-mono md:text-xs">{children}</code>
        </pre>
      )}
    </div>
  );
}
