/**
 * L3 browser — 引擎生命周期（契约篇 §6.10 引擎生命周期段，第四十九批刀一）。
 *
 * 单引擎 + per-session BrowserContext：
 * - spawn 形态：发现序 → 裸 spawn（组合根闭包注入——exec runArgv 对长命引擎
 *   不适用，M1 裁决）→ 轮询 DevToolsActivePort → browser 级单连接；
 * - attach 形态（cdpEndpoint）：只连不杀——无 spawn/登记簿/树杀链；
 * - `--user-data-dir=<dataDir>/browser/profile-<bootId>`：每次 spawn 新 bootId，
 *   双开互不抢 Chrome 单例锁（M4 裁决）；profile 残留清理挂账（挂账清单）；
 * - **OS 沙箱不 confine**（M2 裁决）：本机浏览器引擎非第三方服务器代码——
 *   与 mcp/lsp confine 判据的差异显式记此。
 *
 * 两级闲置回收（冷读 B2 裁决——无会话终结钩子，context 惰性回收）：
 * - 任一工具调用只续命**本 session** 的 context（闲置 idleMs 缺省 300s →
 *   dispose 该 context）；
 * - 引擎在零活 context 状态闲置 idleMs → Browser.close 优雅收场 + 树杀兜底
 *   （下一调用重新 ensure——spawn 形态换新 bootId 复活）。
 *
 * 回卷面：ctx.effect('browser-engine') → dispose（行卸载/作用域终结 = 永久
 * 关停，复活走行重装载）。子进程登记簿自持 `<dataDir>/browser/children.json` +
 * apply 期孤儿清扫（lsp 同款治理）。
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppLogger } from '../contracts/app.js';
import {
  CdpConnection,
  disposeSessionContext,
  fetchVersionInfo,
  openSessionContext,
  type CdpConnectionFactory,
  type CdpRpc,
} from './cdp.js';
import { discoverEngine } from './discover.js';
import type { BrowserAppConfig, DiscoveredEngine, EngineStatus, SessionBrowserState } from './types.js';

/** 裸 spawn 产物结构（组合根 browser-spawn.ts 投影——pid + 活探测两键） */
export interface EngineChild {
  readonly pid: number;
  /** 进程仍活（exitCode === null 语义——树杀竞态判据） */
  readonly alive: () => boolean;
}

/** 子进程登记簿结构子集（mcp ChildRegistry 结构投影——组合根注入真类，零 mcp import） */
export interface EngineRegistryLike {
  add(entry: { hostPid: number; childPid: number; server: string; command: string }): void;
  remove(childPid: number): void;
  sweep(probes: { kill: (pid: number) => void }): Promise<{ readonly killed: readonly number[] }>;
}

/** 引擎生命周期依赖束（组合根闭包注入——browser 模块不见 exec/mcp/child_process） */
export interface BrowserEngineDeps {
  /** 数据目录（profile/登记簿/下载引擎目录的物理锚） */
  readonly dataDir: string;
  /** 行 config（attach/executablePath/headless 消费） */
  readonly config: BrowserAppConfig;
  /** 裸 spawn 闭包（组合根——buildChildEnv + detached 组领导） */
  readonly spawnEngine: (opts: { command: string; args: readonly string[] }) => EngineChild;
  /** 树杀原语（exec killTree 经组合根注入） */
  readonly killTree: (pid: number, alive: () => boolean) => void;
  /** 子进程登记簿（组合根实例化——<dataDir>/browser/children.json） */
  readonly registry: EngineRegistryLike;
  /** JSON-RPC 桥核工厂（mcp JsonRpcConnection 经组合根注入） */
  readonly newConnection: CdpConnectionFactory;
  /** 日志面（引擎生命周期走 logger——零 durable 词汇裁决） */
  readonly logger: Pick<AppLogger, 'debug' | 'info' | 'warn'>;
  /** ui 通知面（boot/回收人读出口——channels 服务结构子集） */
  readonly notify: (message: string, opts?: { level?: 'info' | 'warn' | 'error' }) => void;
  /** 闲置回收时长（缺省 300_000ms——测试注入小值即回收可测） */
  readonly idleMs?: number;
  /** 引擎启动等待帽（spawn→DevToolsActivePort 轮询总帽，缺省 20_000ms） */
  readonly startupTimeoutMs?: number;
  /** target 级事件汇（console 环形缓冲刀三接线——缺省走杂音口） */
  readonly onEvent?: (method: string, params: unknown, sessionId?: string) => void;
  /** 协议杂音出口（非事件通知——debug 级） */
  readonly onNoise?: (message: string) => void;
}

