/**
 * L5 app — 组合树（插件契约篇 §5.1：空根 + 官方默认层 + 用户 overlay，后写胜出）。
 *
 * 职责单子（「装什么/在哪」；「怎么装」归 context 加载器）：
 * 1. overlay 装载与拒绝式校验（`<数据目录>/overlay.yaml`，pre-release 拒绝式——
 *    未知字段/缺 id/类型错即 COMPOSITION_ROW_INVALID，不误读）；
 * 2. 合成：字段级后写胜出（plugin 省略沿用官方层该 id 引用、config 整体替换不深
 *    合并、insert 新行必须自带 plugin）；fixed 行被 overlay 禁用 = 合成期即响；
 * 3. 禁用解析（true → disabled / 平台串命中当前平台 → platform）与插件入口解析
 *    （路径直引或 `<数据目录>/plugins/node_modules/<包名>` 子树 + harness 字段/
 *    约定目录回退）；禁用行不解析入口（挂载休眠——禁用不因缺件而启动失败）；
 * 4. 目录服务（ctx.paths，§1.5——pi-11：无目录服务 = 插件猜宿主路径的开端）与
 *    插件管理最小服务（ctx.plugins.list——装配枚举唯一事实源 = 组合树）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { writeAtomicFile } from '../persist/index.js';
import { AppError, COMPOSITION_ROW_INVALID } from '../contracts/errors.js';
import { canonicalWorkspaceRoot } from '../context/workspace.js';
import type { BuiltinPluginModule, CompositionRow, PluginPlanRow, PluginSkipReason } from '../contracts/plugin.js';

/** overlay 文件名（<数据目录>/overlay.yaml，契约篇 §5.2） */
export const OVERLAY_FILENAME = 'overlay.yaml';

/**
 * 官方件注册表（契约篇 §6.1）：键 = 完整引用串（`builtin:memory` 式），值 = 宿主
 * 随包模块引用。组合根装配期构造（store/workspace 等依赖以闭包注入）；`builtin:`
 * 是保留前缀——注册表是唯一解析面，overlay 不可能引用非官方注册件（查不到即 unresolved）。
 */
export type BuiltinPluginRegistry = Readonly<Record<string, BuiltinPluginModule>>;

/**
 * 官方默认层行集现状（契约篇 §5.1 落码注记随铭牌批更新）：chat（首行，对话
 * 应用件）/ memory / subagent / goal / scheduler / mcp——均 Ring 2 真·可卸
 * （overlay 可禁用，卸掉仅失对应能力，核心循环不破）；tools（第七行）=
 * Ring 1 行树化起算行（2026-08-26 契约篇 §5.1 节奏表第一刀）——**Ring 1
 * 必备行**，overlay 禁用即启动断言拒启（缺它核心循环必破，非可卸）。Ring 0
 * 内核不进组合树；Ring 1 其余行（channels/skills/llm/persist/safety 策略行）
 * 仍为组合根硬装配，随各自纵切逐行入列。
 */
// 官方默认层（Ring 2 官方全家桶——契约篇 §5.1）：chat 首行 + memory/subagent/goal/
// scheduler/mcp 顺移 + tools（Ring 1 行树化起算行——行序是展示/装载叙事，Ring
// 归属不依行序：Ring 1 行经宿主装配期独立锚装载，装载序由 inject 驱动 Kahn）
const DEFAULT_LAYER_ROWS: readonly CompositionRow[] = [
  // 首行 = chat 对话应用件（契约篇 §5.4 应用面第一纵切）：对话是应用不是内核
  //（命题 §3.5）——Ring 2 真·可卸，overlay 禁用即首启无对话循环、宿主照启
  { id: 'chat', plugin: 'builtin:chat' },
  { id: 'memory', plugin: 'builtin:memory' },
  { id: 'subagent', plugin: 'builtin:subagent' },
  { id: 'goal', plugin: 'builtin:goal' },
  // 第五行 = scheduler tick 任务面（内核边界篇 §4.1 席 13 第一刀）：jobs 表 +
  // /tick 命令 + 只读子进程单发——卸掉即无任务面，核心循环不破
  { id: 'scheduler', plugin: 'builtin:scheduler' },
  // 第六行 = mcp 客户端桥（契约篇 §6.6 第一刀，stdio-only）：外部工具生态接
  // 入——servers 空时惰性无害；卸掉即无 MCP 外部工具，核心循环不破
  { id: 'mcp', plugin: 'builtin:mcp' },
  // 第七行 = tools 行（Ring 1 行树化起算，2026-08-26 契约篇 §5.1 节奏表）：
  // 三段管道 + ctx.tools 服务 + fs/检索工具族入列——Ring 1 必备行非可卸
  //（启动断言第二断言类；缺省层替换语义：overlay 可换实现引用不可禁用）
  { id: 'tools', plugin: 'builtin:tools' },
  // 第八行 = web 行（契约篇 §1.5.2 web 刀，Ring 2 真·可卸库角色行）：fetch
  // 工具 + ctx.fetch 服务 + SSRF 五卫生件一批三件——卸掉即无 fetch 能力，
  // 核心循环不破
  { id: 'web', plugin: 'builtin:web' },
  // 第九行 = compaction 行（内核边界篇席 20，会话篇 §2 增补七条——Ring 2 真·
  // 可卸后台角色行）：长会话压缩 durable 五步 + 两段式触发 + 重播种接线。
  // 零宿主资源闭包（服务全经 ctx 取）；卸掉即无自动压缩，核心循环不破
  //（曾压缩过的旧日志可读性不随行装载漂移——词汇宿主面注册）
  { id: 'compaction', plugin: 'builtin:compaction' },
  // 第十行 = admin 行（契约篇 §3.4 平台管理面第一刀，2026-08-27——Ring 2 真·
  // 可卸只读管理件）：plugins_list/events_query 两只读工具 + ctx.sessions
  // 跨会话有界查询消费 + 管理 Skill 同件携带（包根自述锚）。写类动词
  // （install/uninstall/configure/reload）随第二刀导线；卸掉即无管理面
  // 工具，核心循环不破
  { id: 'admin', plugin: 'builtin:admin' },
];

