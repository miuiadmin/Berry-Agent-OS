import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { getSocketPath } from '../utils/paths.js';
import { getConsoleRenderer } from '../observability/console.js';
import { genId } from '../utils/id.js';
import type { SocketProgressEvent, SocketResultEvent, SocketErrorEvent } from '../contracts/socket-protocol.js';

type StreamEvent = SocketProgressEvent | SocketResultEvent | SocketErrorEvent;

export async function startRepl(opts: { session?: string } = {}): Promise<void> {
  const renderer = getConsoleRenderer();
  const socketPath = getSocketPath();

  if (!existsSync(socketPath)) {
    renderer.error('Berry 服务未在运行，请先执行: berry service start');
    process.exit(1);
  }

  let sessionId = opts.session ?? genId('ses');
  renderer.info(`Berry REPL (会话: ${sessionId})`);
  renderer.info('输入消息开始对话，/quit 退出，/session new 新建会话，/help 查看帮助\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: 'you> ',
  });

  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    if (trimmed.startsWith('/')) {
      const handled = handleSlashCommand(trimmed, renderer, socketPath, sessionId, () => {
        sessionId = genId('ses');
        renderer.info(`新会话: ${sessionId}\n`);
      });
      if (handled === 'quit') {
        break;
      }
      if (handled) {
        rl.prompt();
        continue;
      }
    }

    try {
      const response = await sendStreamingMessage(socketPath, trimmed, sessionId, renderer);
      if (response) {
        process.stdout.write(`\n${response}\n\n`);
      }
    } catch (err) {
      renderer.error(`连接失败: ${(err as Error).message}`);
    }

    rl.prompt();
  }

  rl.close();
  renderer.info('再见！');
}

function handleSlashCommand(
  cmd: string,
  renderer: ReturnType<typeof getConsoleRenderer>,
  socketPath: string,
  sessionId: string,
  onNewSession: () => void,
): string | boolean {
  const parts = cmd.split(/\s+/);
  const command = parts[0].toLowerCase();

  switch (command) {
    case '/quit':
    case '/exit':
      return 'quit';
    case '/session':
      if (parts[1] === 'new') {
        onNewSession();
      } else {
        renderer.info('用法: /session new');
      }
      return true;
    case '/status':
      sendStatus(socketPath, renderer);
      return true;
    case '/stop':
      sendInterrupt(socketPath, sessionId, renderer);
      return true;
    case '/model':
      handleModelCommand(parts, socketPath, sessionId, renderer);
      return true;
    case '/help':
      renderer.info('可用命令:');
      renderer.info('  /quit     退出 REPL');
      renderer.info('  /session new  新建会话');
      renderer.info('  /status   查看服务状态');
      renderer.info('  /stop     停止当前任务');
      renderer.info('  /model [fast|default|high]  查看或切换模型层级');
      renderer.info('  /help     显示本帮助\n');
      return true;
    default:
      renderer.warn(`未知命令: ${command}`);
      return true;
  }
}

async function sendStatus(socketPath: string, renderer: ReturnType<typeof getConsoleRenderer>): Promise<void> {
  try {
    const result = await socketRequestSimple(socketPath, { type: 'status' });
    if (result.status) {
      for (const [name, info] of Object.entries(result.status as Record<string, { status: string; pid: number }>)) {
        renderer.info(`  ${name}: ${(info as { status: string }).status} (PID: ${(info as { pid: number }).pid})`);
      }
    }
  } catch {
    renderer.error('无法获取服务状态');
  }
}

async function sendInterrupt(socketPath: string, sessionId: string, renderer: ReturnType<typeof getConsoleRenderer>): Promise<void> {
  try {
    const result = await socketRequestSimple(socketPath, { type: 'interrupt', sessionId });
    if (result.taskId) {
      renderer.info('已停止当前任务');
    } else {
      renderer.info('当前没有正在执行的任务');
    }
  } catch {
    renderer.error('无法发送停止信号');
  }
}

async function handleModelCommand(parts: string[], socketPath: string, sessionId: string, renderer: ReturnType<typeof getConsoleRenderer>): Promise<void> {
  const tier = parts[1];
  if (!tier) {
    try {
      const result = await socketRequestSimple(socketPath, { type: 'model.get', sessionId });
      if (result.ok) {
        const r = result as { currentTier: string; models: Record<string, string> };
        renderer.info(`当前层级: ${r.currentTier}`);
        renderer.info(`  fast:    ${r.models.fast}`);
        renderer.info(`  default: ${r.models.default}`);
        renderer.info(`  high:    ${r.models.high}`);
      }
    } catch {
      renderer.error('无法获取模型信息');
    }
    return;
  }

  if (!['fast', 'default', 'high'].includes(tier)) {
    renderer.warn('用法: /model [fast|default|high]');
    return;
  }

  try {
    const result = await socketRequestSimple(socketPath, { type: 'model.override', sessionId, tier });
    if (result.ok) {
      renderer.info(`已切换到 ${tier} 模型层级`);
    } else {
      renderer.error(`切换失败: ${result.error ?? '未知错误'}`);
    }
  } catch {
    renderer.error('无法连接服务');
  }
}

async function sendStreamingMessage(
  socketPath: string,
  message: string,
  sessionId: string,
  renderer: ReturnType<typeof getConsoleRenderer>,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    let finalResponse: string | null = null;

    socket.on('connect', () => {
      const request = { type: 'message', message, sessionId, streaming: true, permissionMode: 'allow-all' };
      socket.write(JSON.stringify(request) + '\n');
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
            renderer.spinner(event.summary);
          } else if (event.type === 'result') {
            renderer.stopSpinner();
            finalResponse = event.response;
          } else if (event.type === 'error') {
            renderer.stopSpinner();
            renderer.error(`错误: ${event.error}`);
            finalResponse = null;
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    socket.on('end', () => {
      renderer.stopSpinner();
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim()) as StreamEvent;
          if (event.type === 'result') {
            finalResponse = event.response;
          } else if (event.type === 'error') {
            renderer.error(`错误: ${(event as SocketErrorEvent).error}`);
          }
        } catch {
          // ignore
        }
      }
      resolve(finalResponse);
    });

    socket.on('error', reject);
    socket.setTimeout(120000, () => {
      socket.destroy();
      reject(new Error('请求超时'));
    });
  });
}

function socketRequestSimple(socketPath: string, data: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify(data) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            socket.end();
            resolve(JSON.parse(line));
          } catch (e) {
            reject(e);
          }
          return;
        }
      }
    });

    socket.on('error', reject);
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
  });
}
