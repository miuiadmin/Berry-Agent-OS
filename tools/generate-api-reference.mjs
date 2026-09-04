#!/usr/bin/env node
/**
 * API 参考生成器（契约篇 §6.13.9「API 参考自动生成」——2026-09-03 第九十一批
 * 窗口内机器建设）。
 *
 * surface.json → docs/API参考.md：符号面全部生成（符号名/层级/since/deprecated
 * 全从面清单派生——面清单无签名数据，.d.ts 模板面才是签名位；手写文档只留
 * 概念叙述，文档漂移类缺陷结构性消失——全面复盘 20260903-91 刀六勘正：原稿
 * 「签名……派生」宣称失实）。守护 = check-api 查 8 生成物 drift；
 * `npm run build` 尾挂再生。
 *
 * 形态纪律（prettier 稳定）：docs/ 在 format:check 射面内，本文件输出用
 * 标题 + 列表（proseWrap preserve 下 prettier 零动作的形态）——表格列宽对齐
 * 与 CJK 宽度计算不引入，生成即定格。CLI：`--write` 落盘（缺省 stdout）；
 * CHECK_API_SNAPSHOT env 缝与 check-api 同名同语义。
 *
 * renderApiReference 导出供查 8 进程内复用（与 generate-compatibility 同律：
 * 两消费面同一渲染函数）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
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
/** API 参考落盘位（docs/ 公开文档面——查 8 守护对象） */
export const API_REFERENCE_PATH = join(REPO_ROOT, 'docs/API参考.md');

/** tier 语义速览（生成物内的分级说明——语义权威在规范 §6.13.3，此处只指路） */
const TIER_NOTES = {
  stable: 'stable（minor 只增不破）',
  experimental: 'experimental（任意 minor 可破可删）',
  deprecated: 'deprecated（废弃窗内——见 DEP 登记）',
};

/** 形态适用集的短标记（全形态 = 单词；子集逐项列） */
function formFactorsNote(entry) {
  const all = ['standalone', 'daemon', 'server'];
  const set = entry.formFactors;
  if (set.length === all.length && all.every((f) => set.includes(f))) return '全形态';
  return set.join(' / ');
}

/**
 * 渲染 docs/API参考.md 全文（纯函数——查 8 与 CLI 同源）。逐符号行形态：
 * `- `Symbol` — tier，since X，形态集`（deprecated 追加 DEP/死期/替代；
 * forwarded 追加转发注记——tier 承诺归上游）。experimental 符号不入模块节
 * ——单列文末「实验面」节（查 5 豁免位，刀 E；空集不渲染）。
 * @param {{ surface: object, deprecations: Array<{ dep: string, symbol: string, removalIn: string, replacement: string }> }} input
 */
