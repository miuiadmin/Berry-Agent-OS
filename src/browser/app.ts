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
import type { CdpConnectionFactory } from './cdp.js';
import { BrowserEngine, type EngineChild, type EngineRegistryLike, type SessionHandle } from './engine.js';
import { registerBrowserTools } from './tools.js';
import { BROWSER_APP_CONFIG_SCHEMA, type BrowserAppConfig, type EngineStatus } from './types.js';

/** ui 通知面（引擎生命周期人读出口——channels 服务结构子集，lsp 同款） */
interface UiNotifyFace {
  notify(message: string, opts?: { level?: 'info' | 'warn' | 'error' }): void;
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
  readonly killTree: (pid: number, alive: () => boolean) => void;
  /** 子进程登记簿（组合根实例化——<dataDir>/browser/children.json） */
  readonly registry: EngineRegistryLike;
  /** JSON-RPC 桥核工厂（mcp JsonRpcConnection 经组合根注入——帧无关复用） */
  readonly newConnection: CdpConnectionFactory;
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
    inject: ['ui', 'tools'], // ui = 引擎生命周期通知；tools = 刀二工具面注册（行序 browser 最末亦稳）
    apply: (ctx: AppContext, config?: Readonly<Record<string, unknown>>) => {
      const ui = ctx.get<UiNotifyFace>('ui');
      // 行 config（装载面已按 schema 校验——此处窄读消费键）
      const cfg = (config ?? {}) as BrowserAppConfig;

      // 孤儿清扫（先于自家 spawn——上次宿主非正常退出残留的引擎进程树）
      void deps.registry.sweep({ kill: (pid) => deps.killTree(pid, () => true) }).then((report) => {
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
          register: (def) => tools.register(def),
        });
        return () => {
          for (const dispose of disposers) dispose();
        };
      });

      // 行回卷：引擎永久关停（Browser.close 优雅 → 树杀兜底 → 登记簿净退）
      ctx.effect(() => {
        return () => {
          void engine.dispose();
        };
      });
    },
  };
}
