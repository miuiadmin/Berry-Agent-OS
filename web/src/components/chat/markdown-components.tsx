/**
 * Markdown 自定义渲染组件映射。
 *
 * 为 react-markdown 提供自定义的 HTML 渲染规则，
 * 包括代码块（Shiki 高亮）、表格、引用、链接、列表、标题、图片等。
 */

import { type ComponentPropsWithoutRef, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { ExternalLink } from "lucide-react";
import { CodeBlock } from "./code-block";
import { ClickableImage } from "@/components/ui/image-lightbox";
import { INLINE_CODE, SAFE_HREF } from "@/components/ui/_shared";

/** 从 className 中提取 language-xxx 前缀的语言标识 */
const LANG_RE = /language-(\w+)/;

/**
 * 把 react-markdown 传入的 code children 拼成纯文本（用于多行判据）。
 * 兼容 string / number / array / 嵌套 array / element 形态。
 * 与 code-block.tsx 的 nodeToText 同语义，但此处只需判换行，独立实现避免跨文件耦合。
 */
function childrenToText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childrenToText).join("");
  if (typeof node === "object" && "props" in node) {
    return childrenToText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

/**
 * 创建 react-markdown 的 Components 映射。
 *
 * @param isStreaming 是否在流式输出中（true 时跳过代码高亮，减少闪烁）
 */
export function createMarkdownComponents(isStreaming?: boolean): Components {
  return {
    /**
     * 代码组件：区分行内 `code` 与块级代码（fenced ```）。
     *
     * react-markdown v9 不再向 code 组件传 `inline` prop（v9 起行内/块级区分由 mdast
     * 节点结构决定，hast 中块级 code 的父节点是 <pre>，行内 code 的父节点是 <p> 等）。
     * 因此用「内容含换行 或 className 含 language- 前缀」作为块级判据：
     *   - fenced 代码块（```lang\n…\n```）渲染为 <code class="language-lang"> 且多行 → 块级
     *   - 行内 `code` 渲染为 <code>（无 className、单行）→ 行内
     *
     * 之前曾尝试读 (rest as { inline?: boolean }).inline，但 v9 不再提供该 prop，
     * 永远是 undefined → 该分支为死代码，已删除。块级判据改为内容/className。
     */
    code({ className, children, ...rest }) {
      const cls = className || "";
      const match = LANG_RE.exec(cls);
      // 拼出纯文本用于多行判据（react-markdown 的 children 可能是 string/array/element）
      const text = childrenToText(children);
      // 块级 = 有 language- 前缀 或 内容含换行；否则行内
      const isBlock = !!match || /language-/.test(cls) || text.includes("\n");
      // 行内 code：纯 inline 样式，不渲染 CodeBlock 标题栏
      if (!isBlock) {
        return (
          <code className={INLINE_CODE}>
            {children}
          </code>
        );
      }
      // 透传可能存在的 node prop 给 CodeBlock（保留 react-markdown 内部信息，未来可用）
      void rest;
      return (
        <CodeBlock lang={match ? match[1] : null} isStreaming={isStreaming}>
          {children}
        </CodeBlock>
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
     * 超链接：仅允许安全协议，过滤 javascript:/data: 等危险 URI。
     * 外部链接新标签页打开 + 显示外链图标。
     * 不安全 href（被过滤为 undefined）→ 渲染为纯文本 span（非可点击链接），避免出现无 href 却保留链接样式的假链接。
     */
    a({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
      const safeHref = href && SAFE_HREF.test(href) ? href : undefined;
      // 不安全 href：渲染为纯文本，不保留链接样式（之前 href=undefined 仍渲染 <a> 保留蓝色下划线假链接）
      if (!safeHref) {
        return <span>{children}</span>;
      }
      const isExternal = safeHref.startsWith("http");
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

    /**
     * 图片：使用 ClickableImage 支持灯箱放大。
     * src 可能是 string 或 object（某些 react-markdown 插件传 {url,...}），统一规整为 string。
     * 校验协议白名单（与 a 标签 SAFE_HREF 一致），防止 markdown 注入 javascript:/data: 恶意图。
     * 不安全 src → 不渲染（返回 null），避免 ClickableImage 收到 undefined src 行为未定义。
     */
    img({ src, alt }) {
      // src 规整：object 形态（react-markdown 插件）取 .url，否则 string 直用
      const rawSrc = typeof src === "string"
        ? src
        : (src && typeof src === "object" && "url" in src && typeof (src as { url: unknown }).url === "string")
          ? (src as { url: string }).url
          : undefined;
      // 协议白名单校验（图片通常 http(s)，相对路径也允许）
      const imgSrc = rawSrc && SAFE_HREF.test(rawSrc) ? rawSrc : undefined;
      if (!imgSrc) return null;
      return <ClickableImage src={imgSrc} alt={alt} />;
    },
  };
}
