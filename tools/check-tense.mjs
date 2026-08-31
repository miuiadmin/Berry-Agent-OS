#!/usr/bin/env node
/**
 * 时态与词汇门禁（2026-08-30 规范全面审读批根因执法件——报告 §五：
 * 43 条 findings 中约 28 条属「时态纪律双向失守」与「收口面最后一公里」两族，
 * 本器把其中可机械化的一半钉死为机器断言，挂 lint:topology 链尾）。
 *
 * 三条规则（均为零误报前提设计——有正当豁免的显式注记，不静默）：
 *
 * 1. hash 存在性（抓「已落码 <hash>」写错/幻引）：
 *    - 扫描面（AGENTS/README/CONTRIBUTING/docs/01-规范/02-计划）提取 7-40 位
 *      纯十六进制词，必须是本仓某 commit hash 的 7-12 位前缀；
 *    - 纯数字候选跳过（yyyymmdd 日期 / 序号 / ID 域——与 git hash 空间重叠但
 *      文档中语义是数字而非 hash，机械排除）；
 *    - 显式豁免集（TENSE_HASH_EXEMPT）：外部仓库 commit 引用与示例字面量，
 *      逐条注记出处——同 check-events.mjs「显式豁免，不静默」体例；
 *    - 03-参考 不入本规则扫描面（外部仓库 commit 引用面，无法对照本仓）。
 *
 * 2. 完成时态 × 仓库路径存在性（抓「已兑现 `src/xx.ts`」抢跑或文件改名漂移）：
 *    - 行含存在类完成时态动词（已兑现|已落码|已收口|已落地|已实施）且非
 *      消失语境（已退役|已删|已废弃|已移除——「XX 已退役」引用不存在路径是
 *      正确陈述）时，校验该行 backtick 内的仓库相对路径真实存在；
 *    - 路径判定用白名单前缀法（src/ apps/ tools/ docs/）——设计文档/、
 *      参考源码/、~/ 等本地或仓库外路径不校验（clone 环境无这些目录，
 *      白名单保证门禁在任何环境同一结果）；
 *    - 扫描面 = 规则 1 同面（现行宣称面：AGENTS/README/CONTRIBUTING/
 *      docs/01-规范/02-计划）。03-参考 不入——报告是时点快照，写就时为真
 *      的路径记录不应被现行存在性追杀（首跑实证：2026-08-26 冷读报告的
 *      旧结构路径被误伤），语义层归冷读闸。
 *
 * 3. 退役词清零（D36「一切皆应用」词汇翻转的收口执法——审读 A2 实证三批
 *    同位置掉队，根因②的机器面）：
 *    - 现行公开面（AGENTS/README/CONTRIBUTING/docs）出现任一退役词即红；
 *    - 规范面（01-规范/02-计划）不查——规范正文有「原称插件」式历史勘正
 *      语境，词面机器查会误伤，语义层归冷读闸。
 *
 * 用法：node tools/check-tense.mjs（挂 npm run lint:topology 链尾）。
 * 设计文档/ 目录在 clone 环境不存在时对应扫描面静默跳过（本地有效）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* 扫描面                                                              */
/* ------------------------------------------------------------------ */

/** 仓库根级单文件（现行公开面——规则 1/2/3 全查）。
 * README 四语 glob 展开（README*.md——复盘 G-2：三外国语镜像与中文同查，
 * 新增语种文件自动纳管，无需手登记） */
const ROOT_FILES = [
  'AGENTS.md',
  ...readdirSync(ROOT)
    .filter((f) => /^README.*\.md$/.test(f))
    .sort(),
  'CONTRIBUTING.md',
];

/** 公开文档目录（现行——规则 1/2/3 全查） */
const DOCS_DIR = join(ROOT, 'docs');

/**
 * 设计文档目录（gitignored，本地存在才扫）：
 * - 01-规范 / 02-计划：规则 1、2（不含规则 3——历史勘正语境）；
 * - 03-参考：全豁免——时点快照报告面（规则 1 外部 hash 无法对照本仓；
 *   规则 2 历史真陈述不应被现行存在性追杀，首跑实证）。
 */
const SPEC_DIR = join(ROOT, '设计文档/01-规范');
const PLAN_DIR = join(ROOT, '设计文档/02-计划');
const ARCHIVE_DIR = join(ROOT, '设计文档/废弃'); // 全豁免——old-v2 历史快照（03-参考 同判，见头注）

