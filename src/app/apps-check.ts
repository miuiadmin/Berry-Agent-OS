/**
 * L4 app — `berry apps check` 应用 API 体检（契约篇 §6.13.9，第八十七批批 3
 * 落码；`berry apps` 子命令族首位——`migrate` 批 5 预留）。
 *
 * 三色体检面：全部已装应用 × 当前宿主 apiVersion——
 * - ✓ 通过：装载门 admit（含钳制/兼容两出口——target 生效值随行披露）；
 * - ⚠ 用废弃：obs 废弃遥测（§6.13.7 deprecation_rollup_hour 聚合）命中行，
 *   带替代指引与死期（DEP 注册簿 join）；
 * - ✗ 断裂：装载门拒（API_VERSION_MISMATCH）/ 清单非法（APP_INVALID）/
 *   官方面装载失败 / 装机物失联。
 *
 * 另有两档 ⚠ 容忍窗披露：api 块未声明（legacy——批 4 收剑翻必填）与第三方
 * 仓库态件无清单（install 零生效态无 api 声明面）。
 *
 * 纯文件与自管库读面：零组合装配（不建 runtime）、零主库开库。数据面三处
 * 只读：官方清单目录（loadOfficialApps）+ `<数据目录>/apps/sources.json`
 * （纯 JSON 读——不走 loadProvenance 的懒迁移写面）+ obs rollup.db
 * （existsSync 门内开——缺库跳过，开库副作用零）。
 *
 * 退出码（技术栈篇 §5）：0 = 无断裂 / 1 = 有断裂 / 2 = 用法错（main.ts 侧）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEPRECATIONS } from '../contracts/deprecations.js';
import { adjudicateApiGate } from '../contracts/api.js';
import { validateAppManifest } from '../contracts/app.js';
import type { AppManifest } from '../contracts/app.js';
import { openRollupStore } from '../obs/index.js';
import { loadOfficialApps } from './app-registry.js';
import { readHostVersionFields } from './host-face.js';
import { dataDir } from './paths.js';

/** 体检行三色（✓/⚠/✗ 的机器形态——渲染层映射符号） */
export type AppsCheckStatus = 'ok' | 'warn' | 'broken';

/** 单行体检结论 */
export interface AppsCheckRow {
  /** 应用 id（官方裸名 / 第三方装机 id；面级失败的聚合行用域描述词） */
  readonly app: string;
  readonly status: AppsCheckStatus;
  /** 人读结论（替代指引/死期/三段式断裂说明——模型与人同一面） */
  readonly detail: string;
}

/** 废弃遥测汇总行（§6.13.7 → §6.13.9 消费面） */
export interface DeprecationUsageRow {
  readonly app: string;
  /** DEP 编号（join DEPRECATIONS 取替代与死期；未注册编号 = 未知废弃披露） */
  readonly dep: string;
  /** 使用次数（全历史聚合） */
  readonly uses: number;
  /** 注册簿 join 产物（替代指引 + 死期；册外编号 = undefined） */
  readonly entry: { readonly replacement: string; readonly removalIn: string } | undefined;
}

/** 体检收集结果（collectAppsCheck 产物——渲染/退出码/测试三消费面） */
export interface AppsCheckReport {
  /** 宿主 API 面版本（行首披露——体检的比对基准） */
  readonly hostApiVersion: string;
  /** 装载体检行（官方 + 第三方全量） */
  readonly rows: readonly AppsCheckRow[];
  /** 废弃使用遥测汇总（rollup 缺库 = 空数组） */
  readonly deprecations: readonly DeprecationUsageRow[];
}

/** apps-check 环境注入面（测试注入口——缺省全真读） */
export interface AppsCheckOptions {
  /** 数据目录覆写（缺省 paths.dataDir——APP_DATA_DIR 感知） */
  readonly dataDir?: string;
  /** 宿主 apiVersion 覆写（缺省 readHostVersionFields 真读——异版本比对测试注入口） */
  readonly hostApiVersion?: string;
}

