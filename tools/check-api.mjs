#!/usr/bin/env node
/**
 * API 治理机器执法层（契约篇 §6.13.8 check-api 八查，第八十七批批 2 起——
 * 查 8 随第九十一批增设）。
 *
 * 进 lint:topology 链（CI 同一套）。八查形态（落码节奏——批表 §6.13.11）：
 * 1. drift——快照 src/contracts/api-surface.json ≠ 抽取真值即红（面漂移当场抓）；
 * 2. tier 全标——快照逐条 tier 词汇合法 + 公开根直导出（自由符号，现役为零）必带
 *    JSDoc 标签；typebox 转发条目（forwarded）记载不承诺、不参与执法（冷读 M4）；
 * 3. 废弃登记完整性——DEP 注册簿行不变式 + 双向对照（批 3 充实）；
 * 4. 官方全家桶零废弃使用——批 3 充实扫描面；
 * 5. 实验面隔离——experimental 符号/键漏进 docs/ 与 examples/ 即红（现零实验键恒绿，
 *    机制常驻——实验键上线日即执法日）；
 * 6. compat 件死期——批 4 点火前结构性拒绝（src/compat/ 在场即红——死期机器未落地，
 *    compat 件无登记可查 = fail-closed，非静默放行）；
 * 7. 清单 api 块狗家全覆盖——仓内全部 .app.yaml 的 api 块在场且合法（schema 校验 +
 *    装载门裁决非 legacy）；与官方三清单回填同批落——生效日即绿（冷读 M3）。
 * 8. 生成物 drift（第九十一批）——COMPATIBILITY.md / docs/API参考.md ≠ 生成器
 *    真值（面快照 + 注册簿 + 归档族派生）即红：生成物是提交件，手改或面变更后
 *    漏再生即漂移（再生入口 = npm run build 尾挂或生成器 CLI --write）。
 *
 * 出口：零问题静默过（门禁链惯例）；有问题 stderr 逐条 + exit 1。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createJiti } from 'jiti';
import { extractSurface, scanTopLevelExports, serializeSurface } from './extract-api-surface.mjs';
import { renderCompatibility, loadArchivedSnapshots, COMPATIBILITY_PATH } from './generate-compatibility.mjs';
import { renderApiReference, API_REFERENCE_PATH } from './generate-api-reference.mjs';

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

/* ---------------- 查 3：废弃登记完整性（批 3 充实——DEP 注册簿执法） ---------------- */

const deprecatedEntries = surface.exports.filter((e) => e.tier === 'deprecated');
/**
 * DEP 注册簿数据源。`CHECK_API_DEPRECATIONS` env 缝 = 回归锁换片位（CHECK_API_SNAPSHOT
 * 同款纪律）：测试注入带违规行的假注册簿证查 3/4 可红，不动共享树文件；缺省 jiti
 * 载真册。注意查 1 的 surface 真值恒走真册（drift 面不参与 seam）。
 */
