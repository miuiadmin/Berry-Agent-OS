import { exec } from 'node:child_process';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import { checkBlocklist } from '../safety/index.js';

const MAX_OUTPUT = 10000;

const runCommandSchema = z.object({
  command: z.string().describe('要执行的 shell 命令'),
  timeoutMs: z.number().optional().default(30000).describe('超时毫秒数，默认 30000'),
  cwd: z.string().optional().describe('工作目录'),
});

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description: '在 shell 中执行命令并返回输出',
  inputSchema: runCommandSchema,
  dangerLevel: 'dangerous',
  async execute(input: unknown): Promise<ToolResult> {
    const { command, timeoutMs, cwd } = runCommandSchema.parse(input);

    const blockResult = checkBlocklist(command);
    if (blockResult.blocked) {
      return { content: `命令被安全策略阻止: ${blockResult.reason}`, isError: true };
    }

    return new Promise((resolve) => {
      exec(command, { timeout: timeoutMs, cwd, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const truncate = (s: string) => s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n...(输出被截断)' : s;

        if (err && !stdout && !stderr) {
          resolve({ content: `命令执行失败: ${err.message}`, isError: true });
          return;
        }

        let output = '';
        if (stdout) output += truncate(stdout);
        if (stderr) output += (output ? '\n--- stderr ---\n' : '') + truncate(stderr);
        if (!output) output = '(无输出)';

        resolve({ content: output, isError: !!err });
      });
    });
  },
};
