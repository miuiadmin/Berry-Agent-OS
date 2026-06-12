
import { type ComponentPropsWithoutRef } from "react";
import type { Components } from "react-markdown";
import { ExternalLink } from "lucide-react";
import { CodeBlock } from "./code-block";
import { ClickableImage } from "@/components/ui/image-lightbox";

export function createMarkdownComponents(isStreaming?: boolean): Components {
  return {
    code({ className, children }) {
      const match = /language-(\w+)/.exec(className || "");
      const lang = match ? match[1] : null;
      if (lang || /language-/.test(className || "")) {
        return (
          <CodeBlock lang={lang} isStreaming={isStreaming}>
            {children}
          </CodeBlock>
        );
      }
      return (
        <code className="rounded bg-muted/80 px-1.5 py-0.5 text-[13px] font-mono text-foreground">
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    table({ children, ...props }: ComponentPropsWithoutRef<"table">) {
      return (
        <div className="my-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm" {...props}>
            {children}
          </table>
        </div>
      );
    },
    thead({ children, ...props }: ComponentPropsWithoutRef<"thead">) {
      return (
        <thead className="bg-muted/50" {...props}>
          {children}
        </thead>
      );
    },
    th({ children, ...props }: ComponentPropsWithoutRef<"th">) {
      return (
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground" {...props}>
          {children}
        </th>
      );
    },
    td({ children, ...props }: ComponentPropsWithoutRef<"td">) {
      return (
        <td className="border-t border-border px-3 py-2 text-sm" {...props}>
          {children}
        </td>
      );
    },
    blockquote({ children, ...props }: ComponentPropsWithoutRef<"blockquote">) {
      return (
        <blockquote
          className="my-3 border-l-3 border-accent/50 bg-muted/30 py-2 pl-4 pr-3 text-sm text-muted-foreground italic rounded-r-lg"
          {...props}
        >
          {children}
        </blockquote>
      );
    },
    a({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
      // 安全过滤：仅允许安全协议，防止 LLM 幻觉输出注入 javascript:/data: URI
      const safeHref = href && /^(https?:|mailto:|\/|#)/i.test(href) ? href : undefined;
      const isExternal = safeHref?.startsWith("http");
      return (
        <a
          href={safeHref}
          target={isExternal ? "_blank" : undefined}
          rel={isExternal ? "noopener noreferrer" : undefined}
          className="inline-flex items-center gap-0.5 text-accent underline underline-offset-2 hover:text-accent/80 transition-colors"
          {...props}
        >
          {children}
          {isExternal && <ExternalLink className="inline size-3" />}
        </a>
      );
    },
    hr() {
      return <hr className="my-4 border-border" />;
    },
    ul({ children, ...props }: ComponentPropsWithoutRef<"ul">) {
      return (
        <ul className="my-2 ml-4 list-disc space-y-1 text-sm marker:text-muted-foreground" {...props}>
          {children}
        </ul>
      );
    },
    ol({ children, ...props }: ComponentPropsWithoutRef<"ol">) {
      return (
        <ol className="my-2 ml-4 list-decimal space-y-1 text-sm marker:text-muted-foreground" {...props}>
          {children}
        </ol>
      );
    },
    p({ children, ...props }: ComponentPropsWithoutRef<"p">) {
      return (
        <p className="my-2 first:mt-0 last:mb-0 leading-relaxed" {...props}>
          {children}
        </p>
      );
    },
    h1({ children, ...props }: ComponentPropsWithoutRef<"h1">) {
      return <h1 className="mt-4 mb-2 text-lg font-bold" {...props}>{children}</h1>;
    },
    h2({ children, ...props }: ComponentPropsWithoutRef<"h2">) {
      return <h2 className="mt-3 mb-2 text-base font-semibold" {...props}>{children}</h2>;
    },
    h3({ children, ...props }: ComponentPropsWithoutRef<"h3">) {
      return <h3 className="mt-3 mb-1.5 text-sm font-semibold" {...props}>{children}</h3>;
    },
    img({ src, alt }) {
      const imgSrc = typeof src === "string" ? src : undefined;
      return <ClickableImage src={imgSrc} alt={alt} />;
    },
  };
}
