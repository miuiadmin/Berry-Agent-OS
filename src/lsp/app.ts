/**
 * L3 lsp — 官方件 `builtin:lsp`（契约篇 §6.7 第一刀，默认层第十二行，Ring 2 真·可卸）。
 *
 * 触发序：apply（登记簿孤儿清扫 → effect 挂回卷）→ 静态四工具注册 + post 行
 * 注册——**零后台发现**（LSP 工具面静态四件，注册不依赖服务器在线；与 MCP
 * 「装配后异步发现」结构性不同：服务器首用才 spawn，惰性兑现为字面义）。
 *
 * 冷读 blocker 1 修法②+③并采（post 段 5s 硬钟内的快径设计）：
 * - post 行**只消费已活实例**——快径：并发同步全部路径 + 单竞速钟等诊断，
 *   等待上限 = min(diagnostics_timeout_ms, 3500ms) 硬帽（post 段整段竞速
 *   postTimeoutMs 缺省 5s 是管道属性不为 lsp 提钟，格式化余量 1.5s）；
 * - **拉起移出 post 路径**：实例未活/预热在途 = fire-and-forget 后台预热
 *   （scope 活护栏）+ 首触一次性注记「预热中」+ 本次跳过注入。
 *
 * contained 铁律（冷读 major 2）：诊断注入失败 = 吞错 + logger.warn + 不追加
 * 诊断段，**绝不改写原结果、绝不置 isError**——诊断是增益不是策略，注入路径
 * 任何异常不得把已成功落盘的写结果炸成错误。
 *
 * crash 语义：实例标败 + ui.notify warn + 连败计数；**同 server 3 连败熔断**
 * （实例级旗标，复位走 /reload；行内他服务器不受累）。
 *
 * 子进程治理：ChildRegistry 类经组合根注入（exec 腿先例——lsp 零 mcp import，
 * 登记簿物理面 `<dataDir>/lsp/children.json` 由组合根实例化时钉死）。
 */

import { sep } from 'node:path';
import {
  AppError,
  APP_CONFIG_INVALID,
  LSP_CONNECT_FAILED,
  TOOL_DESCRIPTION_REJECTED,
  TOOL_DUPLICATE,
  TOOL_TIMEOUT,
  describeError,
} from '../contracts/errors.js';
import type { AgentToolResult, ToolDefinition, ToolsService } from '../contracts/tools.js';
import { TOOL_POST_EXECUTE_EVENT, type PostInput } from '../contracts/tools.js';
import type { BuiltinAppModule, AppContext } from '../contracts/app.js';
import { Type } from '../contracts/typebox.js';
import type { Disposer } from '../context/types.js';
import {
  connectLspServer,
  DEFAULT_DIAGNOSTICS_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  type JsonRpcConnectionFactory,
  type LspServerConnection,
  type SpawnedProcess,
  uriOf,
} from './client.js';
import {
  LSP_APP_CONFIG_SCHEMA,
  LSP_SERVER_NAME_PATTERN,
  type LspDiagnostic,
  type LspDocumentSymbol,
  type LspLocation,
  type LspServerConfig,
} from './types.js';

/** ui 通知面（连接失败/运行期退出/预热首触的人读出口——channels 服务结构子集） */
interface UiNotifyFace {
  notify(message: string, opts?: { level?: 'info' | 'warn' | 'error' }): void;
}

/**
 * 子进程登记簿结构子集（mcp ChildRegistry 的结构投影——组合根注入真类，
 * 本模块零 mcp import；物理面 <dataDir>/lsp/children.json 由实例化路径钉死）。
 */
export interface ChildRegistryLike {
  /** spawn 即登记（hostPid/childPid/server/command 同形） */
  add(entry: { hostPid: number; childPid: number; server: string; command: string }): void;
  /** 净退即删 */
  remove(childPid: number): void;
  /** 启动期孤儿清扫（先于自家 spawn）——返回报告的 killed 面（结构子集） */
  sweep(probes: { kill: (pid: number) => void }): Promise<{ readonly killed: readonly number[] }>;
}