/**
 * Ring 1 必备行 id 清单（契约篇 §5.1 行树化批「第二断言类」——tools 行起算，
 * 后续行树化纵切逐行累加：channels/skills/llm/persist/safety 策略行）。
 * 判据：卸掉该行首启核心循环「问→做→守→存」必破 = Ring 1（内核边界篇 §5.1
 * 一句话判据在装载面的投影）；fixed 词条不动（其定义 = 安全栈强制点行）。
 */
export const RING1_REQUIRED_ROW_IDS: readonly string[] = ['tools'];

/** Ring 1 必备行断言违规（启动拒绝的事实清单——missing/disabled/platform/unresolved） */
export interface Ring1Violation {
  /** 组合树行 id */
  readonly id: string;
  /** 违规类别：行缺失（结构性）/ overlay 禁用 / 平台门控 / 引用解析失败 */
  readonly kind: 'missing' | 'disabled' | 'platform' | 'unresolved';
  /** 人读事实（拒启清单逐行打印） */
  readonly detail: string;
}

/**
 * Ring 1 必备行断言（契约篇 §5.1 行树化批钉死的「第二断言类」——现码第一类
 * 断言只查 failed 行、skipped 静默，本断言补 Ring 1 面）：overlay 禁用/平台
 * 门控/行缺失/引用解析失败一律拒启。纯函数返回违规全集（调用方格式化与收尾
 * 拒启——组合根 refuseBoot 先 flush/close 持久层再回卷 ctx）。
 */
export function assertRing1Required(report: CompositionReport): readonly Ring1Violation[] {
  const violations: Ring1Violation[] = [];
  for (const id of RING1_REQUIRED_ROW_IDS) {
    const row = report.rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      violations.push({
        id,
        kind: 'missing',
        detail: '组合树无此行（官方默认层缺失——结构性错误，Ring 1 必备行不可抹除）',
      });
      continue;
    }
    const planRow = report.plan.find((candidate) => candidate.id === id);
    if (planRow?.skip === 'disabled') {
      violations.push({
        id,
        kind: 'disabled',
        detail:
          'Ring 1 必备行被 overlay 禁用——卸掉它首启核心循环必破（契约篇 §5.1 行树化批）；如需换实现请替换行引用而非禁用',
      });
      continue;
    }
    if (planRow?.skip === 'platform') {
      violations.push({
        id,
        kind: 'platform',
        detail: `Ring 1 必备行被平台门控禁用（${process.platform}）——Ring 1 行无平台豁免语义`,
      });
      continue;
    }
    if (planRow !== undefined && planRow.unresolved !== undefined) {
      violations.push({
        id,
        kind: 'unresolved',
        detail: `Ring 1 必备行引用解析失败：${planRow.unresolved}`,
      });
    }
  }
  return violations;
}

/**
 * Ring 1 行合成结果差异（/reload 报告面，契约篇 §5.1 /reload 语义）：对比装载
 * 前后同 id 行的合成字段（plugin/config/disabled）——任一变化即该行需重启
 * 生效。Ring 1 行不回卷不重装载（仅 boot 生效），变化只能报告不能热应用。
 * @returns 需重启生效的行 id 清单（空 = 无变化）
 */
