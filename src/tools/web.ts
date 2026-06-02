import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';

const MAX_BODY = 20000;
const TIMEOUT_MS = 15000;

const httpFetchSchema = z.object({
  url: z.string().url().describe('请求的 URL'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional().default('GET').describe('HTTP 方法'),
  headers: z.record(z.string(), z.string()).optional().describe('请求头'),
  body: z.string().optional().describe('请求体'),
});

export const httpFetchTool: ToolDefinition = {
  name: 'http_fetch',
  description: '发送 HTTP 请求并返回响应',
  inputSchema: httpFetchSchema,
  dangerLevel: 'moderate',
  async execute(input: unknown): Promise<ToolResult> {
    const { url, method, headers, body } = httpFetchSchema.parse(input);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        method,
        headers,
        body: body ?? undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const text = await response.text();
      const truncated = text.length > MAX_BODY
        ? text.slice(0, MAX_BODY) + '\n...(响应被截断)'
        : text;

      const statusLine = `HTTP ${response.status} ${response.statusText}`;
      return { content: `${statusLine}\n\n${truncated}`, isError: !response.ok };
    } catch (err) {
      const msg = (err as Error).name === 'AbortError'
        ? `请求超时 (${TIMEOUT_MS}ms)`
        : `请求失败: ${(err as Error).message}`;
      return { content: msg, isError: true };
    }
  },
};

// ─── Web Search ──────────────────────────────────────────────────────────────

const webSearchSchema = z.object({
  query: z.string().describe('搜索关键词'),
  maxResults: z.number().min(1).max(20).optional().default(5).describe('返回结果数'),
});

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网。返回标题、URL 和摘要。支持多个搜索后端（Tavily / SearXNG / DuckDuckGo）。',
  inputSchema: webSearchSchema,
  dangerLevel: 'moderate',
  async execute(input: unknown): Promise<ToolResult> {
    const { query, maxResults } = webSearchSchema.parse(input);

    // Try backends in priority order
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (tavilyKey) {
      return await searchTavily(query, maxResults, tavilyKey);
    }

    const searxngUrl = process.env.SEARXNG_URL;
    if (searxngUrl) {
      return await searchSearXNG(query, maxResults, searxngUrl);
    }

    // DuckDuckGo HTML fallback (no key required)
    return await searchDuckDuckGo(query, maxResults);
  },
};

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return '未找到搜索结果';
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
}

async function searchTavily(query: string, maxResults: number, apiKey: string): Promise<ToolResult> {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: 'basic',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      return { content: `Tavily 搜索失败: HTTP ${response.status}`, isError: true };
    }

    const data = await response.json() as { results?: Array<{ title: string; url: string; content: string }> };
    const results: SearchResult[] = (data.results ?? []).slice(0, maxResults).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content?.slice(0, 200) ?? '',
    }));

    return { content: formatResults(results) };
  } catch (err) {
    return { content: `Tavily 搜索失败: ${(err as Error).message}`, isError: true };
  }
}

async function searchSearXNG(query: string, maxResults: number, baseUrl: string): Promise<ToolResult> {
  try {
    const url = new URL('/search', baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('pageno', '1');

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      return { content: `SearXNG 搜索失败: HTTP ${response.status}`, isError: true };
    }

    const data = await response.json() as { results?: Array<{ title: string; url: string; content: string }> };
    const results: SearchResult[] = (data.results ?? []).slice(0, maxResults).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content?.slice(0, 200) ?? '',
    }));

    return { content: formatResults(results) };
  } catch (err) {
    return { content: `SearXNG 搜索失败: ${(err as Error).message}`, isError: true };
  }
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<ToolResult> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BerryAgent/1.0)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      return { content: `DuckDuckGo 搜索失败: HTTP ${response.status}`, isError: true };
    }

    const html = await response.text();
    const results = parseDuckDuckGoHtml(html, maxResults);

    if (results.length === 0) {
      return { content: '搜索无结果（DuckDuckGo HTML 解析可能受限，建议配置 TAVILY_API_KEY 或 SEARXNG_URL）' };
    }

    return { content: formatResults(results) };
  } catch (err) {
    return { content: `DuckDuckGo 搜索失败: ${(err as Error).message}`, isError: true };
  }
}

