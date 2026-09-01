/**
 * L3 mcp — 官方件 `builtin:mcp`（契约篇 §6.6 第一刀，默认层第六行，Ring 2 真·可卸）。
 *
 * 触发序：apply（登记簿孤儿清扫 → effect 挂回卷）→ 后台发现（并发连全部
 * 服务器，apply 返回时不连——零阻塞启动）→ 全 row 过滤后全局合计过阈值
 * 决定注册形态（>20 降单件目录工具 / ≤20 逐件原生注册）→ tools_change
 * 即时刷新 loop 快照。
 *
 * 竞态护栏（契约篇 §6.6 后台续段条）：续段每步查 ctx.signal——/reload 或
 * 卸行发生在连接中途即中止不造孤儿；单服务器失败不阻同 row 其余。
 *
 * 运行期退出（close 事件）：撤该服务器全部工具 + ui.notify warn + 不自动
 * 重连（复位走 /reload）。
 */

import {
  AppError,
  APP_CONFIG_INVALID,
  TOOL_DESCRIPTION_REJECTED,
  TOOL_DUPLICATE,
  TOOL_TIMEOUT,
  describeError,
} from '../contracts/errors.js';
import type { AgentToolResult, ToolDefinition, ToolsService } from '../contracts/tools.js';
import type { BuiltinAppModule, AppContext, AppLogger } from '../contracts/app.js';
import { Type } from '../contracts/typebox.js';
import type { Disposer } from '../context/types.js';
import { ChildRegistry } from './children.js';
import { connectMcpServer, DEFAULT_TOOL_TIMEOUT_MS, type McpServerConnection, type SpawnedChild } from './client.js';
import { MCP_APP_CONFIG_SCHEMA, MCP_SERVER_NAME_PATTERN, type McpRemoteTool, type McpServerConfig } from './types.js';

/** 目录降级阈值（过滤 enabled/disabled 之后**全局合计**——契约篇 §6.6 冷读 #3） */
export const CATALOG_THRESHOLD = 20;

/** ui 通知面（连接失败/运行期退出/注册拒件的人读出口——channels 服务结构子集） */
interface UiNotifyFace {
  notify(message: string, opts?: { level?: 'info' | 'warn' | 'error' }): void;
}

/** 官方件构造依赖（装配期闭包注入——spawn/kill 组装上提组合根，冷读 #1） */
export interface McpAppDeps {
  /** spawn 组装闭包（app/mcp-spawn.ts：buildChildEnv + env set 层 + detached + cwd=dataDir） */
  readonly spawnServer: (config: McpServerConfig) => Promise<SpawnedChild>;
  /** 树杀原语（exec killTree 经组合根注入） */
  readonly killTree: (pid: number, alive: () => boolean) => void;
  /** 数据目录（登记簿 <dataDir>/mcp/children.json 物理根） */
  readonly dataDir: string;
}

/** 已连接服务器的运行时簿记（发现结果 + 撤件句柄） */
interface LiveServer {
  readonly conn: McpServerConnection;
  /** 本服务器贡献的注册工具撤件句柄（运行期退出/回卷时批量撤） */
  readonly disposers: Disposer[];
  /** 登记簿句子的清理（close 即删条目） */
  readonly offExit: () => void;
}

/** 构造 mcp 官方件（builtins 注册表 `builtin:mcp` 行） */
export function createMcpApp(deps: McpAppDeps): BuiltinAppModule {
  return {
    name: 'mcp',
    // 硬依赖：tools 注册面 + ui 人读出口（channels 先于应用装载——装配序保证可解）
    inject: ['tools', 'ui'],
    config: MCP_APP_CONFIG_SCHEMA,
    apply: (ctx: AppContext, config?: Readonly<Record<string, unknown>>) => applyMcpApp(ctx, config, deps),
  };
}

