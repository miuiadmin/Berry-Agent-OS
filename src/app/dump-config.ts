/**
 * L5 app — `berry dump-config` 组合树诊断（打印实际生效装配，不跑对话）。
 *
 * :memory: 同构（技术栈篇 §5 同构纪律，2026-08-26 挖矿批 P0-3）：诊断面禁 fork
 * 侧门——复用 createRuntime 同一入口、改传 `dbPath=':memory:'` 走**全量
 * 装配**（装载器执法/config 校验/Kahn 激活/应用 apply 全跑）后打印。「不落库」=
 * 会话主库零写入磁盘（内存库写入即弃）；数据目录侧副作用在场（目录创建类动作
 * 被容忍）。诊断的价值 = 报告真实装载会走到的路——侧门诊断 = 组合树漂移的开端。
 * 凭证配置状态不在此列（需要读真库，走 run 面的后续诊断命令——M1 不做）。输出
 * 人读文本：组合树逐行带装载状态（activated/failed/skipped/unresolved）——
 * 「我到底跑的是什么」的一屏答案（契约篇 §5.1）。应用装载失败 = 启动断言在
 * 组合根抛出，此处捕获后尽力先打印纯合成的树（零副作用解析——仅打印形态合成，
 * 失败兜底语义维持）再列失败清单，退出码 1。
 */

import { createRuntime } from './assembly.js';
import type { RuntimeOptions } from './assembly.js';
import { createLspAssemblyDeps, createBrowserAssemblyDeps } from './builtin-deps.js';
import { InflightGates } from '../web/index.js'; // 诊断形态限流占位（构造零副作用——apply 永不跑）
import { loadComposition, OVERLAY_FILENAME, safeModeComposition, type CompositionReport } from './composition.js';
import { loadOfficialApps, assertAppComponents } from './app-registry.js';
import { createBuiltinRegistry } from './builtins.js';
import { createSubagentChildFactory } from './subagent-factory.js';
import { createMcpSpawner } from './mcp-spawn.js';
import { createSandboxService } from '../safety/index.js';
import { killTree } from '../exec/index.js';
import type { AppStatusRow } from './composition.js';
import { resolveRowCarrier } from '../contracts/app.js';
import { AppError, COMPOSITION_ROW_INVALID, APP_LOAD_FAILED, describeError } from '../contracts/errors.js';
import { dataDir } from './paths.js';
import { VERSION } from './version.js';
import { createContext } from '../context/context.js';
import { createLlmRuntime, createStreamFn } from '../llm/index.js';
import { defaultConvertToLlm } from './convert.js';
import { DEFAULT_MODEL } from './assembly.js';

/**
 * 组合树文本渲染（dump 面共用：纯合成无状态版 + 装载后带状态版）。
 * @param composition 组合树装载产物
 * @param statuses 装载状态（缺省 = 纯计划形态——合成期/失败兜底路径用）
 */
function renderCompositionTree(composition: CompositionReport, statuses?: readonly AppStatusRow[]): string {
  const statusById = new Map((statuses ?? []).map((row) => [row.id, row]));
  // 行挂载目标查表（D1 清单投影批）：plan 行不携带 apps 键——合成行按 id 联查
  const appsById = new Map(composition.rows.map((row) => [row.id, row.apps]));
  const lines = composition.plan.map((row) => {
    const status = statusById.get(row.id);
    if (row.skip) return `  - ${row.id}：${status ? `${status.status}（${row.skip}）` : `skipped（${row.skip}）`}`;
    if (row.unresolved !== undefined) {
      return `  - ${row.id}：unresolved——${row.unresolved}`;
    }
    const tag =
      status?.status === 'activated' && status.name
        ? `activated（name: ${status.name}）`
        : status
          ? `${status.status}`
          : 'planned';
    // 载体标记（第二十七批刀二/三；第三十七批 sandbox 块改读 carrier）：非 main
    // 域行显式标注——「这行跑在哪个故障域」是组合树诊断的一等信息公开（main 缺省不带标记）
    const carrierTag = resolveRowCarrier(row) === 'main' ? '' : `@${resolveRowCarrier(row)} `;
    // 挂载目标标记（D1 清单投影批）：挂应用的行显式标注归属——装载序视角下
    // 「哪些行是应用件」一眼可辨（系统行缺省不带标记零噪声；多应用行 = 共享件全列）
    const apps = appsById.get(row.id);
    const appTag = apps === undefined ? '' : `→ ${apps.join('、')} `;
    return `  - ${row.id}：${carrierTag}${tag} ${appTag} ${row.entry ?? ''}`;
  });
  const head = `组合树（${composition.rows.length} 行；官方默认层 + ${OVERLAY_FILENAME} 后写胜出）：`;
  return lines.length > 0 ? [head, ...lines].join('\n') : `${head}\n  （空树——无应用行）`;
}

