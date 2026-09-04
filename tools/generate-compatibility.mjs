#!/usr/bin/env node
/**
 * COMPATIBILITY.md 生成器（契约篇 §6.13.6「面 diff 自动判级」的机器面——
 * 2026-09-03 第九十一批窗口内机器建设）。
 *
 * 输入三源：面快照（src/contracts/api-surface.json 提交位）+ DEP 注册簿
 * （src/contracts/deprecations.ts）+ 归档快照族（api/snapshots/<version>.json——
 * release 子步 3.5 落档，版本号即文件名）。输出根目录 COMPATIBILITY.md（提交件）：
 * - 无归档期（首 release 前）= 当前面盘点 + DEP 节 + 基线注记；
 * - 归档激活后 = 逐版 diff 判级小节（判级携 DEP 语境：sanctioned 销账 = MINOR、
 *   无 DEP 的 removed/changed = MAJOR、added = MINOR）+ 未发布面变更预告节
 *   （面快照 vs 最新归档——待下版快照归档定判级）。
 * - 执法纪元渲染（§6.13.4 点火可见性——全面复盘 20260903-91 刀五）：头部当前
 *   纪元行 + 归档族相邻两版纪元翻转行（eraOf 归一读取——键缺席 = pre-ignition）
 *   + 未发布纪元预告（面快照纪元 ≠ 最新归档纪元）。
 *
 * 守护：check-api 查 8 对本文件做生成物 drift 执法（≠ 生成器真值即红）；
 * `npm run build` 尾挂再生。CLI 形态：`--write` 落盘（缺省打印 stdout）；
 * env 缝与 check-api 同名同语义（CHECK_API_SNAPSHOT / CHECK_API_DEPRECATIONS——
 * 回归锁换片位，不动共享树真身）。
 *
 * 纯核心 renderCompatibility 导出供查 8 进程内复用（CLI 只是薄壳——两消费面
 * 同一渲染函数，drift 判定与人工再生天然同源）。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { EXPERIMENTAL_SECTION_HEADING } from './api-doc-sections.mjs';

/** 仓库根（脚本位置上一级） */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** 面快照提交位（CHECK_API_SNAPSHOT env 缝 = check-api 同款回归锁换片位） */
export const SNAPSHOT_PATH =
  process.env.CHECK_API_SNAPSHOT !== undefined
    ? resolve(REPO_ROOT, process.env.CHECK_API_SNAPSHOT)
    : join(REPO_ROOT, 'src/contracts/api-surface.json');
/** COMPATIBILITY.md 落盘位（仓库根——check-api 查 8 守护对象） */
export const COMPATIBILITY_PATH = join(REPO_ROOT, 'COMPATIBILITY.md');
/** 归档快照族目录（release 子步 3.5 落档——无此目录 = 基线形成前） */
const SNAPSHOTS_DIR = join(REPO_ROOT, 'api/snapshots');

const jiti = createJiti(import.meta.url);
/** 便利导入：仓库内相对路径 → 模块运行时面 */
const imp = (rel) => jiti.import(fileURLToPath(new URL(rel, import.meta.url)));

/**
 * apiVersion 比较（单源 = contracts/api.ts compareApiVersions——MAJOR.MINOR 逐段
 * 数值比较，禁字符串比较；渲染判级（死期状态/销账判定）与装载门同语义）。
 */
const { compareApiVersions } = await imp('../src/contracts/api.ts');

/**
 * 面条目坐标键（与 check-api keyOf 同键形——diff 分类的 join 基准）。
 * @param {import('./extract-api-surface.mjs').SurfaceExport} entry
 */
const keyOf = (entry) => `${entry.module}::${entry.symbol}`;

