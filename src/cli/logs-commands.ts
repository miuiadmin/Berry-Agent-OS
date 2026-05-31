import { existsSync, readFileSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { getLogDir, getAppHome } from '../utils/paths.js';
import { getSocketPath } from '../utils/paths.js';
import { socketRequest } from './service-commands.js';
import { getConsoleRenderer } from '../observability/console.js';
import { MS_PER_SECOND, MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } from '../lib/time-constants.js';

export function registerLogsCommands(program: Command): void {
  const logs = program.command('logs').description('查看和管理日志');

  logs
    .command('show', { isDefault: true })
    .description('查看日志')
    .option('--level <level>', '按级别过滤 (error/warn/info/debug)')
    .option('--module <module>', '按模块过滤')
    .option('--run <runId>', '查看某次运行的日志')
    .option('--since <duration>', '最近多长时间 (如 10m, 1h)')
    .option('--follow', '实时跟踪日志')
    .option('--json', '以 JSON 格式输出')
    .option('-n, --lines <count>', '显示最近 N 行', '50')
    .action(async (opts) => {
      const renderer = getConsoleRenderer();

      if (opts.run) {
        await showRunLogs(opts.run, opts);
        return;
      }

      const logFile = join(getLogDir(), 'berry.log');
      if (!existsSync(logFile)) {
        if (opts.json) {
          renderer.json({ events: [] });
        } else {
          renderer.info('暂无日志');
        }
        return;
      }

      if (opts.follow) {
        await tailFollow(logFile, opts);
        return;
      }

      const lines = readLastLines(logFile, parseInt(opts.lines, 10));
      const filtered = filterLogLines(lines, opts);

      if (opts.json) {
        renderer.json({ events: filtered });
      } else {
        for (const line of filtered) {
          printLogLine(line);
        }
      }
    });

  logs
    .command('console <runId>')
    .description('查看某次运行捕获的控制台输出')
    .option('--stream <stream>', '输出流: stdout, stderr, all', 'all')
    .option('--json', '以 JSON 格式输出')
    .option('-n, --lines <count>', '显示最近 N 行', '200')
    .action((runId, opts) => {
      showRunConsole(runId, opts);
    });

  logs
    .command('level [newLevel]')
    .description('查看或设置日志等级')
    .option('--persist', '写入 config.yaml，重启后仍生效')
    .option('--ttl <duration>', '临时设置，到期恢复 (如 10m)')
    .option('--json', '以 JSON 格式输出')
    .action(async (newLevel, opts) => {
      const renderer = getConsoleRenderer();
      const socketPath = getSocketPath();

      if (!newLevel) {
        if (!existsSync(socketPath)) {
          const configLevel = process.env.APP_LOG_LEVEL ?? 'info';
          if (opts.json) {
            renderer.json({ level: configLevel, source: 'config' });
          } else {
            renderer.info(`当前日志等级: ${configLevel}`);
          }
          return;
        }
        try {
          const response = await socketRequest(socketPath, { type: 'logs.level.get' });
          if (opts.json) {
            renderer.json(response);
          } else {
            renderer.info(`当前日志等级: ${response.level ?? 'info'}`);
          }
        } catch {
          if (opts.json) {
            renderer.json({ level: 'info', source: 'default' });
          } else {
            renderer.info('无法连接服务，当前等级: info');
          }
        }
        return;
      }

      const validLevels = ['error', 'warn', 'info', 'debug'];
      if (!validLevels.includes(newLevel)) {
        renderer.error(`无效的日志等级: ${newLevel}，可选: ${validLevels.join(', ')}`);
        process.exit(2);
      }

      if (!existsSync(socketPath)) {
        renderer.error('Berry 服务未在运行，无法动态调级');
        process.exit(10);
      }

      try {
        const payload: Record<string, unknown> = {
          type: 'logs.level.set',
          level: newLevel,
        };
        if (opts.persist) payload.persist = true;
        if (opts.ttl) payload.ttl = opts.ttl;

        const response = await socketRequest(socketPath, payload);
        if (opts.json) {
          renderer.json(response);
        } else {
          renderer.info(`已设置日志等级: ${newLevel}${opts.ttl ? ` (${opts.ttl} 后恢复)` : ''}`);
        }
      } catch (err) {
        renderer.error(`设置失败: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

function readLastLines(filePath: string, count: number): string[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  return lines.slice(-count);
}

interface LogLineData {
  level?: number | string;
  time?: number;
  module?: string;
  msg?: string;
  [key: string]: unknown;
}

function filterLogLines(lines: string[], opts: { level?: string; module?: string; since?: string }): LogLineData[] {
  const parsed: LogLineData[] = [];
  const levelPriority: Record<string, number> = { error: 50, warn: 40, info: 30, debug: 20 };
  const minLevel = opts.level ? (levelPriority[opts.level] ?? 0) : 0;

  let sinceTs = 0;
  if (opts.since) {
    const match = opts.since.match(/^(\d+)(s|m|h|d)$/);
    if (match) {
      const multipliers: Record<string, number> = { s: MS_PER_SECOND, m: MS_PER_MINUTE, h: MS_PER_HOUR, d: MS_PER_DAY };
      sinceTs = Date.now() - parseInt(match[1], 10) * multipliers[match[2]];
    }
  }

  for (const line of lines) {
    try {
      const data = JSON.parse(line) as LogLineData;
      const lineLevel = typeof data.level === 'number' ? data.level : (levelPriority[data.level as string] ?? 30);
      if (lineLevel < minLevel) continue;
      if (opts.module && data.module !== opts.module) continue;
      if (sinceTs > 0 && data.time && data.time < sinceTs) continue;
      parsed.push(data);
    } catch {
      // skip malformed lines
    }
  }
  return parsed;
}

const PINO_LEVEL_NAMES: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

function printLogLine(data: LogLineData): void {
  const renderer = getConsoleRenderer();
  const time = data.time ? new Date(data.time).toLocaleTimeString() : '?';
  const level = typeof data.level === 'number' ? (PINO_LEVEL_NAMES[data.level] ?? '?') : (data.level ?? '?');
  const module = data.module ? `[${data.module}]` : '';
  const msg = data.msg ?? '';
  renderer.info(`${time} ${level.toUpperCase().padEnd(5)} ${module} ${msg}`);
}

async function showRunLogs(runId: string, opts: { level?: string; module?: string; json?: boolean }): Promise<void> {
  const renderer = getConsoleRenderer();
  const logFile = join(getAppHome(), 'runs', runId, 'berry.log.jsonl');
  if (!existsSync(logFile)) {
    if (opts.json) {
      renderer.json({ ok: false, error: { code: 'RUN_NOT_FOUND', message: `运行 ${runId} 不存在` } });
    } else {
      renderer.error(`运行 ${runId} 不存在或无日志`);
    }
    process.exit(1);
  }

  const content = readFileSync(logFile, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  const events: Record<string, unknown>[] = [];

  for (const line of lines) {
    try {
      const data = JSON.parse(line);
      if (opts.level && data.level !== opts.level) continue;
      if (opts.module && data.module !== opts.module) continue;
      events.push(data);
    } catch {
      // skip
    }
  }

  if (opts.json) {
    renderer.json({ runId, events });
  } else {
    for (const ev of events) {
      const time = ev.ts ? new Date(ev.ts as number).toLocaleTimeString() : '?';
      const lvl = ((ev.level as string) ?? 'info').toUpperCase().padEnd(5);
      const mod = ev.module ? `[${ev.module}]` : '';
      renderer.info(`${time} ${lvl} ${mod} ${ev.msg ?? ''}`);
    }
  }
}

interface ConsoleFrameData {
  ts: number;
  stream: 'stdout' | 'stderr';
  text: string;
  runId: string;
}

function showRunConsole(
  runId: string,
  opts: { stream?: string; json?: boolean; lines?: string },
): void {
  const renderer = getConsoleRenderer();
  const consoleFile = join(getAppHome(), 'runs', runId, 'console.jsonl');
  if (!existsSync(consoleFile)) {
    if (opts.json) {
      renderer.json({ ok: false, error: { code: 'RUN_NOT_FOUND', message: `运行 ${runId} 不存在` } });
    } else {
      renderer.error(`运行 ${runId} 不存在或无控制台输出`);
    }
    process.exit(1);
  }

  const stream = opts.stream ?? 'all';
  if (!['stdout', 'stderr', 'all'].includes(stream)) {
    renderer.error(`无效的输出流: ${stream}，可选: stdout, stderr, all`);
    process.exit(2);
  }

  const maxLines = parseInt(opts.lines ?? '200', 10);
  const lines = readFileSync(consoleFile, 'utf-8').split('\n').filter(Boolean);
  const frames: ConsoleFrameData[] = [];

  for (const line of lines) {
    try {
      const frame = JSON.parse(line) as ConsoleFrameData;
      if (stream !== 'all' && frame.stream !== stream) continue;
      frames.push(frame);
    } catch {
      // skip
    }
  }

  const selected = frames.slice(-maxLines);
  if (opts.json) {
    renderer.json({ runId, frames: selected });
    return;
  }

  for (const frame of selected) {
    renderer.write(frame.stream, frame.text);
  }
}

async function tailFollow(filePath: string, opts: { level?: string; module?: string }): Promise<void> {
  const { spawn } = await import('node:child_process');
  const tail = spawn('tail', ['-f', '-n', '0', filePath]);

  const rl = createInterface({ input: tail.stdout });
  rl.on('line', (line) => {
    try {
      const data = JSON.parse(line) as LogLineData;
      const levelPriority: Record<string, number> = { error: 50, warn: 40, info: 30, debug: 20 };
      if (opts.level) {
        const lineLevel = typeof data.level === 'number' ? data.level : (levelPriority[data.level as string] ?? 30);
        if (lineLevel < (levelPriority[opts.level] ?? 0)) return;
      }
      if (opts.module && data.module !== opts.module) return;
      printLogLine(data);
    } catch {
      // skip
    }
  });

  process.on('SIGINT', () => {
    tail.kill();
    process.exit(0);
  });

  await new Promise(() => {});
}