/** 官方件构造依赖（装配期闭包注入——spawn/kill/桥核/登记簿上提组合根，MCP 同款治理） */
export interface LspAppDeps {
  /** spawn 组装闭包（组合根 confined spawner 的 lsp 实例——workspace 腿传 rootUri 物理根） */
  readonly spawnServer: (config: LspServerConfig) => Promise<SpawnedProcess>;
  /** 树杀原语（exec killTree 经组合根注入） */
  readonly killTree: (pid: number, alive: () => boolean) => void;
  /** 子进程登记簿（组合根实例化注入——<dataDir>/lsp/children.json） */
  readonly registry: ChildRegistryLike;
  /** rootUri 物理根闭包（canonical 工作区根的 realpath——惰性求值，别名层排除） */
  readonly rootPhysicalRoot: () => string;
  /** 工具参数路径解析锚（相对路径 → 绝对路径——与 fs 工具族同 workspace 锚） */
  readonly resolvePath: (path: string) => string;
  /** JSON-RPC 桥核工厂（mcp JsonRpcConnection 经组合根注入——帧无关复用） */
  readonly newConnection: JsonRpcConnectionFactory;
  /**
   * 符号补全挂载键（刀三 @-mention 第二段，契约篇 §6.8 行面晚绑桥第二用例）：
   * webui 件 symbolsFor 的真身挂点——组合根持晚绑 holder，本件 apply 挂真身/
   * 回卷摘除。缺省不传（诊断装配/旧装配形态）= 无补全面（webui 404）。
   */
  readonly mountSymbols?: (face: LspSymbolsFace) => Disposer;
}

/**
 * 符号补全条目（webui WebuiSymbolItem 结构子集——两件各持词面，组合根接线点
 * 编译期即验；WebuiTodoItem 同款先例）。lsp 结构上不见 webui。
 */
export interface LspSymbolCompletion {
  /** 符号名（插入锚） */
  readonly name: string;
  /** 定义行号（1-based；协议缺失时省） */
  readonly line?: number;
  /** LSP SymbolKind 数值（协议直传） */
  readonly kind?: number;
}

/**
 * 符号查询面（工作区相对路径 → 补全条目）：undefined = 无路由/熔断/文件不在
 * 盘（HTTP 404 档）；warming 档 = 未活实例 fire-and-forget 预热中。didOpen
 * 副作用注记（文档同步盘真相——首查即 open，与 lsp_symbols 工具同款前置）。
 */
export type LspSymbolsFace = (
  path: string,
) => Promise<{ readonly symbols: readonly LspSymbolCompletion[]; readonly warming?: boolean } | undefined>;

/** 同 server 3 连败熔断阈值（connect 失败或活过即死都计败；连上归零） */
export const CIRCUIT_BREAK_THRESHOLD = 3;

/** post 注入面诊断等待硬帽（毫秒）——post 段 5s 竞速钟内留 1.5s 格式化余量（契约篇 §6.7） */
export const POST_WAIT_CAP_MS = 3_500;

/** 诊断注入段条目上限（防结果爆炸——契约篇 §6.7 诊断注入条） */
const MAX_DIAG_ENTRIES = 50;

/** 诊断注入段字节上限（4KiB——与结果护栏同量级） */
const MAX_DIAG_SECTION_BYTES = 4_096;

/** 诊断等待缺省取值（毫秒 = 8s——typescript-language-server 冷启全量诊断常超 3s） */
function diagnosticsTimeoutOf(config: LspServerConfig): number {
  return config.diagnostics_timeout_ms ?? DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
}

/** 单服务器实例簿记（惰性生命周期：起中/已活/熔断三态 + 连败计数） */
interface InstanceState {
  /** 起动中共享 promise（并发首调/预热并触共享同一次拉起） */
  promise?: Promise<LspServerConnection>;
  /** 已活连接（运行期退出时置空） */
  conn?: LspServerConnection;
  /** 连续失败计数（connect 失败或活过即死各 +1；connect 成功归零；≥3 熔断） */
  failures: number;
  /** 熔断理由（在场 = 后续调用直接拒绝；复位走 /reload） */
  dead?: string;
}

/** 构造 lsp 官方件（builtins 注册表 `builtin:lsp` 行） */
export function createLspApp(deps: LspAppDeps): BuiltinAppModule {
  return {
    name: 'lsp',
    // 硬依赖：tools 注册面 + ui 人读出口（channels/tools 先于应用装载——装配序保证可解）
    inject: ['tools', 'ui'],
    config: LSP_APP_CONFIG_SCHEMA,
    apply: (ctx: AppContext, config?: Readonly<Record<string, unknown>>) => applyLspApp(ctx, config, deps),
  };
}

/** 诊断条目行文案（severity + 1-based 行号 + 消息 + 诊断码） */
function diagLine(diag: LspDiagnostic): string {
  const severity =
    diag.severity === 1 ? 'Error' : diag.severity === 2 ? 'Warning' : diag.severity === 3 ? 'Info' : 'Hint';
  const line = diag.range?.start.line !== undefined ? diag.range.start.line + 1 : '?'; // 0-based → 1-based
  const code = diag.code !== undefined ? ` (${diag.source ?? 'lsp'} ${diag.code})` : '';
  return `[${severity}] :${line} ${diag.message}${code}`;
}

