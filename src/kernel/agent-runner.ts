import { fork, type ChildProcess } from 'node:child_process';
import { IpcChannel } from './ipc.js';
import type { IpcJournal } from './ipc-journal.js';
import { createStallWatchdog, type StallWatchdog } from './stall-watchdog.js';
import type { AgentName, AgentStatus } from '../contracts/agents.js';

export interface AgentProcess {
  name: AgentName;
  pid: number;
  child: ChildProcess;
  ipc: IpcChannel;
  status: AgentStatus;
  startedAt: number;
  lastHeartbeat: number;
  stallWatchdog: StallWatchdog;
}

const isTsx = process.argv[0]?.includes('tsx') || process.execArgv.some((a) => a.includes('tsx'));

/**
 * W4 修复：为 on-demand agent 创建空操作 watchdog
 * 避免空闲 on-demand agent 在 30s 后被误判为 stalled
 * 实现 StallWatchdog 接口的所有方法为 no-op
 */
function createNoopStallWatchdog(): StallWatchdog {
  return {
    touch() { /* no-op: on-demand agent 无需 stall 检测 */ },
    stop() { /* no-op */ },
    isActive() { return false; },
  };
}

export function forkAgent(name: AgentName, scriptPath: string, env?: Record<string, string>, journal?: IpcJournal, kind?: 'resident' | 'on-demand'): AgentProcess {
  const needsTsx = isTsx || scriptPath.endsWith('.ts');
  const execArgv = needsTsx ? ['--import', 'tsx'] : [];

  // W5 修复：通过 NODE_OPTIONS 设置 V8 堆上限 256MB
  // child_process.fork 的 ForkOptions 类型不包含 resourceLimits（那是 worker_threads 的 API）
  // 使用 --max-old-space-size 是 Node.js 标准的内存限制方式
  const existingNodeOptions = process.env.NODE_OPTIONS ?? '';
  const memoryFlag = `--max-old-space-size=256`;
  const nodeOptions = existingNodeOptions.includes('max-old-space-size')
    ? existingNodeOptions
    : `${existingNodeOptions} ${memoryFlag}`.trim();

  const child = fork(scriptPath, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    execArgv,
    env: { ...process.env, AGENT_NAME: name, ...env, NODE_OPTIONS: nodeOptions },
  });

  const ipc = new IpcChannel(child, 'core', { journal });

  const agent: AgentProcess = {
    name,
    pid: child.pid!,
    child,
    ipc,
    status: 'starting',
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
    stallWatchdog: undefined!,
  };

  // W4 修复：StallWatchdog 仅对 resident agent 创建
  // on-demand agent 在任务间隔期间会自然空闲 30s+，不应被误判为 stalled
  const watchdog = kind === 'resident'
    ? createStallWatchdog({
        label: `agent:${name}`,
        timeoutMs: 30_000,
        onStall: ({ idleMs }) => {
          // W9 修复：统一使用 'ready' 状态值，与 agent-manager.ts 保持一致
          if (agent.status === 'ready') {
            agent.status = 'stalled';
          }
        },
      })
    : createNoopStallWatchdog();
  agent.stallWatchdog = watchdog;

  ipc.onMessage('agent.heartbeat', () => {
    agent.lastHeartbeat = Date.now();
    watchdog.touch();
    if (agent.status === 'stalled') {
      agent.status = 'ready';
    }
  });

  ipc.onMessage('agent.register', () => {
    // W9 修复：agent 注册后进入 'ready' 状态（与 agent-manager.ts 一致）
    agent.status = 'ready';
    watchdog.touch();
  });

  child.on('exit', (code) => {
    agent.status = code === 0 ? 'stopped' : 'crashed';
    watchdog.stop();
  });

  child.on('error', () => {
    agent.status = 'crashed';
    watchdog.stop();
  });

  return agent;
}
