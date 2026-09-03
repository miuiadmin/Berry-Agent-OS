#!/usr/bin/env node
/**
 * API 治理机器执法层（契约篇 §6.13.8 check-api 七查，第八十七批批 2）。
 *
 * 进 lint:topology 链（CI 同一套）。七查形态（批 2 落码节奏——批表 §6.13.11）：
 * 1. drift——快照 src/contracts/api-surface.json ≠ 抽取真值即红（面漂移当场抓）；
 * 2. tier 全标——快照逐条 tier 词汇合法 + 公开根直导出（自由符号，现役为零）必带
 *    JSDoc 标签；typebox 转发条目（forwarded）记载不承诺、不参与执法（冷读 M4）；
 * 3. 废弃登记完整性——骨架先行（现零 deprecated 条目即绿）；DEP 注册簿随批 3 落地
 *    后充实双向对照 / DEP 编号唯一 / removalIn ≥ introducedIn + 3 minor 三执法；
 * 4. 官方全家桶零废弃使用——骨架先行（零 deprecated 条目即绿）；批 3 充实扫描面；
 * 5. 实验面隔离——experimental 符号/键漏进 docs/ 与 examples/ 即红（现零实验键恒绿，
 *    机制常驻——实验键上线日即执法日）；
 * 6. compat 件死期——批 4 前结构性拒绝（src/compat/ 在场即红——死期机器未落地，
 *    compat 件无登记可查 = fail-closed，非静默放行）；
 * 7. 清单 api 块狗家全覆盖——仓内全部 .app.yaml 的 api 块在场且合法（schema 校验 +
 *    装载门裁决非 legacy）；与官方三清单回填同批落——生效日即绿（冷读 M3）。
 *
 * 出口：零问题静默过（门禁链惯例）；有问题 stderr 逐条 + exit 1。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createJiti } from 'jiti';
import { extractSurface, scanTopLevelExports, serializeSurface } from './extract-api-surface.mjs';

/** 仓库根（脚本位置上一级） */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/**
 * API 面快照提交位（查 1 守护对象）。`CHECK_API_SNAPSHOT` env 缝 = 回归锁专用
 * 换片位（check-topology 的 CHECK_ROOT 同款纪律——测试注入篡改快照证查 1 可红，
 * 不动共享树文件；缺省真位）。
 */
const SNAPSHOT_PATH =
  process.env.CHECK_API_SNAPSHOT !== undefined
    ? resolve(REPO_ROOT, process.env.CHECK_API_SNAPSHOT)
    : join(REPO_ROOT, 'src/contracts/api-surface.json');
/** 公开根（自由符号查 2 的扫描对象） */
const BARREL_PATH = join(REPO_ROOT, 'src/contracts/index.ts');
/** 官方应用清单目录（查 7） */
const APPS_DIR = join(REPO_ROOT, 'apps');

const jiti = createJiti(import.meta.url);
/** 便利导入：仓库内相对路径 → 模块运行时面 */
const imp = (rel) => jiti.import(fileURLToPath(new URL(rel, import.meta.url)));

/** 红问题清单（[查 N] 前缀 + 指引文案） */
const problems = [];
const v = (msg) => problems.push(msg);

/** tier 合法词汇（§6.13.3 三级——internal 结构性不可达不进面清单） */
const TIERS = new Set(['stable', 'experimental', 'deprecated']);

/** 递归收集目录下指定后缀文件（相对仓库根路径；符号链接不跟随） */
function walkFiles(dirRel, suffixes, out = []) {
  const abs = join(REPO_ROOT, dirRel);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs).sort()) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const rel = join(dirRel, name);
    const full = join(REPO_ROOT, rel);
    if (statSync(full).isDirectory()) walkFiles(rel, suffixes, out);
    else if (suffixes.some((s) => name.endsWith(s))) out.push(rel);
  }
  return out;
}

/* ---------------- 查 1：drift（快照 ≠ 抽取真值红） ---------------- */

