/**
 * L3 browser — 官方件 `builtin:browser`（契约篇 §6.10，默认层第十六行——
 * 第四十九批刀一）。
 *
 * 触发序：apply（登记簿孤儿清扫 → 引擎构造〔零 spawn——首用才起〕→ effect
 * 挂回卷 → ctx.browser provide）。与 lsp 同款惰性形态：工具面常驻注册不依赖
 * 引擎在线（刀二落），引擎首用才 spawn/attach。
 *
 * 零新 durable 词汇（裁决）：引擎生命周期走 logger + ui.notify——boot/回收/
 * 意外死亡均不落账；工具留痕走 tool_execution 通道（既有词汇）。
 */

import type { AppContext, BuiltinAppModule } from '../contracts/app.js';
import type { ToolsService } from '../contracts/tools.js';
import { describeError } from '../contracts/errors.js';
import type { CdpConnectionFactory } from './cdp.js';
import { BrowserEngine, type EngineChild, type EngineRegistryLike, type SessionHandle } from './engine.js';
import { installEngine } from './install.js';
import { registerBrowserTools } from './tools.js';
import { BROWSER_APP_CONFIG_SCHEMA, type BrowserAppConfig, type EngineStatus } from './types.js';

/** ui 通知面（引擎生命周期人读出口——channels 服务结构子集，lsp 同款） */
interface UiNotifyFace {
  notify(message: string, opts?: { level?: 'info' | 'warn' | 'error' }): void;
}

/**
 * 导航限流面（web 件 InflightGates 的结构子集——「两消费面同一 execute 同一
 * 限流」第三消费位。组合根持单例注入 web/browser 两件，契约篇 §6.10）。
 */
export interface BrowserGatesFace {
  /** 取主机在飞槽（排队等待不拒绝——排队中 abort 立即出队） */
  acquire(host: string, signal?: AbortSignal): Promise<void>;
  /** 释槽（统一出口必还——漏放即泄漏槽位） */
  release(host: string): void;
}

/** 命令注册面（channels 服务最小面——memory 件 ChannelsCommandFace 同构先例） */
interface ChannelsCommandFace {
  registerCommand(cmd: {
    readonly name: string;
    readonly description: string;
    readonly source?: string;
    handler(args: string): void | Promise<void>;
  }): () => void;
}

/** 装机消费的 ctx.fetch 服务面（窄面——fetch 清单腿 + downloadToFile 下载腿） */
interface FetchServiceFace {
  fetch(url: string, opts?: { caller?: string }): Promise<{ status: number; text: string; truncated: boolean }>;
  downloadToFile(
    url: string,
    opts: {
      destPath: string;
      allowedHosts: readonly string[];
      caller?: string;
    },
  ): Promise<{ finalUrl: string; bytes: number; sha256: string }>;
}

/**
 * ctx.browser 服务面（工具面〔刀二〕与补全/命令面〔刀三〕消费）。
 * 结构上即 BrowserEngine 的窄投——独立词面防消费方绑引擎实现类型。
 */
export interface BrowserService {
  /** 引擎诊断态（idle/starting/running/closed——boot 通知与日志同源） */
  status(): EngineStatus;
  /** per-session 隔离态取用（路由键 = ToolCtx.sessionId；匿名兜底 '_default'） */
  acquireContext(sessionId: string | undefined): Promise<SessionHandle>;
  /** 行回卷永久关停（诊断/测试面——生产回卷走 ctx.effect） */
  dispose(): Promise<void>;
}

/** 官方件构造依赖（装配期闭包注入——spawn/kill/桥核/登记簿上提组合根，lsp 同款治理） */
export interface BrowserAppDeps {
  /** 数据目录（profile/下载引擎/登记簿物理锚） */
  readonly dataDir: string;
  /** 裸 spawn 闭包（组合根 app/browser-spawn.ts——detached 组领导 + env 白名单） */
  readonly spawnEngine: (opts: { command: string; args: readonly string[] }) => EngineChild;
  /** 树杀原语（exec killTree 经组合根注入） */
  readonly killTree: (pid: number) => void;
  /** 子进程登记簿（组合根实例化——<dataDir>/browser/children.json） */
  readonly registry: EngineRegistryLike;
  /** JSON-RPC 桥核工厂（mcp JsonRpcConnection 经组合根注入——帧无关复用） */
  readonly newConnection: CdpConnectionFactory;
  /**
   * 导航限流面（组合根单例——与 web 件 fetch 共享同一 InflightGates 实例，
   * 契约篇 §6.10「第三消费位」；builtin-deps 装配注入）
   */
  readonly gates: BrowserGatesFace;
  /** 闲置回收时长（缺省 300s——测试注入小值；组合根诊断形态不传） */
  readonly idleMs?: number;
  /** 引擎启动等待帽（缺省 20s） */
  readonly startupTimeoutMs?: number;
}

