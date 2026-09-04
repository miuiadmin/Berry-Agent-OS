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
 * - 引擎在零活 context 状态闲置 idleMs → spawn 形态 Browser.close 优雅收场
 *   + 树杀兜底（下一调用重新 ensure——spawn 形态换新 bootId 复活）；attach
 *   形态只断连（只连不杀——契约篇 §6.10）。
 *
 * 生命周期收口六修（2026-09-01 遗漏大扫 20260901-b 第五十三批）：attach 收场
 * 只断连 / 起链失败即清算本 child（树杀+净退+closed）/ context 建链半途失败
 * 回滚三表 + 重武装闲置钟 / 连接期失败统一 BROWSER_CONNECT_FAILED / 收场
 * 代际护栏（closeEngine await 窗内换代只结算本代——context 归属判据 = 开
 * context 所用的连接）。另两前置闸：运行时 Node 版本闸（#15）与双配冲突闸
 * （#26——cdpEndpoint×executablePath 同给 BROWSER_CONFIG_CONFLICT）。
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
  AppError,
  BROWSER_CONFIG_CONFLICT,
  BROWSER_CONNECT_FAILED,
  BROWSER_NODE_UNSUPPORTED,
} from '../contracts/errors.js';
import { applyCaptureEvent, SessionCapture } from './capture.js';
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

/** 运行时最低 Node 版本（package.json engines 同源——WebSocket 全局自 Node 22 起在场） */
const MIN_NODE_CORE = [24, 0, 0] as const;

/**
 * Node 运行时版本闸（纯函数——遗漏大扫 20260901-b #15）：bringUp 入口消费。
 * @param v process.versions.node 形态串（`24.1.0` / `22.19.1`；带尾缀按主三段判）
 * @returns undefined = 过闸；否则 = 拒绝理由（AppError 文案直接用）
 */
export function nodeVersionProblem(v: string): string | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  // 非法形态按 0.0.0 兜底判红（fail-closed——未知版本不放行）
  const core = m === null ? [0, 0, 0] : [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (core[i]! < MIN_NODE_CORE[i]!) {
      return `Node ${v} 低于运行时要求（≥24.0）——与 engines 下界对齐。请升级 Node（如 nvm install 24）后重试`;
    }
    if (core[i]! > MIN_NODE_CORE[i]!) break; // 高位已过线，低位不再看
  }
  return undefined;
}

