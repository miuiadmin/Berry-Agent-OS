/**
 * L5 app — 组合树（应用契约篇 §5.1：空根 + 官方默认层 + 用户 overlay，后写胜出）。
 *
 * 职责单子（「装什么/在哪」；「怎么装」归 context 加载器）：
 * 1. overlay 装载与拒绝式校验（`<数据目录>/overlay.yaml`，pre-release 拒绝式——
 *    未知字段/缺 id/类型错即 COMPOSITION_ROW_INVALID，不误读）；
 * 2. 合成：字段级后写胜出（pkg 省略沿用官方层该 id 引用、config 整体替换不深
 *    合并、insert 新行必须自带 pkg）；fixed 行被 overlay 禁用 = 合成期即响；
 * 3. 禁用解析（true → disabled / 平台串命中当前平台 → platform）与应用入口解析
 *    （路径直引或 `<数据目录>/apps/node_modules/<包名>` 子树 + harness 字段/
 *    约定目录回退）；禁用行不解析入口（挂载休眠——禁用不因缺件而启动失败）；
 * 4. 目录服务（ctx.paths，§1.5——pi-11：无目录服务 = 应用猜宿主路径的开端）与
 *    应用管理最小服务（ctx.apps.list——装配枚举唯一事实源 = 组合树）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { writeAtomicFile } from '../persist/index.js';
import { AppError, COMPOSITION_ROW_INVALID } from '../contracts/errors.js';
import { canonicalWorkspaceRoot } from '../context/workspace.js';
import type { BuiltinAppModule, CompositionRow, AppPlanRow, AppSkipReason, RowSandbox } from '../contracts/app.js';
import { AppIdPattern, exclusiveAppOf } from '../contracts/app.js';

/** overlay 文件名（<数据目录>/overlay.yaml，契约篇 §5.2） */
export const OVERLAY_FILENAME = 'overlay.yaml';

/**
 * 官方件注册表（契约篇 §6.1）：键 = 完整引用串（`builtin:memory` 式），值 = 宿主
 * 随包模块引用。组合根装配期构造（store/workspace 等依赖以闭包注入）；`builtin:`
 * 是保留前缀——注册表是唯一解析面，overlay 不可能引用非官方注册件（查不到即 unresolved）。
 */
export type BuiltinAppRegistry = Readonly<Record<string, BuiltinAppModule>>;

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
  { id: 'chat', pkg: 'builtin:chat' },
  { id: 'memory', pkg: 'builtin:memory' },
  { id: 'subagent', pkg: 'builtin:subagent' },
  { id: 'goal', pkg: 'builtin:goal' },
  // 第五行 = scheduler tick 任务面（内核边界篇 §4.1 席 13 第一刀）：jobs 表 +
  // /tick 命令 + 只读子进程单发——卸掉即无任务面，核心循环不破
  { id: 'scheduler', pkg: 'builtin:scheduler' },
  // 第六行 = mcp 客户端桥（契约篇 §6.6 第一刀，stdio-only）：外部工具生态接
  // 入——servers 空时惰性无害；卸掉即无 MCP 外部工具，核心循环不破
  { id: 'mcp', pkg: 'builtin:mcp' },
  // 第七行 = tools 行（Ring 1 行树化起算，2026-08-26 契约篇 §5.1 节奏表）：
  // 三段管道 + ctx.tools 服务 + fs/检索工具族入列——Ring 1 必备行非可卸
  //（启动断言第二断言类；缺省层替换语义：overlay 可换实现引用不可禁用）
  { id: 'tools', pkg: 'builtin:tools' },
  // 第八行 = web 行（契约篇 §1.5.2 web 刀，Ring 2 真·可卸库角色行）：fetch
  // 工具 + ctx.fetch 服务 + SSRF 五卫生件一批三件——卸掉即无 fetch 能力，
  // 核心循环不破
  { id: 'web', pkg: 'builtin:web' },
  // 第九行 = compaction 行（内核边界篇席 20，会话篇 §2 增补七条——Ring 2 真·
  // 可卸后台角色行）：长会话压缩 durable 五步 + 两段式触发 + 重播种接线。
  // 零宿主资源闭包（服务全经 ctx 取）；卸掉即无自动压缩，核心循环不破
  //（曾压缩过的旧日志可读性不随行装载漂移——词汇宿主面注册）
  { id: 'compaction', pkg: 'builtin:compaction' },
  // 第十行 = admin 行（契约篇 §3.4 平台管理面第一刀，2026-08-27——Ring 2 真·
  // 可卸只读管理件）：apps_list/events_query 两只读工具 + ctx.sessions
  // 跨会话有界查询消费 + 管理 Skill 同件携带（包根自述锚）。写类动词
  // （install/uninstall/configure/reload）随第二刀导线；卸掉即无管理面
  // 工具，核心循环不破
  { id: 'admin', pkg: 'builtin:admin' },
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
 * 前后同 id 行的合成字段（apps/config/disabled/sandbox）——任一变化即该行需重启
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