const DEPRECATIONS =
  process.env.CHECK_API_DEPRECATIONS !== undefined
    ? JSON.parse(readFileSync(resolve(REPO_ROOT, process.env.CHECK_API_DEPRECATIONS), 'utf8'))
    : (await imp('../src/contracts/deprecations.ts')).DEPRECATIONS;
{
  // —— 3a 形状半边（批 2 载荷形状 + 批 3 注册簿行不变式——CI 闸是唯一执法位，
  // deprecations.test.ts 同律锁是镜像非冗余：门禁先红、测试锁回归）——
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

  const apiContracts = await imp('../src/contracts/api.ts');
  const DEP_ID_RE = /^DEP-\d{3}$/;
  const registryIds = [];
  for (const reg of DEPRECATIONS) {
    // 行不变式四道：编号格式 / 坐标形 / 版本格式 / 窗口算术 + 替代指引非空
    if (!DEP_ID_RE.test(reg.dep)) v(`[查 3] 注册簿 ${reg.dep}：DEP 编号格式非法（DEP-001 式三位数）`);
    const segs = String(reg.symbol).split('::');
    if (segs.length !== 2 || segs[0] === '' || segs[1] === '') {
      v(`[查 3] 注册簿 ${reg.dep}：symbol 非模块::符号 两段坐标形（${reg.symbol}）`);
    }
    if (!apiContracts.isValidApiVersion(reg.introducedIn) || !apiContracts.isValidApiVersion(reg.removalIn)) {
      v(`[查 3] 注册簿 ${reg.dep}：版本格式非法（${reg.introducedIn} → ${reg.removalIn}，应为 MAJOR.MINOR）`);
    } else {
      const [iMajor, iMinor] = reg.introducedIn.split('.').map(Number);
      const [rMajor] = reg.removalIn.split('.').map(Number);
      if (rMajor !== iMajor || apiContracts.compareApiVersions(reg.removalIn, `${iMajor}.${iMinor + 3}`) < 0) {
        v(
          `[查 3] 注册簿 ${reg.dep}：废弃窗不足（${reg.introducedIn} → ${reg.removalIn}，须同 MAJOR 且 ≥ 3 minor——拍板⑤）`,
        );
      }
    }
    if (typeof reg.replacement !== 'string' || reg.replacement === '') {
      v(`[查 3] 注册簿 ${reg.dep}：replacement 为空（废弃不给替代 = 断头路——§6.13.6）`);
    }
    registryIds.push(reg.dep);
  }
  const regDup = registryIds.filter((id, i) => registryIds.indexOf(id) !== i);
  if (regDup.length > 0) v(`[查 3] 注册簿 DEP 编号重复：${[...new Set(regDup)].join('、')}`);

  // —— 3b 注册簿 ↔ 面清单双向对照（join 键 = module::symbol 坐标；抽取器终段
  // 已从注册簿挂 tier 与载荷——此查对 seam 注入行与篡改面同红）——
  const exportByKey = new Map(surface.exports.map((e) => [`${e.module}::${e.symbol}`, e]));
  for (const reg of DEPRECATIONS) {
    const target = exportByKey.get(reg.symbol);
    if (target === undefined) {
      v(`[查 3] 注册簿 ${reg.dep}：symbol ${reg.symbol} 不在面清单（登记指向不存在的面——先修坐标）`);
      continue;
    }
    if (target.tier !== 'deprecated' || target.deprecated?.dep !== reg.dep) {
      v(
        `[查 3] 注册簿 ${reg.dep}：面清单 ${reg.symbol} 未标 deprecated 或载荷 DEP 编号不一致（重跑抽取器 --write 落同笔快照）`,
      );
    }
  }

  // —— 3c deprecated JSDoc 标签 ↔ 注册簿双向对照（标签形 = `@deprecated DEP-001
  // <说明>`——裸标签红：无编号的标签无法对账；注册行无标签红：登记不落码面
  // 标注即双源）——
  const jsdocFiles = walkFiles('src', ['.ts']).filter((f) => !f.endsWith('.test.ts'));
  const taggedIds = new Set();
  for (const file of jsdocFiles) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const m of text.matchAll(/@deprecated\s+(DEP-\d{3})/g)) taggedIds.add(m[1]);
    if (/@deprecated(?!\s+DEP-\d{3})/.test(text)) {
      v(`[查 3] ${file}：裸 @deprecated 标签未携带 DEP 编号（标签形 = @deprecated DEP-001 说明——§6.13.6 双向断言）`);
    }
  }
  for (const id of taggedIds) {
    if (!registryIds.includes(id)) v(`[查 3] JSDoc 标签 ${id} 未在 DEP 注册簿登记（标签 ↔ 注册簿双向——先登记再标码）`);
  }
  for (const id of registryIds) {
    if (!taggedIds.has(id)) v(`[查 3] 注册簿 ${id} 无对应 @deprecated JSDoc 标签（登记须同步落码面标注——§6.13.6）`);
  }
}

/* ---------------- 查 4：官方全家桶零废弃使用（批 3 充实——扫面含 examples） ---------------- */

