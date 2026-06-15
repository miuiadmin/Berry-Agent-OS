import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { EventBus } from '../contracts/infrastructure.js';
import type { LlmClient } from '../llm/index.js';
import type { ToolDefinition } from '../tools/types.js';
import type { IToolRegistry } from '../tools/contract.js';
import { metrics } from '../observability/metrics.js';
import type {
  McpServerConfig,
  McpServerState,
  IMcpManager,
  CircuitState,
} from './contract.js';
import { createTransport, ProcessManager } from './transport.js';
import { McpOAuthProvider, OAuthCallbackServer } from './oauth.js';
import { SamplingHandler } from './sampling.js';
import { filterMcpTools, convertMcpTools, mcpToolFullName } from './tool-bridge.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('mcp-manager');

// ─── Server Instance ───────────────────────────────────────────

interface McpServerInstance {
  config: McpServerConfig;
  client: Client | null;
  state: McpServerState;
  tools: string[];
  // resources/prompts 字段已在 16.0 §17.8 删除（整链路无消费者）
  samplingHandler: SamplingHandler | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
}

// ─── MCP Manager ───────────────────────────────────────────────

export class McpManager implements IMcpManager {
  private servers = new Map<string, McpServerInstance>();
  private processManager = new ProcessManager();
  private callbackServer: OAuthCallbackServer | null = null;

  constructor(
    private readonly eventBus: EventBus,
    private readonly toolRegistry: IToolRegistry,
    private readonly llmClient: LlmClient,
  ) {}

