import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { Command } from 'commander';
import { getSocketPath } from '../utils/paths.js';
import { startRun, endRun, resolveLogLevel } from '../observability/index.js';
import { getConsoleRenderer } from '../observability/console.js';
import { EXIT_CODES, makeError } from '../kernel/errors.js';
import type { SocketProgressEvent, SocketResultEvent, SocketErrorEvent } from '../contracts/socket-protocol.js';

type StreamEvent = SocketProgressEvent | SocketResultEvent | SocketErrorEvent;

export function registerRunCommand(program: Command): void {
  program
    .command('run <message>')
    .description('向 Berry 发送消息')
    .option('-s, --session <id>', '会话 ID，用于连续对话')
    .option('-p, --permission-mode <mode>', '权限模式: ask, allow-all, deny-all, yolo')
    .option('--non-interactive', '非交互模式；ask 会按 deny-all 处理')
    .option('--json', '以 JSON 格式输出')
    .option('--steps', '输出每一步的详细过程')
    .option('--log-level <level>', '日志等级 (error/warn/info/debug)')
    .option('--capture-output', '捕获完整输出到 run artifact')
    .action(async (message: string, opts) => {
      const renderer = getConsoleRenderer();
      const isJson = opts.json ?? false;
      const level = resolveLogLevel({
        cliLevel: opts.logLevel,
        envLevel: process.env.APP_LOG_LEVEL,
        modeDefault: opts.steps ? 'debug' : 'info',
      });

      const run = startRun(`berry run "${message}"`, level);

      const socketPath = getSocketPath();
      if (!existsSync(socketPath)) {
        writeRunError(run, 'SERVICE_NOT_RUNNING', 'Berry 服务未在运行，请先执行: berry service start', isJson);
        await endRun(EXIT_CODES.SERVICE_NOT_RUNNING);
        process.exit(EXIT_CODES.SERVICE_NOT_RUNNING);
      }

      try {
        const request: Record<string, unknown> = {
          type: 'message',
          message,
          sessionId: opts.session,
          runId: run.runId,
          streaming: true,
        };
        if (opts.permissionMode) {
          request.permissionMode = opts.nonInteractive && opts.permissionMode === 'ask'
            ? 'deny-all'
            : opts.permissionMode;
        }
        if (opts.nonInteractive) request.nonInteractive = true;

        run.log('info', 'cli', '发送消息', { message, sessionId: opts.session });

        const result = await streamingSocketRequest(socketPath, request, {
          onProgress(event) {
            if (isJson) {
              renderer.jsonlEvent(event);
            } else {
              renderer.spinner(event.summary);
            }
          },
        });

        renderer.stopSpinner();

        if (result.type === 'error') {
          run.log('error', 'cli', '服务返回错误', { error: result.error });
          if (isJson) {
            renderer.jsonlEvent({ ...result, runId: run.runId, artifactDir: run.artifactDir });
          } else {
            renderer.error(`错误: ${result.error}`);
          }
          await endRun(EXIT_CODES.UNKNOWN_ERROR);
          process.exit(EXIT_CODES.UNKNOWN_ERROR);
        }

        run.log('info', 'cli', '收到响应', { sessionId: result.sessionId });
        if (isJson) {
          renderer.jsonlEvent({
            ...result,
            runId: run.runId,
            artifactDir: run.artifactDir,
          });
        } else {
          renderer.info(result.response);
        }
        await endRun(EXIT_CODES.SUCCESS);
      } catch (err) {
        renderer.stopSpinner();
        run.log('error', 'cli', '连接失败', { error: (err as Error).message });
        writeRunError(run, 'CONNECTION_ERROR', `无法连接 Berry 服务: ${(err as Error).message}`, isJson);
        await endRun(EXIT_CODES.SERVICE_NOT_RUNNING);
        process.exit(EXIT_CODES.SERVICE_NOT_RUNNING);
      }
    });
}

interface StreamingOptions {
  onProgress: (event: SocketProgressEvent) => void;
}

function streamingSocketRequest(
  socketPath: string,
  data: unknown,
  options: StreamingOptions,
): Promise<SocketResultEvent | SocketErrorEvent> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify(data) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as StreamEvent;
          if (event.type === 'progress') {
            options.onProgress(event);
          } else {
            socket.end();
            resolve(event);
            return;
          }
        } catch (e) {
          socket.end();
          reject(new Error(`无效的服务响应: ${line}`));
          return;
        }
      }
    });

    socket.on('end', () => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim()) as StreamEvent;
          if (event.type === 'progress') {
            reject(new Error('服务连接异常关闭'));
          } else {
            resolve(event);
          }
        } catch {
          reject(new Error('服务连接异常关闭'));
        }
      }
    });

    socket.on('error', reject);
    socket.setTimeout(120000, () => {
      socket.destroy();
      reject(new Error('Socket timeout'));
    });
  });
}

function writeRunError(
  run: ReturnType<typeof startRun>,
  code: string,
  message: string,
  isJson: boolean,
): void {
  const renderer = getConsoleRenderer();
  if (isJson) {
    renderer.json({ ...makeError(code, message), runId: run.runId, artifactDir: run.artifactDir });
    return;
  }
  renderer.error(`错误: ${message}`);
}