/**
 * 第三方装机物定位：sources.json 键 → 装机物根目录。
 * 键四形（apps.ts provenance 键域）：npm 形 `node_modules/<包>` 与 git 形
 * `git/<relDir>` 相对 `<dataDir>/apps/` 拼接；local 形键即绝对路径原样；
 * `skills/<名>` 是技能通道（非应用）→ undefined 跳过。
 */
function artifactRootOf(key: string, dir: string): string | undefined {
  if (key.startsWith('skills/')) return undefined;
  if (isAbsolute(key)) return key; // local 形
  return join(dir, 'apps', key); // node_modules/<包> 与 git/<relDir> 同律拼接
}

/**
 * 装载门裁决 → 体检行（ok/legacy ⚠ 的单点映射——官方与第三方两消费面共用；
 * 门拒的 broken 行由调用方 catch 落，本函数只接 admit/legacy 两态）。
 */
function rowOfGate(appId: string, api: AppManifest['api'], hostApiVersion: string): AppsCheckRow {
  const gate = adjudicateApiGate(api, hostApiVersion, appId);
  if (gate.status === 'legacy') {
    // legacy 容忍窗：api 块缺席（批 4 翻必填）——⚠ 披露不拒
    return { app: appId, status: 'warn', detail: 'api 块未声明（legacy 容忍窗——批 4 收剑翻必填）' };
  }
  return {
    app: appId,
    status: 'ok',
    detail: `admit（生效 target ${gate.effectiveTarget}${gate.experimentalKeys.size > 0 ? ` · 实验键 ${[...gate.experimentalKeys].join('/')}` : ''}）`,
  };
}

/**
 * 单清单裁决：validate → adjudicate（装载门序的只读重演——与装载期同序同判，
 * 不装载只体检）。
 * @returns 体检行；清单非法/门拒时 status 'broken'（消息即执法面原文）
 */