/** 裸 spawn 产物结构（组合根 browser-spawn.ts 投影——pid + 活探测两键） */
export interface EngineChild {
  /** 引擎进程 pid。undefined = spawn 失败腿（EACCES/ENOEXEC 等——无进程可
   *  杀）。禁止 -1 哨兵代偿（全面复盘 20260903 #18，契约篇 §6.10 ⑧）：POSIX
   *  process.kill(-pid) 收 -1 时归一为 kill(1) = 杀 init/自身；消费面统一以
   *  undefined 判缺席（killTree 原生 undefined 早退 = 批 90 统一语义）。 */
  readonly pid: number | undefined;
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
  readonly killTree: (pid: number) => void;
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

/** 会话取用产物：桥 + 隔离态 + 捕获态（工具面消费——rpc 走 session 路由发 page 级命令） */
export interface SessionHandle {
  readonly rpc: CdpRpc;
  readonly session: SessionBrowserState;
  /** per-session 捕获态（console 环形缓冲 + a11y ref 表——刀二） */
  readonly capture: SessionCapture;
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
  /** 发现序产物（fallbackWarning 披露源） */
  private discovered: DiscoveredEngine | undefined;
  /** per-session 隔离态表（路由键 = sessionId；匿名兜底 '_default'） */
  private readonly contexts = new Map<string, SessionBrowserState>();
  /** per-session 捕获态表（与 contexts 同键同生命周期——刀二捕获条款） */
  private readonly captures = new Map<string, SessionCapture>();
  /** context 归属表（路由键 → 开该 context 所用的连接——代际护栏的归属判据，#17） */
  private readonly contextOwners = new Map<string, CdpConnection>();
  /** CDP sessionId → 路由键反查表（事件分流后定位所属捕获态） */
  private readonly keyByCdpSession = new Map<string, string>();
  /** per-session 闲置计时器表（与 contexts 同键同生命周期） */
  private readonly contextTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 引擎级闲置计时器（零活 context 期武装；任一取用即撤） */
  private engineIdleTimer: ReturnType<typeof setTimeout> | undefined;
  /** ensure 并发去重（同时首用只 spawn 一次） */
  private starting: Promise<void> | undefined;
  /** 已收场的代际簿（代收尾幂等——onDead 收场与显式收场同代只结算一次） */
  private readonly tornDown = new WeakSet<CdpConnection>();
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
    // 竞速窗复查（遗漏大扫 20260902 #5）：ensureRunning 在飞期行回卷（或入口检查
    // 后、ensureRunning 前整段 dispose 跑完）——刚起出的引擎不向已回卷行返回活
    // 句柄，就地收场 + 响亮失败（与 dispose 的竞速窗补刀幂等——tornDown 同代只
    // 结算一次，两腿先后到达不双杀）
    if (this.disposed) {
      await this.closeEngine('行已回卷（竞速窗收场）');
      throw new Error('browser 行已回卷——引擎已关停（重装载行后可用）');
    }
    const key = sessionId ?? '_default';
    // 引擎闲置钟撤防（有活 context 期引擎不闲置回收——只由 context 级钟驱动）
    this.clearEngineIdle();
    let session = this.contexts.get(key);
    if (session === undefined) {
      // rpc 必在（ensureRunning 刚保证 running）——防御位仅供类型收窄
      const conn = this.connection;
      if (conn === undefined) throw new Error('引擎未运行（内部状态不一致）');
      try {
        session = await openSessionContext(conn.rpc);
        this.contexts.set(key, session);
        // 捕获态挂载 + 事件分流索引（刀二：console/异常/dialog 事件源随 context 建立）
        this.captures.set(key, new SessionCapture());
        this.contextOwners.set(key, conn); // 归属记本代连接（代际护栏判据，#17）
        this.keyByCdpSession.set(session.sessionId, key);
        // page 级域启用三域（fail-loud：域启用失败 = context 建立失败——不留静默
        // 半捕获态）：Runtime = console/异常事件源；Page = dialog 事件源；DOM =
        // getFlattenedDocument 门控（真 Chrome 未 enable DOM 拒 -32000——第九轮
        // 全面复盘 20260903 #2 同笔）
        await conn.rpc.request('Runtime.enable', undefined, { sessionId: session.sessionId });
        await conn.rpc.request('Page.enable', undefined, { sessionId: session.sessionId });
        await conn.rpc.request('DOM.enable', undefined, { sessionId: session.sessionId });
      } catch (err) {
        // 建链半途失败即回滚（#3）：不留「session 在表但域永未启用」的半捕获态——
        // 三表回滚 + 尽力 dispose（连接可能已坏，容错不拦上抛）+ 零活 context
        // 重武装引擎闲置钟（否则起建失败后闲置钟永久失防 = 引擎悬死不回收）
        this.contexts.delete(key);
        this.captures.delete(key);
        this.contextOwners.delete(key);
        if (session !== undefined) {
          this.keyByCdpSession.delete(session.sessionId);
          await disposeSessionContext(conn.rpc, session.browserContextId).catch(() => undefined);
        }
        if (this.contexts.size === 0) this.armEngineIdle();
        throw err;
      }
      this.deps.logger.debug(`browser context 建立（session=${key}，target=${session.targetId}）`);
    }
    this.touchContext(key);
    const engineNote = this.discovered?.fallbackWarning;
    const capture = this.captures.get(key)!;
    return { rpc: this.connection!.rpc, session, capture, ...(engineNote === undefined ? {} : { engineNote }) };
  }

