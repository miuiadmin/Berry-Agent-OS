#!/usr/bin/env node
/**
 * 测试计数锚（全面复盘 20260902 G-3④）：vitest 汇总行对四语 README 下限宣称。
 *
 * 背景：README 四语的「2,700+ 测试」是纯人工维护的宣称面——测试数缩水（批量
 * 删测/测试轨解绑）时四门禁全绿、宣称静默失真。本锚把它接进 CI：`npm test`
 * 输出 tee 留档，本器提取汇总行 passed 数对照四语下限。
 *
 * 红条件三面：①四语任一解析失败（宣称面写法漂移 fail-loud）②四语下限互不一致
 * （改一处漏三处）③实测 passed < 下限（宣称失真）。日志缺汇总行同样红。
 *
 * 形态注记：千分位随语（zh/en `2,700+`、es `2.700+`、fr `2 700+`），解析时
 * 剥分隔符取整数；根 = CHECK_ROOT（测试夹具注入）缺省仓库根；日志路径 =
 * argv[2]，缺席读 stdin。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

/** 仓库根（本文件在 tools/ 下；CHECK_ROOT 优先——负例测试夹具注入用） */
const ROOT = process.env.CHECK_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');

/** 四语 README 面（下限宣称所在——缺席/无宣称即红，防宣称面静默拆掉） */
const READMES = ['README.md', 'README.en.md', 'README.es.md', 'README.fr.md'];

/** 下限宣称提取：`**2,700+** tests` / `**2.700+** pruebas` / `**2 700+** tests` /
 *  `**2,700+** 测试`——数字带随语千分位分隔符，后随 24 字内语侧计数词 */
const CLAIM_RE = /\*\*(\d[\d.,\s\u00a0\u202f]*)\+\*\*[^·\n]{0,24}?(?:tests|pruebas|测试)/i;

/** 剥千分位分隔符（逗号/点/空格/narrow space）取整数下限 */
const parseFloor = (raw) => {
  const digits = raw.replace(/[.,\s\u00a0\u202f]/g, '');
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

/* ---------- 主流程：读日志 → 提实测 → 读四语 → 三面红对照 ---------- */

const logPath = process.argv[2];
// 原始日志先剥 ANSI 色码再进正则：CI 形态下 chalk 检 CI=true/GITHUB_ACTIONS
// 强制色档，tee 留档日志的汇总行带 ESC 序列（`Tests ^[[22m^[[32m2600 passed`），
// 不剥码则「Tests␣␣数字」正则断在色码上、整锚误报零汇总行（公开仓 CI 三连红
// 实证，run 33660838131）——本地直跑无色码、剥离为无操作，两形态同构
const rawLog = logPath !== undefined ? readFileSync(logPath, 'utf8') : readFileSync(0, 'utf8');
const log = rawLog.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

// vitest 汇总行形态：`      Tests  2883 passed (2883)`（多段时取最后一段 =
// 终局总表——失败混排形 `3 failed | 2882 passed` 取 passed 位不变义）
const testsLines = [...log.matchAll(/^[^\S\n]*Tests[^\S\n]+(\d+) passed/gm)];
if (testsLines.length === 0) {
  console.error('check-test-count ✖ 日志零「Tests  N passed」汇总行——非 npm test 输出或格式漂移');
  process.exit(1);
}
const actual = Number(testsLines.at(-1)[1]);

const floors = [];
for (const rel of READMES) {
  const m = CLAIM_RE.exec(readFileSync(join(ROOT, rel), 'utf8'));
  const floor = m === null ? undefined : parseFloor(m[1]);
  if (floor === undefined) {
    console.error(`check-test-count ✖ ${rel} 测试计数下限宣称解析失败——宣称面漂移（写法改形须同步改锚正则）`);
    process.exit(1);
  }
  floors.push(floor);
}
if (new Set(floors).size !== 1) {
  console.error(`check-test-count ✖ 四语下限互不一致：${floors.join(' / ')}——改一处漏三处`);
  process.exit(1);
}
const floor = floors[0];
if (actual < floor) {
  console.error(`check-test-count ✖ 实测 ${actual} < README 下限 ${floor}——宣称失真（缩测须同笔滚四语计数）`);
  process.exit(1);
}
console.log(`check-test-count ✓ 实测 ${actual} ≥ README 四语下限 ${floor}（余量 +${actual - floor}）`);