/** 件 apply 本体（异常上抛走加载器统一回卷 APP_APPLY_FAILED） */
async function applyMcpApp(
  ctx: AppContext,
  config: Readonly<Record<string, unknown>> | undefined,
  deps: McpAppDeps,
): Promise<void> {
  // config 已经件 schema 校验（servers 缺省为空 = 行惰性无害零 spawn）
  const servers = (config?.servers ?? {}) as Readonly<Record<string, McpServerConfig>>;
  // 非法键检查先于空表早退——全非法键必须响亮拒绝而非静默空转（键词法是
  // `mcp__<server>__<tool>` 解析的防线，schema 的 Record(string) 拦不住词法）
  const illegal = Object.keys(servers).filter((name) => !MCP_SERVER_NAME_PATTERN.test(name));
  if (illegal.length > 0) {
    throw new AppError(APP_CONFIG_INVALID, `服务器键词法非法（须 [A-Za-z0-9-]+）：${illegal.join(', ')}`);
  }
  const names = Object.keys(servers);
  if (names.length === 0) {
    ctx.logger.debug('mcp 件无服务器配置——零 spawn 空转');
    return;
  }

  const registry = new ChildRegistry(`${deps.dataDir}/mcp/children.json`);
  // 启动期孤儿清扫（先于自家 spawn——宿主猝死遗留的 detached 子进程在此认领）
  const report = await registry.sweep({
    kill: (pid) => deps.killTree(pid, () => true),
  });
  if (report.killed.length > 0) {
    ctx.logger.warn(`mcp 孤儿清扫：树杀 ${report.killed.join(',')}（宿主猝死遗留）`);
  }

  /** 活服务器簿（运行期退出撤件 + 回卷批量关停的遍历对象） */
  const live = new Map<string, LiveServer>();
  /** 全 row 已注册工具名集合（目录形态的检索面） */
  const catalog = new Map<string, { server: string; tool: McpRemoteTool; conn: McpServerConnection }>();
  /**
   * 目录工具句柄（件级寿命盒）：单服务器退出只清自己的 catalog 条目不撤目录
   * （其余服务器的工具仍可路由）——目录工具随 effect 回卷撤，不随单服退出撤。
   */
  const catalogBox: { dispose?: Disposer } = {};
  let disposed = false; // 回卷已发生旗（后台续段的硬停依据）

  // effect 回卷：批量协议化关停 + 撤全部注册件（LIFO 与加载器回卷一致）。
  // 注意 effect(fn) 契约 = 立即执行 fn、其返回的 Disposer 回卷才执行——
  // 置旗必须住在 Disposer 里（写在 fn 体会注册即标死，后台续段全程短路）
  ctx.effect(() => {
    return () => {
      disposed = true;
      void shutdownAll(live, registry, catalogBox);
    };
  });

  // 后台发现（apply 返回后才真正连接——零阻塞启动；单服务器失败不阻其余）
  void discoverAll(ctx, names, servers, {
    deps,
    logger: ctx.logger,
    registry,
    live,
    catalog,
    catalogBox,
    isDead: () => disposed,
  });
}

/** 后台续段的共享依赖束（闭包直取，不经 ctx 重复 get） */
interface DiscoverCtx {
  readonly deps: McpAppDeps;
  /** 诊断日志（件 ctx 的 logger 结构子集——退出告警/stderr 都走这里） */
  readonly logger: Pick<AppLogger, 'debug' | 'warn'>;
  readonly registry: ChildRegistry;
  readonly live: Map<string, LiveServer>;
  /** 目录面（全局阈值判定后的检索/路由数据） */
  readonly catalog: Map<string, { server: string; tool: McpRemoteTool; conn: McpServerConnection }>;
  /** 目录工具句柄盒（件级寿命——注册时写盒，回卷时撤） */
  readonly catalogBox: { dispose?: Disposer };
  /** 回卷/卸行已发生（续段硬停） */
  readonly isDead: () => boolean;
}

