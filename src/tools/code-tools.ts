import { readFile, writeFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import { markFileRead, hasFileBeenRead } from './read-tracker.js';

const MAX_OUTPUT = 20000;

const InspectCodeSchema = z.object({
  path: z.string().describe('文件路径'),
  startLine: z.number().optional().describe('起始行号（1-based）'),
  endLine: z.number().optional().describe('结束行号（1-based）'),
  grep: z.string().optional().describe('搜索模式（正则表达式）'),
});

const EditCodeSchema = z.object({
  path: z.string().describe('文件路径'),
  oldText: z.string().describe('要替换的原始文本（精确匹配）'),
  newText: z.string().describe('替换后的文本'),
  replaceAll: z.boolean().default(false).describe('true=替换所有匹配；false=要求唯一匹配（默认）'),
});

const RunTestsSchema = z.object({
  command: z.string().describe('测试/构建命令'),
  cwd: z.string().optional().describe('工作目录'),
  timeoutMs: z.number().optional().default(60000).describe('超时毫秒数'),
});

const SummarizeChangesSchema = z.object({
  cwd: z.string().optional().describe('仓库路径'),
});

const inspectCodeTool: ToolDefinition = {
  name: 'inspect_code',
  description: '读取文件内容，支持行范围和正则搜索',
  inputSchema: InspectCodeSchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { path, startLine, endLine, grep } = InspectCodeSchema.parse(input);
    try {
      const filePath = resolve(path);
      const content = await readFile(filePath, 'utf-8');
      markFileRead(filePath);
      const lines = content.split('\n');

      if (grep) {
        const regex = new RegExp(grep, 'gi');
        const matches = lines
          .map((line, i) => ({ line, num: i + 1 }))
          .filter(({ line }) => regex.test(line));
        if (matches.length === 0) return { content: `未找到匹配: ${grep}` };
        const result = matches.slice(0, 50).map(m => `${m.num}: ${m.line}`).join('\n');
        return { content: `${matches.length} 处匹配:\n${result}` };
      }

      const start = (startLine ?? 1) - 1;
      const end = endLine ?? lines.length;
      const slice = lines.slice(start, end);
      const numbered = slice.map((line, i) => `${start + i + 1}: ${line}`).join('\n');
      return { content: numbered };
    } catch (err) {
      return { content: `读取失败: ${(err as Error).message}`, isError: true };
    }
  },
};

const editCodeTool: ToolDefinition = {
  name: 'edit_code',
  description: '对文件做精确字符串替换。默认要求 oldText 在文件中唯一匹配；设置 replaceAll=true 替换所有匹配。',
  inputSchema: EditCodeSchema,
  dangerLevel: 'moderate',
  async execute(input: unknown): Promise<ToolResult> {
    const { path, oldText, newText, replaceAll } = EditCodeSchema.parse(input);
    try {
      const filePath = resolve(path);

      if (!hasFileBeenRead(filePath)) {
        return { content: `编辑被拒绝: 请先使用 read_file 或 inspect_code 读取该文件。`, isError: true };
      }

      const content = await readFile(filePath, 'utf-8');
      if (!content.includes(oldText)) {
        return { content: `未找到匹配文本，文件未修改。`, isError: true };
      }

      if (!replaceAll) {
        let count = 0;
        let idx = -1;
        while ((idx = content.indexOf(oldText, idx + 1)) !== -1) count++;
        if (count > 1) {
          return { content: `找到 ${count} 处匹配，请提供更多上下文使 oldText 唯一，或设置 replaceAll=true。`, isError: true };
        }
      }

      const updated = replaceAll
        ? content.replaceAll(oldText, newText)
        : content.replace(oldText, newText);
      await writeFile(filePath, updated, 'utf-8');
      return { content: `已修改文件: ${path}` };
    } catch (err) {
      return { content: `编辑失败: ${(err as Error).message}`, isError: true };
    }
  },
};

const runTestsTool: ToolDefinition = {
  name: 'run_tests',
  description: '运行测试或构建命令',
  inputSchema: RunTestsSchema,
  dangerLevel: 'dangerous',
  async execute(input: unknown): Promise<ToolResult> {
    const { command, cwd, timeoutMs } = RunTestsSchema.parse(input);
    return new Promise((resolve) => {
      exec(command, { timeout: timeoutMs, cwd, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
        const truncate = (s: string) => s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n...(截断)' : s;
        let output = '';
        if (stdout) output += truncate(stdout);
        if (stderr) output += (output ? '\n--- stderr ---\n' : '') + truncate(stderr);
        if (!output) output = '(无输出)';
        if (err) output += `\n退出码: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`;
        resolve({ content: output, isError: !!err });
      });
    });
  },
};

const summarizeChangesTool: ToolDefinition = {
  name: 'summarize_changes',
  description: '查看当前 git 变更（git diff + git status）',
  inputSchema: SummarizeChangesSchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { cwd } = SummarizeChangesSchema.parse(input);
    return new Promise((resolve) => {
      exec('git status --short && echo "---" && git diff --stat', { cwd, timeout: 10000 }, (err, stdout, stderr) => {
        if (err && !stdout) {
          resolve({ content: `git 命令失败: ${stderr || err.message}`, isError: true });
          return;
        }
        resolve({ content: stdout || '无变更' });
      });
    });
  },
};

export function registerCodeTools(): ToolDefinition[] {
  return [inspectCodeTool, editCodeTool, runTestsTool, summarizeChangesTool];
}