/** 组合树装载产物（dump-config 打印 + ctx.apps.list 数据源） */
export interface CompositionReport {
  /** 合成后的树（保留 fixed 标记与原始字段——诊断「我到底跑的是什么」） */
  readonly rows: readonly CompositionRow[];
  /** 装载计划（激活行带 entry；skip/unresolved 行带原因——加载器输入） */
  readonly plan: readonly AppPlanRow[];
}

/**
 * 安全模式组合树过滤（技术栈篇 §5 `--no-apps`，第二十六批拍板 ③）：只保
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

/** overlay 允许的行字段全集（未知字段拒绝式——§6.5 pre-release 纪律；第三十六批键域：plugin→pkg、runtime→sandbox、app→apps） */
const ROW_KEYS = new Set(['id', 'pkg', 'config', 'disabled', 'fixed', 'sandbox', 'apps']);

/** 平台门控键值域（disabled 平台串/平台数组元素共用——Node process.platform 三主平台） */
const PLATFORM_KEYS: readonly string[] = ['darwin', 'linux', 'win32'];

/** 应用 id 形状编译版（apps 数组元素校验——与清单 schema 同源单一定义） */
const APP_ID_RE = new RegExp(AppIdPattern);

/** sandbox 块允许的子键全集（未知子键拒绝式——契约篇 §1.7 第三十七批闩三） */
const SANDBOX_KEYS = new Set(['carrier', 'fs', 'net', 'caps']);

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

/**
 * 单行拒绝式校验（第三十六批行 schema 数组化 + 第三十七批 sandbox 块执法）：
 * id 必填非空串；pkg 串；config 纯对象；disabled 布尔/平台串/平台串数组（空数组
 * 拒）；sandbox 块（carrier 必填三值枚举、net 声明即拒、fs/caps 纯对象、builtin
 * 行携块拒〔第一执法点〕）；apps 非空字符串数组（元素过 appId 模式、重复拒）；
 * 未知字段即拒。
 */
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
  const pkg = record['pkg'];
  if (pkg !== undefined && typeof pkg !== 'string') {
    throw new AppError(COMPOSITION_ROW_INVALID, `${where}：pkg 必须是字符串（包名或路径引用）`);
  }
  const config = record['config'];
  if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
    throw new AppError(COMPOSITION_ROW_INVALID, `${where}：config 必须是对象（字段级整体替换，不做深合并）`);
  }
  const disabled = record['disabled'];
  if (disabled !== undefined && disabled !== true && !isValidDisabled(disabled)) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `${where}：disabled 必须是 true、平台名（darwin/linux/win32）或平台名数组（P2-1 数组形态，空数组/重复元素/非平台元素皆拒）`,
    );
  }
  if (record['fixed'] !== undefined) {
    // fixed 是官方默认层安全栈强制点标记——overlay 是用户层，无权设置
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `${where}：fixed 只能出现在官方默认层（安全栈强制点），overlay 不可设置`,
    );
  }
  const sandbox = validateSandbox(record['sandbox'], pkg, where);
  const apps = validateApps(record['apps'], where);
  return {
    id,
    ...(pkg !== undefined ? { pkg } : {}),
    ...(config !== undefined ? { config: config as Record<string, unknown> } : {}),
    ...(disabled !== undefined ? { disabled: disabled as boolean | string | readonly string[] } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(apps !== undefined ? { apps } : {}),
  };
}

/** disabled 值域校验（三形共用）：true / 平台串 / 平台串数组（空数组、重复、非平台元素皆拒） */
function isValidDisabled(value: unknown): boolean {
  if (typeof value === 'string') return PLATFORM_KEYS.includes(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return false; // 空数组 = 零语义键值，拒行不落盘
    const seen = new Set<string>();
    for (const item of value) {
      if (typeof item !== 'string' || !PLATFORM_KEYS.includes(item)) return false;
      if (seen.has(item)) return false; // 重复平台 = 配置面笔误，拒绝式即响
      seen.add(item);
    }
    return true;
  }
  return false;
}

/**
 * sandbox 块校验（契约篇 §1.7 第三十七批，闩三写面完备性 + 闩一执法扩面）：
 * - carrier 必填、三值枚举（main/worker/external——external 载体已落码〔fork
 *   进程域，第三十七批 external carrier 落码批〕，原「预留词过渡冻结」已随
 *   增补 2b 解冻废止）；
 * - net 子键声明即拒（v1 无 net 执法基线——收了不执行的声明 = 宣示与现实脱节，
 *   闩二推论拒绝式）；
 * - fs 子键 external carrier 落码批定形 `{writableRoots?: string[]}`（形状在此
 *   校验；与宿主基线交集的闩二执法在装载消费面——spawn 期推导基线后拒绝式）；
 * - caps v1 只校验纯对象形状（执法面挂账随首个真实消费者）；
 * - 未知子键/半块（缺 carrier）= 机器拒；
 * - builtin 行（pkg 带 `builtin:` 前缀）声明块（任何 carrier）= 拒——官方随包件
 *   恒 main 域，第一执法点（加载器第二执法点防御性同语义）。
 */