/**
 * 挂载分组渲染（D1 清单投影批，契约篇 §5.1 挂载目标两档——冷读 F13）：合成
 * 产物从「一棵合成树」升为「系统合成 + 各在册应用合成」的合成面集合，诊断面
 * 分两类打印。跳过/未解析行如实带注进组（分组是树形事实非装载断言——禁用行
 * 也在组合面可见）。
 * @param composition 组合树装载产物
 * @param appIds 在册应用 id 清单（每组恒在场——零挂载应用也是合法合成面）
 */
function renderMountGrouping(composition: CompositionReport, appIds: readonly string[]): string {
  const planById = new Map(composition.plan.map((row) => [row.id, row]));
  const byApp = new Map<string, string[]>(appIds.map((id) => [id, []]));
  const systemRows: string[] = [];
  for (const row of composition.rows) {
    const plan = planById.get(row.id);
    const note =
      plan?.skip === undefined ? (plan?.unresolved === undefined ? '' : '（unresolved）') : `（${plan.skip}）`;
    const entry = `${row.id}${note}`;
    if (row.apps === undefined) {
      systemRows.push(entry);
    } else {
      // 合成期①执法保证 apps ∈ 在册——防御查无即忽略（不静默挂进系统面）；
      // 多应用行（共享件）进每个目标应用组
      for (const appId of row.apps) byApp.get(appId)?.push(entry);
    }
  }
  const lines = [`  系统合成（${systemRows.length} 行）：${systemRows.join('、') || '（空）'}`];
  for (const id of appIds) {
    const rows = byApp.get(id) ?? [];
    lines.push(`  应用合成 ${id}（${rows.length} 行）：${rows.join('、') || '（空——纯系统合成）'}`);
  }
  return ['挂载分组（系统合成 + 各在册应用合成，契约篇 §5.1 两档）：', ...lines].join('\n');
}

/**
 * 仓库态件渲染（D2 装机两态批，契约篇 §6.1）：装机仓库里已装未挂的件——
 * provenance 账本 ∖ 组合树行（list() 差集条目）。「装了没挂」是装机面的
 * 断头路警示位，诊断面必须可见（不可静默）。
 * @param statuses 装载状态清单（list() 产物——installed-unmounted 条目在此）
 */
function renderInstalledUnmounted(statuses: readonly AppStatusRow[]): string {
  const rows = statuses.filter((row) => row.status === 'installed-unmounted');
  const items = rows.map((row) => `${row.id}（${row.source}）`);
  return `仓库态件（已装未挂 ${rows.length}）：${items.join('、') || '（无）'}`;
}

/**
 * 默认应用披露行（组装批默认应用键，契约篇 §5.4 冷读 M7/m13）：解析出的默认
 * id + 缺场回落原因——回落发生了用户须能知道为何（禁一件默认应用换人是
 * components 诚实声明的自然后果，诊断面如实呈现链路）。
 * @param apps 官方清单表
 * @param gaps 组件缺场表（与解析同源——per-open 活取同一投影的快照）
 */