/** 件 apply 本体（异常上抛走加载器统一回卷 APP_APPLY_FAILED） */
async function applyLspApp(
  ctx: AppContext,
  config: Readonly<Record<string, unknown>> | undefined,
  deps: LspAppDeps,
): Promise<void> {
  // config 已经件 schema 校验（servers 缺省为空 = 行惰性无害零 spawn——契约篇 §6.7）
  const servers = (config?.servers ?? {}) as Readonly<Record<string, LspServerConfig>>;
  // 非法键检查（词法防线——schema 的 Record(string) 拦不住词法，MCP 同款纪律）
  const illegal = Object.keys(servers).filter((name) => !LSP_SERVER_NAME_PATTERN.test(name));
  if (illegal.length > 0) {
    throw new AppError(APP_CONFIG_INVALID, `LSP 服务器键词法非法（须 [A-Za-z0-9-]+）：${illegal.join(', ')}`);
  }
  const names = Object.keys(servers);
  if (names.length === 0) {
    ctx.logger.debug('lsp 件无服务器配置——零 spawn 空转');
    return;
  }

  // 启动期孤儿清扫（先于自家 spawn——宿主猝死遗留的 detached 子进程在此认领）
  const report = await deps.registry.sweep({ kill: (pid) => deps.killTree(pid, () => true) });
  if (report.killed.length > 0) ctx.logger.warn(`lsp 孤儿清扫：树杀 ${report.killed.join(',')}（宿主猝死遗留）`);

  const ui = ctx.get<UiNotifyFace>('ui');
  const tools = ctx.get<ToolsService>('tools');

  /** 惰性实例簿（server 键 → 三态簿记；首用才 spawn——契约篇 §6.7 生命周期条） */
  const instances = new Map<string, InstanceState>();
  /** 预热首触一次性注记旗（per-server——post 行触预热时给模型一句实话） */
  const preheatNoted = new Set<string>();
  let disposed = false; // 回卷已发生旗（预热门硬停依据）

  /**
   * 拉起或复用一实例（四工具首调与预热共用的唯一入口）。
   * 三态：活返 conn；起中返同 promise（并发共享同次拉起）；熔断抛
   * LSP_CONNECT_FAILED。失败计数 → 3 连败熔断；connect 成功归零。
   */
  function getOrLaunch(name: string): Promise<LspServerConnection> {
    const state = instances.get(name) ?? { failures: 0 };
    instances.set(name, state);
    if (state.conn !== undefined) return Promise.resolve(state.conn);
    if (state.dead !== undefined) {
      return Promise.reject(
        new AppError(LSP_CONNECT_FAILED, `LSP 服务器 ${name} 已熔断（${state.dead}）——复位走 /reload`),
      );
    }
    if (state.promise !== undefined) return state.promise;
    const config = servers[name]!;
    state.promise = (async () => {
      const conn = await connectLspServer(name, config, deps.rootPhysicalRoot(), {
        spawnServer: deps.spawnServer,
        killTree: deps.killTree,
        logger: ctx.logger,
        newConnection: deps.newConnection,
      });
      // 先置活再接线（同段同步——close 事件不可能插入；置活后 onExit 的
      // state.conn === conn 判断在任意竞速下都能正确清活）
      state.conn = conn;
      if (conn.childPid !== undefined) {
        deps.registry.add({ hostPid: process.pid, childPid: conn.childPid, server: name, command: config.command });
      }
      conn.onExit((reason) => {
        // 回卷期退出不是「运行期退出」——清算由回卷本体负责（防误计数触发熔断 notify）
        if (disposed) return;
        if (state.conn === conn) state.conn = undefined;
        if (conn.childPid !== undefined) deps.registry.remove(conn.childPid);
        state.failures += 1;
        if (state.failures >= CIRCUIT_BREAK_THRESHOLD) {
          state.dead = reason;
          ui.notify(`LSP 服务器「${name}」连续 ${state.failures} 次失败已熔断（复位走 /reload）`, { level: 'warn' });
        } else {
          ui.notify(`LSP 服务器「${name}」退出：${reason}（下次使用重试）`, { level: 'warn' });
        }
        ctx.logger.warn(`lsp 服务器 ${name} 运行期退出：${reason}`);
      });
      state.failures = 0; // 连上即归零——「连败」语义 = 无成功间隔的连续失败
      return conn;
    })()
      .catch((err: unknown) => {
        // connect 失败同样计败（起不来的连败与活过即死的连败同账）
        state.failures += 1;
        if (state.failures >= CIRCUIT_BREAK_THRESHOLD) {
          state.dead = describeError(err);
          ui.notify(`LSP 服务器「${name}」连续 ${state.failures} 次连接失败已熔断（复位走 /reload）`, {
            level: 'warn',
          });
        }
        throw err;
      })
      .finally(() => {
        state.promise = undefined; // 起动窗口结束（成败都清——失败不缓存，重试直到熔断）
      });
    return state.promise;
  }

  /** 已活实例读针（同步窥视——未活/起中/熔断都算未活；post 注入面唯一取实例通道） */
  function liveOf(name: string): LspServerConnection | undefined {
    return instances.get(name)?.conn;
  }

  /** fire-and-forget 后台预热（post 行触达未活实例时——不占 post 段预算，契约篇 §6.7 blocker 修法） */
  function preheat(name: string): void {
    if (disposed || ctx.signal.aborted) return; // scope 活护栏（MCP 后台续段同款）
    void getOrLaunch(name).catch(() => undefined); // 失败已由 getOrLaunch 记败/熔断，此处只防 unhandled
  }

  /** 扩展名路由（声明序首命中——路由规则全件唯一：诊断注入与四工具同表同序） */
  function routeFor(absPath: string): { name: string; config: LspServerConfig } | undefined {
    const dot = absPath.lastIndexOf('.');
    const ext = dot === -1 ? '' : absPath.slice(dot).toLowerCase();
    if (ext === '') return undefined;
    for (const name of names) {
      if (servers[name]!.languages?.includes(ext) === true) return { name, config: servers[name]! };
    }
    return undefined;
  }

  /** 路径是否在 rootUri 物理根内（根外写入不诊断——LSP 服务器只解析根内文档） */
  function inRoot(absPath: string): boolean {
    const root = deps.rootPhysicalRoot();
    return absPath === root || absPath.startsWith(`${root}${sep}`);
  }

  // effect 回卷：批量协议化关停（LIFO 与加载器回卷一致；幂等由 conn.dispose 自持）
  ctx.effect(() => {
    return () => {
      disposed = true;
      const items = [...instances.values()]
        .map((it) => it.conn)
        .filter((c): c is LspServerConnection => c !== undefined);
      for (const it of instances.values()) it.conn = undefined;
      void Promise.all(
        items.map(async (conn) => {
          if (conn.childPid !== undefined) deps.registry.remove(conn.childPid);
          await conn.dispose();
        }),
      );
    };
  });

  /* ---------------- 静态四工具注册（全局层，effect 恒 'read'，1-based 坐标） ---------------- */

  /**
   * ensure-open 统一管线（冷读 major 5——四工具同一前置：路由 + 根内 + 实例 +
   * 读盘同步；URI 未 open 则 didOpen——多数服务器要求先 open 才响应符号/定义
   * /引用请求且只对 open 文档发诊断）。
   * 返回：{conn, server, config, version} 继续执行（version = 本次同步发出的
   * 版本号——诊断等待对齐锚）；{ok:false} 转 isError；undefined = 文件不在盘。
   */
  async function ensureOpen(
    absPath: string,
  ): Promise<
    | { conn: LspServerConnection; server: string; config: LspServerConfig; version: number }
    | { ok: false; text: string }
    | undefined
  > {
    const route = routeFor(absPath);
    if (route === undefined) {
      return {
        ok: false,
        text: `路径扩展名不在任何 LSP 服务器的 languages 路由表内（${absPath}）——请在 builtin:lsp 行 config servers.<name>.languages 声明后 /reload`,
      };
    }
    if (!inRoot(absPath)) {
      return {
        ok: false,
        text: `路径在 LSP 工作区根外（根 = ${deps.rootPhysicalRoot()}）——服务器只解析根内文档：${absPath}`,
      };
    }
    let conn: LspServerConnection;
    try {
      conn = await getOrLaunch(route.name); // 工具面有耐心：等拉起（含握手）
    } catch (err) {
      // connect 期失败/熔断 = 数据不是宿主故障（工具结果 error 不升 AppError——契约篇 §6.7）
      return { ok: false, text: `LSP 服务器「${route.name}」不可用：${describeError(err)}` };
    }
    const version = await conn.syncDocument(absPath);
    if (version === undefined) return undefined; // 文件不在盘上
    return { conn, server: route.name, config: route.config, version };
  }

  const disposers: Disposer[] = [];
  /** 注册包裹：拒件（撞名/描述扫描）不炸整 row——跳过该工具 + notify warn（MCP 同款纪律） */
  function safeRegister(def: ToolDefinition): void {
    try {
      disposers.push(tools.register(def));
    } catch (err) {
      if (err instanceof AppError && (err.code === TOOL_DUPLICATE || err.code === TOOL_DESCRIPTION_REJECTED)) {
        ui.notify(`LSP 工具 ${def.name} 注册被拒（撞名/描述扫描）：跳过`, { level: 'warn' });
        return;
      }
      throw err; // 其他码 = 装配层缺陷，响亮上抛
    }
  }

  // 工具面管道预算：startup + max(request, diagnostics) 两钟接力上界 + 1.5s 缓冲
  //（首调含握手——契约篇 §6.7 两钟接力条款；多服务器取 max）
  const toolBudgetMs =
    Math.max(
      ...names.map((name) => {
        const config = servers[name]!;
        const startup = (config.startup_timeout_sec ?? DEFAULT_STARTUP_TIMEOUT_MS / 1000) * 1000;
        const request = (config.request_timeout_sec ?? DEFAULT_REQUEST_TIMEOUT_MS / 1000) * 1000;
        return startup + Math.max(request, diagnosticsTimeoutOf(config));
      }),
    ) + 1_500;

  /** 单请求钟取值（symbols/definitions/references 用） */
  const requestTimeoutOf = (config: LspServerConfig): number =>
    (config.request_timeout_sec ?? DEFAULT_REQUEST_TIMEOUT_MS / 1000) * 1000;

  safeRegister({
    name: 'lsp_diagnostics',
    description:
      '取某文件的 LSP 诊断（编译错误/警告）。write/edit 后诊断自动附在工具结果里；本工具用于主动全量查询（冷启动首次调用需等服务器索引，可能较慢）。path 相对工作区根。',
    parameters: Type.Object({
      path: Type.String({ description: '目标文件路径（相对工作区根）' }),
    }),
    effect: 'read',
    timeoutMs: toolBudgetMs,
    execute: async (args: Record<string, unknown>): Promise<AgentToolResult> => {
      const abs = deps.resolvePath(String(args.path ?? ''));
      const opened = await ensureOpen(abs);
      if (opened === undefined) return { content: [{ type: 'text', text: '文件不在盘上' }], isError: true };
      if (!('conn' in opened)) return { content: [{ type: 'text', text: opened.text }], isError: true };
      // 工具面全额等待（无 post 帽——冷启全量诊断的现实预算，契约篇 §6.7 两档等待）；
      // 不读空缓存（空缓存会误导模型「无问题」——冷路径主动同步等待）
      const timeoutMs = diagnosticsTimeoutOf(opened.config);
      const diags = await opened.conn.waitForDiagnostics(abs, opened.version, timeoutMs);
      if (diags === undefined) {
        // 超时诚实降级：不算失败（诊断异步性是协议本质），但明说未达
        return {
          content: [{ type: 'text', text: `诊断未及回流（等待 ${timeoutMs}ms）——服务器索引中，稍后重试` }],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text:
              diags.length === 0
                ? `LSP 诊断：0 条（${abs} 无问题）`
                : `LSP 诊断（${opened.server}，${diags.length} 条）：\n${diags.map(diagLine).join('\n')}`,
          },
        ],
      };
    },
  });

  safeRegister({
    name: 'lsp_symbols',
    description: '取某文件的符号大纲（函数/类/变量/方法——documentSymbol）。path 相对工作区根。',
    parameters: Type.Object({
      path: Type.String({ description: '目标文件路径（相对工作区根）' }),
    }),
    effect: 'read',
    timeoutMs: toolBudgetMs,
    execute: async (args: Record<string, unknown>): Promise<AgentToolResult> => {
      const abs = deps.resolvePath(String(args.path ?? ''));
      const opened = await ensureOpen(abs);
      if (opened === undefined) return { content: [{ type: 'text', text: '文件不在盘上' }], isError: true };
      if (!('conn' in opened)) return { content: [{ type: 'text', text: opened.text }], isError: true };
      const timeoutMs = requestTimeoutOf(opened.config);
      try {
        const symbols = (await opened.conn.request(
          'textDocument/documentSymbol',
          { textDocument: { uri: uriOf(abs) } },
          timeoutMs,
        )) as
          readonly (LspDocumentSymbol | { name: string; location?: { range: { start: { line: number } } } })[] | null;
        if (symbols === null || symbols.length === 0) {
          return { content: [{ type: 'text', text: `（${abs} 无符号）` }] };
        }
        // 两种协议形态统一展开：DocumentSymbol（有 range/children）与旧协议
        // SymbolInformation（平铺有 location）；children v1 不递归——顶层大纲足够
        const lines = symbols.map((sym) => {
          const startLine = (sym as LspDocumentSymbol).range?.start.line ?? sym.location?.range.start.line;
          const line = startLine !== undefined ? ` :${startLine + 1}` : '';
          return `- ${sym.name}${line}`;
        });
        return { content: [{ type: 'text', text: `符号大纲（${abs}，${lines.length} 个）：\n${lines.join('\n')}` }] };
      } catch (err) {
        return toolCallError(err);
      }
    },
  });

  /** 位置类工具（definitions/references）共用执行体：1-based 坐标入 → 0-based 协议出 */
  async function runPositionQuery(
    args: Record<string, unknown>,
    method: 'textDocument/definition' | 'textDocument/references',
    label: string,
  ): Promise<AgentToolResult> {
    const abs = deps.resolvePath(String(args.path ?? ''));
    const line = Number(args.line ?? 1);
    const column = Number(args.column ?? 1);
    const opened = await ensureOpen(abs);
    if (opened === undefined) return { content: [{ type: 'text', text: '文件不在盘上' }], isError: true };
    if (!('conn' in opened)) return { content: [{ type: 'text', text: opened.text }], isError: true };
    const timeoutMs = requestTimeoutOf(opened.config);
    try {
      const params: Record<string, unknown> = {
        textDocument: { uri: uriOf(abs) },
        position: { line: line - 1, character: column - 1 }, // 1-based 工具面 → 0-based 协议面
      };
      if (method === 'textDocument/references') params.context = { includeDeclaration: true };
      const raw = await opened.conn.request(method, params, timeoutMs);
      // definition/references 宽容展开：null / 单对象 / 数组 / LocationLink（targetUri）各形态
      const items = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
      const lines: string[] = [];
      for (const item of items as Record<string, unknown>[]) {
        // LocationLink 形态：targetUri + targetRange；Location 形态：uri + range
        const uri = (item.targetUri ?? item.uri) as string | undefined;
        const range = (item.targetRange ?? item.range) as LspLocation['range'] | undefined;
        if (uri === undefined || range === undefined) continue;
        lines.push(`- ${uri} :${range.start.line + 1}:${range.start.character + 1}`);
      }
      if (lines.length === 0) return { content: [{ type: 'text', text: `（无${label}）` }] };
      return { content: [{ type: 'text', text: `${label}（${lines.length} 处）：\n${lines.join('\n')}` }] };
    } catch (err) {
      return toolCallError(err);
    }
  }

  safeRegister({
    name: 'lsp_definitions',
    description: '取某位置符号的定义处（文件:行:列）。坐标 1-based。path 相对工作区根。',
    parameters: Type.Object({
      path: Type.String({ description: '目标文件路径（相对工作区根）' }),
      line: Type.Number({ description: '行号（1-based）' }),
      column: Type.Number({ description: '列号（1-based）' }),
    }),
    effect: 'read',
    timeoutMs: toolBudgetMs,
    execute: (args) => runPositionQuery(args, 'textDocument/definition', '定义'),
  });

  safeRegister({
    name: 'lsp_references',
    description: '取某位置符号的全部引用处（含声明）。坐标 1-based。path 相对工作区根。',
    parameters: Type.Object({
      path: Type.String({ description: '目标文件路径（相对工作区根）' }),
      line: Type.Number({ description: '行号（1-based）' }),
      column: Type.Number({ description: '列号（1-based）' }),
    }),
    effect: 'read',
    timeoutMs: toolBudgetMs,
    execute: (args) => runPositionQuery(args, 'textDocument/references', '引用'),
  });

  // 四工具件级寿命（effect 回卷统一撤——行卸载即无 LSP 工具面）
  ctx.effect(() => {
    return () => {
      for (const dispose of disposers) dispose();
    };
  });

  /* ---------------- 符号补全面（刀三 @-mention 第二段——webui 晚绑桥真身） ---------------- */

  /**
   * 符号查询面（webui 补全端点消费——与 lsp_symbols 工具同源管线但两档差异：
   * 未活实例**不等待拉起**：fire-and-forget 预热 + warming 档〔补全弹窗等不了
   * 握手秒级；工具面有耐心两档的分工——契约篇 §6.7 两档等待〕）。didOpen
   * 副作用与工具面同款（syncDocument 盘真相——首查即 open）。
   */
  const symbolsFace: LspSymbolsFace = async (path) => {
    const abs = deps.resolvePath(path);
    const route = routeFor(abs);
    if (route === undefined || !inRoot(abs)) return undefined; // 无路由/根外 = 404 档
    const state = instances.get(route.name);
    if (state?.dead !== undefined) return undefined; // 熔断 = 404 档（复位走 /reload）
    const conn = liveOf(route.name);
    if (conn === undefined) {
      preheat(route.name); // 起中/未活——后台拉起，本次 warming
      return { symbols: [], warming: true };
    }
    try {
      const version = await conn.syncDocument(abs);
      if (version === undefined) return undefined; // 文件不在盘 = 404 档
      const raw = (await conn.request(
        'textDocument/documentSymbol',
        { textDocument: { uri: uriOf(abs) } },
        requestTimeoutOf(route.config),
      )) as
        | readonly (
            LspDocumentSymbol | { name: string; kind?: number; location?: { range: { start: { line: number } } } }
          )[]
        | null;
      if (raw === null) return { symbols: [] };
      // 两种协议形态统一展开（与 lsp_symbols 工具同式——DocumentSymbol 有 range/
      // SymbolInformation 有 location）；children v1 不递归
      const symbols = raw.map((sym) => {
        const startLine = (sym as LspDocumentSymbol).range?.start.line ?? sym.location?.range.start.line;
        return {
          name: sym.name,
          ...(startLine !== undefined ? { line: startLine + 1 } : {}), // 0-based → 1-based
          ...(typeof sym.kind === 'number' ? { kind: sym.kind } : {}),
        };
      });
      return { symbols };
    } catch {
      return { symbols: [] }; // 请求超时等 IO 面——空集降级（补全面非工具面，不升错误）
    }
  };

  // deps.mountSymbols 缺席（诊断装配/旧装配形态）= 不挂面，webui 侧 404 兜底
  if (deps.mountSymbols !== undefined) {
    const disposeFace = deps.mountSymbols(symbolsFace);
    ctx.effect(() => disposeFace); // 行回卷摘桥——此后 webui 补全面 404（桥 holder 置空）
  }

  /* ---------------- 诊断注入（post 行就地改写 + 守门行传导；contained 铁律） ---------------- */

  // checkpoint pre 行同款形态：ctx.on 应用行注册（rowId 由 loader 登记时自动携带，
  // fresh 驱动作用域经守门行传导惰性可达——运行时骨架篇 §6.1，零新接线）
  ctx.effect(() =>
    ctx.on(TOOL_POST_EXECUTE_EVENT, async (input: PostInput, next: () => unknown) => {
      // contained 铁律：注入路径任何异常吞掉 + warn——绝不改写原结果、绝不置 isError
      try {
        await injectDiagnostics(input, {
          routeFor,
          inRoot,
          liveOf,
          preheat,
          preheatNoted,
          logger: ctx.logger,
          servers: Object.fromEntries(names.map((name) => [name, servers[name]!])),
        });
      } catch (err) {
        ctx.logger.warn('lsp 诊断注入失败（contained——原结果不受影响）', { error: describeError(err) });
      }
      return next(); // 监听器纪律：绝不含自身异常挡 post 链
    }),
  );
}

