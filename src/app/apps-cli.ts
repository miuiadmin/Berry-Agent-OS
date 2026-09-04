/**
 * L5 app — `berry apps` CLI 对等族 + `berry sessions` 只读族（第八十五批批 F，
 * 技术栈篇 §5 对等律③：TUI 能做的 CLI 一致可做）。
 *
 * **薄壳单源纪律**：apps 动词全部转发既有实现——装机族走 `AppsService`
 * （admin 工具族/桌面管理面同一真身），技能/MCP 族走 `store` 服务面（桌面商店
 * 视图同一消费面）；本文件零业务逻辑，只做 argv 分派、退出码与输出形态。
 * 禁第二实现。
 *
 * **进程形态**：apps 族动词全在**文件面**（装机子树/组合 overlay/provenance
 * 账本——不触会话库），runtime 以 `persist: false` 起（零库零 boot 会话——CLI
 * 一发进程不造空会话行污染近史清单）；sessions 族只读直开 Store +
 * SessionFtsIndex（同一单源类，零 runtime 同因）。
 *
 * 退出码（main-cli 先例）：0 = 成功（含两段式第一段检视）；1 = 动词失败/面
 * 缺席诚实拒；2 = 用法错。
 *
 * 两段式纪律（卸载族——与桌面 confirm 原语对等）：缺省 = inspect 报告 +
 * 指路 `--yes`；`--yes` = 执行（数据域恒 keep——purge 走管理工具面）。
 */

import { createRuntime } from './assembly.js';
import type { RuntimeOptions } from './assembly.js';
import { dbPath } from './paths.js';
import { openStore } from '../persist/index.js';
import { SessionFtsIndex } from '../memory/index.js';
import { collectBuiltinMigrations } from './builtins.js';
import type { StoreService } from './store-app.js';
import type { DesktopAdminResult } from './desktop-shell.js';
import { formatUninstallExec, formatUninstallReport } from './commands.js';

/** CLI 输出注入面（测试注内存缓冲；缺省 stdout/stderr） */
export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** 缺省真进程输出（stdout 结果面 / stderr 拒因面——脚本消费方不受扰） */
const defaultIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** apps 族分派选项（main.ts case 'apps' 透传——旗标语义只在动词处执法） */
export interface AppsCliOptions {
  /** 子命令位与位置参数（`berry apps <sub> …` 的 `<sub> …` 段） */
  readonly args: readonly string[];
  /** --yes（卸载族两段式第二段钥匙——shutdown/reboot 同一旗标词） */
  readonly yes: boolean;
  /** 运行形态旗标在场面（readOnly/background/tick/app/port/noApps/sandboxHost/foreground/appFile 任一在场即真——apps 族全拒） */
  readonly formFlagsPresent: boolean;
  /** 组合根选项透传（测试注入数据目录/compositionDir；persist 恒被覆写 false） */
  readonly runtimeOptions?: RuntimeOptions;
  /** 输出注入（测试面；缺省真进程流） */
  readonly io?: CliIo;
}

/** apps 族用法行（子命令定稿表单源——main.ts usage 消费同文） */
export const APPS_CLI_USAGE =
  '用法：berry apps <list | install <ref> | uninstall <id> [--yes] | mount <id> <app…> | unmount <rowId> | ' +
  'toggle <id> | update <id> | skill-install <名> | skill-mount <名> | skill-unmount <名> | skill-uninstall <名> [--yes] | ' +
  'mcp-add <名> <命令绝对路径> [参数…] | mcp-remove <名>>（run 族旗标不适用）';

/**
 * 回执呈现与两段式跟进（桌面 confirm 机器的 CLI 对等）：string = 拒因走
 * stderr 退 1；receipt = stdout 打印退 0；confirm 在场且未 --yes = 指路行退 0
 * （inspect 是合法终点）；--yes = 执行 confirm.run 并递归呈现下一层回执。
 */
async function present(result: DesktopAdminResult, yes: boolean, io: CliIo): Promise<number> {
  if (typeof result === 'string') {
    io.err(result);
    return 1;
  }
  io.out(result.title);
  for (const line of result.lines) io.out(line);
  if (result.confirm === undefined) return 0;
  if (!yes) {
    io.out(`（两段式第一段——加 --yes 执行：${result.confirm.label}）`);
    return 0;
  }
  return present(await result.confirm.run(), false, io);
}

/** apps 族子命令全集（对等门禁消费——cli-parity 交叉核对 CLI 侧真相源） */
export const APPS_CLI_SUBCOMMANDS: readonly string[] = [
  'list',
  'install',
  'uninstall',
  'mount',
  'unmount',
  'toggle',
  'update',
  'skill-install',
  'skill-mount',
  'skill-unmount',
  'skill-uninstall',
  'mcp-add',
  'mcp-remove',
];

/** sessions 族子命令全集（对等门禁消费——同上） */
export const SESSIONS_CLI_SUBCOMMANDS: readonly string[] = ['list', 'search'];