/** 件工厂（builtins.ts 注册——恒注册，卸行靠 overlay 禁用） */
export function createBrowserApp(deps: BrowserAppDeps): BuiltinAppModule {
  return {
    name: 'browser',
    config: BROWSER_APP_CONFIG_SCHEMA,
    // ui = 引擎生命周期通知；tools = 刀二工具面注册；channels = /browser install
    // 命令注册（Ring 1 必备行恒在——memory 件同律硬依赖）。
    // fetch = **软依赖**：web 行是 Ring 2 真可卸——禁 web 行时 /browser install
    // 诚实缺席附指引（tryGet 降级），不级联拒启整机（契约篇 §6.10 冷读裁决）
    inject: ['ui', 'tools', 'channels'],
    optionalInject: ['fetch'],
    apply: (ctx: AppContext, config?: Readonly<Record<string, unknown>>) => {
      const ui = ctx.get<UiNotifyFace>('ui');
      // 行 config（装载面已按 schema 校验——此处窄读消费键）
      const cfg = (config ?? {}) as BrowserAppConfig;

      /* ---- 云端 provider 占位（凭证检测 + 优先级链数据面——执行面零接） ---- */
      detectProviders(cfg, ui, ctx);

      // 孤儿清扫（先于自家 spawn——上次宿主非正常退出残留的引擎进程树）。
      // kill 探针直连 killTree（exec/mcp/lsp 三消费腿同形）：非正 pid 死账在
      // sweep 单点归类 reaped 不进 kill 面（遗漏大扫 20260904 #16，契约篇
      // §6.6 死账分类单点）——消费闭包 pid>0 卫（§6.10 ⑧ 原修法）退役：双守
      // 会掩盖单点执法回归（sweep 侧漏卫时消费卫仍拦 = 红锁测不出单点失守）
      void deps.registry
        .sweep({
          kill: deps.killTree,
        })
        .then((report) => {
          if (report.killed.length > 0) {
            ctx.logger.warn(`browser 孤儿引擎清扫 ${report.killed.length} 株（${report.killed.join(',')}）`);
          }
        });

      // 引擎构造（零 spawn——首用才起链；notify/logger 经 ctx 接线）
      const engine = new BrowserEngine({
        dataDir: deps.dataDir,
        config: cfg,
        spawnEngine: deps.spawnEngine,
        killTree: deps.killTree,
        registry: deps.registry,
        newConnection: deps.newConnection,
        logger: ctx.logger,
        notify: (message, opts) => ui.notify(message, opts),
        ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
        ...(deps.startupTimeoutMs !== undefined ? { startupTimeoutMs: deps.startupTimeoutMs } : {}),
      });

      // 服务注册（词面 ctx.browser——刀二工具面/刀三命令面消费）
      const service: BrowserService = {
        status: () => engine.getStatus(),
        acquireContext: (sessionId) => engine.acquireContext(sessionId),
        dispose: () => engine.dispose(),
      };
      ctx.provide('browser', service);

      // 工具面十件注册（刀二——模型面 ctx.effect：行回卷同批注销）
      ctx.effect(() => {
        const tools = ctx.get<ToolsService>('tools');
        const disposers = registerBrowserTools({
          service,
          dataDir: deps.dataDir,
          gates: deps.gates,
          register: (def) => tools.register(def),
        });
        return () => {
          for (const dispose of disposers) dispose();
        };
      });

      /* ---- /browser install 命令（装机运维动词——不进模型工具面） ----
       * 显式命令不自动下载（150MB 级惊喜下载不可接受——发现序④指引文本即
       * 指向本命令）。web 件缺席（Ring 2 真可卸）= 诚实缺席附指引非级联失败。 */
      const channels = ctx.get<ChannelsCommandFace>('channels');
      ctx.effect(() =>
        channels.registerCommand({
          name: 'browser',
          description:
            '浏览器引擎装机：/browser install（下载 Chrome for Testing 稳定版至数据目录 engine/——150MB 级下载，幂等可重跑）',
          source: 'app',
          handler: async (args: string) => {
            if (args.trim() !== 'install') {
              ui.notify('用法：/browser install（下载 Chrome for Testing 稳定版引擎）');
              return;
            }
            const fetchSvc = ctx.tryGet<FetchServiceFace>('fetch');
            if (fetchSvc === undefined || typeof fetchSvc.downloadToFile !== 'function') {
              ui.notify(
                '/browser install 不可用：web 件（ctx.fetch 服务）未装载——装机下载原语缺席。\n' +
                  '替代：装系统 Chrome（macOS /Applications 或 Linux 包管理器），或在 browser 行 config 配 executablePath。',
                { level: 'warn' },
              );
              return;
            }
            ui.notify('引擎装机开始：解析 Chrome for Testing 稳定版清单…');
            try {
              const report = await installEngine({
                manifestFetch: (url, opts) => fetchSvc.fetch(url, opts),
                download: (url, opts) => fetchSvc.downloadToFile(url, opts),
                dataDir: deps.dataDir,
                // 降级可见面：摘要账本损坏/写失败点名（P1-4——纯保护面不 brick 装机）
                warn: (message) => ctx.logger.warn(message),
              });
              if (report.alreadyInstalled) {
                ui.notify(
                  `引擎已装（Chrome for Testing ${report.version}）——无需重装。\n路径：${report.enginePath ?? '(布局表未命中——请检查 engine/ 目录)'}`,
                );
                return;
              }
              ui.notify(
                `装机完成：Chrome for Testing ${report.version}（${report.slot.key}）\n` +
                  `路径：${report.enginePath ?? '(布局表未命中——请检查 engine/ 目录)'}\n` +
                  `校验：SHA256 ${report.sha256.slice(0, 12)}…（${report.bytes} 字节，锚定摘要账本 digests.json + 记档 install.json）`,
              );
            } catch (err) {
              ui.notify(`装机失败：${describeError(err)}`, { level: 'error' });
            }
          },
        }),
      );

      // 行回卷：引擎永久关停（Browser.close 优雅 → 树杀兜底 → 登记簿净退）
      ctx.effect(() => {
        return () => {
          void engine.dispose();
        };
      });
    },
  };
}