/** 诊断注入依赖束（injectDiagnostics 的注入面——纯逻辑半可独立测试） */
interface InjectDeps {
  /** 扩展名路由（声明序首） */
  readonly routeFor: (absPath: string) => { name: string; config: LspServerConfig } | undefined;
  /** 根内判断 */
  readonly inRoot: (absPath: string) => boolean;
  /** 已活实例读针（同步窥视——未活/起中/熔断都算未活） */
  readonly liveOf: (name: string) => LspServerConnection | undefined;
  /** fire-and-forget 预热（未活实例触达时） */
  readonly preheat: (name: string) => void;
  /** 预热首触一次性注记旗 */
  readonly preheatNoted: Set<string>;
  /** 服务器配置表（诊断等待钟取值用） */
  readonly servers: Readonly<Record<string, LspServerConfig>>;
  readonly logger: Pick<AppContext['logger'], 'debug' | 'warn'>;
}

/**
 * 诊断注入本体（契约篇 §6.7 诊断注入条——post 段快径设计）：
 * 只消费已活实例；未活触发 fire-and-forget 预热 + 首触一次性注记后跳过；
 * 已活则并发同步全部写路径 + 各路径等待（cap = min(配值, 3.5s) 硬帽），
 * 超钟诚实降级注记；诊断段追加进 result.content（50 条 + 4KiB 帽）。
 * delete 路径发 didClose 告别（读盘必 ENOENT——已 open 的 URI 才有告别面）。
 */