/**
 * semver 三段比较（归档族排序专用——release 号全集是 semver 形，导出供
 * release 子步 3.5 与排序单测复用）。字典序两大陷阱在此修正：
 * ① 预发布段必须排在正式版之前（semver 优先级律：1.0.0-alpha < 1.0.0——
 *   字典序相反，'1.0.0' 是 '1.0.0-alpha.1' 的前缀而排前）；
 * ② 预发布段内数值段按数值序（alpha.2 < alpha.10——localeCompare 默认不开
 *   numeric collation，字典序必反）。
 * @returns {number} 负 = a 先于 b
 */
export function compareSemver(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(v);
    // 非法形态沉底（排最末 = 最新位，变更史尾节人眼常扫处可见；归档文件名应恒
    // semver，此支纯防御。MAX_SAFE_INTEGER 而非 -1：-1 会排最前被夹进远古史里隐形）
    if (m === null) return { core: [Number.MAX_SAFE_INTEGER, 0, 0], pre: null };
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }
  // 正式版（无预发布段）恒排在一切预发布之后
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  // 预发布段间：点分逐段，数值段数值比、数值标识符恒小于字母数字标识符
  // （semver 第 11 节同律——本仓预发布段现实形态 alpha.N / rc.N 已全覆盖）
  const as = pa.pre.split('.');
  const bs = pb.pre.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 读取归档快照族（文件名 = 版本号，内容 = 该版面快照本体）。返回按 semver 升序
 * （compareSemver——字典序的预发布/数值段陷阱见其注释）。目录缺席 = 空数组
 * （基线形成前）。dir 参数化（缺省仓库归档位）：release 子步 3.5 以 workDir
 * 锚定的归档目录调用（真跑同根、测试临时 workDir——两消费面同一函数）。
 * @param {string} [dir] 归档目录（缺省 = 仓库 api/snapshots）
 * @returns {Array<{ version: string, surface: object }>}
 */
export function loadArchivedSnapshots(dir = SNAPSHOTS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => ({ version: n.slice(0, -'.json'.length), surface: JSON.parse(readFileSync(join(dir, n), 'utf8')) }))
    .sort((a, b) => compareSemver(a.version, b.version));
}

/**
 * 执法纪元归一读取（§6.13.4 点火可见性——全面复盘 20260903-91 刀五）。
 * 归一语义：`enforcement` 键缺席（纪元章落地前的归档快照）= 'pre-ignition'
 * ——该时期语义本就是窗口容忍态，老快照零假翻转行；任何非 'ignited' 值（含
 * 垃圾值）同归 pre-ignition（fail-closed 反向：纪元章只认显式 'ignited'，
 * 误写不放大执法宣称）。导出供 check-api.test.mjs 直锁归一语义。
 * @param {object} surface 面快照（当前提交位或归档位任一形态）
 * @returns {'pre-ignition' | 'ignited'}
 */
export function eraOf(surface) {
  return surface.enforcement === 'ignited' ? 'ignited' : 'pre-ignition';
}

/**
 * 两版面 diff 分类（§6.13.6 四类）。changed = 除 tier/deprecated 外字段有变
 * （形状/语义变）；re-tiered = 仅 tier 变（含 DEP 登记日 tier→deprecated 与
 * 撤销日 deprecated→原级——治理动作非形状变更，走 api-deprecate: 裁决类）；
 * deprecated 载荷-only 调整（如 replacement 文案润色）不入任何桶——治理记录
 * 从 DEP 真册渲染（DEP 节天然反映），不构成面形变更。
 * @param {object} prev 上一版面快照
 * @param {object} curr 当前面快照
 */