/**
 * 云端 provider 占位检测（契约篇 §6.10「云端 provider 占位」段）：
 * 凭证在场 → ui.notify 一条（level info——「云端已配置、v1 未接执行面，引擎
 * 恒本地」）+ logger.debug 记优先级链解析结果（BrowserUse > Browserbase >
 * local——数据面自我披露，不落 durable）。执行面零接（真云接入挂账）。
 */
function detectProviders(cfg: BrowserAppConfig, ui: UiNotifyFace, ctx: AppContext): void {
  const browseruse = cfg.providers?.browseruse?.apiKey;
  const browserbase = cfg.providers?.browserbase?.apiKey;
  const hasBrowseruse = browseruse !== undefined && browseruse !== '';
  const hasBrowserbase = browserbase !== undefined && browserbase !== '';
  if (!hasBrowseruse && !hasBrowserbase) return; // 无凭证零面（常态）
  const configured = [hasBrowseruse ? 'browseruse' : '', hasBrowserbase ? 'browserbase' : ''].filter((s) => s !== '');
  // 优先级链数据面（BrowserUse > Browserbase > local——v1 只解析不路由）
  const chain = [hasBrowseruse ? 'BrowserUse' : '', hasBrowserbase ? 'Browserbase' : '', '本地引擎'].filter(
    (s) => s !== '',
  );
  ui.notify(
    `云端 provider 已配置（${configured.join(', ')}）——v1 未接云端执行面，引擎恒本地。` +
      '优先级链数据面：' +
      chain.join(' > '),
    { level: 'info' },
  );
  ctx.logger.debug(`browser provider 占位链解析：${chain.join(' > ')}（执行面零接——真云接入挂账）`);
}