function renderDefaultApp(
  apps: ReadonlyMap<string, { id: string; default?: boolean }>,
  gaps: ReadonlyMap<string, readonly string[]>,
): string {
  const marked = [...apps.values()].find((m) => m.default === true);
  // 第一跳：带标在场（无缺场记录）
  if (marked !== undefined && !gaps.has(marked.id)) return `默认应用：${marked.id}`;
  // 回落链/兜底态：拼原因（带标缺场 → 缺哪些件；chat 可达性另判）
  const markedNote =
    marked === undefined
      ? '无 default: true 声明清单'
      : `${marked.id} 缺场（缺组件：${gaps.get(marked.id)?.join('、') ?? '?'}）`;
  const chat = apps.get('chat');
  if (chat !== undefined && !gaps.has('chat')) return `默认应用：chat（回落——${markedNote}）`;
  const chatNote = chat === undefined ? 'chat 清单缺席' : `chat 缺场（缺组件：${gaps.get('chat')?.join('、') ?? '?'}）`;
  return `默认应用：（无——默认解析无果：${markedNote}；${chatNote}——open 防御降级，查组件缺场行）`;
}

/**
 * env 覆盖来源标注（基建大扫 #10/#32）：终值来源可辨——诊断「为什么我的模型/
 * 数据目录不对」从输出即可分 env 覆盖还是缺省，不用回查 shell 环境。
 * @param key APP_* 变量名
 * @returns 在场 = 「（KEY 覆盖）」标注；缺席 = 空串（缺省态不加噪声）
 */
function envOverrideNote(key: string): string {
  return process.env[key] !== undefined ? `（${key} 覆盖）` : '';
}

/**
 * env 生效面披露行（基建大扫 #10/#32）：四个子系统级 APP_* 变量（日志档/fd
 * 发现路径/bash 路径/浏览器路径）不体现在模型/数据目录各行，在场者并一行点名
 * ——「fd 补全为什么不工作」类排障从本屏即可见变量是否被设。
 * 全缺席 = 行缺席（零配置常态零噪声）；APP_DATA_DIR/APP_MODEL 不在此行
 * （已就地标注于所属行）、APP_DB_PATH 被 :memory: 诊断面钉死（设计使然）。
 */
function renderEnvOverrides(): string[] {
  const keys = ['APP_LOG_LEVEL', 'APP_FD_PATH', 'APP_BASH_PATH', 'APP_BROWSER_PATH'];
  const present = keys.filter((key) => process.env[key] !== undefined);
  if (present.length === 0) return [];
  return [`env 覆盖面：${present.join('、')}（已设——生效值见各子系统行为）`];
}

/**
 * 组合树打印主流程。
 * @param options 组合根选项透传（与生产同参——诊断的就是实际生效组合）
 * @returns 进程退出码（0 = 全激活/显式跳过；1 = 装载失败清单）
 */