export function classifyFaceDiff(prev, curr) {
  const prevMap = new Map(prev.exports.map((e) => [keyOf(e), e]));
  const currMap = new Map(curr.exports.map((e) => [keyOf(e), e]));
  /** @type {string[]} */ const added = [];
  /** @type {string[]} */ const removed = [];
  /** @type {string[]} */ const changed = [];
  /** @type {Array<{ key: string; from: string; to: string }>} */ const reTiered = [];
  for (const [key, entry] of currMap) {
    if (!prevMap.has(key)) {
      added.push(key);
      continue;
    }
    const old = prevMap.get(key);
    // 剥 tier + deprecated 两键再比——DEP 登记日（tier 变 + 载荷挂上）与撤销日
    // （载荷消失）都只剩 tier 差异 → re-tiered 桶；载荷-only 桶差为零 → 无面变
    const { tier: oldTier, deprecated: _oldDep, ...oldRest } = old;
    const { tier, deprecated: _dep, ...rest } = entry;
    if (JSON.stringify(oldRest) !== JSON.stringify(rest)) changed.push(key);
    else if (oldTier !== tier) reTiered.push({ key, from: oldTier, to: tier });
  }
  for (const key of prevMap.keys()) if (!currMap.has(key)) removed.push(key);
  const capChanged = JSON.stringify(prev.capabilities) !== JSON.stringify(curr.capabilities);
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    reTiered: reTiered.sort((a, b) => a.key.localeCompare(b.key, 'en')),
    capabilitiesChanged: capChanged,
  };
}

/**
 * 判级携 DEP 语境（§6.13.6 冷读 M1——机器判级认登记不认动机）。导出供
 * check-api.test.mjs 直锁判级语义（sanctioned/MAJOR 分桶）。
 * removed/changed 且有生效 DEP、死期已到（该版**面号** apiVersion ≥ removalIn）=
 * sanctioned 销账类 MINOR；无 DEP = MAJOR；added = MINOR。
 * 号域纪律：removalIn 注册即面号域（apiVersion 两段形 1.2，§6.13.2 号独立
 * 演进）——判级对照必须用面号，禁传宿主 release 号（semver 三段，宿主号可
 * 漂移在面号前方——截断比对会假判死期已到）。
 * @param {string[]} keys 变更坐标清单
 * @param {'removed'|'changed'} kind 变更类
 * @param {Array<{ symbol: string; dep: string; removalIn: string }>} deprecations DEP 注册簿
 * @param {string} apiVersion 该版面号（两段形——调用方传 cur.surface.apiVersion）
 */
export function judgeBreakages(keys, kind, deprecations, apiVersion) {
  const bySymbol = new Map(deprecations.map((d) => [d.symbol, d]));
  /** @type {Array<{ key: string; dep: string }>} */ const sanctioned = [];
  /** @type {string[]} */ const major = [];
  for (const key of keys) {
    const reg = bySymbol.get(key);
    // 生效判据 = DEP 在册且死期已到（窗口走完的销账删除/改形才是 sanctioned）
    if (reg !== undefined && compareApiVersions(apiVersion, reg.removalIn) >= 0) sanctioned.push({ key, dep: reg.dep });
    else major.push(key);
  }
  return { kind, sanctioned, major };
}

/**
 * 渲染 COMPATIBILITY.md 全文（纯函数——查 8 与 CLI 同源）。
 * @param {{ surface: object, deprecations: Array<object>, snapshots: Array<{ version: string, surface: object }> }} input
 */