function validateSandbox(raw: unknown, pkg: string | undefined, where: string): RowSandbox | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError(COMPOSITION_ROW_INVALID, `${where}：sandbox 必须是对象（载体块，契约篇 §1.7 第三十七批）`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SANDBOX_KEYS.has(key)) {
      throw new AppError(
        COMPOSITION_ROW_INVALID,
        `${where}：sandbox 未知子键「${key}」（允许子键：${[...SANDBOX_KEYS].join('/')}——块缺键/半块/未知子键皆机器拒写）`,
      );
    }
  }
  const carrier = record['carrier'];
  if (carrier !== 'main' && carrier !== 'worker' && carrier !== 'external') {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `${where}：sandbox.carrier 必填且为 'main' | 'worker' | 'external'（当前值：${String(carrier)}——半块〔缺 carrier〕机器拒写）`,
    );
  }
  if (record['net'] !== undefined) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `${where}：sandbox.net 声明即拒——v1 无 net 执法基线（收了不执行的声明 = 宣示与现实脱节，闩二推论；契约篇 §1.7 第三十七批）`,
    );
  }
  const fs = record['fs'];
  if (fs !== undefined) {
    if (typeof fs !== 'object' || fs === null || Array.isArray(fs)) {
      throw new AppError(COMPOSITION_ROW_INVALID, `${where}：sandbox.fs 必须是对象`);
    }
    const fsKeys = Object.keys(fs as Record<string, unknown>);
    // 子键白名单（external carrier 落码批定形）：只收 writableRoots——
    // 未知子键拒绝式与块级同纪律
    for (const key of fsKeys) {
      if (key !== 'writableRoots') {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `${where}：sandbox.fs 未知子键「${key}」（允许子键：writableRoots——external carrier 落码批定形）`,
        );
      }
    }
    const roots = (fs as Record<string, unknown>)['writableRoots'];
    if (roots !== undefined) {
      // 每元素非空字符串（绝对路径与基线交集在装载消费面执法——闩二拒绝式；
      // 此处只管形状：数组 + 元素非空字符串）
      if (!Array.isArray(roots) || roots.some((r) => typeof r !== 'string' || r === '')) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `${where}：sandbox.fs.writableRoots 必须是非空字符串数组（绝对路径声明，装载期与宿主基线交集）`,
        );
      }
    }
  }
  const caps = record['caps'];
  if (caps !== undefined && (typeof caps !== 'object' || caps === null || Array.isArray(caps))) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `${where}：sandbox.caps 必须是对象（深层形态随 carrier 落码批定，v1 只校验形状）`,
    );
  }
  // builtin 行携块拒（任何 carrier）：官方随包件恒 main 域——零分域收益不买隔离
  if (pkg !== undefined && pkg.startsWith('builtin:')) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `${where}：builtin 官方件行（${pkg}）不可声明 sandbox 块（官方随包件恒 main 域执行，任何 carrier 皆拒，契约篇 §1.7 第三十七批）`,
    );
  }
  return {
    carrier,
    ...(fs !== undefined ? { fs: fs as Record<string, unknown> } : {}),
    ...(caps !== undefined ? { caps: caps as Record<string, unknown> } : {}),
  };
}

/**
 * apps 键校验（第三十六批作用域数组化）：非空字符串数组、元素过 appId 模式、
 * 重复元素拒（去重由拒绝式保证——写入面不静默归一）、空数组拒行（零语义键值
 * 不落盘，与 disabled 空数组同律）。
 */
function validateApps(raw: unknown, where: string): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `${where}：apps 必须是非空字符串数组（挂载目标应用 id 集，契约篇 §5.1）`,
    );
  }
  if (raw.length === 0) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `${where}：apps 空数组 = 拒行（零语义键值不落盘——全局作用域 = 省略 apps 键）`,
    );
  }
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || !APP_ID_RE.test(item)) {
      throw new AppError(
        COMPOSITION_ROW_INVALID,
        `${where}：apps 元素「${String(item)}」不符应用 id 形状（小写段字母数字开头，可含 . _ -，可选单层 / 域前缀）`,
      );
    }
    if (seen.has(item)) {
      throw new AppError(
        COMPOSITION_ROW_INVALID,
        `${where}：apps 重复元素「${item}」（重复挂载 = 配置面笔误，拒绝式即响）`,
      );
    }
    seen.add(item);
  }
  return raw as readonly string[];
}

/**
 * 合成：官方默认层打底，overlay 逐行后写胜出。
 * - 同 id = 字段级替换（pkg 省略沿用官方层引用、config/disabled 给定即整体替换）；
 * - 新 id = insert（必须自带 pkg——无官方层引用可沿用）；
 * - fixed 行被 overlay 禁用 = 合成期即响（安全栈强制点，§5.1）；
 * - 合成后 builtin 行携 sandbox 块 = 即响（validateRow 只见 overlay 行原貌——
 *   overlay 行省略 pkg 沿用官方层 builtin 引用 + 带 sandbox 的「换壳夹带」只有
 *   合成产物可见，此处补刀 = builtin 携块执法的合成期完备点）。
 */