const surface = await extractSurface();
const snapshotText = readFileSync(SNAPSHOT_PATH, 'utf8');
if (serializeSurface(surface) !== snapshotText) {
  // 结构化 diff 摘要（计数 + 样例——修复指引指回抽取器 CLI）
  const snap = JSON.parse(snapshotText);
  const keyOf = (e) => `${e.module}::${e.symbol}`;
  const truthMap = new Map(surface.exports.map((e) => [keyOf(e), e]));
  const snapMap = new Map(snap.exports.map((e) => [keyOf(e), e]));
  const added = [...truthMap.keys()].filter((k) => !snapMap.has(k));
  const removed = [...snapMap.keys()].filter((k) => !truthMap.has(k));
  const changed = [...truthMap.entries()]
    .filter(([k, e]) => snapMap.has(k) && JSON.stringify(snapMap.get(k)) !== JSON.stringify(e))
    .map(([k]) => k);
  const capChanged = JSON.stringify(snap.capabilities) !== JSON.stringify(surface.capabilities);
  const samples = (list) => list.slice(0, 5).join('、') + (list.length > 5 ? ' 等' : '');
  v(
    `[查 1] API 面快照漂移：新增 ${added.length}（${samples(added)}）、移除 ${removed.length}（${samples(removed)}）、` +
      `改形 ${changed.length}（${samples(changed)}）、capabilities ${capChanged ? '有变' : '无变'}——` +
      `确认面变更后重跑 \`node tools/extract-api-surface.mjs --write\` 落新快照；面变更 PR 须带 api-break:/api-deprecate:/api-add: ` +
      `裁决标签之一（§6.13.6——自由不豁免记录）`,
  );
}

/* ---------------- 查 2：tier 全标（零隐式 API） ---------------- */

for (const entry of surface.exports) {
  if (!TIERS.has(entry.tier)) {
    v(
      `[查 2] ${entry.module}::${entry.symbol} tier 非法：${entry.tier}（词汇 = stable/experimental/deprecated，§6.13.3）`,
    );
  }
  if (typeof entry.since !== 'string' || entry.since.length === 0) {
    v(`[查 2] ${entry.module}::${entry.symbol} 缺 since（首快照全 1.0——面清单逐条必带）`);
  }
  if (!Array.isArray(entry.formFactors) || entry.formFactors.length === 0) {
    v(`[查 2] ${entry.module}::${entry.symbol} 缺 formFactors（面清单逐条必带）`);
  }
  // forwarded 条目（typebox 转发面）：tier 仅记载不承诺（M4）——词汇/形状仍验，执法豁免即到此为止
}

// 自由符号半边：公开根自身的直导出（非转译）必带 JSDoc 标签——现役为零，闸守新增
const barrelScan = scanTopLevelExports(readFileSync(BARREL_PATH, 'utf8'));
if (barrelScan.names.size > 0) {
  const barrelText = readFileSync(BARREL_PATH, 'utf8');
  const tagged = /@(stable|experimental|deprecated)\b/.test(barrelText);
  if (!tagged) {
    v(
      `[查 2] 公开根出现直导出（${[...barrelScan.names.keys()].join('、')}）而无 @stable/@experimental/@deprecated ` +
        `JSDoc 标签——自由符号标级载体是 JSDoc（§6.13.3 标级载体分职）；或改走 export * 目录宿主形`,
    );
  }
}

/* ---------------- 查 3：废弃登记完整性（骨架——批 3 充实） ---------------- */

const deprecatedEntries = surface.exports.filter((e) => e.tier === 'deprecated');
{
  // 形状半边（批 2 已可执法）：deprecated 条目必带 deprecated 载荷 { dep, removalIn, replacement }
  const depIds = [];
  for (const entry of deprecatedEntries) {
    const d = entry.deprecated;
    if (
      d === undefined ||
      typeof d.dep !== 'string' ||
      typeof d.removalIn !== 'string' ||
      typeof d.replacement !== 'string'
    ) {
      v(
        `[查 3] ${entry.module}::${entry.symbol} 标 deprecated 而缺完整 deprecated 载荷 { dep, removalIn, replacement }（§6.13.6）`,
      );
    } else {
      depIds.push(d.dep);
    }
  }
  const dup = depIds.filter((id, i) => depIds.indexOf(id) !== i);
  if (dup.length > 0) v(`[查 3] DEP 编号重复：${[...new Set(dup)].join('、')}（编号唯一——§6.13.8 查 3）`);
  // @deprecated JSDoc ↔ 注册簿双向对照与 removalIn 窗口算术随批 3 DEP 注册簿落地充实
}

