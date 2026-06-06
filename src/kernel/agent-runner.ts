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

export function forkAgent(name: AgentName, scriptPath: string, env?: Record<string, string>, journal?: IpcJournal): AgentProcess {
  const needsTsx = isTsx || scriptPath.endsWith('.ts');
  const execArgv = needsTsx ? ['--import', 'tsx'] : [];

  const child = fork(scriptPath, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    execArgv,
    env: { ...process.env, AGENT_NAME: name, ...env },
    // W5 修复：为 agent 进程设置资源上限，防止有 bug 的 agent 占用过多内存
    // 参考 isolated-runtime.ts 的 maxOldGenerationSizeMb: 128 模式，agent 分配 256MB
    // TypeScript ForkOptions 类型未声明此字段（Node.js 运行时支持），需要类型断言
    ...({ resourceLimits: { maxOldGenerationSizeMb: 256 } } as Record<string, unknown>),
  } as Parameters<typeof fork>[2]);

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

  const watchdog = createStallWatchdog({
    label: `agent:${name}`,
    timeoutMs: 30_000,
    onStall: ({ idleMs }) => {
      // W9 修复：统一使用 'ready' 状态值，与 agent-manager.ts 保持一致
      if (agent.status === 'ready') {
        agent.status = 'stalled';
      }
    },
  });
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
