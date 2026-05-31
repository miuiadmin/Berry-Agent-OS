import { createHighlighter, type Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;
const cache = new Map<string, string>();

const PRELOADED_LANGS = [
  "typescript",
  "javascript",
  "python",
  "bash",
  "json",
  "yaml",
  "go",
  "rust",
  "sql",
  "html",
  "css",
  "markdown",
] as const;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark", "github-light"],
      langs: [...PRELOADED_LANGS],
    });
  }
  return highlighterPromise;
}

export async function highlight(
  code: string,
  lang: string,
  theme: "dark" | "light" = "dark",
): Promise<string> {
  const key = `${theme}:${lang}:${code}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const h = await getHighlighter();
    const themeName = theme === "dark" ? "github-dark" : "github-light";

    const supported = h.getLoadedLanguages();
    const effectiveLang = supported.includes(lang as never) ? lang : "text";

    const html = h.codeToHtml(code, { lang: effectiveLang, theme: themeName });
    cache.set(key, html);
    return html;
  } catch {
    return "";
  }
}
