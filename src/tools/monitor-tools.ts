import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import { killTree } from '../utils/kill-tree.js';

const MAX_MONITORS = 5;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER_LINES = 100;

interface MonitorEntry {
  id: string;
  command: string;
  description: string;
  child: ChildProcess;
  startedAt: number;
  lines: string[];
  timer: ReturnType<typeof setTimeout>;
}

const monitors = new Map<string, MonitorEntry>();
let nextId = 1;

function generateId(): string {
  return `mon_${nextId++}`;
}

const monitorStartSchema = z.object({
  command: z.string().describe('要执行的监控命令（stdout 逐行作为事件）'),
  description: z.string().optional().default('').describe('监控目标描述'),
  timeoutMs: z.number().optional().default(DEFAULT_TIMEOUT_MS).describe('监控超时毫秒数（默认 5 分钟）'),
});

const monitorStopSchema = z.object({
  monitorId: z.string().describe('监控 ID'),
});

const monitorStatusSchema = z.object({
  monitorId: z.string().optional().describe('监控 ID（不提供则列出所有）'),
});

export const monitorStartTool: ToolDefinition = {
  name: 'monitor_start',
  description: '启动后台命令并持续收集 stdout 输出。用于监控日志、等待服务启动、观察构建进度。最多同时 5 个。',
  inputSchema: monitorStartSchema,
  dangerLevel: 'moderate',
  async execute(input: unknown): Promise<ToolResult> {
    const { command, description, timeoutMs } = monitorStartSchema.parse(input);

    if (monitors.size >= MAX_MONITORS) {
      const ids = [...monitors.keys()].join(', ');
      return { content: `已达最大并发监控数 (${MAX_MONITORS})。活跃: ${ids}。请先停止一个。`, isError: true };
    }

    const id = generateId();
    const child = spawn(command, [], {
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines: string[] = [];
    let remainder = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      remainder += chunk.toString();
      const parts = remainder.split('\n');
      remainder = parts.pop() ?? '';
      for (const line of parts) {
        if (lines.length < MAX_BUFFER_LINES) {
          lines.push(line);
        } else {
          lines.shift();
          lines.push(line);
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && lines.length < MAX_BUFFER_LINES) {
        lines.push(`[stderr] ${text}`);
      }
    });

    const timer = setTimeout(() => {
      stopMonitor(id);
    }, timeoutMs);

    child.on('close', () => {
      if (remainder) lines.push(remainder);
      clearTimeout(timer);
      // Keep entry for status query but mark child as gone
    });

    const entry: MonitorEntry = { id, command, description, child, startedAt: Date.now(), lines, timer };
    monitors.set(id, entry);

    return {
      content: `监控已启动\n  ID: ${id}\n  命令: ${command}\n  超时: ${Math.round(timeoutMs / 1000)}s\n使用 monitor_stop 停止，或 monitor_status 查看输出。`,
    };
  },
};

export const monitorStopTool: ToolDefinition = {
  name: 'monitor_stop',
  description: '停止后台监控并返回已收集的输出。',
  inputSchema: monitorStopSchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { monitorId } = monitorStopSchema.parse(input);
    const entry = monitors.get(monitorId);
    if (!entry) {
      return { content: `未找到监控: ${monitorId}`, isError: true };
    }

    const output = stopMonitor(monitorId);
    return { content: `监控已停止: ${monitorId}\n\n最近输出:\n${output || '(无输出)'}` };
  },
};

export const monitorStatusTool: ToolDefinition = {
  name: 'monitor_status',
  description: '查看监控状态和最近输出。不提供 ID 则列出所有活跃监控。',
  inputSchema: monitorStatusSchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { monitorId } = monitorStatusSchema.parse(input);

    if (monitorId) {
      const entry = monitors.get(monitorId);
      if (!entry) return { content: `未找到监控: ${monitorId}`, isError: true };

      const elapsed = Math.round((Date.now() - entry.startedAt) / 1000);
      const tail = entry.lines.slice(-20).join('\n');
      return {
        content: `监控 ${monitorId} (${elapsed}s)\n命令: ${entry.command}\n行数: ${entry.lines.length}\n\n最近输出:\n${tail || '(暂无输出)'}`,
      };
    }

    // List all
    if (monitors.size === 0) {
      return { content: '无活跃监控' };
    }

    const list = [...monitors.values()].map(e => {
      const elapsed = Math.round((Date.now() - e.startedAt) / 1000);
      return `  ${e.id}: ${e.command} (${elapsed}s, ${e.lines.length} 行)`;
    }).join('\n');

    return { content: `活跃监控 (${monitors.size}/${MAX_MONITORS}):\n${list}` };
  },
};

function stopMonitor(id: string): string {
  const entry = monitors.get(id);
  if (!entry) return '';

  clearTimeout(entry.timer);
  if (entry.child.pid && !entry.child.killed) {
    killTree(entry.child.pid).catch(() => {});
  }

  const output = entry.lines.slice(-50).join('\n');
  monitors.delete(id);
  return output;
}