  /**
   * target 级事件路由（连接级单口——bringUp 两形态统一接线）：
   * ① CDP sessionId 反查路由键 → 所属捕获态消费（console/异常进环形缓冲；
   *    dialog 出 dismiss 判定 → 本层持 rpc 回发——capture 件零协议发送）；
   * ② 尾部透传 deps.onEvent（外部观察面/刀三接线）。
   */
  private readonly routeEvent = (method: string, params: unknown, sessionId?: string): void => {
    if (sessionId !== undefined) {
      const key = this.keyByCdpSession.get(sessionId);
      const capture = key === undefined ? undefined : this.captures.get(key);
      if (capture !== undefined) {
        const outcome = applyCaptureEvent(capture, method, params);
        if (outcome?.dialog !== undefined) {
          // JS dialog 自动 dismiss（v1 缺省裁决——不弹审批不开 allow 旋钮）；
          // 吞竞态错误：dialog 可能已被页面导航收走（回执失败不影响缓冲已记账）
          const rpc = this.connection?.rpc;
          if (rpc !== undefined && !rpc.isClosed) {
            void rpc.request('Page.handleJavaScriptDialog', { accept: false }, { sessionId }).catch(() => undefined);
          }
        }
      }
    }
    this.deps.onEvent?.(method, params, sessionId);
  };

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
    // 捕获态同键回收（console 缓冲/ref 表随 context 丢弃——重新建立即空态）
    this.captures.delete(key);
    this.contextOwners.delete(key);
    this.keyByCdpSession.delete(session.sessionId);
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
      // fire-and-forget 收口律（契约篇 §6.10 泛化——一切 void 异步腿必带失败
      // 收口；遗漏大扫 20260904-c 刀B）：closeEngine 现行抛面经分析为零
      // （Browser.close 已 catch；teardownGeneration 的净退失败被 fireDead
      // 回调派发层吸收——live-test 实录，契约篇 §6.6 同批裁定），本 .catch 是
      // 律令层防御——防未来抛面扩张，失败降 warn 不炸宿主
      void this.closeEngine('引擎闲置回收').catch((err: unknown) => {
        this.deps.logger.warn(`browser 引擎闲置回收失败收口：${String(err)}`);
      });
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
    // 运行时版本闸（遗漏大扫 20260901-b #15，生命周期收口⑥）：两形态共用入口
    // 先验——engines 缺省 advisory 只警告，不达标时装机/boot/对话全正常，cdp 连接
    // 层 new WebSocket 首用才以裸 ReferenceError 延迟爆炸（与根因距离极远）。此闸
    // 把失败提前到 spawn/连接之前 + 错误码带升级指引（不留半建态不留野进程）。
    const problem = nodeVersionProblem(process.versions.node);
    if (problem !== undefined) throw new AppError(BROWSER_NODE_UNSUPPORTED, problem);
    // 双配冲突闸（遗漏大扫 20260901-b #26）：attach 既有引擎（cdpEndpoint）与
    // 指定引擎路径（executablePath）互斥——规范「配置错 fail-loud」条款的执法位。
    // 静默走 attach 丢弃 executablePath = 用户自配路径被无声吞掉（types.ts 注释
    // 自书「互斥」却零执法）；闸在 spawn/连接之前，status 原地可改配置后重试。
    if (this.deps.config.cdpEndpoint !== undefined && this.deps.config.executablePath !== undefined) {
      throw new AppError(
        BROWSER_CONFIG_CONFLICT,
        'cdpEndpoint 与 executablePath 互斥（同给 = 配置错）——前者连既有引擎不 spawn，后者指定引擎路径，两者不能同时生效；请只保留其一',
      );
    }
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
    // 入口状态快照（遗漏大扫 20260901-d #17）：失败腿回放锚——交叠窗内（旧代
    // closeEngine 先置 closed 后 await Browser.close）入口值即 closed，常态冷
    // 启动入口亦 closed，两形一致
    const entryStatus = this.status;
    this.status = { state: 'starting' };
    // spawn 调用位并入 try（遗漏大扫 20260904 #1，契约篇 §6.10 ⑧ 同步腿）：
    // ENOEXEC 形态（文件过发现序 X_OK 但非可执行格式——截断二进制/垃圾内容）
    // 在本仓目标平台（macOS / Node 24）实测于 spawn 调用位**同步抛**——裸抛在
    // try 外会直接穿出 bringUp：status 钉死 'starting'（#17 状态不谎报的反面）
    // + 清算零执行。声明提升到 try 外；同步腿抛出时 child 保持 undefined，
    // teardownGeneration 各判据守卫双缺席（不树杀不净退），失败原样上抛。
    let child: EngineChild | undefined;
    try {
      child = this.deps.spawnEngine({ command: discovered.path, args });
      this.child = child;
      // pid 缺席形态不入登记簿（全面复盘 20260903 #18，契约篇 §6.10 ⑧）：spawn
      // 失败腿（child.pid undefined——无进程可杀）入册只会留 children.json 死账，
      // 且遗留 -1 哨兵条目会被下次启动清扫再触 kill(1) 链——在场才记
      if (child.pid !== undefined) {
        this.deps.registry.add({
          hostPid: process.pid,
          childPid: child.pid,
          server: 'browser-engine',
          command: discovered.path,
        });
      }
      this.deps.logger.info(
        `browser 引擎 spawn（pid=${child.pid ?? 'n/a（spawn 失败腿——无进程）'}，profile=profile-${bootId.slice(0, 8)}）`,
      );

      // ---- DevToolsActivePort 轮询（spawn → 可握手之间的就绪信号） ----
      const wsUrl = await this.waitForDevToolsPort(profileDir, child);
      const connection = await CdpConnection.connect(wsUrl, this.deps.newConnection, {
        onEvent: this.routeEvent, // 统一走事件路由（捕获态消费 + 外部透传）
        onNoise: this.deps.onNoise,
      });
      this.adoptConnection(connection, { enginePath: discovered.path, attach: false });
    } catch (err) {
      // 起链失败即清算本 child（#2/#9）：活 Chrome 不留野、登记簿不留尸、
      // 状态不谎报 starting（收场后置 closed）——失败原样上抛，下一调用照常复活。
      // conn 恒传 undefined（#23）：本代从未收养连接（adoptConnection 只在成功
      // 尾部置 this.connection），此刻现值必属别代——传现值会抢别代连接的
      // tornDown 幂等闸位，别代自身收场的树杀/登记簿净退被闸吞
      this.teardownGeneration({ conn: undefined, child });
      // 交叠窗状态回放（遗漏大扫 20260901-d #17，契约篇 §6.10 修⑤ 勘正）：复位
      // 合取可能因旧代连接仍在位而不成立（旧代 closeEngine 的 Browser.close 2s
      // await 窗交叠）——status 残留本腿所置 starting 即回放入口快照（窗内入口值
      // = 旧代先置的 closed），诊断面不谎报；常态腿复位已落 closed 时守卫不命中
      if (this.status.state === 'starting') this.status = entryStatus;
      throw err;
    }
    this.deps.notify('浏览器引擎已启动（本地 CDP 回环）');
  }

  /** attach 形态起链（只连不杀——无 spawn/登记簿/树杀链） */
  private async bringUpAttach(endpoint: string): Promise<void> {
    // 入口状态快照（d 轮 #17，与 spawn 腿同律）：失败腿回放锚
    const entryStatus = this.status;
    this.status = { state: 'starting' };
    // 端点发现与握手产物（通知面消费浏览器自报名——收进 try 保持单出口）
    let browserName = '(unknown)';
    try {
      const info = await fetchVersionInfo(endpoint);
      browserName = info.browser;
      const connection = await CdpConnection.connect(info.webSocketDebuggerUrl, this.deps.newConnection, {
        onEvent: this.routeEvent, // 统一走事件路由（捕获态消费 + 外部透传）
        onNoise: this.deps.onNoise,
      });
      this.adoptConnection(connection, { enginePath: `(attach ${endpoint})`, attach: true });
    } catch (err) {
      // 连不上即收场复位（#9：状态不谎报 starting）——attach 无 child 零清算面；
      // conn 恒传 undefined（#23，与 spawn 失败腿同律）：此刻 this.connection
      // 现值属别代（本代从未收养），不得借 teardown 抢别代幂等闸位
      this.teardownGeneration({ conn: undefined, child: undefined });
      // 交叠窗状态回放（d 轮 #17，与 spawn 失败腿同律——契约篇 §6.10 修⑤ 勘正）
      if (this.status.state === 'starting') this.status = entryStatus;
      throw err;
    }
    this.deps.notify(`浏览器引擎已 attach（${browserName}）`);
  }

  /** 连接收养公共尾：死亡感知挂线（携带本代 conn/child 快照——代际护栏，#17）+ 状态置 running */
  private adoptConnection(connection: CdpConnection, running: { enginePath: string; attach: boolean }): void {
    this.connection = connection;
    // 本代快照随闭包固化：死亡回调只清算本代产物（窗内换代不误伤新代）
    const childAtAdopt = this.child;
    connection.onDead((reason) => this.onEngineDead(reason, connection, childAtAdopt));
    this.status = { state: 'running', enginePath: running.enginePath, attach: running.attach };
  }

  /** 引擎死亡收场（意外死亡/闲置回收/主动 dispose 同口——按 status 辨因；代际快照由挂线闭包携带） */
  private onEngineDead(reason: string, conn: CdpConnection, child: EngineChild | undefined): void {
    const wasRunning = this.status.state === 'running';
    this.teardownGeneration({ conn, child });
    if (wasRunning) {
      // 意外死亡（引擎 crash）——人读出口 + 状态落 closed；下一调用复活
      this.deps.logger.warn(`browser 引擎意外死亡：${reason}`);
      this.deps.notify(`浏览器引擎意外退出：${reason}`, { level: 'warn' });
    }
  }

  /**
   * 本代收尾（幂等——同代只结算一次）：本代 context 簿记清算（归属判据 =
   * 开 context 所用的连接）+ 闲置钟撤防 + 共享引用代际护栏 + 本代 child
   * 树杀/登记簿净退。
   *
   * 代际护栏（#17）：closeEngine 的 await 窗（Browser.close 在飞）内并发
   * bringUp 换代时——新代的 connection/child/status 与新代 context 簿记
   * 一律不动，本收场只结算本代产物。
   */
  private teardownGeneration(atClose: { conn: CdpConnection | undefined; child: EngineChild | undefined }): void {
    if (atClose.conn !== undefined) {
      // 同代幂等闸（onDead 收场与显式收场同代只跑一次——树杀/净退不重复）
      if (this.tornDown.has(atClose.conn)) return;
      this.tornDown.add(atClose.conn);
    }
    this.clearEngineIdle();
    for (const [key, owner] of [...this.contextOwners]) {
      // 只清算归属本代的 context（换代期新代 context 簿记不动）
      if (owner !== atClose.conn) continue;
      const timer = this.contextTimers.get(key);
      if (timer !== undefined) clearTimeout(timer);
      this.contextTimers.delete(key);
      this.contextOwners.delete(key);
      const session = this.contexts.get(key);
      if (session !== undefined) {
        this.contexts.delete(key);
        this.captures.delete(key);
        this.keyByCdpSession.delete(session.sessionId);
      }
    }
    // 共享引用护栏：仍指向本代产物才清（换代 = 新代引用原位不动）。三判据分立
    // （#23）：conn/child/status 各按自判据清算不嵌套——起链失败腿 conn=undefined
    // （本代从未收养）不清别代 connection，但仍清本代 child（判据 =
    // this.child === 本代 child），并在 connection 与 child 均不再在位时复位
    // status 为 closed（判据缺席不清算 = 旧回归面：this.child 残壳 + starting 谎报）
    if (this.connection === atClose.conn) this.connection = undefined;
    if (this.child === atClose.child) {
      this.child = undefined;
    }
    if (this.connection === undefined && this.child === undefined) {
      this.status = { state: 'closed' };
    }
    if (atClose.child !== undefined && atClose.child.pid !== undefined) {
      // pid 在场才树杀/净退（全面复盘 20260903 #18）：undefined = spawn 失败腿
      // （无进程可杀、也从未入册）——两调用在此形下都是死账面动作
      this.deps.killTree(atClose.child.pid); // 树杀兜底（Browser.close 未达/竞态）
      this.deps.registry.remove(atClose.child.pid);
    }
  }

  /**
   * 引擎收场（闲置回收/永久关停）：spawn 形态 Browser.close 优雅 → 树杀兜底；
   * **attach 形态只断连**（契约篇 §6.10「只连不杀」——Browser.close 会杀掉
   * 用户自起的浏览器，attach 形态不拥引擎生命周期，关停仅拆自己的连接）。
   */
  private async closeEngine(reason: string): Promise<void> {
    const conn = this.connection;
    if (conn === undefined) return;
    // 代际快照（#17）：await 窗内换代时本收场只结算本代
    const atClose = { conn, child: this.child };
    const attachAtClose = this.status.state === 'running' ? this.status.attach : false;
    this.status = { state: 'closed' }; // 先置 closed——onDead 收场辨因用
    if (!attachAtClose) {
      try {
        await conn.rpc.request('Browser.close', undefined, { timeoutMs: 2_000 });
      } catch {
        // 优雅腿失败不拦收场——树杀兜底在后
      }
    }
    conn.close(reason);
    this.teardownGeneration(atClose);
    this.deps.logger.info(`browser 引擎收场（${reason}${attachAtClose ? '——attach 形态只断连' : ''}）`);
  }

  /** 永久关停（ctx.effect 回卷——行卸载/作用域终结） */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.closeEngine('行回卷关停');
    // 竞速窗补刀（遗漏大扫 20260902 #5）：首段 closeEngine 时 bringUp 可能仍在飞
    // ——conn 未收养即早退，起出的引擎无人结算（post-dispose 僵尸滞留闲置双钟）。
    // 等在飞起链落定后再补一刀（起出即收）；起链失败不拦收场（吞掉 rejection）
    const inflight = this.starting;
    if (inflight !== undefined) {
      await inflight.catch(() => undefined);
      await this.closeEngine('行回卷关停（竞速窗补刀）');
    }
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
            new AppError(
              BROWSER_CONNECT_FAILED,
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
            reject(
              new AppError(BROWSER_CONNECT_FAILED, `引擎就绪等待超时（>${timeoutMs}ms，DevToolsActivePort 未出现）`),
            );
            return;
          }
          const timer = setTimeout(poll, pollMs);
          timer.unref?.();
          return;
        }
        const [portLine, pathLine] = raw.split('\n');
        if (portLine === undefined || pathLine === undefined || portLine.trim() === '') {
          if (Date.now() - startedAt > timeoutMs) {
            reject(new AppError(BROWSER_CONNECT_FAILED, 'DevToolsActivePort 内容异常（缺 port/ws path 行）'));
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