export function diffRing1Rows(before: CompositionReport, after: CompositionReport): readonly string[] {
  const changed: string[] = [];
  for (const id of RING1_REQUIRED_ROW_IDS) {
    // 行合成字段全量序列化比对（字段级后写胜出的合成产物，键序确定）
    const snapshot = (report: CompositionReport): string | undefined => {
      const row = report.rows.find((candidate) => candidate.id === id);
      return row === undefined ? undefined : JSON.stringify(row);
    };
    if (snapshot(before) !== snapshot(after)) changed.push(id);
  }
  return changed;
}

/** 组合树装载产物（dump-config 打印 + ctx.plugins.list 数据源） */
export interface CompositionReport {
  /** 合成后的树（保留 fixed 标记与原始字段——诊断「我到底跑的是什么」） */
  readonly rows: readonly CompositionRow[];
  /** 装载计划（激活行带 entry；skip/unresolved 行带原因——加载器输入） */
  readonly plan: readonly PluginPlanRow[];
}

/**
 * 安全模式组合树过滤（技术栈篇 §5 `--no-plugins`，第二十六批拍板 ③）：只保
 * Ring 1 硬装配行——默认层与 overlay 的其余行全部跳过（一视同仁，不是「只跳
 * overlay」）。boot 合成期与 dump-config 失败兜底树两消费点共用（诊断面报告
 * 的必须是「实际生效装配」）。/reload 不经此过滤（救援环语义：boot 安全模式
 * → 修 overlay → /reload 正常读盘恢复全树——一进程内闭环，无需重启）。
 */
export function safeModeComposition(report: CompositionReport): CompositionReport {
  return {
    rows: report.rows.filter((row) => RING1_REQUIRED_ROW_IDS.includes(row.id)),
    plan: report.plan.filter((row) => RING1_REQUIRED_ROW_IDS.includes(row.id)),
  };
}

/** overlay 允许的行字段全集（未知字段拒绝式——§6.5 pre-release 纪律） */
const ROW_KEYS = new Set(['id', 'plugin', 'config', 'disabled', 'fixed', 'runtime']);

/**
 * 读并校验 overlay 行集（文件不存在 = 空 overlay——首启零配置即合法）。
 * YAML 顶层必须是 `{ rows: [...] }`；行字段逐个校验类型。
 * 公开导出（写回操作与装机服务的对账读取面共用同一拒绝式校验）。
 */