function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Parse result blocks: <a class="result__a" href="...">title</a> and <a class="result__snippet">...</a>
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi;

  const links = [...html.matchAll(linkRegex)];
  const snippets = [...html.matchAll(snippetRegex)];

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    const link = links[i];
    const snippet = snippets[i];
    results.push({
      title: stripHtml(link[2]),
      url: decodeURIComponent(link[1].replace(/.*uddg=/, '').replace(/&.*/, '') || link[1]),
      snippet: snippet ? stripHtml(snippet[1]).slice(0, 200) : '',
    });
  }

  return results;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
}

// ─── Web Fetch (HTML → Readable Text) ───────────────────────────────────────

const MAX_FETCH_BODY = 8000;

const webFetchSchema = z.object({
  url: z.string().url().describe('要抓取的 URL'),
  selector: z.string().optional().describe('CSS 选择器提取区域（如 "article"、"main"）— 简单匹配'),
});

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: '抓取网页并转为可读文本（自动去除 HTML 标签、脚本、样式）。适合阅读文章、文档页面。',
  inputSchema: webFetchSchema,
  dangerLevel: 'moderate',
  async execute(input: unknown): Promise<ToolResult> {
    const { url, selector } = webFetchSchema.parse(input);

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; BerryAgent/1.0)',
          'Accept': 'text/html,application/xhtml+xml,*/*',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        return { content: `抓取失败: HTTP ${response.status} ${response.statusText}`, isError: true };
      }

      const contentType = response.headers.get('content-type') ?? '';
      const html = await response.text();

      // Non-HTML: return raw text
      if (!contentType.includes('html')) {
        const truncated = html.length > MAX_FETCH_BODY
          ? html.slice(0, MAX_FETCH_BODY) + '\n...(截断)'
          : html;
        return { content: truncated };
      }

      // Extract section if selector given (simple tag match)
      let body = html;
      if (selector) {
        const tagMatch = body.match(new RegExp(`<${selector}[^>]*>([\\s\\S]*?)<\\/${selector}>`, 'i'));
        if (tagMatch) body = tagMatch[1];
      } else {
        // Try to extract <main> or <article> or <body>
        const mainMatch = body.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
          || body.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
          || body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        if (mainMatch) body = mainMatch[1];
      }

      const readable = htmlToReadable(body);
      const truncated = readable.length > MAX_FETCH_BODY
        ? readable.slice(0, MAX_FETCH_BODY) + '\n\n...(内容截断，共 ' + readable.length + ' 字符)'
        : readable;

      return { content: `来源: ${url}\n\n${truncated}` };
    } catch (err) {
      const msg = (err as Error).name === 'TimeoutError'
        ? `请求超时 (${TIMEOUT_MS}ms)`
        : `抓取失败: ${(err as Error).message}`;
      return { content: msg, isError: true };
    }
  },
};

function htmlToReadable(html: string): string {
  let text = html;
  // Remove scripts and styles
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  // Convert headings
  text = text.replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi, (_, level, content) => {
    const prefix = '#'.repeat(Number(level));
    return `\n${prefix} ${stripHtml(content).trim()}\n`;
  });
  // Convert links
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_, href, content) => {
    const linkText = stripHtml(content).trim();
    return href.startsWith('http') ? `[${linkText}](${href})` : linkText;
  });
  // Convert list items
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, (_, content) => `• ${stripHtml(content).trim()}\n`);
  // Convert paragraphs and divs to line breaks
  text = text.replace(/<\/(p|div|tr|section)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Strip remaining tags
  text = stripHtml(text);
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

