import { forkAgent, type AgentProcess } from './agent-runner.js';
import { ensureAgentHome } from './agent-home.js';
import type { IpcMessage } from './types.js';
import type { AgentName } from '../contracts/agents.js';
import type { AppConfig } from '../config/schema.js';
import { FAST_POLL_MS } from '../lib/time-constants.js';
import { getLogger } from '../utils/logger.js';
import type { AgentRegistry } from './agent-registry.js';
import type { EventBus } from './event-bus.js';
import { AgentUnavailableError, TimeoutError } from './errors.js';
import { metrics } from '../observability/metrics.js';
import { BackpressureMonitor, DeadLetterQueue } from './ipc-resilience.js';
import { getDb } from '../memory/index.js';

const logger = getLogger('agent-manager');

const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_THRESHOLD = 3;
/** W6 修复：熔断后 5 分钟自动尝试恢复（half-open 状态） */
const CIRCUIT_RECOVERY_MS = 5 * 60 * 1000;

export class AgentManager {
  private agents = new Map<string, AgentProcess>();
  /** W6: 熔断器自动恢复定时器 */
  private circuitRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private heartbeatCheckers = new Map<string, ReturnType<typeof setInterval>>();
  private crashTimestamps = new Map<string, number[]>();
  private config: AppConfig;
  private registry: AgentRegistry;
  private eventBus: EventBus | null;
  /** IPC journal 用于可靠投递和崩溃重放 */
  private journal: import('./ipc-journal.js').IpcJournal | null = null;
  // C2 修复：IPC 弹性机制（背压监控 + 死信队列）
  private backpressure: BackpressureMonitor = new BackpressureMonitor();
  private deadLetterQueue: DeadLetterQueue | null = null;

  constructor(config: AppConfig, registry: AgentRegistry, eventBus?: EventBus) {
    this.config = config;
    this.registry = registry;
    this.eventBus = eventBus ?? null;
  }

  /** 设置 IPC journal（在 core-service setup 后调用） */
  setJournal(journal: import('./ipc-journal.js').IpcJournal): void {
    this.journal = journal;
    // C2 修复：journal 准备好时同时创建死信队列（共享同一个 DB）
    try {
      this.deadLetterQueue = new DeadLetterQueue(getDb());
    } catch (err) {
      logger.warn({ err }, '死信队列初始化失败，将降级为静默丢弃');
    }
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
    // W2 修复：先移除 forkAgent/startAgent 注册的 exit listener，防止累积泄漏
    agent.child.removeAllListeners('exit');
    agent.ipc.send('agent.shutdown', name, {});
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        agent.child.kill('SIGKILL');
        resolve();
      }, 5000);
      agent.child.once('exit', () => {
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
    // L3: 将 dialogueObserve.maxRounds 传递给 Agent 子进程
    if (registered?.manifest.dialogueObserve?.maxRounds) {
      env.AGENT_OBSERVE_MAX_ROUNDS = String(registered.manifest.dialogueObserve.maxRounds);
    }
    // C1 修复（中间步骤）：传递所有 agent 名称给子进程，用于文件路径隔离校验
    // 完整方案（DB 代理层）留作后续架构目标
    env.AGENT_NAMES = this.registry.getAgentNames().join(',');
    // W4 修复：传递 agent kind 给 forkAgent，让 StallWatchdog 仅对 resident agent 创建
    const agent = forkAgent(
      name,
      scriptPath,
      env,
      this.journal ?? undefined,
      registered?.manifest.kind as 'resident' | 'on-demand' | undefined,
    );
    // C2 修复：注入弹性机制到 IpcChannel
    agent.ipc.setResilience({
      backpressure: this.backpressure,
      deadLetterQueue: this.deadLetterQueue ?? undefined,
    });
    this.agents.set(name, agent);

    agent.ipc.onMessage('agent.register', () => {
      agent.status = 'ready';
      agent.lastHeartbeat = Date.now();
      logger.info({ agent: name, pid: agent.pid }, `智能体已注册: ${name}`);
      this.eventBus?.emit('agent.registered', { name, pid: agent.pid });
      // 重放崩溃前未完成的消息（IPC journal at-least-once 投递）
      if (this.journal) {
        const replayed = this.journal.replay(name, (msg) => agent.ipc.send(msg.type, msg.to, msg.payload, msg.correlationId));
        if (replayed > 0) logger.info({ agent: name, replayed }, 'IPC journal replay 完成');
      }
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
      // W6 修复：熔断触发后启动自动恢复定时器，5 分钟后尝试重置并重启
      const existingTimer = this.circuitRecoveryTimers.get(name);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        this.circuitRecoveryTimers.delete(name);
        logger.info({ agent: name }, '熔断器冷却完成，自动恢复尝试');
        this.resetCircuit(name);
        // 尝试重启 agent
        const registered = this.registry.get(name);
        if (registered) {
          try {
            this.startAgent(name, registered.entryPath);
          } catch (err) {
            logger.error({ err, agent: name }, '熔断恢复重启失败');
          }
        }
      }, CIRCUIT_RECOVERY_MS);
      timer.unref(); // 不阻止进程退出
      this.circuitRecoveryTimers.set(name, timer);
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
      await new Promise((resolve) => setTimeout(resolve, FAST_POLL_MS));
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
      // W3 修复：移除旧进程 exit listener，防止旧进程退出时触发 recordCrash
      // 导致误判为新崩溃，影响熔断器计数
      existing.child.removeAllListeners('exit');
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

  /**
   * L5: 返回所有当前在线（已注册且 status=ready）的 Agent 信息列表。
   * 供 KernelRouter 的 agent.discover handler 使用，实现动态目录查询。
   */
  listAliveAgents(): Array<{ name: string; description?: string; capabilities?: string[] }> {
    const result: Array<{ name: string; description?: string; capabilities?: string[] }> = [];
    for (const [name, agent] of this.agents) {
      if (agent.status === 'ready') {
        const registered = this.registry.get(name);
        result.push({
          name,
          description: registered?.manifest.description,
          capabilities: registered?.manifest.capabilities ? Object.keys(registered.manifest.capabilities) : [],
        });
      }
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