/**
 * apps 族主流程（main.ts case 'apps' 的子命令族半边——check 子命令由 API 治理
 * 批独占，本函数只见其余动词）。
 */
export async function appsCliMain(options: AppsCliOptions): Promise<number> {
  const io = options.io ?? defaultIo;
  const [sub = '', ...rest] = options.args;
  // 形态旗标互斥（upgrade/shutdown 同律）：apps 族是维护动词不与运行形态并用
  if (options.formFlagsPresent) {
    io.err(APPS_CLI_USAGE);
    return 2;
  }
  // 子命令参数面执法（缺参/越参即用法错——静默吞参数即语义丢失）。
  // 变长族：mount（装机 id + ≥1 挂载目标）/ mcp-add（名 + 启动命令 + 变长 args）
  const fixed: Record<string, number> = {
    list: 0,
    install: 1,
    uninstall: 1,
    unmount: 1,
    toggle: 1,
    update: 1,
    'skill-install': 1,
    'skill-mount': 1,
    'skill-unmount': 1,
    'skill-uninstall': 1,
    'mcp-remove': 1,
  };
  const variadicMin: Record<string, number> = { mount: 2, 'mcp-add': 2 };
  // 分派表与对等门禁真相源（APPS_CLI_SUBCOMMANDS）一致性在此执法——两表漂移
  // 即本行 fail-loud（改子命令面必须同笔过 cli-parity）
  for (const name of APPS_CLI_SUBCOMMANDS) {
    if (fixed[name] === undefined && variadicMin[name] === undefined) {
      throw new Error(`apps CLI 分派表缺子命令 ${name}（APPS_CLI_SUBCOMMANDS 与分派表漂移）`);
    }
  }
  const expectFixed = fixed[sub];
  const expectVariadic = variadicMin[sub];
  const shapeOk =
    expectFixed === undefined
      ? expectVariadic === undefined
        ? false
        : rest.length >= expectVariadic
      : rest.length === expectFixed;
  if (!shapeOk) {
    io.err(APPS_CLI_USAGE);
    return 2;
  }

  // runtime 起装（persist:false——apps 族动词全在文件面，零库零 boot 会话）
  let runtime: Awaited<ReturnType<typeof createRuntime>>;
  try {
    runtime = await createRuntime({
      ...(options.runtimeOptions ?? {}),
      persist: false,
      interactive: false,
      processKind: 'run',
    });
  } catch (err) {
    io.err(`装配失败：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  try {
    const apps = runtime.appsService;
    // 商店服务面（技能/MCP 族单源——桌面商店视图同一消费面；行禁用即缺席诚实拒）
    const storeFace = (): StoreService | undefined => runtime.ctx.tryGet<StoreService>('store');

    switch (sub) {
      case 'list': {
        // 装载态一览（admin apps_list 工具同源数据——list() 单真相，各自格式化）
        const rows = apps.list();
        if (rows.length === 0) io.out('（无装机行）');
        for (const row of rows) {
          const source = row.source ?? '内置';
          io.out(
            row.status === 'activated'
              ? `✓ ${row.id}（${source}${row.name === undefined ? '' : ` · ${row.name}`}）`
              : row.status === 'failed'
                ? `✖ ${row.id}（${source}）：${row.code ?? '?'} ${row.message ?? ''}`.trimEnd()
                : row.status === 'installed-unmounted'
                  ? `◇ ${row.id}（${source}）已装未挂载——mount <id> <app…> 挂载后生效`
                  : `· ${row.id}（${source}）${row.status}`,
          );
        }
        return 0;
      }
      case 'install': {
        // 装机（D2 仓库态零生效——回执明示两态与挂载指引）
        const report = await apps.install(rest[0]!);
        io.out(`已装机 ${report.id}（仓库态零生效）`);
        io.out(`  ${report.message}`);
        io.out('  挂载后生效：berry apps mount <id> <应用id…>');
        return 0;
      }
      case 'uninstall': {
        // 两段式：缺省 inspect 报告 + 指路 --yes；--yes 执行（数据域恒 keep）
        const report = await apps.uninstall(rest[0]!, { mode: 'inspect' });
        io.out(formatUninstallReport(report));
        if (!options.yes) {
          io.out('（两段式第一段——加 --yes 执行卸载〔数据域保留；purge 走管理工具面〕）');
          return 0;
        }
        const exec = await apps.uninstall(rest[0]!, { mode: 'execute', dataAction: 'keep' });
        io.out(formatUninstallExec(exec));
        io.out('（CLI 一发进程——无热重载；下次启动即按新组合树装载）');
        return 0;
      }
      case 'mount': {
        const report = await apps.mount(rest[0]!, { apps: rest.slice(1) });
        io.out(`已挂载 ${report.id}`);
        io.out(`  ${report.message}`);
        io.out(`  挂载目标：apps ${report.apps.join('、')}（${report.source} 源）`);
        io.out('（CLI 一发进程——无热重载；下次启动即生效）');
        return 0;
      }
      case 'unmount': {
        const report = await apps.unmount(rest[0]!);
        io.out(`已卸挂载 ${report.id}`);
        io.out(`  ${report.message}`);
        for (const warning of report.warnings) io.out(`  ⚠ ${warning}`);
        io.out('（CLI 一发进程——无热重载；下次启动即生效）');
        return 0;
      }
      case 'toggle': {
        const disabled = apps.toggle(rest[0]!);
        io.out(
          disabled
            ? `已禁用 ${rest[0]}（overlay disabled 行——下次启动跳过）`
            : `已启用 ${rest[0]}（disabled 键已删——下次启动装载）`,
        );
        return 0;
      }
      case 'update': {
        const report = await apps.update(rest[0]!);
        io.out(`已更新 ${report.id}`);
        io.out(`  ${report.message}`);
        return 0;
      }
      case 'skill-install':
      case 'skill-mount':
      case 'skill-unmount':
      case 'skill-uninstall': {
        const face = storeFace();
        if (face === undefined) {
          io.err('商店服务面不在场（store 行被禁用或未装载）——/apps-toggle store 或 overlay 装回');
          return 1;
        }
        // 技能族动词（服务面回执即披露面：install 含 provenance/两态说明，
        // uninstall 缺省检视三清将删什么、--yes 执行）
        const action =
          sub === 'skill-install'
            ? face.installSkill(rest[0]!)
            : sub === 'skill-mount'
              ? face.mountSkill(rest[0]!)
              : sub === 'skill-unmount'
                ? face.unmountSkill(rest[0]!)
                : options.yes
                  ? face.uninstallSkill(rest[0]!)
                  : Promise.resolve(face.skillUninstallInspect(rest[0]!));
        return present(await action, options.yes, io);
      }
      case 'mcp-add':
      case 'mcp-remove': {
        const face = storeFace();
        if (face === undefined) {
          io.err('商店服务面不在场（store 行被禁用或未装载）——/apps-toggle store 或 overlay 装回');
          return 1;
        }
        // MCP 配置分发（servers 键合并写入/删键——服务面回执含 config 指引）
        const action =
          sub === 'mcp-add' ? face.addMcpServer(rest[0]!, rest[1]!, rest.slice(2)) : face.removeMcpServer(rest[0]!);
        return present(await action, false, io);
      }
      default:
        io.err(APPS_CLI_USAGE);
        return 2;
    }
  } catch (err) {
    // 动词失败（AppError 族——服务面 fail-loud 抛出在此收口为退出码 1）
    io.err(`${sub} 失败：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await runtime.shutdown();
  }
}

/** sessions 族用法行 */
export const SESSIONS_CLI_USAGE = '用法：berry sessions <list | search <关键词…>>（只读面）';

/**
 * sessions 族主流程（只读直开 Store——零 runtime 防 boot 会话污染；recentSessions
 * 与 session_fts 与桌面切换器/webui 同一单源类）。
 */
export async function sessionsCliMain(args: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const [sub = '', ...rest] = args;
  if (sub === 'list' && rest.length === 0) return listSessionsCli(io);
  if (sub === 'search' && rest.length > 0) return searchSessionsCli(rest.join(' '), io);
  io.err(SESSIONS_CLI_USAGE);
  return 2;
}

/** 近史会话清单（recentSessions 单源——桌面切换器/webui 清单同一取数面） */
function listSessionsCli(io: CliIo): number {
  const store = openStore({ path: dbPath(), migrations: collectBuiltinMigrations() });
  try {
    const rows = store.recentSessions(50);
    if (rows.length === 0) {
      io.out('（近史无会话——库空或首启）');
      return 0;
    }
    for (const row of rows) {
      const when =
        row.lastEventAt === null
          ? '（零事件）'
          : new Date(row.lastEventAt).toISOString().replace('T', ' ').slice(0, 16);
      io.out(`${row.id}  [${row.app ?? 'chat'}]  ${when}  ${row.cwd ?? ''}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

/** 全文搜索（SessionFtsIndex 单源；先对账再查——索引与日志一致的既定编舞） */
function searchSessionsCli(query: string, io: CliIo): number {
  const store = openStore({ path: dbPath(), migrations: collectBuiltinMigrations() });
  try {
    const fts = new SessionFtsIndex(store.connection);
    fts.synchronize(store); // 激活期对账（memory 件同款尽力而为——索引追平日志）
    const hits = fts.search(query, { limit: 50 });
    if (hits.length === 0) {
      io.out(`「${query}」无命中`);
      return 0;
    }
    for (const hit of hits) io.out(`${hit.sessionId}  #${hit.seq}  ${hit.snippet}`);
    return 0;
  } finally {
    store.close();
  }
}