function mergeRows(defaultRows: readonly CompositionRow[], overlayRows: readonly CompositionRow[]): CompositionRow[] {
  const byId = new Map<string, CompositionRow>(defaultRows.map((row) => [row.id, { ...row }]));
  const order: string[] = defaultRows.map((row) => row.id);
  for (const overlay of overlayRows) {
    const existing = byId.get(overlay.id);
    if (!existing) {
      if (overlay.pkg === undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `overlay 行 ${overlay.id}：insert 新行必须自带 pkg 引用（无官方层同 id 行可沿用）`,
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
      ...(overlay.pkg !== undefined ? { pkg: overlay.pkg } : {}),
      ...(overlay.config !== undefined ? { config: overlay.config } : {}),
      ...(overlay.disabled !== undefined ? { disabled: overlay.disabled } : {}),
      ...(overlay.sandbox !== undefined ? { sandbox: overlay.sandbox } : {}),
      ...(overlay.apps !== undefined ? { apps: overlay.apps } : {}),
    });
  }
  const merged = order.map((id) => byId.get(id)!);
  // builtin 携块执法合成期完备点（注释头「换壳夹带」分支）：替换行省略 pkg
  // 沿用官方 builtin 引用 + overlay 带 sandbox 块 → 合成产物 builtin 行携块
  for (const row of merged) {
    if (row.sandbox !== undefined && row.pkg !== undefined && row.pkg.startsWith('builtin:')) {
      throw new AppError(
        COMPOSITION_ROW_INVALID,
        `组合树行 ${row.id}：builtin 官方件行（${row.pkg}）合成后携带 sandbox 块——官方随包件恒 main 域执行（overlay 换壳夹带同样拒，契约篇 §1.7 第三十七批）`,
      );
    }
  }
  return merged;
}

/**
 * 禁用解析（P2-1 数组形态吸收后三形统一）：true → 静态禁用；平台串命中当前
 * 平台 → 平台门控；平台串数组含当前平台 → 平台门控；否则未禁用。
 */
function resolveSkip(disabled: boolean | string | readonly string[] | undefined): AppSkipReason | undefined {
  if (disabled === true) return 'disabled';
  if (typeof disabled === 'string') return disabled === process.platform ? 'platform' : undefined;
  if (Array.isArray(disabled)) return disabled.includes(process.platform) ? 'platform' : undefined;
  return undefined;
}

/** 判定路径形态引用（显式 ./ ../ 前缀或绝对路径）；裸名 = 装入子树的包名 */
export function isPathReference(ref: string): boolean {
  return isAbsolute(ref) || ref.startsWith('./') || ref.startsWith('../');
}

/**
 * 解析应用包目录入口文件（§6.2 harness 字段 → 约定目录回退，pi 同形）：
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
 * 解析应用引用 → 入口绝对路径。
 * 路径形态（./ ../ 或绝对）：相对 cwd 直引文件或目录（local 源——开发迭代用）。
 * 裸名：`<数据目录>/apps/node_modules/<包名>`（npm 装机子树，§6.1）。
 * @returns 入口绝对路径；无法解析返回 undefined（→ unresolved 行进启动断言——加载器永不自动安装）
 */
export function resolveAppEntry(ref: string, dataDir: string): string | undefined {
  const target = isPathReference(ref)
    ? resolve(process.cwd(), ref)
    : join(dataDir, 'apps', 'node_modules', ...ref.split('/'));
  if (!existsSync(target)) return undefined;
  if (statSync(target).isFile()) return target; // 直指入口文件
  if (statSync(target).isDirectory()) return resolvePackageEntry(target);
  return undefined;
}

/** `builtin:` 保留前缀（契约篇 §6.1）——入口解析链最先查官方件注册表 */
const BUILTIN_PREFIX = 'builtin:';

/**
 * 行挂载目标键执法（契约篇 §5.1 挂载目标两档，D1 清单投影批 2026-08-27；
 * 第三十六批 apps 数组化改形；触发②随 D2 装机两态开闸）：四触发全集单点
 * 执法，任一命中即 COMPOSITION_ROW_INVALID 拒绝式即响——
 * - 触发①（未知应用 id）：apps 元素不在在册应用清单集（清单是应用身份唯一源——
 *   apps 键指向不存在应用的行是配置面错误，不是可降级缺件）；
 * - 触发②（第三方行缺省挂系统）：不带 apps 键的第三方行拒绝——判源 = 行引用
 *   形（pkg 非 `builtin:` 前缀即第三方行，与触发④同源判据）。全局作用域 v1
 *   官方专属：第三方全局件 = 绕过应用隔离的后门（授权面全部失锚）。开闸前提
 *   已随 D2 就位：install 两态化不再写行（新装机零行），旧 install 产物行属
 *   pre-release 破坏面（重挂带 apps 或删行——commit 信息载迁移路径）；
 * - 触发③（Ring 1 必备行带 apps）：Ring 1 行是全局作用域必备行（换实现可、换
 *   作用域不可——卸掉核心循环必破的行没有「挂到某应用」的语义）；
 * - 触发④（官方引用行带 apps）：官方件作用域恒全局作用域（判源 = 行引用形——
 *   合成产物 pkg 带 `builtin:` 前缀即官方行；overlay 替换行省略 pkg 沿用官方
 *   层引用，合成后同为 builtin 前缀，判源不需特判「省略」形态）。
 * 全行统一执法（disabled 行含）：潜伏配置预先即拒，不留「toggle 启用才炸」陷阱。
 */
