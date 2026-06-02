import { readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import { markFileRead } from './read-tracker.js';

function getUserRoot(): string {
  return homedir();
}

function resolvePath(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return resolve(getUserRoot(), p.slice(2) || '.');
  }
  if (p.startsWith('/')) return resolve(p);
  return resolve(getUserRoot(), p);
}

function assertWithinBoundary(resolved: string): void {
  const root = getUserRoot();
  if (!resolved.startsWith(root + '/') && resolved !== root) {
    throw new Error(`路径越界: 不允许访问用户目录之外的路径`);
  }
}

const DEFAULT_LINE_LIMIT = 2000;

const readFileSchema = z.object({
  path: z.string().describe('文件的绝对或相对路径'),
  startLine: z.number().optional().describe('起始行号（1-based）'),
  endLine: z.number().optional().describe('结束行号（1-based，包含）'),
  limit: z.number().optional().describe('最多返回行数（默认 2000）'),
});

const writeFileSchema = z.object({
  path: z.string().describe('文件的绝对或相对路径'),
  content: z.string().describe('要写入的内容'),
});

const listDirSchema = z.object({
  path: z.string().default('~').describe('目录路径，默认用户主目录'),
});

const deleteFileSchema = z.object({
  path: z.string().describe('要删除的文件路径'),
});

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: '读取文件内容，返回带行号的文本。支持行范围分页。大文件（>2000行）未指定范围时只返回前 2000 行。',
  inputSchema: readFileSchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { path, startLine, endLine, limit } = readFileSchema.parse(input);
    try {
      const resolved = resolvePath(path);
      assertWithinBoundary(resolved);
      const content = await readFile(resolved, 'utf-8');
      markFileRead(resolved);

      const lines = content.split('\n');
      const totalLines = lines.length;

      const start = (startLine ?? 1) - 1;
      const maxLines = limit ?? DEFAULT_LINE_LIMIT;
      const end = endLine ? Math.min(endLine, totalLines) : Math.min(start + maxLines, totalLines);

      const slice = lines.slice(start, end);
      const numbered = slice.map((line, i) => `${start + i + 1}\t${line}`).join('\n');

      if (!startLine && !endLine && !limit && totalLines > DEFAULT_LINE_LIMIT) {
        return { content: `${numbered}\n\n... (共 ${totalLines} 行，已显示前 ${DEFAULT_LINE_LIMIT} 行。使用 startLine/endLine 查看更多)` };
      }

      if (endLine && endLine < totalLines) {
        return { content: `${numbered}\n\n(共 ${totalLines} 行，当前显示 ${start + 1}-${end} 行)` };
      }

      return { content: numbered };
    } catch (err) {
      return { content: `读取文件失败: ${(err as Error).message}`, isError: true };
    }
  },
};

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: '将内容写入指定文件（覆盖已有内容）',
  inputSchema: writeFileSchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { path: filePath, content } = writeFileSchema.parse(input);
    try {
      const resolved = resolvePath(filePath);
      assertWithinBoundary(resolved);
      await writeFile(resolved, content, 'utf-8');
      return { content: `已写入文件: ${filePath}` };
    } catch (err) {
      return { content: `写入文件失败: ${(err as Error).message}`, isError: true };
    }
  },
};

export const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description: '列出目录中的文件和子目录',
  inputSchema: listDirSchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { path: dirPath } = listDirSchema.parse(input);
    try {
      const resolved = resolvePath(dirPath);
      assertWithinBoundary(resolved);
      const entries = await readdir(resolved, { withFileTypes: true });
      const lines = entries.map((e) => {
        const type = e.isDirectory() ? '[目录]' : '[文件]';
        return `${type} ${e.name}`;
      });
      return { content: lines.join('\n') || '(空目录)' };
    } catch (err) {
      return { content: `列出目录失败: ${(err as Error).message}`, isError: true };
    }
  },
};

export const deleteFileTool: ToolDefinition = {
  name: 'delete_file',
  description: '删除指定文件',
  inputSchema: deleteFileSchema,
  dangerLevel: 'dangerous',
  async execute(input: unknown): Promise<ToolResult> {
    const { path: filePath } = deleteFileSchema.parse(input);
    try {
      const resolved = resolvePath(filePath);
      assertWithinBoundary(resolved);
      const info = await stat(resolved);
      if (info.isDirectory()) {
        return { content: '不能使用此工具删除目录', isError: true };
      }
      await unlink(resolved);
      return { content: `已删除文件: ${filePath}` };
    } catch (err) {
      return { content: `删除文件失败: ${(err as Error).message}`, isError: true };
    }
  },
};