/** 后台发现全 row（并发连全部 → 全局阈值 → 注册形态二择） */
async function discoverAll(
  ctx: AppContext,
  names: readonly string[],
  servers: Readonly<Record<string, McpServerConfig>>,
  bag: DiscoverCtx,
): Promise<void> {
  const ui = ctx.get<UiNotifyFace>('ui'); // 硬依赖（inject 已声明——装载轮次保证在场）
  // 并发握手+发现（per-server try/catch——单点失败不阻其余，契约篇 §6.6）
  const found = await Promise.all(
    names.map(async (name) => {
      if (bag.isDead() || ctx.signal.aborted) return null; // spawn 前查活（冷读 #7）
      try {
        const conn = await connectMcpServer(name, servers[name]!, {
          spawnServer: bag.deps.spawnServer,
          killTree: bag.deps.killTree,
          logger: ctx.logger,
        });
        const tools = await conn.discover();
        if (bag.isDead() || ctx.signal.aborted) {
          // 竞态：发现完成时作用域已死——立即协议化关停，不注册
          await conn.dispose();
          return null;
        }
        return { name, conn, tools };
      } catch (err) {
        const message = err instanceof AppError ? describeError(err) : String(err);
        ctx.logger.warn(`mcp 服务器 ${name} 连接失败：${message}`);
        ui.notify(`MCP 服务器「${name}」连接失败：${message}`, { level: 'warn' });
        return null; // MCP_CONNECT_FAILED 不阻启动（契约篇 §6.6）
      }
    }),
  );

  if (bag.isDead() || ctx.signal.aborted) return;
  const connected = found.filter(
    (it): it is { name: string; conn: McpServerConnection; tools: McpRemoteTool[] } => it !== null,
  );
  if (connected.length === 0) return; // 全灭：行留在装载清单、零工具注册（语义诚实）

  // enabled/disabled 双表过滤（发现后过滤——契约篇 §6.6 工具注册条）
  const filtered = connected.map(({ name, conn, tools }) => ({
    name,
    conn,
    tools: tools.filter((tool) => {
      if (servers[name]!.enabled_tools && !servers[name]!.enabled_tools.includes(tool.name)) return false;
      if (servers[name]!.disabled_tools?.includes(tool.name)) return false;
      return true;
    }),
  }));
  const totalCount = filtered.reduce((sum, it) => sum + it.tools.length, 0);

  const tools = ctx.get<ToolsService>('tools');
  // 全局阈值二择（冷读 #3：过滤后合计 >20 全降目录；≤20 逐件原生注册）
  if (totalCount > CATALOG_THRESHOLD) {
    for (const { name, conn, tools: serverTools } of filtered) {
      for (const tool of serverTools) {
        // 目录寻址键 = <server>__<tool> 复合名（契约篇 §6.6 勘正〔20260901-d #10〕）：
        // 防跨服务器同名工具静默遮蔽——裸原名键下后连服务器恒胜、前者结构性不可达，
        // 违「没生效必须有信号」纪律。复合名恒含 '__'，与目录工具自身的名字 'mcp'
        // 结构性不可能相撞，旧 'mcp' 字面 guard 随之退役；call 落桥时换回服务器侧
        // 原名（item.tool.name——复合名只是目录寻址面，不上线协议）
        bag.catalog.set(`${name}__${tool.name}`, { server: name, tool, conn });
      }
    }
    const serversLine = filtered.map((it) => it.name).join(', ');
    const dispose = safeRegister(
      tools,
      {
        name: 'mcp',
        description: `MCP 外部工具目录（服务器：${serversLine}；工具 ${totalCount} 件超 ${CATALOG_THRESHOLD} 阈值已降级目录形态）。action=search 按关键词找工具（结果为 <server>__<tool> 复合名，与原生 mcp__<server>__<tool> 命名空间同律）；action=describe 看某工具参数 schema；action=call 调用之（describe/call 以复合名寻址）`,
        parameters: Type.Object({
          action: Type.Union([Type.Literal('search'), Type.Literal('describe'), Type.Literal('call')]),
          query: Type.Optional(Type.String({ description: 'search：工具名/描述关键词' })),
          tool: Type.Optional(
            Type.String({ description: 'describe/call：目标工具（复合名 <server>__<tool>——search 结果里的名字）' }),
          ),
          args: Type.Optional(Type.Record(Type.String(), Type.Unknown())), // call：工具参数对象（任意键值）
        }),
        // 目录内含可写调用——fail-closed 恒 write（契约篇 §6.6）
        effect: 'write',
        // 调用预算与原生形态一致（管道按 def.timeoutMs 执法——结构化 TOOL_TIMEOUT）
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        execute: (callArgs) => runCatalogAction(callArgs, bag),
      },
      (toolName) => ui.notify(`MCP 工具 ${toolName} 注册被拒：仅目录工具跳过`, { level: 'warn' }),
    );
    if (dispose !== undefined) bag.catalogBox.dispose = dispose; // 件级寿命盒——回卷才撤
    // 全部活服务器接线（撤件集空——目录工具不随单服退出撤，单服 close 只清自己的目录条目）
    for (const { name, conn } of filtered) {
      wireLive(bag, name, conn, servers[name]!, [], ui);
    }
    return;
  }

  // 原生注册形态：逐件 mcp__<server>__<tool>（readOnlyHint → read，缺省 write fail-closed）
  for (const { name, conn, tools: serverTools } of filtered) {
    const disposers: Disposer[] = [];
    for (const tool of serverTools) {
      const def = buildRemoteToolDef(name, tool, conn, servers[name]!);
      const dispose = safeRegister(tools, def, (toolName) =>
        ui.notify(`MCP 工具 ${toolName} 注册被拒（描述扫描/撞名）：仅该工具跳过`, { level: 'warn' }),
      );
      if (dispose !== undefined) disposers.push(dispose);
    }
    wireLive(bag, name, conn, servers[name]!, disposers, ui);
  }
}