function assertRowAppTargets(rows: readonly CompositionRow[], knownAppIds: ReadonlySet<string>): void {
  for (const row of rows) {
    // 行籍判据（触发②④共用）：pkg 省略（合成沿用官方层）或 `builtin:` 前缀
    // = 官方行；其余引用形（npm 裸名 / git·local 路径）= 第三方行——籍随行引用
    // 形不随包身世（契约篇 §5.1 执法形态全集）
    const official = row.pkg === undefined || row.pkg.startsWith(BUILTIN_PREFIX);
    if (row.apps === undefined) {
      // 触发②：第三方行缺省挂系统拒（D2 开闸——前提 = install 不再写行）
      if (!official) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `组合树行 ${row.id}：第三方行（${row.pkg}）缺省挂系统——全局作用域 v1 官方专属，第三方件必须挂应用` +
            `（行加 apps: [<应用id>, …] 重挂；装机两态下 install 不再写行，旧产物行请清除重挂。契约篇 §5.1 触发②）`,
        );
      }
      continue;
    }
    // 触发①逐元素执法（多应用行全元素核——数组化后执法不随元素数稀释）
    for (const appId of row.apps) {
      if (!knownAppIds.has(appId)) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `组合树行 ${row.id}：未知应用 id「${appId}」（apps 取值域 = 在册应用清单 id——在册：${
            [...knownAppIds].join('、') || '无'
          }）`,
        );
      }
    }
    if (RING1_REQUIRED_ROW_IDS.includes(row.id)) {
      throw new AppError(
        COMPOSITION_ROW_INVALID,
        `组合树行 ${row.id}：Ring 1 必备行不可携带 apps 键（Ring 1 = 全局作用域必备行，非挂载目标——契约篇 §5.1）`,
      );
    }
    // 触发④：官方行籍判据同上（省略沿用 = builtin 前缀合成后同判）
    if (official) {
      throw new AppError(
        COMPOSITION_ROW_INVALID,
        `组合树行 ${row.id}：官方件行（${row.pkg}）不可携带 apps 键——官方件作用域恒全局作用域（契约篇 §5.1）`,
      );
    }
  }
}

/**
 * 装载组合树（合成 + 禁用解析 + 入口解析 → 装载计划）。
 * @param dataDir 数据目录（overlay 与装机子树的根）
 * @param builtins 官方件注册表（组合根装配期构造；缺省空表——`builtin:` 行一律
 * unresolved。dump-config 纯合成面也传同构注册表，树形不因诊断态失真）
 * @param knownAppIds 在册应用清单 id 集（app 键取值域——组合根传
 * loadOfficialApps 产物键集〔装载序上官方清单先行〕；缺省空集 = 拒绝式缺省，
 * 任何 app 行都过不了触发①，测试面直接裸调即测「未知应用」路径）
 */
export function loadComposition(
  dataDir: string,
  builtins: BuiltinAppRegistry = {},
  knownAppIds: ReadonlySet<string> = new Set(),
): CompositionReport {
  const rows = mergeRows(DEFAULT_LAYER_ROWS, loadOverlayRows(dataDir));
  // 挂载目标键执法先于装载计划构建：触发在合成期即响（契约篇 §5.1 四触发③①④，
  // ②随 D2——见 assertRowAppTargets 注记），坏行不带装载副作用进断言面
  assertRowAppTargets(rows, knownAppIds);
  const plan: AppPlanRow[] = [];
  for (const row of rows) {
    const skip = resolveSkip(row.disabled);
    if (skip) {
      // 禁用行不解析入口——不要求应用已装（挂载休眠精神）；apps 照透传（单区
      // reload 重发 skipped 行需要分区归属——分区判据按行原貌不按激活态）
      plan.push({ id: row.id, skip, ...(row.apps !== undefined ? { apps: row.apps } : {}) });
      continue;
    }
    const ref = row.pkg;
    if (ref === undefined) {
      throw new AppError(
        COMPOSITION_ROW_INVALID,
        `组合树行 ${row.id}：激活行缺 pkg 引用（insert 行必须自带；替换行不可只留空引用）`,
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
        // 机器执法（§1.7，第三十七批 sandbox 块执法扩面）：builtin 官方随包件
        // 恒 main 域——随包件零分域收益（不额外买隔离），声明 sandbox 块（任何
        // carrier）= 配置面错误即响。validateRow/mergeRows 两点已拒，此处与加载
        // 器同语义防御性兜底（多执法点不冲突——纪律单实现多点执法）
        if (row.sandbox !== undefined) {
          throw new AppError(
            COMPOSITION_ROW_INVALID,
            `组合树行 ${row.id}：builtin 官方件不可声明 sandbox 块（官方随包件恒 main 域执行，任何 carrier 皆拒，契约篇 §1.7 第三十七批）`,
          );
        }
        plan.push({
          id: row.id,
          // 引用透传（装载身份串）：应用内存预算 join 键——与清单 components 字面同域
          pkg: ref,
          builtin: module,
          ...(row.config !== undefined ? { config: row.config } : {}),
          ...(row.apps !== undefined ? { apps: row.apps } : {}),
        });
      }
      continue;
    }
    const entry = resolveAppEntry(ref, dataDir);
    plan.push({
      id: row.id,
      // 引用透传（装载身份串）：应用内存预算 join 键——激活/未解析两态都带
      //（未解析行不装载无消费面，带上无妨且归因完整）
      pkg: ref,
      ...(entry !== undefined
        ? { entry }
        : {
            unresolved: `应用「${ref}」入口无法解析（<数据目录>/apps/node_modules/ 下未安装或无入口文件）——加载器永不自动安装，请先安装`,
          }),
      ...(row.config !== undefined ? { config: row.config } : {}),
      ...(row.sandbox !== undefined ? { sandbox: row.sandbox } : {}),
      ...(row.apps !== undefined ? { apps: row.apps } : {}),
    });
  }
  return { rows, plan };
}

