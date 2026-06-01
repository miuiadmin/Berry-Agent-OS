import { readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';

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

const readFileSchema = z.object({
  path: z.string().describe('文件的绝对或相对路径'),
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
  description: '读取文件内容并返回文本',
  inputSchema: readFileSchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { path } = readFileSchema.parse(input);
    try {
      const resolved = resolvePath(path);
      assertWithinBoundary(resolved);
      const content = await readFile(resolved, 'utf-8');
      return { content };
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
