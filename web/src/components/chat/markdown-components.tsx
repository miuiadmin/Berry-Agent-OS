/**
 * Markdown 自定义渲染组件映射。
 *
 * 为 react-markdown 提供自定义的 HTML 渲染规则，
 * 包括代码块（Shiki 高亮）、表格、引用、链接、列表、标题、图片等。
 *
 * @param isStreaming 是否在流式输出中（跳过代码高亮，减少闪烁）
 * @returns react-markdown 的 Components 映射对象
 */

import { type ComponentPropsWithoutRef } from "react";
import type { Components } from "react-markdown";
import { ExternalLink } from "lucide-react";
import { CodeBlock } from "./code-block";
import { ClickableImage } from "@/components/ui/image-lightbox";

export function createMarkdownComponents(isStreaming?: boolean): Components {
  return {
    /** 代码：有语言标识 → CodeBlock 组件，无标识 → 行内 code */
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

    /** pre 标签：透传子元素（CodeBlock 自带外层容器） */
    pre({ children }) {
      return <>{children}</>;
    },

    /** 表格：圆角边框包裹，支持横向滚动 */
    table({ children, ...props }: ComponentPropsWithoutRef<"table">) {
      return (
        <div className="my-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm" {...props}>
            {children}
          </table>
        </div>
      );
    },

    /** 表头行：浅灰背景 */
    thead({ children, ...props }: ComponentPropsWithoutRef<"thead">) {
      return (
        <thead className="bg-muted/50" {...props}>
          {children}
        </thead>
      );
    },

    /** 表头单元格：小号字体 */
    th({ children, ...props }: ComponentPropsWithoutRef<"th">) {
      return (
        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground" {...props}>
          {children}
        </th>
      );
    },

    /** 表格数据单元格：顶部分割线 */
    td({ children, ...props }: ComponentPropsWithoutRef<"td">) {
      return (
        <td className="border-t border-border px-3 py-2 text-sm" {...props}>
          {children}
        </td>
      );
    },

    /** 引用块：左侧品牌色竖线 + 灰底斜体 */
    blockquote({ children, ...props }: ComponentPropsWithoutRef<"blockquote">) {
      return (
        <blockquote
          className="my-3 border-l-3 border-brand/50 bg-muted/30 py-2 pl-4 pr-3 text-sm text-muted-foreground italic rounded-r-lg"
          {...props}
        >
          {children}
        </blockquote>
      );
    },

    /**
     * 超链接：仅允许安全协议（https / mailto / 相对路径 / 锚点），
     * 过滤 LLM 幻觉注入的 javascript: / data: URI。
     * 外部链接新标签页打开 + 显示外链图标。
     */
    a({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
      const safeHref = href && /^(https?:|mailto:|\/|#)/i.test(href) ? href : undefined;
      const isExternal = safeHref?.startsWith("http");
      return (
        <a
          href={safeHref}
          target={isExternal ? "_blank" : undefined}
          rel={isExternal ? "noopener noreferrer" : undefined}
          className="inline-flex items-center gap-0.5 text-brand underline underline-offset-2 hover:text-brand/80 transition-colors"
          {...props}
        >
          {children}
          {isExternal && <ExternalLink className="inline size-3" />}
        </a>
      );
    },

    /** 水平分割线 */
    hr() {
      return <hr className="my-4 border-border" />;
    },

    /** 无序列表 */
    ul({ children, ...props }: ComponentPropsWithoutRef<"ul">) {
      return (
        <ul className="my-2 ml-4 list-disc space-y-1 text-sm marker:text-muted-foreground" {...props}>
          {children}
        </ul>
      );
    },

    /** 有序列表 */
    ol({ children, ...props }: ComponentPropsWithoutRef<"ol">) {
      return (
        <ol className="my-2 ml-4 list-decimal space-y-1 text-sm marker:text-muted-foreground" {...props}>
          {children}
        </ol>
      );
    },

    /** 段落：首段无上边距，末段无下边距 */
    p({ children, ...props }: ComponentPropsWithoutRef<"p">) {
      return (
        <p className="my-2 first:mt-0 last:mb-0 leading-relaxed" {...props}>
          {children}
        </p>
      );
    },

    /** 一级标题 */
    h1({ children, ...props }: ComponentPropsWithoutRef<"h1">) {
      return <h1 className="mt-4 mb-2 text-lg font-bold" {...props}>{children}</h1>;
    },

    /** 二级标题 */
    h2({ children, ...props }: ComponentPropsWithoutRef<"h2">) {
      return <h2 className="mt-3 mb-2 text-base font-semibold" {...props}>{children}</h2>;
    },

    /** 三级标题 */
    h3({ children, ...props }: ComponentPropsWithoutRef<"h3">) {
      return <h3 className="mt-3 mb-1.5 text-sm font-semibold" {...props}>{children}</h3>;
    },

    /** 图片：使用 ClickableImage 支持灯箱放大 */
    img({ src, alt }) {
      const imgSrc = typeof src === "string" ? src : undefined;
      return <ClickableImage src={imgSrc} alt={alt} />;
    },
  };
}