/** 注册包裹：拒件（描述扫描/撞名）不炸整 row——notify warn + 返回 undefined（冷读 #7） */
function safeRegister(
  tools: ToolsService,
  def: ToolDefinition,
  onReject: (name: string) => void,
): Disposer | undefined {
  try {
    return tools.register(def);
  } catch (err) {
    if (err instanceof AppError && (err.code === TOOL_DUPLICATE || err.code === TOOL_DESCRIPTION_REJECTED)) {
      onReject(def.name);
      return undefined;
    }
    throw err; // 其他码 = 装配层缺陷，响亮上抛
  }
}

/** 单件远端工具定义（mcp__<server>__<tool>——外部工具同一执法面，不分特权路径） */
function buildRemoteToolDef(
  server: string,
  tool: McpRemoteTool,
  conn: McpServerConnection,
  config: McpServerConfig,
): ToolDefinition {
  const timeoutMs = (config.tool_timeout_sec ?? DEFAULT_TOOL_TIMEOUT_MS / 1000) * 1000;
  return {
    name: `mcp__${server}__${tool.name}`,
    description: tool.description ?? `MCP 服务器 ${server} 的工具 ${tool.name}`,
    parameters: tool.inputSchema ?? { type: 'object', additionalProperties: true },
    // readOnlyHint → 'read'；缺省不声明（注册面归一为 'write' fail-closed）
    ...(tool.annotations?.readOnlyHint === true ? { effect: 'read' as const } : {}),
    // 用户可配逐调用预算上管道执法面（超时 = 结构化 TOOL_TIMEOUT 错误）
    timeoutMs,
    execute: async (args: Record<string, unknown>): Promise<AgentToolResult> => {
      try {
        // 桥侧预算 +500ms 让管道先执法（同码不撞车——桥超时只是兜底）
        const out = await conn.call(tool.name, args, timeoutMs + 500);
        return { content: [{ type: 'text', text: out.text }], ...(out.isError ? { isError: true } : {}) };
      } catch (err) {
        // 调用超时是预算执法不是数据——原样上抛（管道转结构化 TOOL_TIMEOUT）
        if (err instanceof AppError && err.code === TOOL_TIMEOUT) throw err;
        // 服务器错误/连接死是数据不是宿主故障——工具结果 error（不升 AppError）
        return { content: [{ type: 'text', text: `MCP 调用失败：${describeError(err)}` }], isError: true };
      }
    },
  };
}