async function injectDiagnostics(input: PostInput, deps: InjectDeps): Promise<void> {
  // 只挂 write/edit 两工具且成功结果（shell 改文件不落 details 面——诚实边界）
  if (input.tool.name !== 'write' && input.tool.name !== 'edit') return;
  if (input.result.isError === true) return;
  const details = input.result.details as Record<string, unknown> | undefined;

  /** 收集目标路径（write = details.path；edit = details.operations 结构化数组） */
  const written: string[] = [];
  const deleted: string[] = [];
  if (input.tool.name === 'write') {
    if (typeof details?.path === 'string') written.push(details.path);
  } else {
    const ops = Array.isArray(details?.operations) ? (details!.operations as { op?: string; path?: string }[]) : [];
    for (const op of ops) {
      if (typeof op.path !== 'string') continue;
      if (op.op === 'delete') deleted.push(op.path);
      else written.push(op.path);
    }
  }
  if (written.length === 0 && deleted.length === 0) return;

  // delete 路径：didClose 告别（major 3——文件已删读盘必 ENOENT，同步告知服务器弃档）
  for (const path of deleted) {
    const route = deps.routeFor(path);
    const live = route === undefined ? undefined : deps.liveOf(route.name);
    live?.closeDocument(path);
  }

  /** 写路径按 server 分组（一次补丁可跨多文件多语言——各组独立快径判定） */
  const byServer = new Map<string, { config: LspServerConfig; paths: string[] }>();
  const skipped: string[] = [];
  for (const path of written) {
    if (!deps.inRoot(path)) {
      skipped.push(path); // 根外写入不诊断——诚实注记（服务器只解析根内文档）
      continue;
    }
    const route = deps.routeFor(path);
    if (route === undefined) continue; // 扩展名无路由：不注（未配 LSP 的常态面）
    const group = byServer.get(route.name) ?? { config: route.config, paths: [] };
    group.paths.push(path);
    byServer.set(route.name, group);
  }

  /** 组级处理：未活 → 预热 + 首触注记；已活 → 并发同步 + 组内等待（cap 硬帽） */
  const sections: string[] = [];
  for (const [name, group] of byServer) {
    const live = deps.liveOf(name);
    if (live === undefined) {
      // 快径第一律：拉起绝不占 post 段预算——后台预热 + 首触一次性注记后跳过
      if (!deps.preheatNoted.has(name)) {
        deps.preheatNoted.add(name);
        sections.push(`LSP 服务器「${name}」预热中，本次未附诊断（下次写入生效）`);
      }
      deps.preheat(name);
      continue;
    }
    // 并发同步全部路径 + 等各自诊断（cap = min(配值, 3.5s) 硬帽——post 段预算内）
    const cap = Math.min(diagnosticsTimeoutOf(group.config), POST_WAIT_CAP_MS);
    const settled = await Promise.all(
      group.paths.map(async (path) => {
        const version = await live.syncDocument(path);
        if (version === undefined) return { path, diags: undefined };
        return { path, diags: await live.waitForDiagnostics(path, version, cap) };
      }),
    );
    // 组内诊断格式化（条目帽 + 4KiB 帽）
    const lines: string[] = [];
    let truncated = false;
    for (const item of settled) {
      for (const diag of item.diags ?? []) {
        if (lines.length >= MAX_DIAG_ENTRIES) {
          truncated = true;
          break;
        }
        lines.push(`${item.path} ${diagLine(diag)}`);
      }
    }
    const gotAny = settled.some((it) => it.diags !== undefined);
    if (!gotAny) {
      sections.push(`LSP 诊断未及回流（${name}，等待 ${cap}ms）——服务器索引中`);
    } else if (lines.length === 0) {
      sections.push(`LSP 诊断：0 条（${name}，已检路径无问题）`);
    } else {
      let text = `LSP 诊断（${name}，${lines.length} 条${truncated ? `，截断至 ${MAX_DIAG_ENTRIES}` : ''}）：\n${lines.join('\n')}`;
      if (Buffer.byteLength(text, 'utf8') > MAX_DIAG_SECTION_BYTES) {
        text = `${text.slice(0, MAX_DIAG_SECTION_BYTES)}\n…（4KiB 截断）`;
      }
      sections.push(text);
    }
  }
  if (skipped.length > 0) sections.push(`（${skipped.length} 个路径在 LSP 工作区根外，未诊断）`);
  if (sections.length === 0) return;

  // 就地追加进首个 text 块（write/edit 均为 textResult 单块形态）
  const block = input.result.content[0];
  if (block !== undefined && block.type === 'text') {
    block.text = `${block.text}\n\n${sections.join('\n')}`;
  }
}

/** 工具调用错误统一转结果 error（服务器错误/连接死是数据不是宿主故障——契约篇 §6.7） */
function toolCallError(err: unknown): AgentToolResult {
  if (err instanceof AppError && err.code === TOOL_TIMEOUT) throw err; // 桥钟超时与管道同码——原样上抛结构化
  return { content: [{ type: 'text', text: `LSP 调用失败：${describeError(err)}` }], isError: true };
}