/** 会话取用产物：桥 + 隔离态（工具面消费——rpc 走 session 路由发 page 级命令） */
export interface SessionHandle {
  readonly rpc: CdpRpc;
  readonly session: SessionBrowserState;
  /** 引擎来源自述（fallbackWarning 在场 = 发现序回退过——工具结果披露面消费） */
  readonly engineNote?: string;
}

/**
 * 引擎管理器（件级单例——apply 期构造、effect 回卷终结）。
 * 全部闲置计时器 unref：不持活进程（TUI/测试自然退出）。
 */
export class BrowserEngine {
  private readonly deps: BrowserEngineDeps;
  /** 引擎状态（诊断面——status() 消费） */
  private status: EngineStatus = { state: 'idle' };
  /** 活连接（browser 级单连接——running 期非空） */
  private connection: CdpConnection | undefined;
  /** spawn 产物（attach 形态恒空） */
  private child: EngineChild | undefined;
  /** spawn 引擎路径（attach 形态记 '(attach)'） */
  private enginePath: string | undefined;
  /** 发现序产物（fallbackWarning 披露源） */
  private discovered: DiscoveredEngine | undefined;
  /** per-session 隔离态表（路由键 = sessionId；匿名兜底 '_default'） */
  private readonly contexts = new Map<string, SessionBrowserState>();
  /** per-session 闲置计时器表（与 contexts 同键同生命周期） */
  private readonly contextTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 引擎级闲置计时器（零活 context 期武装；任一取用即撤） */
  private engineIdleTimer: ReturnType<typeof setTimeout> | undefined;
  /** ensure 并发去重（同时首用只 spawn 一次） */
  private starting: Promise<void> | undefined;
  /** 永久关停旗（effect 回卷后 true——dispose 后不再复活，行重装载才重建） */
  private disposed = false;

  constructor(deps: BrowserEngineDeps) {
    this.deps = deps;
  }

  /** 诊断态（boot 通知/日志消费——不落 durable） */
  getStatus(): EngineStatus {
    return this.status;
  }

  /** 闲置时长取值（缺省 300s） */
  private get idleMs(): number {
    return this.deps.idleMs ?? 300_000;
  }

  /**
   * 会话取用主口（工具面每调用消费）：引擎 ensure（惰性 spawn/attach）+
   * per-session context ensure + 续命本 session。任一调用只续命本 session
   * （冷读 B2——不牵连他 session 的闲置钟，也不撤引擎闲置钟之外的钟）。
   */
  async acquireContext(sessionId: string | undefined): Promise<SessionHandle> {
    if (this.disposed) {
      // 永久关停后再取用 = 行已回卷（/reload 后旧闭包引用悬空调用）——
      // 响亮报引擎不可用而非静默复活
      throw new Error('browser 行已回卷——引擎已关停（重装载行后可用）');
    }
    await this.ensureRunning();
    const key = sessionId ?? '_default';
    // 引擎闲置钟撤防（有活 context 期引擎不闲置回收——只由 context 级钟驱动）
    this.clearEngineIdle();
    let session = this.contexts.get(key);
    if (session === undefined) {
      // rpc 必在（ensureRunning 刚保证 running）——防御位仅供类型收窄
      const conn = this.connection;
      if (conn === undefined) throw new Error('引擎未运行（内部状态不一致）');
      session = await openSessionContext(conn.rpc);
      this.contexts.set(key, session);
      this.deps.logger.debug(`browser context 建立（session=${key}，target=${session.targetId}）`);
    }
    this.touchContext(key);
    const engineNote = this.discovered?.fallbackWarning;
    return { rpc: this.connection!.rpc, session, ...(engineNote !== undefined ? { engineNote } : {}) };
  }

  /** 本 session 闲置钟续命（清旧钟 + 新钟到点 dispose 该 context） */
  private touchContext(key: string): void {
    const old = this.contextTimers.get(key);
    if (old !== undefined) clearTimeout(old);
    const timer = setTimeout(() => {
      void this.reapContext(key);
    }, this.idleMs);
    timer.unref?.();
    this.contextTimers.set(key, timer);
  }