export function loadOverlayRows(dataDir: string): CompositionRow[] {
  const overlayPath = join(dataDir, OVERLAY_FILENAME);
  if (!existsSync(overlayPath)) return [];
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(overlayPath, 'utf8'));
  } catch (err) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `overlay.yaml 解析失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (doc === null || doc === undefined) return []; // 空文件 = 空 overlay
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new AppError(COMPOSITION_ROW_INVALID, 'overlay.yaml 顶层必须是 `{ rows: [...] }` 对象');
  }
  const rows = (doc as Record<string, unknown>)['rows'];
  if (rows === undefined) {
    throw new AppError(COMPOSITION_ROW_INVALID, 'overlay.yaml 缺顶键 `rows`（行清单）');
  }
  if (!Array.isArray(rows)) {
    throw new AppError(COMPOSITION_ROW_INVALID, 'overlay.yaml 的 rows 必须是数组');
  }
  return rows.map((raw, index) => validateRow(raw, `overlay.yaml rows[${index}]`));
}

/** 单行拒绝式校验：id 必填非空串；plugin 串；config 纯对象；disabled 布尔/平台串；未知字段即拒 */
function validateRow(raw: unknown, where: string): CompositionRow {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError(COMPOSITION_ROW_INVALID, `${where}：行必须是对象`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ROW_KEYS.has(key)) {
      throw new AppError(
        COMPOSITION_ROW_INVALID,
        `${where}：未知字段「${key}」（允许字段：${[...ROW_KEYS].join('/')}）`,
      );
    }
  }
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new AppError(COMPOSITION_ROW_INVALID, `${where}：id 必填且为非空字符串（组合树行稳定标识）`);
  }
  const plugin = record['plugin'];
  if (plugin !== undefined && typeof plugin !== 'string') {
    throw new AppError(COMPOSITION_ROW_INVALID, `${where}：plugin 必须是字符串（包名或路径引用）`);
  }
  const config = record['config'];
  if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
    throw new AppError(COMPOSITION_ROW_INVALID, `${where}：config 必须是对象（字段级整体替换，不做深合并）`);
  }
  const disabled = record['disabled'];
  if (
    disabled !== undefined &&
    disabled !== true &&
    !(typeof disabled === 'string' && ['darwin', 'linux', 'win32'].includes(disabled))
  ) {
    throw new AppError(COMPOSITION_ROW_INVALID, `${where}：disabled 必须是 true 或平台名（darwin/linux/win32）`);
  }
  if (record['fixed'] !== undefined) {
    // fixed 是官方默认层安全栈强制点标记——overlay 是用户层，无权设置
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `${where}：fixed 只能出现在官方默认层（安全栈强制点），overlay 不可设置`,
    );
  }
  const runtime = record['runtime'];
  if (runtime !== undefined && runtime !== 'main' && runtime !== 'worker') {
    // 'external'（案三外部进程域）是预留词未开闸——显式点名防误配
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `${where}：runtime 必须是 'main' 或 'worker'（当前值：${String(runtime)}；'external' 为案三预留词未开闸，契约篇 §1.7）`,
    );
  }
  return {
    id,
    ...(plugin !== undefined ? { plugin } : {}),
    ...(config !== undefined ? { config: config as Record<string, unknown> } : {}),
    ...(disabled !== undefined ? { disabled: disabled as boolean | string } : {}),
    ...(runtime !== undefined ? { runtime: runtime as 'main' | 'worker' } : {}),
  };
}

/**
 * 合成：官方默认层打底，overlay 逐行后写胜出。
 * - 同 id = 字段级替换（plugin 省略沿用官方层引用、config/disabled 给定即整体替换）；
 * - 新 id = insert（必须自带 plugin——无官方层引用可沿用）；
 * - fixed 行被 overlay 禁用 = 合成期即响（安全栈强制点，§5.1）。
 */
function mergeRows(defaultRows: readonly CompositionRow[], overlayRows: readonly CompositionRow[]): CompositionRow[] {
  const byId = new Map<string, CompositionRow>(defaultRows.map((row) => [row.id, { ...row }]));
  const order: string[] = defaultRows.map((row) => row.id);
  for (const overlay of overlayRows) {
    const existing = byId.get(overlay.id);
    if (!existing) {
      if (overlay.plugin === undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `overlay 行 ${overlay.id}：insert 新行必须自带 plugin 引用（无官方层同 id 行可沿用）`,
        );
      }
      byId.set(overlay.id, { ...overlay });
      order.push(overlay.id);
      continue;
    }
    if (overlay.disabled !== undefined && existing.fixed) {
      throw new AppError(
        COMPOSITION_ROW_INVALID,
        `overlay 行 ${overlay.id}：fixed 行（安全栈强制点）不可禁用——只能替换其策略槽位内的行（契约篇 §5.1）`,
      );
    }
    byId.set(overlay.id, {
      ...existing,
      ...(overlay.plugin !== undefined ? { plugin: overlay.plugin } : {}),
      ...(overlay.config !== undefined ? { config: overlay.config } : {}),
      ...(overlay.disabled !== undefined ? { disabled: overlay.disabled } : {}),
      ...(overlay.runtime !== undefined ? { runtime: overlay.runtime } : {}),
    });
  }
  return order.map((id) => byId.get(id)!);
}

/** 禁用解析：true → 静态禁用；平台串命中当前平台 → 平台门控；否则未禁用 */
function resolveSkip(disabled: boolean | string | undefined): PluginSkipReason | undefined {
  if (disabled === true) return 'disabled';
  if (typeof disabled === 'string' && disabled === process.platform) return 'platform';
  return undefined;
}

/** 判定路径形态引用（显式 ./ ../ 前缀或绝对路径）；裸名 = 装入子树的包名 */
export function isPathReference(ref: string): boolean {
  return isAbsolute(ref) || ref.startsWith('./') || ref.startsWith('../');
}

/**
 * 解析插件包目录入口文件（§6.2 harness 字段 → 约定目录回退，pi 同形）：
 * 1. package.json 带 `harness.extensions` → 取首个存在者；
 * 2. 约定目录 `extensions/index.ts|js`；
 * 3. 兜底包根 `index.ts|js`。
 * @returns 入口绝对路径；目录无入口返回 undefined
 */
function resolvePackageEntry(pkgDir: string): string | undefined {
  const candidates: string[] = [];
  const manifestPath = join(pkgDir, 'package.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { harness?: { extensions?: string[] } };
      for (const ext of manifest.harness?.extensions ?? []) candidates.push(resolve(pkgDir, ext));
    } catch {
      // manifest 解析失败走约定目录回退（错误在入口缺失时统一报）
    }
  }
  candidates.push(
    join(pkgDir, 'extensions', 'index.ts'),
    join(pkgDir, 'extensions', 'index.js'),
    join(pkgDir, 'index.ts'),
    join(pkgDir, 'index.js'),
  );
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/**
 * 解析插件引用 → 入口绝对路径。
 * 路径形态（./ ../ 或绝对）：相对 cwd 直引文件或目录（local 源——开发迭代用）。
 * 裸名：`<数据目录>/plugins/node_modules/<包名>`（npm 装机子树，§6.1）。
 * @returns 入口绝对路径；无法解析返回 undefined（→ unresolved 行进启动断言——加载器永不自动安装）
 */
export function resolvePluginEntry(ref: string, dataDir: string): string | undefined {
  const target = isPathReference(ref)
    ? resolve(process.cwd(), ref)
    : join(dataDir, 'plugins', 'node_modules', ...ref.split('/'));
  if (!existsSync(target)) return undefined;
  if (statSync(target).isFile()) return target; // 直指入口文件
  if (statSync(target).isDirectory()) return resolvePackageEntry(target);
  return undefined;
}

/** `builtin:` 保留前缀（契约篇 §6.1）——入口解析链最先查官方件注册表 */
const BUILTIN_PREFIX = 'builtin:';

/**
 * 装载组合树（合成 + 禁用解析 + 入口解析 → 装载计划）。
 * @param dataDir 数据目录（overlay 与装机子树的根）
 * @param builtins 官方件注册表（组合根装配期构造；缺省空表——`builtin:` 行一律
 * unresolved。dump-config 纯合成面也传同构注册表，树形不因诊断态失真）
 */
export function loadComposition(dataDir: string, builtins: BuiltinPluginRegistry = {}): CompositionReport {
  const rows = mergeRows(DEFAULT_LAYER_ROWS, loadOverlayRows(dataDir));
  const plan: PluginPlanRow[] = [];
  for (const row of rows) {
    const skip = resolveSkip(row.disabled);
    if (skip) {
      plan.push({ id: row.id, skip }); // 禁用行不解析入口——不要求插件已装（挂载休眠精神）
      continue;
    }
    const ref = row.plugin;
    if (ref === undefined) {
      throw new AppError(
        COMPOSITION_ROW_INVALID,
        `组合树行 ${row.id}：激活行缺 plugin 引用（insert 行必须自带；替换行不可只留空引用）`,
      );
    }
    // builtin: 前缀 = 入口解析链最先查官方件注册表（§6.1）；查不到即 unresolved——
    // 注册表是宿主唯一解析面，overlay 不可能借该前缀伪装官方件身份
    if (ref.startsWith(BUILTIN_PREFIX)) {
      const module = builtins[ref];
      if (module === undefined) {
        plan.push({
          id: row.id,
          unresolved: `官方件「${ref}」不在宿主注册表（builtin: 是保留前缀——仅官方随包件可用）`,
        });
      } else {
        // 机器执法（§1.7，第二十七批刀二）：builtin 官方随包件恒 main 域——随包
        // 件零分域收益（不额外买隔离），声明 worker = 配置面错误即响
        if (row.runtime === 'worker') {
          throw new AppError(
            COMPOSITION_ROW_INVALID,
            `组合树行 ${row.id}：builtin 官方件不可声明 runtime: worker（官方随包件恒 main 域执行，契约篇 §1.7）`,
          );
        }
        plan.push({
          id: row.id,
          // 引用透传（装载身份串）：应用内存预算 join 键——与清单 components 字面同域
          plugin: ref,
          builtin: module,
          ...(row.config !== undefined ? { config: row.config } : {}),
        });
      }
      continue;
    }
    const entry = resolvePluginEntry(ref, dataDir);
    plan.push({
      id: row.id,
      // 引用透传（装载身份串）：应用内存预算 join 键——激活/未解析两态都带
      //（未解析行不装载无消费面，带上无妨且归因完整）
      plugin: ref,
      ...(entry !== undefined
        ? { entry }
        : {
            unresolved: `插件「${ref}」入口无法解析（<数据目录>/plugins/node_modules/ 下未安装或无入口文件）——加载器永不自动安装，请先安装`,
          }),
      ...(row.config !== undefined ? { config: row.config } : {}),
      ...(row.runtime !== undefined ? { runtime: row.runtime } : {}),
    });
  }
  return { rows, plan };
}

/** 目录服务（ctx.paths，契约篇 §1.5 表）——pi-11：插件不猜宿主路径 */
export interface PathsService {
  /** 数据目录根（组合树/overlay/装机子树所在） */
  dataDir(): string;
  /**
   * canonical 工作区根（2026-08-26 挖矿批 P0-1）：context 模块 commondir 归并
   * 既有能力再导出——多个检索/文件类插件需要锚定工作区而不许读 env 猜 cwd。
   * 兜底口径：git 根找不到回退 resolved cwd，**永不返回 undefined**；
   * project-aliases 重定向可能使根偏离 cwd 直觉位（canonical 归并语义，宿主单点裁定）。
   */
  workspaceRoot(): string;
  /**
   * 插件数据根：`<数据目录>/plugins/<id>/`（首取即建目录，幂等缓存）。
   * 插件代码原生可写（进程内全权限受信，§1.4 不经 fence）；模型工具写入 =
   * outside-roots 拒绝面（§1.5.1(a) 拍板——插件数据目录是插件自身治理域，
   * 模型直写即绕过其治理的暗门）。id 取 ctx.rowId（正规获取口——禁自推行 id）。
   */
  pluginDataDir(id: string): string;
}

/** 建目录服务实例（组合根 provide 'paths' 用；workspace = 装配工作区，canonical 推导锚点） */
export function createPathsService(dataDir: string, workspace: string): PathsService {
  const created = new Set<string>();
  return {
    dataDir: () => dataDir,
    workspaceRoot: () => canonicalWorkspaceRoot(workspace),
    pluginDataDir(id: string): string {
      const dir = join(dataDir, 'plugins', id);
      if (!created.has(dir)) {
        mkdirSync(dir, { recursive: true });
        created.add(dir);
      }
      return dir;
    },
  };
}

/**
 * 单行来源（ctx.plugins.list 的 source 字段，2026-08-27 刀 1——契约篇 §3.4
 * 第一刀细化段）：从组合树 plan 行推导（builtin 标记 → builtin / entry 落
 * git 装机子树 → git / 落 npm 装机子树 → npm / 其余路径 → local）。
 * unresolved 行无锚可判 = 缺省不带。
 */
export type PluginRowSource = 'builtin' | 'npm' | 'git' | 'local';

/** 单行装载状态（ctx.plugins.list 返回形） */
export interface PluginStatusRow {
  /** 组合树行 id */
  readonly id: string;
  /** 状态：activated / failed / skipped /（加载前视角的）planned */
  readonly status: 'activated' | 'failed' | 'skipped' | 'planned';
  /** 插件声明名（activated 时已知） */
  readonly name?: string;
  /** failed 时的错误码（PLUGIN_ 族） */
  readonly code?: string;
  /** failed 时的错误信息 */
  readonly message?: string;
  /** skipped 时的原因 */
  readonly reason?: PluginSkipReason;
  /** activated 时的 apply 耗时打点（毫秒，B2 P5 打点先行，2026-08-27 刀〇a——诊断面展示启动开销，不参与控制流） */
  readonly applyMs?: number;
  /** 行来源（list 时从组合树 plan 行现推导——计划行的位置事实非装载态） */
  readonly source?: PluginRowSource;
}

/**
 * 从组合树 plan 行推导行来源（ctx.plugins.list / admin 件 plugins_list 共用）。
 * @param row 组合树计划行（entry/builtin 二元判据）
 * @param dataDir 组合目录（装机子树根 `<dataDir>/plugins/` 的前缀判定锚）
 */
export function derivePluginRowSource(row: PluginPlanRow, dataDir: string): PluginRowSource | undefined {
  if (row.builtin !== undefined) return 'builtin';
  if (row.entry === undefined) return undefined; // unresolved 行：无锚可判（不带 source）
  const gitRoot = `${join(dataDir, 'plugins', 'git')}/`;
  const npmRoot = `${join(dataDir, 'plugins', 'node_modules')}/`;
  if (row.entry.startsWith(gitRoot)) return 'git';
  if (row.entry.startsWith(npmRoot)) return 'npm';
  return 'local'; // 其余路径 = local 直引（含测试 fixture 目录）
}

/** 插件管理服务面（ctx.plugins，§1.5 表尾）——有状态单例的实现移驻 ./plugins.ts（2026-08-23 /reload 纵切：install/toggle/update 落码） */

/** 目录存在且非空判定（dump-config 判断装机子树是否在用的展示辅助） */
export function pluginInstallRootExists(dataDir: string): boolean {
  const root = join(dataDir, 'plugins', 'node_modules');
  try {
    return readdirSync(root).length > 0;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------------- */
/* overlay 写回（ctx.plugins install/toggle 的持久化半边，2026-08-23 M2 /reload 纵切）。 */
/* 原子写走 persist 公共件（§1.5.1(b)）；往返纪律（§6.3）：写面只序列化 overlay 合法    */
/* 字段（id/plugin/config/disabled/runtime——fixed 属官方层永不出现在写面），装载面      */
/* validateRow 拒绝式同构——parse→stringify→parse 零字段损失（往返测试锁）。             */
/* ---------------------------------------------------------------------------------- */

/**
 * overlay 行集写回（原子写）。调用方保证行已过校验（本模块内部产物或已验证形态）。
 */
export function saveOverlayRows(dataDir: string, rows: readonly CompositionRow[]): void {
  const doc = {
    rows: rows.map((row) => ({
      id: row.id,
      ...(row.plugin !== undefined ? { plugin: row.plugin } : {}),
      ...(row.config !== undefined ? { config: row.config } : {}),
      ...(row.disabled !== undefined ? { disabled: row.disabled } : {}),
      ...(row.runtime !== undefined ? { runtime: row.runtime } : {}),
    })),
  };
  writeAtomicFile(join(dataDir, OVERLAY_FILENAME), stringifyYaml(doc));
}

/**
 * overlay 行禁用状态翻转（ctx.plugins.toggle 持久化半边，契约篇 §1.5 表尾）。
 * - 现启用 → 禁用：overlay 行 disabled 置 true（保留既有 plugin/config）；行只在
 *   官方层时插一行 `{ id, disabled: true }` 替换（字段级后写胜出）。
 * - 现禁用 → 启用：删 disabled 键（显式 `disabled: false` 是非法形态——validateRow
 *   拒绝，删键即唯一启用语义）；删键后仅剩 `{ id }` 的纯禁用行整行移除（空替换行无意义）。
 * - 未知行 id（overlay 与官方层皆无）/ fixed 行禁用 = COMPOSITION_ROW_INVALID 即时即响
 *   （fixed 不可禁用在合成期也会响，这里提前到写回时——不留「写完下次启动才炸」的陷阱）。
 * @returns 翻转后的禁用状态（true = 现已禁用）
 */
export function toggleOverlayRow(dataDir: string, id: string): boolean {
  const rows = loadOverlayRows(dataDir);
  const overlayRow = rows.find((row) => row.id === id);
  const defaultRow = DEFAULT_LAYER_ROWS.find((row) => row.id === id);
  if (!overlayRow && !defaultRow) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `toggle：未知行 id「${id}」（overlay 与官方默认层皆无此行——清单以组合树为准，勿凭记忆拼 id）`,
    );
  }
  if (defaultRow?.fixed && (!overlayRow || overlayRow.disabled === undefined)) {
    // fixed 行当前未禁用、翻转将禁用 = 安全栈强制点被关——拒绝（已在 overlay 禁用的
    // fixed 行理论到不了这里：合成期即响；防御性同拒）
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `toggle：fixed 行「${id}」是安全栈强制点，不可禁用——只能替换其策略槽位内的行（契约篇 §5.1）`,
    );
  }
  if (overlayRow !== undefined && overlayRow.disabled !== undefined) {
    // 现禁用 → 启用：删键；纯禁用行（无 plugin/config 可言）整行移除
    const next: CompositionRow[] = [];
    for (const row of rows) {
      if (row.id !== id) {
        next.push(row);
        continue;
      }
      const rest = { ...row };
      delete rest.disabled;
      if (rest.plugin === undefined && rest.config === undefined && rest.runtime === undefined) continue;
      next.push(rest);
    }
    saveOverlayRows(dataDir, next);
    return false;
  }
  // 现启用 → 禁用：overlay 行保留 plugin/config 只置 disabled；官方层行插替换行
  if (overlayRow !== undefined) {
    saveOverlayRows(
      dataDir,
      rows.map((row) => (row.id === id ? { ...row, disabled: true } : row)),
    );
  } else {
    saveOverlayRows(dataDir, [...rows, { id, disabled: true }]);
  }
  return true;
}

/**
 * install 写回 overlay 行（ctx.plugins.install 持久化半边）：行存在则只替换 plugin
 * 引用（保留 config/disabled——重装不改变启停与配置状态），不存在则 insert
 * （自带 plugin——insert 行硬要求）。id 由装机服务按源推导（npm=包名 / git=repo 名 /
 * local=目录或文件名）；pluginRef 形态按源（npm 裸包名 / local+git 绝对路径，§6.1）。
 */
export function upsertOverlayPluginRef(dataDir: string, id: string, pluginRef: string): void {
  const rows = loadOverlayRows(dataDir);
  const exists = rows.some((row) => row.id === id);
  const next = exists
    ? rows.map((row) => (row.id === id ? { ...row, plugin: pluginRef } : row))
    : [...rows, { id, plugin: pluginRef }];
  saveOverlayRows(dataDir, next);
}

/**
 * configure 写回半边（ctx.plugins.configure 持久化，契约篇 §3.4 刀 2 工具族
 * 条）：行 config 整体写入 overlay（patch 顶层键整值替换已在服务面合并成完整
 * config——本面只落整值）。与 toggleOverlayRow 同构的行集操作：
 * - 行在 overlay → config 键整替（保留 plugin/disabled/runtime）；
 * - 行只在官方默认层 → 插替换行 `{ id, config }`（省略 plugin = 沿用官方层引用）；
 * - 空对象入参 = 删 config 键（与「启用删 disabled 键」同律：空值不留键）；
 *   删键后仅剩 `{ id }` 的纯替换行整行移除。
 * 调用方保证 id 存在于 overlay 或官方层、且 config 已过插件声明 schema 校验
 * （校验归服务面——本面只管落盘，与装机/翻转写面同分工）。
 */
export function writeOverlayRowConfig(dataDir: string, id: string, config: Record<string, unknown>): void {
  const rows = loadOverlayRows(dataDir);
  const hasKeys = Object.keys(config).length > 0;
  const overlayRow = rows.find((row) => row.id === id);
  if (overlayRow === undefined) {
    if (!hasKeys) return; // 空 patch 落纯默认层行 = no-op（不造空替换行）
    saveOverlayRows(dataDir, [...rows, { id, config }]);
    return;
  }
  const next: CompositionRow[] = [];
  for (const row of rows) {
    if (row.id !== id) {
      next.push(row);
      continue;
    }
    const rest = { ...row };
    delete rest.config;
    if (hasKeys) rest.config = config;
    // 仅剩 id 的纯替换行无意义（删键即回退官方层默认 config）——整行移除
    if (rest.plugin === undefined && rest.disabled === undefined && rest.runtime === undefined) continue;
    next.push(rest);
  }
  saveOverlayRows(dataDir, next);
}

/**
 * uninstall 写回半边①（ctx.plugins.uninstall 三源文件行的持久化半边，契约篇
 * §3.4 第二刀——与 toggleOverlayRow 同构的行集操作）：整行移除 overlay 行。
 * 「重装对账即恢复」由此免费获得——overlay 行没了，install 的 upsert 会重写；
 * 移除替换行会让官方默认层同 id 行重新露出（后写胜出随行消失，回出厂态）。
 * 行不在 overlay = no-op（调用方已保证行存在于 overlay 或官方层；纯官方层
 * builtin 行走 disableOverlayRow 不走本面）。Ring 1 / fixed 拒卸在服务面先裁。
 */
export function removeOverlayRow(dataDir: string, id: string): void {
  const rows = loadOverlayRows(dataDir);
  if (!rows.some((row) => row.id === id)) return;
  saveOverlayRows(
    dataDir,
    rows.filter((row) => row.id !== id),
  );
}

/**
 * uninstall 写回半边②（builtin 行卸载的持久化半边）：overlay 禁用行落盘——
 * **幂等硬禁用**，非 toggle 翻转（已禁用行保持禁用；platform 门控字符串也
 * 统一收严为 true——本机视角声明死）。代码随包物理不可删，声明死即禁用死；
 * 重装 = toggle 回（启用删键，纯禁用行整行移除）。调用方保证行 id 存在于
 * overlay 或官方层、且非 Ring 1 / fixed 行。
 */
export function disableOverlayRow(dataDir: string, id: string): void {
  const rows = loadOverlayRows(dataDir);
  const existing = rows.find((row) => row.id === id);
  if (existing?.disabled === true) return; // 已硬禁用——幂等 no-op
  const next = existing
    ? rows.map((row) => (row.id === id ? { ...row, disabled: true as const } : row))
    : [...rows, { id, disabled: true as const }];
  saveOverlayRows(dataDir, next);
}

/**
 * 行位置双查（overlay 行 + 官方默认层行，契约篇 §3.4 第二刀 uninstall 的
 * 存在性判据）：行现状 = overlay 行先出（后写胜出语义的读半边），官方层行
 * 供 builtin 归属与「卸替换行回出厂态」判定。两者皆无 = 调用方按未知行拒绝。
 */
export function findRowLocation(
  dataDir: string,
  id: string,
): { overlay?: CompositionRow; defaultRow?: CompositionRow } {
  return {
    overlay: loadOverlayRows(dataDir).find((row) => row.id === id),
    defaultRow: DEFAULT_LAYER_ROWS.find((row) => row.id === id),
  };
}