export function renderApiReference({ surface, deprecations }) {
  const bySymbol = new Map(deprecations.map((d) => [d.symbol, d]));
  const lines = [];
  lines.push('# API 参考');
  lines.push('');
  lines.push(
    '> 本文件由 `tools/generate-api-reference.mjs` 从 `src/contracts/api-surface.json` 生成（`npm run build` 尾挂再生，check-api 查 8 drift 守护）——勿手编。',
  );
  lines.push(
    '> 稳定性分级与兼容承诺见 docs/应用开发指南.md「API 稳定性与兼容性」节与仓库 COMPATIBILITY.md；本文件只派生符号面。',
  );
  lines.push('');
  lines.push(
    `当前 apiVersion：\`${surface.apiVersion}\`。导出 ${surface.exports.length} 项、能力 ${surface.capabilities.length} 项。`,
  );
  lines.push('');
  lines.push('## 目录');
  lines.push('');
  // 模块分节（字典序——与 COMPATIBILITY.md 当前面盘点同序）。experimental 符号
  // 不入模块节——单列文末「实验面」节（查 5 豁免位，§6.13.8/9 刀 E）；零实验
  // 符号时过滤为恒等、节不渲染——输出与旧形态字节等值（查 8 不因本刀漂移）
  const experimentalExports = surface.exports
    .filter((e) => e.tier === 'experimental')
    .sort((a, b) => `${a.module}::${a.symbol}`.localeCompare(`${b.module}::${b.symbol}`, 'en'));
  const stableExports = surface.exports.filter((e) => e.tier !== 'experimental');
  const modules = [...new Set(stableExports.map((e) => e.module))].sort((a, b) => a.localeCompare(b, 'en'));
  for (const m of modules) lines.push(`- [\`${m}\`](#${m.replace(/[/]/g, '')})`);
  lines.push('- [能力面（capabilities）](#能力面capabilities)');
  // 目录腿同律：零实验符号不加目录行（空节不渲染——不产死链）
  if (experimentalExports.length > 0) lines.push('- [实验面（experimental）](#实验面experimental)');
  lines.push('');
  for (const m of modules) {
    lines.push(`## \`${m}\``);
    lines.push('');
    const entries = stableExports.filter((e) => e.module === m).sort((a, b) => a.symbol.localeCompare(b.symbol, 'en'));
    for (const entry of entries) {
      let note = TIER_NOTES[entry.tier] ?? entry.tier;
      note += `，since ${entry.since}，${formFactorsNote(entry)}`;
      if (entry.forwarded === true) note += '（forwarded 转发——tier 承诺归上游 typebox）';
      const reg = bySymbol.get(`${m}::${entry.symbol}`);
      if (reg !== undefined) note += `（${reg.dep}，死期 ${reg.removalIn}，替代 \`${reg.replacement}\`）`;
      lines.push(`- \`${entry.symbol}\` — ${note}`);
    }
    lines.push('');
  }
  lines.push('## 能力面（capabilities）');
  lines.push('');
  lines.push(
    '能力 = 宿主能力目录登记的语义单位（providedBy 归因官方件；`ctx.host.capabilities` 派生源；server 形装载器按此拒载要求缺席能力的应用）。',
  );
  lines.push('');
  for (const cap of [...surface.capabilities].sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    lines.push(`- \`${cap.name}\` — ${cap.providedBy}，${formFactorsNote(cap)}`);
  }
  // —— 实验面节（查 5 豁免位——experimental 符号在 docs 的唯一合法披露位）——
  // 空集不渲染（无永久空节——查 8 字节等值会把空节锁死在文档直到首个实验键）；
  // 行带模块注记（跨模块单列，模块归属不可丢）
  if (experimentalExports.length > 0) {
    lines.push('');
    lines.push(EXPERIMENTAL_SECTION_HEADING);
    lines.push('');
    lines.push('实验符号单列本节（查 5 豁免位——节外禁入稳定文档；任意 minor 可破可删，承诺语义见 §6.13.3）。');
    lines.push('');
    for (const entry of experimentalExports) {
      let note = `experimental，since ${entry.since}，${formFactorsNote(entry)}`;
      const reg = bySymbol.get(`${entry.module}::${entry.symbol}`);
      if (reg !== undefined) note += `（${reg.dep}，死期 ${reg.removalIn}，替代 \`${reg.replacement}\`）`;
      lines.push(`- \`${entry.symbol}\`（\`${entry.module}\`） — ${note}`);
    }
  }
  // 尾形纪律：恰一个换行收尾（prettier 形态——多条尾空行会被 format:check 红）
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

/* ---------------- CLI 薄壳（--write 落盘；缺省 stdout） ---------------- */

// CLI 直跑判定（健壮形——与 extract-api-surface.mjs 同款）：URL 手拼对照在
// 路径含 #/? 等保留字符时必错（# 截成 fragment）；resolve 对照 argv[1] 绝对
// 化后与自身 fileURLToPath 逐字节比（遗漏大扫 20260904 #17）
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const jiti = createJiti(import.meta.url);
  // 注册簿装载与 generate-compatibility 同律（CHECK_API_DEPRECATIONS env 缝 + jiti
  // 真册缺省）——deprecated 符号行的 DEP 注记与查 8 渲染必须同输入，防两源分叉恒红
  const deprecations =
    process.env.CHECK_API_DEPRECATIONS !== undefined
      ? JSON.parse(readFileSync(resolve(REPO_ROOT, process.env.CHECK_API_DEPRECATIONS), 'utf8'))
      : (await jiti.import(fileURLToPath(new URL('../src/contracts/deprecations.ts', import.meta.url)))).DEPRECATIONS;
  const surface = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  const text = renderApiReference({ surface, deprecations });
  if (process.argv.includes('--write')) {
    writeFileSync(API_REFERENCE_PATH, text);
    console.log(`docs/API参考.md 已再生（${text.length} 字符——查 8 守护对象）`);
  } else {
    process.stdout.write(text);
  }
}