/* ---------------- 装载计划分区（D3 装载分面分区，契约篇 §5.1，2026-08-29） ---------------- */

/**
 * 装载计划分区产物（纯函数产物——boot 与全量 /reload 两时点同构调用）：
 * 分区对象 = 合成后装载计划行（mergeRows 产物投影），判据两步——先剔 Ring 1
 * 必备行（独立维持现状：boot 装载于 ring1Anchor 生效不回卷），再按 apps 键归区。
 */
export interface PlanPartition {
  /** Ring 1 必备行（装载于 ring1Anchor——/reload 不动，维持现状非本结构属地） */
  ring1: AppPlanRow[];
  /**
   * 系统区行：apps 缺席（官方默认层行/官方替换行）∪ apps 多元素（跨区行——
   * effect 链挂 apps:system 锚随系统相位装载恰一次，provide 扇出各区表，
   * 契约篇 §5.1 跨区行装载律①）
   */
  system: AppPlanRow[];
  /**
   * 应用 id 清单（**字典序**——装载序契约面：系统区先行收口后，各应用区依
   * 在册清单 id 字典序串行装载；序仅定日志序，区际零依赖故无正确性约束）
   */
  appIds: string[];
  /** 应用区行表（键 = 应用 id；行 = apps 恰 [该 app] 的独占行——「该区行」谓词） */
  zoneRows: ReadonlyMap<string, AppPlanRow[]>;
}

/**
 * 装载计划分区（D3 纯函数——组合树合成产物 → 装载分区，无副作用可重复调用）。
 * apps 空数组在合成期 validateApps 已拒（零语义键值不落盘），此处不重复执法。
 */
export function partitionPlan(plan: readonly AppPlanRow[]): PlanPartition {
  const ring1: AppPlanRow[] = [];
  const system: AppPlanRow[] = [];
  const zoneRows = new Map<string, AppPlanRow[]>();
  for (const row of plan) {
    if (RING1_REQUIRED_ROW_IDS.includes(row.id)) {
      // 第一步：剔 Ring 1 必备行——独立装载锚独立生命周期，不进分区账
      ring1.push(row);
      continue;
    }
    // 「该区行」谓词单源（contracts exclusiveAppOf）：缺席 = 系统区行；多元素 =
    // 跨区行（挂系统相位——装载律①）；恰一元素 = 该应用区独占行（单区 reload
    // 四集合的判定源）
    const appId = exclusiveAppOf(row);
    if (appId === undefined) {
      system.push(row);
      continue;
    }
    const bucket = zoneRows.get(appId);
    if (bucket === undefined) zoneRows.set(appId, [row]);
    else bucket.push(row);
  }
  return { ring1, system, appIds: [...zoneRows.keys()].sort(), zoneRows };
}

/** 目录服务（ctx.paths，契约篇 §1.5 表）——pi-11：应用不猜宿主路径 */
export interface PathsService {
  /** 数据目录根（组合树/overlay/装机子树所在） */
  dataDir(): string;
  /**
   * canonical 工作区根（2026-08-26 挖矿批 P0-1）：context 模块 commondir 归并
   * 既有能力再导出——多个检索/文件类应用需要锚定工作区而不许读 env 猜 cwd。
   * 兜底口径：git 根找不到回退 resolved cwd，**永不返回 undefined**；
   * project-aliases 重定向可能使根偏离 cwd 直觉位（canonical 归并语义，宿主单点裁定）。
   */
  workspaceRoot(): string;
  /**
   * 应用数据根：`<数据目录>/apps/<id>/`（首取即建目录，幂等缓存）。
   * 应用代码原生可写（进程内全权限受信，§1.4 不经 fence）；模型工具写入 =
   * outside-roots 拒绝面（§1.5.1(a) 拍板——应用数据目录是应用自身治理域，
   * 模型直写即绕过其治理的暗门）。id 取 ctx.rowId（正规获取口——禁自推行 id）。
   */
  appDataDir(id: string): string;
}

/**
 * apps/ 直下保留名对（单一来源）：git = git 源克隆子树、node_modules = npm
 * 装机子树、sources.json = provenance 全源账本文件（D2 两态，2026-08-27——
 * 数据根撞账本文件 = purge 会吞账本，同撞子树同级防线）。消费点——
 * appDataDirOf 闸（数据根取址全消费面）与 tmp 扫龄跳过（apps.ts）。
 * 布局知识单源（契约篇 §1.5 tmp 钉位细则④ + §3.4 落码注记补①），新增保留名只改此处。
 */
