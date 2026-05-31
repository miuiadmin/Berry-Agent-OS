import { forkAgent, type AgentProcess } from './agent-runner.js';
import { ensureAgentHome } from './agent-home.js';
import type { IpcMessage } from './types.js';
import type { AgentName } from '../contracts/agents.js';
import type { AppConfig } from '../config/schema.js';
import { getLogger } from '../utils/logger.js';
import type { AgentRegistry } from './agent-registry.js';
import type { EventBus } from './event-bus.js';
import { AgentUnavailableError, TimeoutError } from './errors.js';
import { metrics } from '../observability/metrics.js';

const logger = getLogger('agent-manager');

const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_THRESHOLD = 3;

export class AgentManager {
  private agents = new Map<string, AgentProcess>();
  private heartbeatCheckers = new Map<string, ReturnType<typeof setInterval>>();
  private crashTimestamps = new Map<string, number[]>();
  private config: AppConfig;
  private registry: AgentRegistry;
  private eventBus: EventBus | null;

  constructor(config: AppConfig, registry: AgentRegistry, eventBus?: EventBus) {
    this.config = config;
    this.registry = registry;
    this.eventBus = eventBus ?? null;
  }

  async startAll(): Promise<void> {
    for (const agent of this.registry.listResident()) {
      this.startAgent(agent.manifest.name, agent.entryPath);
    }
  }

  async ensureAgent(name: string): Promise<AgentProcess> {
    const existing = this.agents.get(name);
    if (existing && existing.status !== 'crashed' && existing.status !== 'stopped'
        && existing.status !== 'circuit_broken' && existing.child.connected) {
      return existing;
    }
    if (this.isCircuitOpen(name)) {
      throw new AgentUnavailableError(`智能体 ${name} 已熔断，无法启动`, name);
    }
    const registered = this.registry.get(name);
    if (!registered) throw new AgentUnavailableError(`未注册的智能体: ${name}`, name);
    this.startAgent(name, registered.entryPath);
    return this.waitForReady(name);
  }