export function renderCompatibility({ surface, deprecations, snapshots }) {
  const lines = [];
  lines.push('# API 兼容性档案（COMPATIBILITY）');
  lines.push('');
  lines.push(
    '> 本文件由 `tools/generate-compatibility.mjs` 生成（`npm run build` 尾挂再生，check-api 查 8 drift 守护）——勿手编。',
  );
  lines.push(
    '> 面真值 = `src/contracts/api-surface.json`；语义权威 = 设计文档「应用契约与扩展点」API 治理章（§6.13）。',
  );
  lines.push('');
  lines.push(`## 当前面盘点（apiVersion ${surface.apiVersion}）`);
  lines.push('');
  // 逐模块 tier 计数（全排序保确定性——模块名字典序）
  const modules = [...new Set(surface.exports.map((e) => e.module))].sort((a, b) => a.localeCompare(b, 'en'));
  const count = (m, tier) => surface.exports.filter((e) => e.module === m && e.tier === tier).length;
  lines.push('| 模块 | stable | experimental | deprecated | 合计 |');
  lines.push('|---|---|---|---|---|');
  for (const m of modules) {
    const s = count(m, 'stable');
    const x = count(m, 'experimental');
    const d = count(m, 'deprecated');
    lines.push(`| \`${m}\` | ${s} | ${x} | ${d} | ${s + x + d} |`);
  }
  const total = surface.exports.length;
  lines.push(
    `| **合计** | ${surface.exports.filter((e) => e.tier === 'stable').length} | ${surface.exports.filter((e) => e.tier === 'experimental').length} | ${surface.exports.filter((e) => e.tier === 'deprecated').length} | **${total}** |`,
  );
  lines.push('');
  lines.push(`能力面（capabilities）共 ${surface.capabilities.length} 项。`);
  lines.push('');
  // 当前执法纪元行（§6.13.4 点火可见性——刀五）：面快照 enforcement 纪元章归一
  // 读取；两态文案各带执法语义速览（读者不翻规范即知当前容忍/拒载形态）
  lines.push(
    eraOf(surface) === 'ignited'
      ? '执法纪元：`ignited`（兼容执法已点火——清单 api 块缺席拒载、min fail-loud 对全体应用生效）。'
      : '执法纪元：`pre-ignition`（兼容执法未点火——清单 api 块缺席为 legacy 容忍态，仅聚合 warn）。',
  );
  lines.push('');

  // —— 实验面节（查 5 豁免位的 COMPATIBILITY 侧同律——§6.13.8/9 刀 E）——
  // 当前面在役实验符号逐名单列（盘点表只计数不点名）；空集不渲染：无永久空节
  // （零实验符号时输出与旧形态字节等值——查 8 不因本刀漂移）
  const experimentalExports = surface.exports
    .filter((e) => e.tier === 'experimental')
    .sort((a, b) => `${a.module}::${a.symbol}`.localeCompare(`${b.module}::${b.symbol}`, 'en'));
  if (experimentalExports.length > 0) {
    lines.push(EXPERIMENTAL_SECTION_HEADING);
    lines.push('');
    lines.push('当前面在役实验符号（任意 minor 可破可删——判级语义见 §6.13.3/6.13.6）。');
    lines.push('');
    for (const entry of experimentalExports) {
      lines.push(`- \`${entry.module}::${entry.symbol}\` — since ${entry.since}`);
    }
    lines.push('');
  }

  // —— DEP 注册簿节 ——
  lines.push('## 废弃登记（DEP 注册簿）');
  lines.push('');
  if (deprecations.length === 0) {
    lines.push('现役零废弃登记（首个真实废弃日起本节逐行生成——登记纪律见 §6.13.6）。');
    lines.push('');
  } else {
    lines.push('| DEP | 符号 | 废弃窗 | 替代 | 死期状态 |');
    lines.push('|---|---|---|---|---|');
    for (const reg of [...deprecations].sort((a, b) => a.dep.localeCompare(b.dep, 'en'))) {
      const due = compareApiVersions(surface.apiVersion, reg.removalIn) >= 0;
      lines.push(
        `| ${reg.dep} | \`${reg.symbol}\` | ${reg.introducedIn} → ${reg.removalIn} | \`${reg.replacement}\` | ${due ? '**已到死期**（销账删除合法）' : '窗口内（桥存活）'} |`,
      );
    }
    lines.push('');
  }

  // —— 变更史节 ——
  lines.push('## 变更史（快照 diff 自动判级）');
  lines.push('');
  if (snapshots.length === 0) {
    lines.push('基线形成前——首个 release 归档首版快照（`api/snapshots/`）即基线，此后逐版生成本节。');
    // 尾形纪律：恰一个换行收尾（与 docs/API参考.md 同律——生成物定格形态）
    return lines.join('\n').replace(/\n+$/, '') + '\n';
  }
  // 逐版小节：v_i 对照 v_{i-1}（首版 = 基线全量）
  for (let i = 0; i < snapshots.length; i++) {
    const cur = snapshots[i];
    const prev = i === 0 ? null : snapshots[i - 1];
    lines.push(`### ${cur.version}${prev === null ? '（基线）' : `（对照 ${prev.version}）`}`);
    lines.push('');
    if (prev === null) {
      lines.push(
        `基线快照：面 ${cur.surface.exports.length} 导出 / 能力 ${cur.surface.capabilities.length} 项（apiVersion ${cur.surface.apiVersion}）。`,
      );
      lines.push('');
      continue;
    }
    // 纪元翻转行（§6.13.4 点火可见性——刀五）：先于面 diff 单列——零面变更的
    // 纯翻转 release 也有迹可查（翻转本身是执法行为变更，api-break: 语义裁决）
    const prevEra = eraOf(prev.surface);
    const curEra = eraOf(cur.surface);
    if (prevEra !== curEra) {
      lines.push(
        `- **执法纪元翻转**（\`${prevEra}\` → \`${curEra}\`——本版起 api 块缺席从聚合 warn 变拒载、min fail-loud 对全体应用生效，\`api-break:\` 语义裁决）`,
      );
      lines.push('');
    }
    renderDiffSection(lines, classifyFaceDiff(prev.surface, cur.surface), cur.surface.apiVersion, deprecations);
  }
  // 未发布面变更预告节（面快照 vs 最新归档——判级待下版归档）
  const latest = snapshots[snapshots.length - 1];
  const pending = classifyFaceDiff(latest.surface, surface);
  // 纪元预告（§6.13.4 点火可见性——刀五）：面快照纪元 ≠ 最新归档纪元 = 点火位
  // 已翻而尚未归档——点火日 PR 的快照 diff 必落本节，裁决义务（api-break:）点名
  const eraFlipPending = eraOf(latest.surface) !== eraOf(surface);
  const hasPending =
    pending.added.length + pending.removed.length + pending.changed.length + pending.reTiered.length > 0 ||
    pending.capabilitiesChanged ||
    eraFlipPending;
  lines.push(`### 未发布面变更（对照最新归档 ${latest.version}——判级待下版快照归档）`);
  lines.push('');
  if (!hasPending) {
    lines.push('面快照与最新归档一致（零未发布面变更）。');
    lines.push('');
  } else {
    const parts = [];
    if (eraFlipPending)
      parts.push(
        `执法纪元待翻转（\`${eraOf(latest.surface)}\` → \`${eraOf(surface)}\`——点火位已翻、快照已 diff；本 PR 须带 \`api-break:\` 裁决标签）`,
      );
    if (pending.added.length > 0)
      parts.push(`新增 ${pending.added.length}：${pending.added.map((k) => `\`${k}\``).join('、')}`);
    if (pending.removed.length > 0)
      parts.push(`移除 ${pending.removed.length}：${pending.removed.map((k) => `\`${k}\``).join('、')}`);
    if (pending.changed.length > 0)
      parts.push(`改形 ${pending.changed.length}：${pending.changed.map((k) => `\`${k}\``).join('、')}`);
    if (pending.reTiered.length > 0)
      parts.push(
        `重定级 ${pending.reTiered.length}：${pending.reTiered.map((r) => `\`${r.key}\`（${r.from}→${r.to}）`).join('、')}`,
      );
    if (pending.capabilitiesChanged) parts.push('能力面有变');
    for (const p of parts) {
      lines.push(`- ${p}`);
    }
    lines.push('');
    lines.push(
      '判级与销账归类随下版快照归档（release 子步 3.5）落定——本节只是预告，未定级前移除/改形不得合入无 `api-break:` 标签的 PR。',
    );
    lines.push('');
  }
  // 尾形纪律：恰一个换行收尾（与 docs/API参考.md 同律——生成物定格形态）
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

/**
 * 渲染单版 diff 小节（判级携 DEP 语境——sanctioned 销账单列、无 DEP 断 MAJOR）。
 * @param {string[]} lines 输出行缓冲
 * @param {ReturnType<typeof classifyFaceDiff>} diff
 * @param {string} apiVersion 该版面号（两段形——判级对照 removalIn 用面号域，
 *   非归档文件名里的宿主 release 号；号域纪律见 judgeBreakages 注释）
 * @param {Array<object>} deprecations DEP 注册簿
 */
function renderDiffSection(lines, diff, apiVersion, deprecations) {
  const empty =
    diff.added.length + diff.removed.length + diff.changed.length + diff.reTiered.length === 0 &&
    !diff.capabilitiesChanged;
  if (empty) {
    lines.push('与上版快照一致（零面变更 release）。');
    lines.push('');
    return;
  }
  const removed = judgeBreakages(diff.removed, 'removed', deprecations, apiVersion);
  const changed = judgeBreakages(diff.changed, 'changed', deprecations, apiVersion);
  if (diff.added.length > 0) {
    lines.push(
      `- **added（判 MINOR / \`api-add:\`）** ${diff.added.length} 项：${diff.added.map((k) => `\`${k}\``).join('、')}`,
    );
  }
  if (removed.sanctioned.length + changed.sanctioned.length > 0) {
    const items = [...removed.sanctioned, ...changed.sanctioned].map((s) => `\`${s.key}\`（${s.dep} 销账）`);
    lines.push(`- **废弃窗销账（判 MINOR——有生效 DEP 且死期已到）** ${items.length} 项：${items.join('、')}`);
  }
  if (removed.major.length > 0) {
    lines.push(
      `- **removed 无 DEP（判 MAJOR / \`api-break:\`）** ${removed.major.length} 项：${removed.major.map((k) => `\`${k}\``).join('、')}`,
    );
  }
  if (changed.major.length > 0) {
    lines.push(
      `- **changed 无 DEP（判 MAJOR / \`api-break:\`）** ${changed.major.length} 项：${changed.major.map((k) => `\`${k}\``).join('、')}`,
    );
  }
  if (diff.reTiered.length > 0) {
    const items = diff.reTiered.map(
      (r) => `\`${r.key}\`（${r.from}→${r.to}${r.to === 'deprecated' ? '——须带 \`api-deprecate:\` 与 DEP 登记' : ''}）`,
    );
    lines.push(`- **re-tiered（稳定性重标定）** ${diff.reTiered.length} 项：${items.join('、')}`);
  }
  if (diff.capabilitiesChanged)
    lines.push('- **capabilities 有变**（能力面增删——`api-add:` / `api-break:` 按增/删分判）');
  lines.push('');
}

/* ---------------- CLI 薄壳（--write 落盘；缺省 stdout） ---------------- */

// CLI 直跑判定（健壮形——与 extract-api-surface.mjs 同款）：URL 手拼对照在
// 路径含 #/? 等保留字符时必错（# 截成 fragment）；resolve 对照 argv[1] 绝对
// 化后与自身 fileURLToPath 逐字节比（遗漏大扫 20260904 #17）
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const surface = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  const deprecations =
    process.env.CHECK_API_DEPRECATIONS !== undefined
      ? JSON.parse(readFileSync(resolve(REPO_ROOT, process.env.CHECK_API_DEPRECATIONS), 'utf8'))
      : (await imp('../src/contracts/deprecations.ts')).DEPRECATIONS;
  const text = renderCompatibility({ surface, deprecations, snapshots: loadArchivedSnapshots() });
  if (process.argv.includes('--write')) {
    writeFileSync(COMPATIBILITY_PATH, text);
    console.log(`COMPATIBILITY.md 已再生（${text.length} 字符——查 8 守护对象）`);
  } else {
    process.stdout.write(text);
  }
}