export const RESERVED_SUBTREE_NAMES: readonly string[] = ['git', 'node_modules', 'sources.json'];

/**
 * 件数据根布局原语（`<dataDir>/apps/<id>`）——唯一的件数据根取址通道。
 * 内建保留名闸：行 id 撞装机子树名（git / node_modules）时数据根路径与
 * 装机子树同径，任何写（mkdir / 账本）与删（purge rmSync）都会误吞装机
 * 子树，故取址本身即拒（COMPOSITION_ROW_INVALID）。闸住本函数 = install
 * 收割写 / uninstall purge / ctx.paths.appDataDir 公共面 / 检视报告
 * 取址全消费面结构覆盖（2026-08-27 复盘批收口：原公共面自复刻 join 零闸）。
 */
export function appDataDirOf(dataDir: string, id: string): string {
  if (RESERVED_SUBTREE_NAMES.includes(id)) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `行 id「${id}」撞装机子树保留名（apps/）——件数据根与装机子树布局冲突，拒绝操作`,
    );
  }
  return join(dataDir, 'apps', id);
}

/** 建目录服务实例（组合根 provide 'paths' 用；workspace = 装配工作区，canonical 推导锚点） */
export function createPathsService(dataDir: string, workspace: string): PathsService {
  const created = new Set<string>();
  return {
    dataDir: () => dataDir,
    workspaceRoot: () => canonicalWorkspaceRoot(workspace),
    appDataDir(id: string): string {
      const dir = appDataDirOf(dataDir, id); // 布局与保留名闸同源单点（复盘批收口——不再自复刻 join）
      if (!created.has(dir)) {
        mkdirSync(dir, { recursive: true });
        created.add(dir);
      }
      return dir;
    },
  };
}

/**
 * 单行来源（ctx.apps.list 的 source 字段，2026-08-27 刀 1——契约篇 §3.4
 * 第一刀细化段）：从组合树 plan 行推导（builtin 标记 → builtin / entry 落
 * git 装机子树 → git / 落 npm 装机子树 → npm / 其余路径 → local）。
 * unresolved 行无锚可判 = 缺省不带。
 */
export type AppRowSource = 'builtin' | 'npm' | 'git' | 'local';

/** 单行装载状态（ctx.apps.list 返回形） */
export interface AppStatusRow {
  /** 组合树行 id；installed-unmounted 态 = 装机推导 id（仓库态件无行——账本差集条目） */
  readonly id: string;
  /**
   * 状态：activated / failed / skipped /（加载前视角的）planned / installed-unmounted
   * （D2 装机两态 2026-08-27：装机后未挂的仓库态件——数据源 = provenance 账本 ∖
   * 组合树行差集，按同包归一键算非行 id，契约篇 §6.1 可见性）
   */
  readonly status: 'activated' | 'failed' | 'skipped' | 'planned' | 'installed-unmounted';
  /** 应用声明名（activated 时已知） */
  readonly name?: string;
  /** failed 时的错误码（APP_ 族） */
  readonly code?: string;
  /** failed 时的错误信息 */
  readonly message?: string;
  /** skipped 时的原因 */
  readonly reason?: AppSkipReason;
  /** activated 时的 apply 耗时打点（毫秒，B2 P5 打点先行，2026-08-27 刀〇a——诊断面展示启动开销，不参与控制流） */
  readonly applyMs?: number;
  /** 行来源（list 时从组合树 plan 行现推导——计划行的位置事实非装载态） */
  readonly source?: AppRowSource;
}

/**
 * 从组合树 plan 行推导行来源（ctx.apps.list / admin 件 apps_list 共用）。
 * @param row 组合树计划行（entry/builtin 二元判据）
 * @param dataDir 组合目录（装机子树根 `<dataDir>/apps/` 的前缀判定锚）
 */
export function deriveAppRowSource(row: AppPlanRow, dataDir: string): AppRowSource | undefined {
  if (row.builtin !== undefined) return 'builtin';
  if (row.entry === undefined) return undefined; // unresolved 行：无锚可判（不带 source）
  const gitRoot = `${join(dataDir, 'apps', 'git')}/`;
  const npmRoot = `${join(dataDir, 'apps', 'node_modules')}/`;
  if (row.entry.startsWith(gitRoot)) return 'git';
  if (row.entry.startsWith(npmRoot)) return 'npm';
  return 'local'; // 其余路径 = local 直引（含测试 fixture 目录）
}

/** 应用管理服务面（ctx.apps，§1.5 表尾）——有状态单例的实现移驻 ./apps.ts（2026-08-23 /reload 纵切：install/toggle/update 落码） */