  /** 单 context 闲置回收（dispose BrowserContext——engine 连接保持） */
  private async reapContext(key: string): Promise<void> {
    const timer = this.contextTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.contextTimers.delete(key);
    const session = this.contexts.get(key);
    if (session === undefined) return;
    this.contexts.delete(key);
    const conn = this.connection;
    if (conn !== undefined) {
      await disposeSessionContext(conn.rpc, session.browserContextId);
    }
    this.deps.logger.debug(`browser context 闲置回收（session=${key}）`);
    // 零活 context → 武装引擎闲置钟（第二级回收入口）
    if (this.contexts.size === 0) this.armEngineIdle();
  }

  /** 武装引擎闲置钟（零活 context 起算 idleMs → 引擎收场） */
  private armEngineIdle(): void {
    if (this.engineIdleTimer !== undefined) return; // 已武装不重置（零活起算时刻不变）
    this.engineIdleTimer = setTimeout(() => {
      this.engineIdleTimer = undefined;
      void this.closeEngine('引擎闲置回收');
    }, this.idleMs);
    this.engineIdleTimer.unref?.();
  }

  /** 撤防引擎闲置钟（任一 context 取用即撤——有活 context 期引擎不回收） */
  private clearEngineIdle(): void {
    if (this.engineIdleTimer !== undefined) {
      clearTimeout(this.engineIdleTimer);
      this.engineIdleTimer = undefined;
    }
  }

  /** 引擎 ensure（并发去重——同时首用只走一次 spawn/attach） */
  private async ensureRunning(): Promise<void> {
    if (this.status.state === 'running') return;
    if (this.starting === undefined) {
      this.starting = this.bringUp().finally(() => {
        this.starting = undefined;
      });
    }
    await this.starting;
  }

  /** 引擎起链（spawn 形态全链 / attach 形态只连） */
  private async bringUp(): Promise<void> {
    if (this.deps.config.cdpEndpoint !== undefined) {
      await this.bringUpAttach(this.deps.config.cdpEndpoint);
      return;
    }
    // ---- 发现序（每 spawn 重发现——配置/安装态可能已变） ----
    const discovered = discoverEngine(this.deps.config, join(this.deps.dataDir, 'browser', 'engine'));
    this.discovered = discovered;
    if (discovered.fallbackWarning !== undefined) {
      this.deps.logger.warn(`browser 引擎发现序回退：${discovered.fallbackWarning}`);
      this.deps.notify(`浏览器引擎发现序回退：${discovered.fallbackWarning}`, { level: 'warn' });
    }
    // ---- profile 目录（每次 spawn 新 bootId——双开不抢单例锁，M4） ----
    const bootId = randomUUID();
    const profileDir = join(this.deps.dataDir, 'browser', `profile-${bootId}`);
    mkdirSync(profileDir, { recursive: true });
    // ---- spawn（detached 组领导 = killTree 负 pid 语义前提；remote-allow-origins
    // 消除 WS Origin 校验失败类——非浏览器客户端不带 Origin，防御位保留无害） ----
    const args = [
      '--remote-debugging-port=0', // 端口 0 = 自动分配，落 DevToolsActivePort
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-allow-origins=*',
      ...((this.deps.config.headless ?? true) ? ['--headless=new'] : []),
    ];
    this.status = { state: 'starting' };
    const child = this.deps.spawnEngine({ command: discovered.path, args });
    this.child = child;
    this.enginePath = discovered.path;
    this.deps.registry.add({
      hostPid: process.pid,
      childPid: child.pid,
      server: 'browser-engine',
      command: discovered.path,
    });
    this.deps.logger.info(`browser 引擎 spawn（pid=${child.pid}，profile=profile-${bootId.slice(0, 8)}）`);

    // ---- DevToolsActivePort 轮询（spawn → 可握手之间的就绪信号） ----
    const wsUrl = await this.waitForDevToolsPort(profileDir, child);
    const connection = await CdpConnection.connect(wsUrl, this.deps.newConnection, {
      onEvent: this.deps.onEvent,
      onNoise: this.deps.onNoise,
    });
    this.adoptConnection(connection, { enginePath: discovered.path, attach: false });
    this.deps.notify('浏览器引擎已启动（本地 CDP 回环）');
  }

  /** attach 形态起链（只连不杀——无 spawn/登记簿/树杀链） */
  private async bringUpAttach(endpoint: string): Promise<void> {
    this.status = { state: 'starting' };
    const info = await fetchVersionInfo(endpoint);
    const connection = await CdpConnection.connect(info.webSocketDebuggerUrl, this.deps.newConnection, {
      onEvent: this.deps.onEvent,
      onNoise: this.deps.onNoise,
    });
    this.adoptConnection(connection, { enginePath: `(attach ${endpoint})`, attach: true });
    this.deps.notify(`浏览器引擎已 attach（${info.browser}）`);
  }

