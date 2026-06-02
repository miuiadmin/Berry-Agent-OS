import { glob } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, relative } from 'node:path';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';

const EXCLUDED_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__'];
const MAX_GLOB_RESULTS = 100;
const MAX_GREP_RESULTS = 50;
const MAX_GREP_OUTPUT = 15000;

const searchFilesSchema = z.object({
  pattern: z.string().describe('glob 模式（如 "**/*.ts"、"src/**/*.test.*"、"{a,b}/*.js"）'),
  cwd: z.string().optional().describe('搜索根目录（默认用户主目录）'),
  maxResults: z.number().optional().default(MAX_GLOB_RESULTS).describe('最多返回条数'),
});

const grepFilesSchema = z.object({
  pattern: z.string().describe('正则表达式搜索模式'),
  path: z.string().optional().describe('搜索目录（默认用户主目录）'),
  include: z.string().optional().describe('文件名 glob 过滤（如 "*.ts"）'),
  maxResults: z.number().optional().default(MAX_GREP_RESULTS).describe('最多返回条数'),
  context: z.number().optional().describe('上下文行数（前后各 N 行）'),
});

export const searchFilesTool: ToolDefinition = {
  name: 'search_files',
  description: '按名称模式递归搜索文件。支持 glob 语法（**、*、{a,b}）。自动排除 node_modules/.git/dist 等目录。',
  inputSchema: searchFilesSchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { pattern, cwd, maxResults } = searchFilesSchema.parse(input);
    try {
      const root = cwd ? resolve(cwd) : homedir();
      const exclude = EXCLUDED_DIRS.map(d => `**/${d}/**`);
      const results: string[] = [];

      for await (const entry of glob(pattern, { cwd: root, exclude })) {
        results.push(entry as string);
        if (results.length >= maxResults + 1) break;
      }

      if (results.length === 0) {
        return { content: `未找到匹配文件: ${pattern}` };
      }

      const truncated = results.length > maxResults;
      const shown = results.slice(0, maxResults);
      let output = shown.join('\n');
      if (truncated) {
        output += `\n\n... (超过 ${maxResults} 个结果，请缩小搜索范围)`;
      }
      return { content: output };
    } catch (err) {
      return { content: `文件搜索失败: ${(err as Error).message}`, isError: true };
    }
  },
};

export const grepFilesTool: ToolDefinition = {
  name: 'grep_files',
  description: '跨文件搜索内容（正则）。返回文件路径+行号+匹配行。优先使用 ripgrep，回退到 Node.js 实现。',
  inputSchema: grepFilesSchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { pattern, path, include, maxResults, context } = grepFilesSchema.parse(input);
    const searchPath = path ? resolve(path) : homedir();

    try {
      new RegExp(pattern);
    } catch {
      return { content: `无效正则表达式: ${pattern}`, isError: true };
    }

    try {
      const result = await grepWithRipgrep(pattern, searchPath, include, maxResults, context);
      return result;
    } catch {
      return await grepFallback(pattern, searchPath, include, maxResults);
    }
  },
};

function grepWithRipgrep(
  pattern: string,
  searchPath: string,
  include: string | undefined,
  maxResults: number,
  context: number | undefined,
): Promise<ToolResult> {
  return new Promise((resolvePromise, reject) => {
    const args = [
      '--line-number',
      '--no-heading',
      '--color', 'never',
      '--max-count', String(maxResults * 2),
    ];

    if (context) {
      args.push('-C', String(context));
    }

    for (const dir of EXCLUDED_DIRS) {
      args.push('--glob', `!${dir}`);
    }

    if (include) {
      args.push('--glob', include);
    }

    args.push(pattern, searchPath);

    let stdout = '';
    let stderr = '';
    const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_GREP_OUTPUT) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString().slice(0, 500);
    });

    child.on('error', () => reject(new Error('ripgrep not available')));
    child.on('close', (code) => {
      if (code === 2) {
        reject(new Error(stderr || 'ripgrep error'));
        return;
      }

      if (!stdout.trim()) {
        resolvePromise({ content: `未找到匹配: ${pattern}` });
        return;
      }

      const lines = stdout.trim().split('\n');
      const truncated = lines.length > maxResults;
      const shown = lines.slice(0, maxResults);

      const relativeOutput = shown.map(line => {
        if (line.startsWith(searchPath)) {
          return line.slice(searchPath.length + 1);
        }
        return line;
      }).join('\n');

      let output = `${Math.min(lines.length, maxResults)} 条结果:\n${relativeOutput}`;
      if (truncated) {
        output += `\n\n... (超过 ${maxResults} 条，请缩小搜索范围)`;
      }
      resolvePromise({ content: output });
    });
  });
}

async function grepFallback(
  pattern: string,
  searchPath: string,
  include: string | undefined,
  maxResults: number,
): Promise<ToolResult> {
  const { readFile } = await import('node:fs/promises');
  const { readdir } = await import('node:fs/promises');

  const regex = new RegExp(pattern, 'gi');
  const results: string[] = [];
  const includeRegex = include ? new RegExp(include.replace(/\*/g, '.*').replace(/\?/g, '.')) : null;

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (EXCLUDED_DIRS.includes(entry.name)) continue;

      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (includeRegex && !includeRegex.test(entry.name)) continue;
        try {
          const content = await readFile(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            if (regex.test(lines[i])) {
              const rel = relative(searchPath, fullPath);
              results.push(`${rel}:${i + 1}: ${lines[i]}`);
            }
            regex.lastIndex = 0;
          }
        } catch {
          // skip binary/unreadable files
        }
      }
    }
  }

  await walk(searchPath);

  if (results.length === 0) {
    return { content: `未找到匹配: ${pattern}` };
  }

  return { content: `${results.length} 条结果:\n${results.join('\n')}` };
}
