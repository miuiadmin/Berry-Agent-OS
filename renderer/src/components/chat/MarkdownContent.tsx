import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  content: string;
}

export function MarkdownContent({ content }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => (
          <pre className="my-2 overflow-x-auto rounded-md bg-[hsl(var(--muted))] p-3 text-xs">
            {children}
          </pre>
        ),
        code: ({ children, className }) => {
          const isBlock = className?.startsWith('language-');
          if (isBlock) {
            return <code className="text-xs">{children}</code>;
          }
          return (
            <code className="rounded bg-[hsl(var(--muted))] px-1 py-0.5 text-xs font-mono">
              {children}
            </code>
          );
        },
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
            {children}
          </a>
        ),
        ul: ({ children }) => <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="text-sm">{children}</li>,
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        h1: ({ children }) => <h1 className="text-lg font-bold mb-1">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-bold mb-1">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-bold mb-1">{children}</h3>,
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border px-2 py-1 bg-muted font-medium text-left">{children}</th>,
        td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground">
            {children}
          </blockquote>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