  /** 连接收养公共尾：死亡感知挂线 + 状态置 running */
  private adoptConnection(connection: CdpConnection, running: { enginePath: string; attach: boolean }): void {
    this.connection = connection;
    connection.onDead((reason) => this.onEngineDead(reason));
    this.status = { state: 'running', enginePath: running.enginePath, attach: running.attach };
  }

  /** 引擎死亡收场（意外死亡/闲置回收/主动 dispose 同口——按 status 辨因） */
  private onEngineDead(reason: string): void {
    const wasRunning = this.status.state === 'running';
    this.teardownConnection();
    if (wasRunning) {
      // 意外死亡（引擎 crash）——人读出口 + 状态落 closed；下一调用复活
      this.deps.logger.warn(`browser 引擎意外死亡：${reason}`);
      this.deps.notify(`浏览器引擎意外退出：${reason}`, { level: 'warn' });
    }
  }

  /** 物理收尾：连接置空 + 钟全清 + 子进程树杀/净退（幂等） */
  private teardownConnection(): void {
    this.clearEngineIdle();
    for (const [, timer] of this.contextTimers) clearTimeout(timer);
    this.contextTimers.clear();
    this.contexts.clear();
    this.connection = undefined;
    const child = this.child;
    this.child = undefined;
    this.enginePath = undefined;
    if (child !== undefined) {
      this.deps.killTree(child.pid, child.alive); // 树杀兜底（Browser.close 未达/竞态）
      this.deps.registry.remove(child.pid);
    }
    this.status = { state: 'closed' };
  }

  /** 引擎收场（闲置回收）：Browser.close 优雅 → 树杀兜底 → 净退 */
  private async closeEngine(reason: string): Promise<void> {
    const conn = this.connection;
    if (conn === undefined) return;
    this.status = { state: 'closed' }; // 先置 closed——onDead 收场辨因用
    try {
      await conn.rpc.request('Browser.close', undefined, { timeoutMs: 2_000 });
    } catch {
      // 优雅腿失败不拦收场——树杀兜底在后
    }
    conn.close(reason);
    this.teardownConnection();
    this.deps.logger.info(`browser 引擎收场（${reason}）`);
  }

  /** 永久关停（ctx.effect 回卷——行卸载/作用域终结） */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.closeEngine('行回卷关停');
  }

  /**
   * 轮询 DevToolsActivePort（profile 目录下两行：port + browser ws path）。
   * 超帽/引擎先死 → BROWSER_CONNECT_FAILED（连接期统一码——附启动帽上下文）。
   */
  private waitForDevToolsPort(profileDir: string, child: EngineChild): Promise<string> {
    const timeoutMs = this.deps.startupTimeoutMs ?? 20_000;
    const pollMs = 100;
    return new Promise<string>((resolve, reject) => {
      const startedAt = Date.now();
      const poll = (): void => {
        // 引擎先死 = 起链失败（Linux 缺库等形态——BROWSER_CONNECT_FAILED 附指引语义位）
        if (!child.alive()) {
          reject(
            new Error(
              `浏览器引擎启动即退出（exitCode 非 null）——可执行存在但依赖缺失（Linux 缺共享库时装 --with-deps 或换渠道引擎）`,
            ),
          );
          return;
        }
        let raw: string;
        try {
          raw = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8');
        } catch {
          if (Date.now() - startedAt > timeoutMs) {
            reject(new Error(`引擎就绪等待超时（>${timeoutMs}ms，DevToolsActivePort 未出现）`));
            return;
          }
          const timer = setTimeout(poll, pollMs);
          timer.unref?.();
          return;
        }
        const [portLine, pathLine] = raw.split('\n');
        if (portLine === undefined || pathLine === undefined || portLine.trim() === '') {
          if (Date.now() - startedAt > timeoutMs) {
            reject(new Error('DevToolsActivePort 内容异常（缺 port/ws path 行）'));
            return;
          }
          const timer = setTimeout(poll, pollMs);
          timer.unref?.();
          return;
        }
        resolve(`ws://127.0.0.1:${portLine.trim()}${pathLine.trim()}`);
      };
      poll();
    });
  }
}