export async function dumpConfigMain(options: RuntimeOptions = {}): Promise<number> {
  try {
    // :memory: 同构（P0-3）：persist 不传（缺省 true——持久层在场，凭证/预算投影
    // /memory 件全真跑），库路径锁 ':memory:'（内存库写入即弃 = 主库零落盘；
    // ensureDbDir 对 ':memory:' 既有跳过判定同源——不建数据库目录）
    const runtime = await createRuntime({ ...options, interactive: false, dbPath: ':memory:' });
    try {
      const lines = [
        `Berry ${VERSION}`,
        // 来源标注（基建大扫 #10/#32）：env 覆盖 vs 缺省一屏可辨
        `数据目录：${dataDir()}${envOverrideNote('APP_DATA_DIR')}`,
        `工作区：${runtime.workspace}`,
        `模型：${runtime.model}${envOverrideNote('APP_MODEL')}`,
        `沙箱档：${runtime.sandboxMode}`,
        `审批档：${runtime.approval.policyMode}`,
        // env 生效面（基建大扫 #10/#32）：子系统级变量在场点名行
        ...renderEnvOverrides(),
        // 安全模式可见面（--no-apps 同径）：一行声明本树是安全模式产物——
        // Ring 2/3 跳过不是树坏是旗标使然，operator 一眼可辨
        ...(options.noApps
          ? ['安全模式（--no-apps）：Ring 2/3 全跳过——boot 拒启自救位（/reload 读盘不受旗标影响）']
          : []),
        renderCompositionTree(runtime.composition, runtime.appsService.list()),
        // 挂载分组（D1 清单投影批 F13）：系统合成 + 各在册应用合成分两类打印
        renderMountGrouping(runtime.composition, [...runtime.apps.keys()]),
        // 默认应用披露（组装批 M7/m13）：解析出的默认 id + 缺场回落原因
        renderDefaultApp(runtime.apps, runtime.appGaps),
        // 仓库态件（D2 装机两态批）：已装未挂的装机仓库差集——断头路警示位
        renderInstalledUnmounted(runtime.appsService.list()),
        // 应用面（契约篇 §5.4 第二纵切——官方清单装载 + 组件在场断言产物）：
        // 缺场应用带缺失组件清单（应用级隔离不拒启，诊断走此面）
        `应用（${runtime.apps.size}）：${
          [...runtime.apps.values()]
            .map((m) => {
              const missing = runtime.appGaps.get(m.id);
              return missing === undefined
                ? `${m.id}[${m.label}]`
                : `${m.id}[${m.label}]（缺组件：${missing.join('、')}）`;
            })
            .join('、') || '（无）'
        }`,
        // 工具行 = 全局层口径（S2 两层注册表）：per-session 域层条目（fs 四名随
        // chat 件驱动 open 注册）不在此列——诊断面无活驱动，域层恒空
        `工具（全局层 ${runtime.tools.list().length}）：${runtime.tools
          .list()
          .map((t) => t.name)
          .join('、')}`,
        `技能发现位置：${runtime.skillLocations.map((l) => l.dir).join('、') || '（无）'}`,
        `技能（${runtime.skills.list().length}）：${
          runtime.skills
            .list()
            .map((s) => s.name)
            .join('、') || '（无）'
        }`,
        `系统提示词：${runtime.systemPrompt.length} 字符`,
      ];
      process.stdout.write(lines.join('\n') + '\n');
      // G1 失败自查（2026-08-30）：boot 对第三方行失败已隔离降级不再抛——诊断面
      // 自立「失败行在场 → 退出码 1」规则接续旧拒启语义（nonzero = 有行失败须
      // 人眼，尽管平台照启）；官方行失败仍拒启走上方 catch 原路。树打印
      // （renderCompositionTree）已含逐行状态，此处补清单 + 退出码
      const failedRows = runtime.appsService.list().filter((row) => row.status === 'failed');
      if (failedRows.length > 0) {
        process.stdout.write(
          `失败行（${failedRows.length}——已隔离跳过，平台照启；官方行失败则拒启）：\n${failedRows
            .map((row) => `  - [${row.code}] ${row.id}：${row.message}`)
            .join('\n')}\n`,
        );
        return 1;
      }
      return 0;
    } finally {
      await runtime.shutdown();
    }
  } catch (err) {
    // 启动断言失败（应用装载/组合树校验）——诊断面捕获后打印树与清单，不裸抛
    if (err instanceof AppError && (err.code === APP_LOAD_FAILED || err.code === COMPOSITION_ROW_INVALID)) {
      process.stdout.write(`Berry ${VERSION}\n数据目录：${dataDir()}\n`);
      // 树尽力打印：纯合成解析零副作用（应用 import 失败也能看到树本身）；
      // 官方件注册表同构传入（无 store 诊断态）——builtin: 行解析不失真
      //（subagent 真工厂构造全惰性——委派永不发生，占位依赖零副作用；chat 为
      // 纯树合成的占位件——apply 永不跑，只需注册表键在）
      try {
        // app 键取值域同构（D1 清单投影批）：与真 boot 同一清单源（官方目录
        // 现读）——兜底树与实装树对 app 行同一执法口径，诊断面不侧门漂移；
        // 清单坏 = loadOfficialApps 抛错，走「合成本身失败」兜底（错误即诊断）
        const officialApps = loadOfficialApps();
        const synthetic = loadComposition(
          options.compositionDir ?? dataDir(),
          createBuiltinRegistry({
            workspace: () => process.cwd(),
            subagentFactory: createSubagentChildFactory({
              getParent: () => undefined,
              streamFn: createStreamFn(createLlmRuntime()),
              model: options.model ?? process.env['APP_MODEL'] ?? DEFAULT_MODEL,
              convertToLlm: (messages) => defaultConvertToLlm(messages),
              workspace: process.cwd(),
              sandboxMode: options.sandboxMode ?? 'workspace-write',
              rootCtx: createContext({ name: 'dump-diag' }),
              // 守门行传导判据占位（第三十一批必传面）：诊断面装载不发生、根总线
              // 恒空——空锚/空集即传导恒零行，与「委派永不发生」同语义
              gateRowFilter: { anchors: [], mainRows: () => new Set<string>() },
            }),
            getSession: () => undefined,
            // chat 占位件：纯树合成只查注册表键（形状/装载均不发生）——
            // apply 为空实现占位，构造期零副作用
            chat: {
              name: 'chat',
              apply: async () => undefined,
            },
            // mcp 件闭包同构（构造零副作用——spawner 只返回闭包不 spawn；
            // 诊断面 apply 永不跑，登记簿/子进程均不触。OS 沙箱层升格三参
            // 形：sandbox 传真服务实例（构造零副作用——后端链惰性 probe 不
            // 发生）、workspace 对齐本占位族 process.cwd() 口径）
            mcpDeps: {
              spawnServer: createMcpSpawner(dataDir(), createSandboxService(), process.cwd()),
              killTree,
              dataDir: dataDir(),
            },
            // lsp 件闭包同构（默认层第十二行，契约篇 §6.7）：复用组合根工厂
            //（构造零副作用——TMPDIR 建目录已惰性到首 spawn，诊断面不触盘）
            lspDeps: createLspAssemblyDeps(dataDir(), createSandboxService(), process.cwd()),
            // browser 件闭包（诊断装配同构——引擎惰性零 spawn，诊断面构造 deps 不触盘）
            browserDeps: createBrowserAssemblyDeps(dataDir(), new InflightGates()), // 占位单例（诊断面不共享生产 webGates——apply 永不跑零行为差）
            // tools 件闭包占位（Ring 1 行树化批——诊断面 apply 永不跑，占位
            // 闭包零副作用；检索族 workspace 锚在，注册表键在即树形不失真）
            toolsDeps: {
              gateSink: () => undefined,
              workspace: () => process.cwd(),
            },
            // channels 件闭包占位（Ring 1 第十三行树化——同 toolsDeps 律：诊断面
            // apply 永不跑，注册表键在即树形不失真；onUiError 占位零副作用）
            channelsDeps: {
              onUiError: () => undefined,
            },
            // webui 件闭包占位（默认层第十四行——enabled:false 行缺省惰性零监听，
            // 诊断面 apply 永不跑；占位腿全 stub，注册表键在即树形不失真）
            webuiDeps: {
              addDisplay: () => undefined,
              submitTo: () => null,
              historyFor: () => undefined,
              sessionsFor: () => [],
              openSession: async () => undefined,
              todoFor: () => undefined,
              approvals: {
                // claim 挂载占位：回卷函数立即执行（零持有）
                mountClaim: () => () => undefined,
              },
              workspaceRoot: () => '',
              symbolsFor: () => Promise.resolve(undefined),
              ui: () => {
                throw new Error('dump-config 占位：ui 服务在诊断面不可达');
              },
              version: VERSION,
            },
          }),
          new Set(officialApps.keys()),
        );
        // 安全模式同径（--no-apps）：失败兜底树同样只保 Ring 1 行——诊断面
        // 报告「实际生效装配」，全量树在此形态下根本不会生效
        const fallbackTree = options.noApps ? safeModeComposition(synthetic) : synthetic;
        process.stdout.write(renderCompositionTree(fallbackTree) + '\n');
        // 挂载分组同构（D1）：兜底树与实装树同一分组口径（官方清单现读）
        process.stdout.write(renderMountGrouping(fallbackTree, [...officialApps.keys()]) + '\n');
        // 默认应用披露同构（组装批 M7）：与成功路同口径——官方清单现读 + 兜底树
        // 算缺场（assertAppComponents 纯读合成产物，诊断态零装载即可调用）
        process.stdout.write(renderDefaultApp(officialApps, assertAppComponents(officialApps, fallbackTree)) + '\n');
      } catch {
        // 合成本身失败——跳过树，错误信息即诊断
      }
      process.stdout.write(`${describeError(err)}\n`);
      return 1;
    }
    throw err;
  }
}