function checkManifest(manifestPath: string, hostApiVersion: string, fallbackId: string): AppsCheckRow {
  try {
    // yaml 前置解析与装载期同律（清单是身份唯一源——坏清单 = 断裂不是跳过）。
    // 门拒（API_VERSION_MISMATCH）经 throw 走 catch 落 broken 行——三色齐全
    const manifest = validateAppManifest(parseYaml(readFileSync(manifestPath, 'utf8')), manifestPath);
    return rowOfGate(manifest.id, manifest.api, hostApiVersion);
  } catch (err) {
    return { app: fallbackId, status: 'broken', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 体检收集主序（纯读三面 → 行集；不打印——渲染与退出码归 appsCheckMain/测试）。
 */
export function collectAppsCheck(opts: AppsCheckOptions = {}): AppsCheckReport {
  const dir = opts.dataDir ?? dataDir();
  const hostApiVersion = opts.hostApiVersion ?? readHostVersionFields().apiVersion;
  const rows: AppsCheckRow[] = [];
  const deprecations = collectDeprecationUsage(dir);

  /* 面一：官方清单目录（随包面——loadOfficialApps 与装载期同装载序，装载已过
   * validate；此处按 api 块有无分 ok/legacy ⚠——门拒在 loadOfficialApps 即抛，
   * 面级 catch 落聚合断裂行） */
  try {
    const official = loadOfficialApps(undefined, { hostApiVersion });
    for (const manifest of official.values()) {
      rows.push(rowOfGate(manifest.id, manifest.api, hostApiVersion));
    }
  } catch (err) {
    // 面级失败（任一清单非法/门拒即抛——装载序 fail-loud 在体检面降为聚合断裂行）
    rows.push({
      app: '(官方清单面)',
      status: 'broken',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  /* 面二：第三方装机账本（sources.json 纯读 + 装机物清单发现） */
  const sourcesPath = join(dir, 'apps', 'sources.json');
  if (existsSync(sourcesPath)) {
    let ledger: Record<string, unknown>;
    try {
      ledger = JSON.parse(readFileSync(sourcesPath, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      rows.push({
        app: '(装机账本)',
        status: 'broken',
        detail: `sources.json 损坏：${err instanceof Error ? err.message : String(err)}`,
      });
      ledger = {};
    }
    for (const [key, record] of Object.entries(ledger)) {
      const root = artifactRootOf(key, dir);
      if (root === undefined) continue; // skills/ 键——技能通道非应用
      const id =
        typeof (record as { id?: unknown })?.['id'] === 'string' ? String((record as { id: unknown })['id']) : key;
      if (!existsSync(root)) {
        rows.push({ app: id, status: 'broken', detail: `装机物失联：${root}（账本在而物不在——重装或卸载收账）` });
        continue;
      }
      const manifests = discoverManifests(root);
      if (manifests.length === 0) {
        rows.push({ app: id, status: 'warn', detail: '无 .app.yaml 清单（仓库态件无 api 声明面——legacy 容忍窗）' });
        continue;
      }
      for (const manifestPath of manifests) rows.push(checkManifest(manifestPath, hostApiVersion, id));
    }
  }

  return { hostApiVersion, rows, deprecations };
}

/** 装机物根目录下发现 .app.yaml 清单（单层目录直读——npm/git/local 产物同律） */
function discoverManifests(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return []; // 读不可即无清单面（⚠ 容忍窗同判）
  }
  return entries.filter((name) => name.endsWith('.app.yaml')).map((name) => join(root, name));
}

/**
 * 废弃遥测汇总（面三）：rollup.db 存在才开（openRollupStore 会建库跑迁移——
 * 缺库跳过是零副作用纪律；app × dep 全历史聚合 join DEP 注册簿）。
 */
function collectDeprecationUsage(dir: string): DeprecationUsageRow[] {
  const dbPath = join(dir, 'apps', 'obs', 'rollup.db');
  if (!existsSync(dbPath)) return [];
  const store = openRollupStore(dbPath);
  try {
    const rows = store.query({
      metric: 'deprecation',
      fromMs: 0,
      toMs: Number.MAX_SAFE_INTEGER,
      groupBy: ['app', 'dep'],
      limit: 500,
    });
    return rows.map((row) => {
      const dep = String(row.dims['dep'] ?? '');
      const entry = DEPRECATIONS.find((e) => e.dep === dep);
      return {
        app: String(row.dims['app'] ?? '(unknown)'),
        dep,
        uses: row.measures['uses'] ?? 0,
        entry: entry === undefined ? undefined : { replacement: entry.replacement, removalIn: entry.removalIn },
      };
    });
  } finally {
    store.close();
  }
}

/** 三色符号映射（机器态 → 人读面） */
const STATUS_ICON: Readonly<Record<AppsCheckStatus, string>> = { ok: '✓', warn: '⚠', broken: '✗' };

/** 体检报告渲染（stdout 单串——行序：装载行全量 + 废弃段） */
export function renderAppsCheckReport(report: AppsCheckReport): string {
  const lines: string[] = [`应用 API 体检（宿主 apiVersion ${report.hostApiVersion}）：`];
  if (report.rows.length === 0) lines.push('  （无已装应用）');
  for (const row of report.rows) lines.push(`  ${STATUS_ICON[row.status]} ${row.app} —— ${row.detail}`);
  if (report.deprecations.length > 0) {
    lines.push('废弃 API 使用（遥测汇总）：');
    for (const dep of report.deprecations) {
      const guidance =
        dep.entry === undefined
          ? '册外编号（宿主版本旧于登记簿或异常载荷）'
          : `替代 ${dep.entry.replacement} · 死期 ${dep.entry.removalIn}`;
      lines.push(`  ⚠ ${dep.app} —— ${dep.dep} ×${dep.uses}（${guidance}）`);
    }
  }
  const broken = report.rows.filter((r) => r.status === 'broken').length;
  lines.push(broken === 0 ? '结论：无断裂' : `结论：${broken} 处断裂（退出码 1）`);
  return lines.join('\n');
}

/**
 * CLI 入口（main.ts `case 'apps':` 接线）：收集 → 打印 → 退出码
 * （0 无断裂 / 1 有断裂；用法错 2 归 main.ts 旗标互斥执法）。
 */
export function appsCheckMain(opts: AppsCheckOptions = {}): number {
  const report = collectAppsCheck(opts);
  process.stdout.write(renderAppsCheckReport(report) + '\n');
  return report.rows.some((r) => r.status === 'broken') ? 1 : 0;
}