  async start(configs: McpServerConfig[]): Promise<void> {
    const enabled = configs.filter(c => c.enabled);
    if (enabled.length === 0) return;

    logger.info({ count: enabled.length }, 'MCP 启动');
    const results = await Promise.allSettled(enabled.map(c => this.connectServer(c)));

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const name = enabled[i].name;
        const err = (results[i] as PromiseRejectedResult).reason as Error;
        logger.error({ serverName: name, error: err.message }, 'MCP 服务器连接失败');
      }
    }
  }

  async stop(): Promise<void> {
    for (const [, instance] of this.servers) {
      if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
      await this.disconnectInstance(instance);
    }
    this.servers.clear();
    await this.processManager.cleanupAll();
    this.callbackServer?.stop();
    this.callbackServer = null;
    logger.info('MCP 已全部关闭');
  }

  getState(name: string): McpServerState | undefined {
    return this.servers.get(name)?.state;
  }

  getAllStates(): McpServerState[] {
    return [...this.servers.values()].map(s => s.state);
  }

  async reconnect(name: string): Promise<void> {
    const instance = this.servers.get(name);
    if (!instance) throw new Error(`MCP server "${name}" 不存在`);
    await this.disconnectInstance(instance);
    instance.state.circuitState = 'closed';
    instance.reconnectAttempt = 0;
    await this.connectServer(instance.config);
  }

  async handleConfigReload(configs: McpServerConfig[]): Promise<void> {
    const next = new Map(configs.map(c => [c.name, c]));

    for (const [name, instance] of this.servers) {
      if (!next.has(name)) {
        await this.disconnectInstance(instance);
        this.servers.delete(name);
      }
    }

    for (const [name, config] of next) {
      if (!this.servers.has(name)) {
        if (config.enabled) await this.connectServer(config);
      } else {
        const existing = this.servers.get(name)!;
        if (configChanged(existing.config, config)) {
          await this.disconnectInstance(existing);
          this.servers.delete(name);
          if (config.enabled) await this.connectServer(config);
        }
      }
    }
  }

  /**
   * 注意：MCP resources / prompts 链路已在 16.0 §17.8 删除（铺好未接线、零消费者）。
   * 底座仅保留 tools（真实工具调用）+ sampling（LLM 采样）。
   * 若未来需要 resources/prompts API，需重新接入：listResources/listPrompts/getPrompt/
   * readResource 公共读方法 + refreshResources/refreshPrompts 内部刷新 + capabilities 标记。
   */

  // ─── Connection Lifecycle ──────────────────────────────────────

  private async connectServer(config: McpServerConfig): Promise<void> {
    const instance = this.getOrCreateInstance(config);
    instance.state.status = 'connecting';

    try {
      const oauthProvider = config.oauth && typeof config.oauth === 'object'
        ? await this.getOAuthProvider(config)
        : undefined;

      const { transport, type: transportType } = createTransport(config, oauthProvider);

      const client = new Client(
        { name: 'agent', version: '1.0.0' },
        { capabilities: { sampling: {}, roots: { listChanged: true } } },
      );

      const connectOptions = config.connectTimeout
        ? { timeout: config.connectTimeout }
        : undefined;

      await client.connect(transport, connectOptions);

      instance.client = client;

      if (config.sampling.enabled) {
        const handler = new SamplingHandler(config.name, config.sampling, this.llmClient, this.eventBus);
        handler.register(client);
        instance.samplingHandler = handler;
      }

      this.setupNotificationHandlers(instance);
      await this.refreshTools(instance);

      instance.state.status = 'connected';
      instance.state.lastConnectedAt = Date.now();
      instance.state.consecutiveFailures = 0;
      instance.state.circuitState = 'closed';
      instance.reconnectAttempt = 0;

      logger.info({
        serverName: config.name,
        transportType,
        toolCount: instance.state.toolCount,
      }, 'MCP 服务器已连接');

      this.emitConnected(instance);
    } catch (err) {
      const error = err as Error;
      instance.state.status = 'failed';
      instance.state.error = error.message;
      instance.state.consecutiveFailures++;

      logger.warn({ serverName: config.name, error: error.message }, 'MCP 连接失败');
      this.emitFailed(instance, error.message);
      this.scheduleReconnect(instance);
    }
  }

  private async disconnectInstance(instance: McpServerInstance): Promise<void> {
    if (instance.reconnectTimer) {
      clearTimeout(instance.reconnectTimer);
      instance.reconnectTimer = null;
    }

    if (instance.tools.length > 0) {
      this.toolRegistry.clearNames(instance.tools);
      instance.tools = [];
    }

    if (instance.client) {
      try { await instance.client.close(); } catch { /* ignore */ }
      instance.client = null;
    }

    await this.processManager.cleanup(instance.config.name);
    instance.state.status = 'disconnected';
    instance.state.toolCount = 0;

    this.eventBus.emit('mcp.disconnected', { serverName: instance.config.name });
  }

  // ─── Reconnection & Circuit Breaker ────────────────────────────

  private scheduleReconnect(instance: McpServerInstance): void {
    if (instance.state.circuitState === 'open') return;

    const attempt = ++instance.reconnectAttempt;
    metrics.counter('mcp_reconnections_total').inc({ server: instance.config.name });
    if (attempt > 5) {
      this.openCircuit(instance);
      return;
    }

    const base = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.round(base + jitter);

    logger.debug({ serverName: instance.config.name, attempt, delay }, 'MCP 重连计划');

    this.eventBus.emit('mcp.reconnecting', {
      serverName: instance.config.name,
      attempt,
      delayMs: delay,
    });

    instance.reconnectTimer = setTimeout(() => {
      instance.reconnectTimer = null;
      this.connectServer(instance.config);
    }, delay);
  }

  private openCircuit(instance: McpServerInstance): void {
    instance.state.circuitState = 'open';
    instance.state.status = 'failed';

    logger.warn({ serverName: instance.config.name }, 'MCP 熔断器打开');
    this.emitFailed(instance, '连续失败次数过多，已熔断', true);

    setTimeout(() => {
      if (instance.state.circuitState !== 'open') return;
      instance.state.circuitState = 'half-open';
      logger.debug({ serverName: instance.config.name }, 'MCP 熔断器半开，尝试探测');
      this.connectServer(instance.config);
    }, 60_000);
  }

  // ─── Notification Handlers ─────────────────────────────────────

  private setupNotificationHandlers(instance: McpServerInstance): void {
    const client = instance.client!;

    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      logger.debug({ serverName: instance.config.name }, 'MCP tools_changed 通知');
      await this.refreshTools(instance);
    });

    // resources / prompts 通知处理已在 16.0 §17.8 删除（整链路无消费者）
  }

  // ─── Tool Refresh ──────────────────────────────────────────────

  private async refreshTools(instance: McpServerInstance): Promise<void> {
    const client = instance.client!;
    const config = instance.config;

    const { tools: rawTools } = await client.listTools();
    const filtered = filterMcpTools(rawTools as McpTool[], config);

    const oldNames = new Set(instance.tools);
    const bridgeCtx = {
      client,
      config,
      getCircuitState: (): CircuitState => instance.state.circuitState,
      onError: (err: Error) => this.handleToolError(instance, err),
    };
    const definitions = convertMcpTools(filtered as McpTool[], bridgeCtx);
    const newNames = new Set(definitions.map(d => d.name));

    const removed = [...oldNames].filter(n => !newNames.has(n));
    const added = [...newNames].filter(n => !oldNames.has(n));

    if (removed.length > 0) this.toolRegistry.clearNames(removed);
    for (const def of definitions) this.toolRegistry.register(def);

    instance.tools = [...newNames];
    instance.state.toolCount = definitions.length;

    if (added.length > 0 || removed.length > 0) {
      this.emitToolsChanged(instance, added, removed);
    }
  }

  // ─── Error Handling ────────────────────────────────────────────

  private handleToolError(instance: McpServerInstance, _error: Error): void {
    instance.state.consecutiveFailures++;
    if (instance.state.consecutiveFailures >= 3 && instance.state.circuitState === 'closed') {
      this.openCircuit(instance);
    }
  }

  // ─── OAuth ─────────────────────────────────────────────────────

  private async getOAuthProvider(config: McpServerConfig): Promise<McpOAuthProvider> {
    const oauthConfig = config.oauth as Exclude<typeof config.oauth, false | undefined>;
    if (!this.callbackServer) {
      this.callbackServer = new OAuthCallbackServer(oauthConfig.redirectPort);
      await this.callbackServer.start();
    }
    return new McpOAuthProvider(config.name, oauthConfig, this.callbackServer, this.eventBus);
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private getOrCreateInstance(config: McpServerConfig): McpServerInstance {
    if (this.servers.has(config.name)) return this.servers.get(config.name)!;

    const instance: McpServerInstance = {
      config,
      client: null,
      state: {
        name: config.name,
        status: 'disconnected',
        toolCount: 0,
        lastConnectedAt: null,
        consecutiveFailures: 0,
        circuitState: 'closed',
      },
      tools: [],
      samplingHandler: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
    };

    this.servers.set(config.name, instance);
    return instance;
  }

  // ─── Event Emission ────────────────────────────────────────────

  private emitConnected(instance: McpServerInstance): void {
    this.eventBus.emit('mcp.connected', {
      serverName: instance.config.name,
      toolCount: instance.state.toolCount,
      capabilities: this.getCapabilities(instance),
    });
  }

  private emitFailed(instance: McpServerInstance, error: string, circuitBroken = false): void {
    this.eventBus.emit('mcp.failed', {
      serverName: instance.config.name,
      error,
      circuitBroken,
    });
  }

  private emitToolsChanged(instance: McpServerInstance, added: string[], removed: string[]): void {
    this.eventBus.emit('mcp.tools_changed', {
      serverName: instance.config.name,
      added,
      removed,
    });
  }

  private getCapabilities(_instance: McpServerInstance): string[] {
    // resources/prompts 已在 16.0 §17.8 删除；capabilities 仅剩 tools + sampling
    const caps: string[] = ['tools'];
    if (_instance.samplingHandler) caps.push('sampling');
    return caps;
  }
}

// ─── Utils ─────────────────────────────────────────────────────

function configChanged(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}