/** 目录存在且非空判定（dump-config 判断装机子树是否在用的展示辅助） */
export function appInstallRootExists(dataDir: string): boolean {
  const root = join(dataDir, 'apps', 'node_modules');
  try {
    return readdirSync(root).length > 0;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------------- */
/* overlay 写回（ctx.apps install/toggle 的持久化半边，2026-08-23 M2 /reload 纵切）。 */
/* 原子写走 persist 公共件（§1.5.1(b)）；往返纪律（§6.3）：写面只序列化 overlay 合法    */
/* 字段（id/pkg/config/disabled/sandbox/apps——fixed 属官方层永不出现在写面），装载面   */
/* validateRow 拒绝式同构——parse→stringify→parse 零字段损失（往返测试锁）。             */
/* ---------------------------------------------------------------------------------- */

/**
 * overlay 行集写回（原子写，契约篇 §1.7 第三十七批闩三收口点）：**落盘公共漏斗**
 * ——mount 经 insertOverlayRow、toggle/configure/uninstall 各写面全数汇入本函数，
 * 故写面完备性校验收口于此：全行再过 validateRow（块缺键/半块/未知子键/apps 空
 * 数组或坏形状 = 机器拒写，手编绕过服务面的行在**下次写任何行**时也会被全量再
 * 校验拦下——漏斗单点优于各写面自校）。读盘校验（loadOverlayRows）仍是装载期
 * 第一道闸，本闩保证的是「写出去的盘上永远没有坏行」。
 */
export function saveOverlayRows(dataDir: string, rows: readonly CompositionRow[]): void {
  // 闩三：全行写前再校验（where 带「写回」标明执法点——与读盘校验错误可区分）
  for (const row of rows) validateRow(row, 'overlay 写回校验');
  const doc = {
    rows: rows.map((row) => ({
      id: row.id,
      ...(row.pkg !== undefined ? { pkg: row.pkg } : {}),
      ...(row.config !== undefined ? { config: row.config } : {}),
      ...(row.disabled !== undefined ? { disabled: row.disabled } : {}),
      ...(row.sandbox !== undefined ? { sandbox: row.sandbox } : {}),
      ...(row.apps !== undefined ? { apps: row.apps } : {}),
    })),
  };
  writeAtomicFile(join(dataDir, OVERLAY_FILENAME), stringifyYaml(doc));
}

/**
 * overlay 行禁用状态翻转（ctx.apps.toggle 持久化半边，契约篇 §1.5 表尾）。
 * - 现启用 → 禁用：overlay 行 disabled 置 true（保留既有 app/config）；行只在
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
    // 现禁用 → 启用：删键；纯禁用行（无 apps/config 可言）整行移除
    const next: CompositionRow[] = [];
    for (const row of rows) {
      if (row.id !== id) {
        next.push(row);
        continue;
      }
      const rest = { ...row };
      delete rest.disabled;
      // 仅剩 id 的纯禁用行整行移除。apps 刻意不进保留判据：无 pkg 的 {id, apps}
      // 残留行不可能是合法行（insert 须带 pkg、官方层替换带 apps 触发④）——
      // 三键皆空即删，apps 不救行（残留即下次装载地雷）
      if (rest.pkg === undefined && rest.config === undefined && rest.sandbox === undefined) continue;
      next.push(rest);
    }
    saveOverlayRows(dataDir, next);
    return false;
  }
  // 现启用 → 禁用：overlay 行保留 apps/config 只置 disabled；官方层行插替换行
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
 * mount 写行面（ctx.apps.mount 持久化半边，契约篇 §6.1 装机/挂载两态批
 * 2026-08-27）：追加挂载行 `{id, pkg, apps?, config?}`——纯 insert 语义（无
 * 替换分支：撞名在服务面先裁 COMPOSITION_ROW_INVALID，本面不悄悄改既有行——
 * 与旧 install 写面 upsertOverlayAppRef 的「同 id 换引用」语义刻意分流，
 * 挂载是用户显式组合面动作）。行字段完整性由服务面负责（pkg 引用按源推导、
 * apps 必填执法〔第三方挂全局 v1 拒〕、config 已过 schema 校验）。
 */
export function insertOverlayRow(dataDir: string, row: CompositionRow): void {
  const rows = loadOverlayRows(dataDir);
  saveOverlayRows(dataDir, [...rows, row]);
}

/**
 * configure 写回半边（ctx.apps.configure 持久化，契约篇 §3.4 刀 2 工具族
 * 条）：行 config 整体写入 overlay（patch 顶层键整值替换已在服务面合并成完整
 * config——本面只落整值）。与 toggleOverlayRow 同构的行集操作：
 * - 行在 overlay → config 键整替（保留 apps/disabled/sandbox）；
 * - 行只在官方默认层 → 插替换行 `{ id, config }`（省略 pkg = 沿用官方层引用）；
 * - 空对象入参 = 删 config 键（与「启用删 disabled 键」同律：空值不留键）；
 *   删键后仅剩 `{ id }` 的纯替换行整行移除。
 * 调用方保证 id 存在于 overlay 或官方层、且 config 已过应用声明 schema 校验
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
    // 仅剩 id 的纯替换行无意义（删键即回退官方层默认 config）——整行移除。apps
    // 刻意不进保留判据（同 toggle 谓词）：无 pkg 的 {id, apps} 残留恒非法，删
    if (rest.pkg === undefined && rest.disabled === undefined && rest.sandbox === undefined) continue;
    next.push(rest);
  }
  saveOverlayRows(dataDir, next);
}

/**
 * uninstall 写回半边①（ctx.apps.uninstall 三源文件行的持久化半边，契约篇
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
