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

  const watchdog = createStallWatchdog({
    label: `agent:${name}`,
    timeoutMs: 30_000,
    onStall: ({ idleMs }) => {
      if (agent.status === 'running') {
        agent.status = 'stalled';
      }
    },
  });
  agent.stallWatchdog = watchdog;

  ipc.onMessage('agent.heartbeat', () => {
    agent.lastHeartbeat = Date.now();
    watchdog.touch();
    if (agent.status === 'stalled') {
      agent.status = 'running';
    }
  });

  ipc.onMessage('agent.register', () => {
    agent.status = 'running';
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
