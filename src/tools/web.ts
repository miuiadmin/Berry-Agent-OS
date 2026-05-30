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