/** 递归收集目录下全部 .md（存在性豁免：clone 环境无设计文档/ 时静默跳过） */
function collectMd(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (isDir(full)) out.push(...collectMd(full));
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** statSync 包装（目录判定——调用点已过 existsSync） */
function isDir(p) {
  return statSync(p).isDirectory();
}

/* ------------------------------------------------------------------ */
/* 规则 1：hash 存在性                                                  */
/* ------------------------------------------------------------------ */

/**
 * 显式豁免集——外部仓库 commit 与示例字面量（逐条注记出处，新增外部引用
 * 在此追加；非静默豁免，与 check-events.mjs 的 reserved 豁免同体例）：
 * - 0a1b2c3d：记忆篇标记格式「[m:8位十六进制]」示例字面量；
 * - 7fb0d8f：old-v2 mercury 域实证 commit（memory 篇历史引注）；
 * - 01a03051/01a03052/c49906ec/b150a55：路线图蓝本快照表——pi / dsh
 *   外部仓库 commit（参考源码/ 快照锚）。
 */
const TENSE_HASH_EXEMPT = new Set(['0a1b2c3d', '7fb0d8f', '01a03051', '01a03052', 'c49906ec', 'b150a55']);

/** 取本仓全部 commit hash 的 7-12 位前缀集（文档引用按前缀对照——短 hash 随仓库增长变长，7 位引用恒为某 hash 前缀） */
function collectHashPrefixes() {
  const full = execFileSync('git', ['log', '--all', '--format=%H'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
  const prefixes = new Set();
  for (const h of full) {
    for (let len = 7; len <= 12; len++) prefixes.add(h.slice(0, len));
  }
  return prefixes;
}

/** 规则 1 断言：hex 词 ∈ 本仓 hash 前缀集（纯数字与豁免集跳过） */
function checkHashes(files, prefixes) {
  const bad = [];
  let checked = 0;
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
        const word = m[0];
        if (/^[0-9]+$/.test(word)) continue; // 纯数字=日期/序号/ID 域，非 hash
        if (TENSE_HASH_EXEMPT.has(word)) continue; // 显式豁免（见注记）
        checked++;
        if (!prefixes.has(word)) {
          bad.push(`${rel(file)}:${i + 1} 非 hash 幻引「${word}」（不在本仓 commit 前缀集）`);
        }
      }
    });
  }
  return { bad, checked };
}

/* ------------------------------------------------------------------ */
/* 规则 2：完成时态 × 仓库路径存在性                                    */
/* ------------------------------------------------------------------ */

/** 存在类完成时态动词（宣称「码已在」——消失类「已退役/已删」语境排除） */
const PERFECTIVE_RE = /(已兑现|已落码|已收口|已落地|已实施)/;
/** 消失类语境（引用不存在路径是正确陈述，不触发校验） */
const GONE_RE = /(已退役|已删|已废弃|已移除)/;
/** 仓库相对路径白名单前缀（clone 环境恒在的目录——环境无差异） */
const PATH_EXT_RE = /\.(ts|mjs|cjs|js|yaml|yml|json|md|sql)$/;

/** 规则 2 断言：完成时态行内 backtick 仓库路径必须存在 */
function checkPaths(files) {
  const bad = [];
  let checked = 0;
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!PERFECTIVE_RE.test(line) || GONE_RE.test(line)) return;
      for (const m of line.matchAll(/`([^`]+)`/g)) {
        // 去掉 :669 式行号尾缀，再过白名单前缀 + 扩展名双闸
        const p = m[1].replace(/:\d+.*$/, '');
        const isRepoPath = /^(src|apps|tools|docs)\/[\w./-]+$/.test(p) && PATH_EXT_RE.test(p);
        if (!isRepoPath) continue;
        checked++;
        if (!existsSync(join(ROOT, p))) {
          bad.push(`${rel(file)}:${i + 1} 完成时态引用路径不存在「${p}」`);
        }
      }
    });
  }
  return { bad, checked };
}

/* ------------------------------------------------------------------ */
/* 规则 3：退役词清零（D36 词汇翻转执法面）                             */
/* ------------------------------------------------------------------ */

/**
 * 退役词表（D36「一切皆应用」2026-08-28 全仓翻转 + 装载批作用域词汇收束后的
 * 现行正名：应用（三类型：应用型/扩展型/服务型）、作用域两档（全局/应用）。
 * 词表只收「当前公开面计数为零」的词——收词前提即零误报）。
 */
const RETIRED_WORDS = ['插件', '母体', '系统组合', '应用组合', '挂载目标', '后台服务'];

/** 规则 3 断言：现行公开面退役词计数必须为零 */
function checkRetired(files) {
  const bad = [];
  let checked = 0;
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const w of RETIRED_WORDS) {
        checked++;
        if (line.includes(w)) {
          bad.push(`${rel(file)}:${i + 1} 退役词「${w}」（现行正名见 D36 词汇方案档）`);
        }
      }
    });
  }
  return { bad, checked };
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

/** 仓库相对路径（报错可点开） */
function rel(p) {
  return p.startsWith(ROOT + '/') ? p.slice(ROOT.length + 1) : p;
}

const rootFiles = ROOT_FILES.map((f) => join(ROOT, f)).filter(existsSync);
const docsFiles = collectMd(DOCS_DIR);
const specFiles = collectMd(SPEC_DIR);
const planFiles = collectMd(PLAN_DIR);
void ARCHIVE_DIR; // 废弃/ 全豁免——显式留名说明不扫

const rule1Files = [...rootFiles, ...docsFiles, ...specFiles, ...planFiles];
const rule2Files = rule1Files; // 同面——03-参考 全豁免（见头注规则 2）
const rule3Files = [...rootFiles, ...docsFiles];

const prefixes = collectHashPrefixes();
const r1 = checkHashes(rule1Files, prefixes);
const r2 = checkPaths(rule2Files);
const r3 = checkRetired(rule3Files);

const allBad = [...r1.bad, ...r2.bad, ...r3.bad];
for (const b of allBad) console.error('✗ ' + b);
console.log(
  `check-tense: hash ${r1.checked} 对照、时态路径 ${r2.checked} 对照、退役词 ${r3.checked} 行扫描` +
    `（面：现行宣称 ${rule1Files.length} / 公开 ${rule3Files.length} 文件）` +
    (allBad.length === 0 ? ' —— 绿' : ` —— 红 ${allBad.length} 条`),
);
process.exit(allBad.length === 0 ? 0 : 1);