{
  // 扫描面 = src 非测试产码 + examples（官方示例是全家桶的公开面）；定义点豁免
  // 机械推导：export 声明该符号的文件是定义位非使用位（registry 文件自身另免——
  // 注册簿坐标串是元数据非使用）。seam 注入行走同一扫面（红路径可测）。
  // 扫描目标 = 注册簿腿 ∪ 面清单腿（join 一致时同符号——按坐标去重防双报）
  const scanTargets = [
    ...DEPRECATIONS.map((reg) => ({ dep: reg.dep, symbol: reg.symbol })),
    ...deprecatedEntries.map((e) => ({
      dep: e.deprecated?.dep ?? '(载荷缺 dep)',
      symbol: `${e.module}::${e.symbol}`,
    })),
  ].filter((t, i, arr) => arr.findIndex((o) => o.symbol === t.symbol) === i);
  if (scanTargets.length > 0) {
    const srcFiles = walkFiles('src', ['.ts']).filter(
      (f) => !f.endsWith('.test.ts') && !f.endsWith('contracts/deprecations.ts'),
    );
    const exampleFiles = walkFiles('examples', ['.ts']);
    const texts = new Map([...srcFiles, ...exampleFiles].map((f) => [f, readFileSync(join(REPO_ROOT, f), 'utf8')]));
    for (const target of scanTargets) {
      const name = target.symbol.split('::')[1] ?? target.symbol;
      // 键形符号（含 /）按子串（import 说明符无词边界）；标识符按 \b 词边界
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const useRe = name.includes('/') ? new RegExp(escaped) : new RegExp(`\\b${escaped}\\b`);
      // 定义点 = export 声明该符号的文件（含 declare 前缀形——机械推导，首真实废弃日执法面即正确）
      const defRe = new RegExp(
        `export\\s+(?:declare\\s+)?(?:const|function|class|interface|type|enum|let|var)\\s+${escaped}\\b`,
      );
      for (const [file, text] of texts) {
        if (defRe.test(text)) continue; // 定义位非使用位
        if (useRe.test(text)) {
          v(
            `[查 4] 官方产码 ${file} 使用废弃面 ${target.symbol}（DEP ${target.dep}）——迁移路径先被狗家证明（拍板⑥，§6.13.8 查 4）`,
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

/* ---------------- 查 8：生成物 drift（第九十一批——两生成物 ≠ 生成器真值红） ---------------- */

{
  // 生成物派生自【提交位快照】（非抽取真值——快照 ≠ 真值时查 1 已红；生成物纪律
  // 单独执法：手改生成物 / 面变更后漏再生在此红）。seam 注入的快照/注册簿原样
  // 入渲染——回归锁换片位天然联动（篡改快照 = 查 1 + 查 8 双红）。
  const snapSurface = JSON.parse(snapshotText);
  const pairs = [
    {
      label: 'COMPATIBILITY.md',
      path: COMPATIBILITY_PATH,
      want: renderCompatibility({
        surface: snapSurface,
        deprecations: DEPRECATIONS,
        snapshots: loadArchivedSnapshots(),
      }),
    },
    {
      label: 'docs/API参考.md',
      path: API_REFERENCE_PATH,
      want: renderApiReference({ surface: snapSurface, deprecations: DEPRECATIONS }),
    },
  ];
  for (const { label, path, want } of pairs) {
    if (!existsSync(path)) {
      v(`[查 8] 生成物 ${label} 缺席（npm run build 尾挂或生成器 --write 落盘——生成物是提交件）`);
      continue;
    }
    if (readFileSync(path, 'utf8') !== want) {
      v(
        `[查 8] 生成物 ${label} 漂移：与生成器真值不符（面快照 + DEP 注册簿 + 归档族派生）——` +
          `手改生成物或面变更后漏再生；重跑 \`npm run build\`（或 node tools/generate-*.mjs --write）`,
      );
    }
  }
}

/* ---------------- 出口 ---------------- */

if (problems.length > 0) {
  console.error(`check-api：${problems.length} 个问题`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
