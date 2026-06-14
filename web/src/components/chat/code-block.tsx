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
import { INLINE_CODE } from "@/components/ui/_shared";
import { useT } from "@/lib/i18n";

interface CodeBlockProps {
  /** 编程语言标识（如 "typescript"、"python"）；为 null 时降级为行内 code */
  lang: string | null;
  /** 代码文本内容（react-markdown 传入，可能是 string / array / element） */
  children?: ReactNode;
  /** 是否在流式输出中（true 时跳过高亮） */
  isStreaming?: boolean;
}

/** 超过此行数显示行数统计 */
const LINE_COUNT_THRESHOLD = 10;

/**
 * 把 ReactNode（react-markdown 的 children）拼成纯字符串。
 * 兼容 string / number / array / 嵌套 array 多种形态。
 */
function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  // element：递归取 props.children
  if (typeof node === "object" && "props" in node) {
    return nodeToText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

/**
 * 代码块组件。
 *
 * - 有 lang 时：Shiki 异步高亮，加载中降级为等宽文本
 * - 无 lang 时：行内 `<code>` 渲染
 * - 超过 LINE_COUNT_THRESHOLD 行时显示行数统计
 * - 复制按钮使用共享 ui/copy-button.tsx（与 message-bubble-parts 共用）
 */
export function CodeBlock({ lang, children, isStreaming }: CodeBlockProps) {
  const t = useT();
  /** 去掉末尾换行的纯代码文本（String(children) 兼容 react-markdown 传入的多种 children 形态） */
  const code = nodeToText(children).replace(/\n$/, "");
  const { resolvedTheme } = useTheme();
  /** Shiki 高亮后的 HTML（空字符串 = 未高亮 / 流式中） */
  const [highlightedHtml, setHighlightedHtml] = useState("");
  /** 防 effect 竞态（sessionId 切换 / 流式结束并发触发） */
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    /** 无语言或流式中跳过高亮，降级为纯文本 */
    if (!lang || isStreaming) { setHighlightedHtml(""); return; }
    const theme = resolvedTheme === "dark" ? "dark" : "light";
    highlight(code, lang, theme)
      .then((html) => { if (!cancelledRef.current) setHighlightedHtml(html); })
      .catch(() => { /* 高亮失败，降级为纯文本 */ });
    return () => { cancelledRef.current = true; };
  }, [code, lang, resolvedTheme, isStreaming]);

  /** 无语言标识 → 行内 code 渲染（与 markdown-components 的兜底样式一致，共用 INLINE_CODE 常量） */
  if (!lang) {
    return (
      <code className={INLINE_CODE}>
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
          {lineCount > LINE_COUNT_THRESHOLD && (
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
