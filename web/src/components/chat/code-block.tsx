"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import { useTheme } from "@/lib/theme";
import { highlight } from "@/lib/highlighter";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

function CopyBtn({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1.5 md:px-1.5 md:py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent transition-colors",
        className,
      )}
      aria-label="Copy code"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

interface CodeBlockProps {
  lang: string | null;
  children?: ReactNode;
  isStreaming?: boolean;
}

export function CodeBlock({ lang, children, isStreaming }: CodeBlockProps) {
  const code = String(children).replace(/\n$/, "");
  const { resolvedTheme } = useTheme();
  const [highlightedHtml, setHighlightedHtml] = useState<string>("");

  useEffect(() => {
    if (!lang || isStreaming) {
      setHighlightedHtml("");
      return;
    }

    let cancelled = false;
    const theme = resolvedTheme === "dark" ? "dark" : "light";
    highlight(code, lang, theme).then((html) => {
      if (!cancelled) setHighlightedHtml(html);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, resolvedTheme, isStreaming]);

  if (!lang) {
    return (
      <code className="rounded bg-muted/80 px-1.5 py-0.5 text-[13px] font-mono text-foreground">
        {children}
      </code>
    );
  }

  const lineCount = code.split("\n").length;

  return (
    <div className="group/code relative my-3 rounded-lg border border-border bg-muted/30 overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 bg-muted/50">
        <span className="text-[11px] md:text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          {lang}
        </span>
        <div className="flex items-center gap-2">
          {lineCount > 10 && (
            <span className="text-[11px] md:text-[10px] text-muted-foreground/60">
              {lineCount} lines
            </span>
          )}
          <CopyBtn text={code} />
        </div>
      </div>
      {highlightedHtml ? (
        <div
          className="overflow-x-auto p-3 text-[13px] md:text-xs [&_pre]:!m-0 [&_pre]:!p-0 [&_pre]:!bg-transparent [&_code]:!text-[13px] md:[&_code]:!text-xs [&_code]:!font-mono"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre className="!m-0 !rounded-none !border-0 !bg-transparent p-3 overflow-x-auto">
          <code className="text-[13px] md:text-xs font-mono">{children}</code>
        </pre>
      )}
    </div>
  );
}