  async stopAgent(name: string): Promise<void> {
    const checker = this.heartbeatCheckers.get(name);
    if (checker) {
      clearInterval(checker);
      this.heartbeatCheckers.delete(name);
    }
    const agent = this.agents.get(name);
    if (!agent) return;
    logger.info({ agent: name }, `正在停止智能体: ${name}`);
    agent.ipc.send('agent.shutdown', name, {});
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        agent.child.kill('SIGKILL');
        resolve();
      }, 5000);
      agent.child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    agent.ipc.destroy();
    this.agents.delete(name);
  }

  async upgradeAgent(name: string, newScriptPath: string): Promise<void> {
    await this.stopAgent(name);
    this.startAgent(name, newScriptPath);
    await this.waitForReady(name);
  }

  isRunning(name: string): boolean {
    const agent = this.agents.get(name);
    return agent?.status === 'ready';
  }

  startAgent(name: string, scriptPath: string): void {
    if (this.isCircuitOpen(name)) {
      logger.warn({ agent: name }, '智能体已熔断，跳过启动');
      return;
    }

    logger.info({ agent: name }, `正在启动智能体: ${name}`);
    const registered = this.registry.get(name);
    let homePath: string | undefined;
    try {
      if (registered) {
        const homePaths = ensureAgentHome(registered.manifest);
        homePath = homePaths.home;
      }
    } catch (err) {
      logger.error({ err, agent: name }, '创建 Agent Home 失败，使用默认路径');
    }
    const env: Record<string, string> = { AGENT_NAME: name };
    if (homePath) env.APP_AGENT_HOME = homePath;
    if (registered?.manifest.ipcProtocol === 'generic-loop') {
      env.GENERIC_AGENT_CONFIG = registered.manifestPath;
    }
    const agent = forkAgent(name, scriptPath, env);
    this.agents.set(name, agent);

    agent.ipc.onMessage('agent.register', () => {
      agent.status = 'ready';
      agent.lastHeartbeat = Date.now();
      logger.info({ agent: name, pid: agent.pid }, `智能体已注册: ${name}`);
      this.eventBus?.emit('agent.registered', { name, pid: agent.pid });
    });

    agent.ipc.onMessage('agent.heartbeat', () => {
      agent.lastHeartbeat = Date.now();
    });

    agent.child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        this.recordCrash(name);
        if (this.isCircuitOpen(name)) {
          agent.status = 'circuit_broken';
          logger.error({ agent: name, crashes: CIRCUIT_THRESHOLD, windowMs: CIRCUIT_WINDOW_MS },
            '智能体熔断：短时间内多次崩溃，停止自动重启');
          this.eventBus?.emit('agent.crashed', { name, error: `熔断: ${CIRCUIT_WINDOW_MS}ms 内崩溃 ${CIRCUIT_THRESHOLD} 次`, circuitBroken: true });
          return;
        }
        this.eventBus?.emit('agent.crashed', { name, error: `退出码: ${code}` });
        logger.warn({ agent: name, code }, '智能体异常退出，准备重启');
        this.restartAgent(name, scriptPath);
      }
    });

    const isResident = registered?.manifest.kind === 'resident';

    if (isResident) {
      this.heartbeatCheckers.set(name, setInterval(() => {
        const elapsed = Date.now() - agent.lastHeartbeat;
        if (elapsed > this.config.heartbeatTimeoutMs && agent.status === 'ready') {
          logger.warn({ agent: name, elapsed }, '智能体心跳超时，准备重启');
          this.eventBus?.emit('agent.crashed', { name, error: `心跳超时: ${elapsed}ms` });
          this.restartAgent(name, scriptPath);
        }
      }, this.config.heartbeatIntervalMs));
    }
  }

  resetCircuit(name: string): void {
    this.crashTimestamps.delete(name);
    const agent = this.agents.get(name);
    if (agent?.status === 'circuit_broken') {
      agent.status = 'stopped';
    }
    logger.info({ agent: name }, '智能体熔断已重置');
  }

  private recordCrash(name: string): void {
    const now = Date.now();
    const timestamps = this.crashTimestamps.get(name) ?? [];
    timestamps.push(now);
    const cutoff = now - CIRCUIT_WINDOW_MS;
    const recent = timestamps.filter(t => t > cutoff);
    this.crashTimestamps.set(name, recent);
    metrics.counter('agent_crashes_total').inc({ agent: name });
    if (recent.length >= CIRCUIT_THRESHOLD) {
      metrics.counter('agent_circuit_breaks_total').inc({ agent: name });
    }
  }

  private isCircuitOpen(name: string): boolean {
    const timestamps = this.crashTimestamps.get(name);
    if (!timestamps) return false;
    const now = Date.now();
    const cutoff = now - CIRCUIT_WINDOW_MS;
    const recent = timestamps.filter(t => t > cutoff);
    return recent.length >= CIRCUIT_THRESHOLD;
  }

  private async waitForReady(name: string, timeoutMs?: number): Promise<AgentProcess> {
    const deadline = Date.now() + (timeoutMs ?? this.config.requestTimeoutMs);
    while (Date.now() < deadline) {
      const agent = this.agents.get(name);
      if (agent?.status === 'ready') return agent;
      if (agent?.status === 'crashed' || agent?.status === 'circuit_broken') {
        throw new AgentUnavailableError(`智能体启动失败: ${name}`, name);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new TimeoutError(`等待智能体就绪超时: ${name}`, name);
  }

  private restartAgent(name: string, scriptPath: string): void {
    if (this.isCircuitOpen(name)) {
      logger.warn({ agent: name }, '智能体已熔断，跳过重启');
      return;
    }
    metrics.counter('agent_restarts_total').inc({ agent: name });
    const existing = this.agents.get(name);
    if (existing) {
      existing.ipc.destroy();
      existing.child.kill('SIGTERM');
    }
    this.startAgent(name, scriptPath);
  }

  getAgent(name: string): AgentProcess | undefined {
    return this.agents.get(name);
  }

  routeMessage(msg: IpcMessage): void {
    const target = this.agents.get(msg.to);
    if (target) {
      target.ipc.send(msg.type, msg.to, msg.payload, msg.correlationId ?? msg.id);
    } else {
      logger.warn({ to: msg.to }, '未找到可路由的智能体');
    }
  }

  getStatus(): Record<string, { status: string; pid: number; uptime: number }> {
    const result: Record<string, { status: string; pid: number; uptime: number }> = {};
    for (const [name, agent] of this.agents) {
      result[name] = {
        status: agent.status,
        pid: agent.pid,
        uptime: Date.now() - agent.startedAt,
      };
    }
    return result;
  }

  async stopAll(): Promise<void> {
    for (const [name, checker] of this.heartbeatCheckers) {
      clearInterval(checker);
    }
    this.heartbeatCheckers.clear();

    for (const name of [...this.agents.keys()]) {
      await this.stopAgent(name);
    }
    this.agents.clear();
  }
}