/** 目录工具三动作（search/describe/call——schema 恒定保 prompt cache） */
async function runCatalogAction(args: Record<string, unknown>, bag: DiscoverCtx): Promise<AgentToolResult> {
  const action = String(args.action ?? '');
  if (action === 'search') {
    const query = String(args.query ?? '').toLowerCase();
    const hits = [...bag.catalog.entries()]
      .filter(
        ([name, item]) =>
          query === '' ||
          name.toLowerCase().includes(query) ||
          (item.tool.description ?? '').toLowerCase().includes(query),
      )
      // 复合名自带服务器前缀——陈列行不再追加 （server） 后缀（描述保留）
      .map(([name, item]) => `- ${name}：${item.tool.description ?? '无描述'}`)
      .join('\n');
    return { content: [{ type: 'text', text: hits === '' ? '（无匹配工具）' : hits }] };
  }
  if (action === 'describe') {
    const target = String(args.tool ?? '');
    const item = bag.catalog.get(target);
    if (item === undefined) return { content: [{ type: 'text', text: `未知工具：${target}` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(item.tool.inputSchema ?? { type: 'object' }, null, 2) }] };
  }
  if (action === 'call') {
    const target = String(args.tool ?? '');
    const item = bag.catalog.get(target);
    if (item === undefined) return { content: [{ type: 'text', text: `未知工具：${target}` }], isError: true };
    try {
      // 桥侧预算 +500ms 让管道先执法（目录工具 def.timeoutMs = 60s 同码）；
      // 落桥换回服务器侧原名（target 是复合名——只是目录寻址面，不上线协议）
      const out = await item.conn.call(
        item.tool.name,
        (args.args as Record<string, unknown>) ?? {},
        DEFAULT_TOOL_TIMEOUT_MS + 500,
      );
      return { content: [{ type: 'text', text: out.text }], ...(out.isError ? { isError: true } : {}) };
    } catch (err) {
      // 调用超时原样上抛（结构化 TOOL_TIMEOUT）——服务器错误/连接死才是数据
      if (err instanceof AppError && err.code === TOOL_TIMEOUT) throw err;
      return { content: [{ type: 'text', text: `MCP 调用失败：${describeError(err)}` }], isError: true };
    }
  }
  return { content: [{ type: 'text', text: `未知 action：${action}（search/describe/call）` }], isError: true };
}

/**
 * 活服务器接线：登记簿落条（真实 command——PID 复用防护基线）+ close 退出订阅。
 *
 * 运行期退出语义（契约篇 §6.6）：撤该服务器全部工具（原生形态=撤件集；
 * 目录形态=清 catalog 条目）+ ui.notify warn + 不自动重连（复位走 /reload）。
 */
function wireLive(
  bag: DiscoverCtx,
  name: string,
  conn: McpServerConnection,
  config: McpServerConfig,
  disposers: Disposer[],
  ui: UiNotifyFace | undefined,
): void {
  const offExit = conn.onExit((reason) => {
    // 退出三清：live 簿移除 → 撤本服工具 → 清目录条目 + 登记簿删行
    bag.live.delete(name);
    for (const dispose of disposers) dispose();
    for (const [key, item] of [...bag.catalog]) {
      if (item.server === name) bag.catalog.delete(key);
    }
    if (conn.childPid !== undefined) bag.registry.remove(conn.childPid);
    ui?.notify(`MCP 服务器「${name}」退出：${reason}（其工具已撤；恢复走 /reload）`, { level: 'warn' });
    bag.logger.warn(`mcp 服务器 ${name} 运行期退出：${reason}`);
  });
  bag.live.set(name, { conn, disposers, offExit });
  if (conn.childPid !== undefined) {
    bag.registry.add({
      hostPid: process.pid,
      childPid: conn.childPid,
      server: name,
      command: config.command, // 真实命令行基线——清扫期 ps 验身用
    });
  }
}

/**
 * 回卷批量关停：先统一退订 close 监听 + 撤件 + 删登记（同步簿记），再并发
 * 协议化关停（每台内部 告别→宽限→树杀；并发总时长 ≈ 单台宽限——/reload
 * 不随服务器台数线性拖长）。
 */
async function shutdownAll(
  live: Map<string, LiveServer>,
  registry: ChildRegistry,
  catalogBox: { dispose?: Disposer },
): Promise<void> {
  catalogBox.dispose?.(); // 目录工具件级撤件（先撤工具再关连接——可见性即时）
  const items = [...live.values()];
  live.clear();
  await Promise.all(
    items.map(async (item) => {
      item.offExit(); // 先退订 close 监听：回卷关停不是「运行期退出」，不再 notify
      for (const dispose of item.disposers) dispose();
      if (item.conn.childPid !== undefined) registry.remove(item.conn.childPid);
      await item.conn.dispose();
    }),
  );
}
