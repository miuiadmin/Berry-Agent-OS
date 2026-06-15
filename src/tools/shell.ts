import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import { checkBlocklist } from '../safety/index.js';
import { killTree } from '../utils/kill-tree.js';

const MAX_OUTPUT = 10000;
const CWD_MARKER = '__AGENT_CWD_MARKER__';

let lastCwd: string = homedir();

export function getLastCwd(): string {
  return lastCwd;
}

export function resetLastCwd(): void {
  lastCwd = homedir();
}

const backgroundProcesses = new Map<number, { command: string; startedAt: number }>();

const runCommandSchema = z.object({
  command: z.string().describe('要执行的 shell 命令'),
  timeoutMs: z.number().optional().default(120000).describe('超时毫秒数，默认 120000'),
  cwd: z.string().optional().describe('工作目录（默认为上次命令的目录）'),
  runInBackground: z.boolean().default(false).describe('后台运行，立即返回 pid'),
});

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description: '在 shell 中执行命令并返回输出。支持持久工作目录和后台执行。',
  inputSchema: runCommandSchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { command, timeoutMs, cwd, runInBackground } = runCommandSchema.parse(input);

    const blockResult = checkBlocklist(command);
    if (blockResult.blocked) {
      return { content: `命令被安全策略阻止: ${blockResult.reason}`, isError: true };
    }

    const effectiveCwd = cwd || lastCwd;

    // Background execution: spawn and return immediately
    if (runInBackground) {
      const child = spawn(command, [], {
        shell: true,
        cwd: effectiveCwd,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      if (child.pid) {
        backgroundProcesses.set(child.pid, { command, startedAt: Date.now() });
      }
      return { content: `后台任务已启动 (pid: ${child.pid ?? 'unknown'}, cwd: ${effectiveCwd})` };
    }

    // Foreground execution with cwd tracking
    const wrappedCommand = `${command} ; echo '${CWD_MARKER}' ; pwd`;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const child = spawn(wrappedCommand, [], {
        shell: true,
        cwd: effectiveCwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        killed = true;
        if (child.pid) {
          killTree(child.pid).catch(() => {});
        } else {
          child.kill('SIGKILL');
        }
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT * 2) stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const truncate = (s: string) => s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n...(输出被截断)' : s;

        if (killed) {
          const partial = truncate(stdout || stderr || '');
          resolve({ content: `命令超时 (${timeoutMs}ms) 已终止${partial ? '\n' + partial : ''}`, isError: true });
          return;
        }

        // Extract cwd from stdout tail
        let userOutput = stdout;
        const markerIdx = stdout.lastIndexOf(CWD_MARKER);
        if (markerIdx !== -1) {
          userOutput = stdout.slice(0, markerIdx);
          const afterMarker = stdout.slice(markerIdx + CWD_MARKER.length).trim();
          if (afterMarker) {
            lastCwd = afterMarker;
          }
        }

        let output = '';
        if (userOutput.trim()) output += truncate(userOutput.trimEnd());
        if (stderr) output += (output ? '\n--- stderr ---\n' : '') + truncate(stderr);
        if (!output) output = '(无输出)';

        resolve({ content: output, isError: code !== 0 });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ content: `命令执行失败: ${err.message}`, isError: true });
      });
    });
  },
};