/* ---------------- 查 4：官方全家桶零废弃使用（骨架——批 3 充实） ---------------- */

{
  // 逐废弃符号全仓产码扫描（测试豁免同 DAG 纪律；批 3 充实定义点/使用点区分与扫面治理）
  if (deprecatedEntries.length > 0) {
    const srcFiles = walkFiles('src', ['.ts']).filter((f) => !f.endsWith('.test.ts'));
    const texts = new Map(srcFiles.map((f) => [f, readFileSync(join(REPO_ROOT, f), 'utf8')]));
    for (const entry of deprecatedEntries) {
      const re = new RegExp(`\\b${entry.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      for (const [file, text] of texts) {
        if (re.test(text)) {
          v(
            `[查 4] 官方产码 ${file} 使用废弃面 ${entry.module}::${entry.symbol}——迁移路径先被狗家证明（拍板⑥，§6.13.8 查 4）`,
          );
        }
      }
    }
  }
}

/* ---------------- 查 5：实验面隔离（experimental 漏进稳定文档/示例红） ---------------- */

{
  const experimentalSymbols = surface.exports.filter((e) => e.tier === 'experimental');
  if (experimentalSymbols.length > 0) {
    const docFiles = [...walkFiles('docs', ['.md']), ...walkFiles('examples', ['.ts', '.md'])];
    for (const entry of experimentalSymbols) {
      const re = new RegExp(`\\b${entry.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      // 实验键（module = 虚拟键）另查键名字符串本身（import 说明符无词边界——按子串）
      const keyRe =
        entry.module.startsWith('berryagent/') || entry.module.startsWith('typebox')
          ? new RegExp(entry.module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          : null;
      for (const file of docFiles) {
        const text = readFileSync(join(REPO_ROOT, file), 'utf8');
        if (re.test(text) || (keyRe !== null && keyRe.test(text))) {
          v(
            `[查 5] 实验面 ${entry.module}::${entry.symbol} 漏进稳定文档/示例 ${file}——实验面不入稳定文档（§6.13.8 查 5）`,
          );
        }
      }
    }
  }
}

/* ---------------- 查 6：compat 件死期（批 4 前结构性拒绝） ---------------- */

{
  const compatDir = join(REPO_ROOT, 'src/compat');
  if (existsSync(compatDir)) {
    v(
      `[查 6] src/compat/ 在场而 compat 死期机器未落地（批 4 收剑点火件）——死期未登记的废弃桥结构性拒绝；` +
        `compat 件随批 4 DEP/edition 锚机器同批落（§6.13.8 查 6）`,
    );
  }
}

/* ---------------- 查 7：清单 api 块狗家全覆盖（生效日即绿） ---------------- */

{
  const appMod = await imp('../src/contracts/app.ts');
  const apiMod = await imp('../src/contracts/api.ts');
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const manifests = readdirSync(APPS_DIR).filter((n) => n.endsWith('.app.yaml'));
  for (const name of manifests) {
    const path = join(APPS_DIR, name);
    const manifest = appMod.validateAppManifest(parseYaml(readFileSync(path, 'utf8')), path);
    const gate = apiMod.adjudicateApiGate(manifest.api, pkg.apiVersion, manifest.id);
    if (gate.status === 'legacy') {
      v(`[查 7] 官方清单 ${name} 缺 api 块（legacy 容忍态窗口内——回填 api.minApiVersion 即绿；批 4 翻必填）`);
    }
  }
  if (manifests.length === 0) v(`[查 7] apps/ 目录零 .app.yaml——官方清单目录空（仓库布局异常）`);
}

/* ---------------- 出口 ---------------- */

if (problems.length > 0) {
  console.error(`check-api：${problems.length} 个问题`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
