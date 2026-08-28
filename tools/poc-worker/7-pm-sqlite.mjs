#!/usr/bin/env node
/**
 * PoC ⑦（第三十七批 PoC 台账·补炮三）：better-sqlite3 在 Permission Model 下的禁令面。
 *
 * d37 研究判词：PM 只能当中层——native addon 是 PM 的独立管辖（--allow-addons），
 * 管辖不开即拒。本炮两跑对照实证：
 *   跑 A（禁令面）：--permission + --allow-fs-read=*（放行读面隔离变量）但不给
 *     --allow-addons → require('better-sqlite3') 应以 addon 禁令拒（非静默）；
 *   跑 B（开闸面）：同上 + --allow-addons → native 库装载、建表读写正常。
 *
 * 判定：A 拒得响亮（错误码落在 addon 管辖）且 B 全通 = PASS——「PM 下 better-sqlite3
 * 走 --allow-addons 管辖不开即拒」成立，external 域缺省（不开 addons）下应用自带
 * native 依赖即拒装，机制与预期一致。
 * 退出码：0 = PASS，1 = FAIL。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 子脚本绝对路径（PM 沙箱内跑的 probe） */
const childPath = fileURLToPath(new URL('./7-pm-sqlite.child.mjs', import.meta.url));

// 30 秒硬超时
const timer = setTimeout(() => {
  console.error('FAIL: PoC 超时（30s）');
  process.exit(1);
}, 30_000);
timer.unref();

/**
 * 跑一发 PM 沙箱子进程，收齐 stdout（probe 以 JSON 行回报）。
 * @param {string[]} extraFlags 附加 execArgv（如 --allow-addons）
 */
function runUnderPm(extraFlags) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--permission', '--allow-fs-read=*', ...extraFlags, childPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', (c) => (err += c));
    proc.on('close', (code) => resolve({ code, out, err }));
  });
}

const runA = await runUnderPm([]);
const runB = await runUnderPm(['--allow-addons']);

clearTimeout(timer);

let fail = false;

/* ---- 跑 A：禁令面（无 --allow-addons）---- */
{
  // probe 自身 try/catch 后以 JSON 行回报（错误码是判定对象——不是进程崩）
  const report = runA.out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
    .at(-1);
  // 兜底：若 probe 直接崩（顶层抛错），从 stderr 抓 addon 禁令签名
  const denied =
    (report && report.loaded === false) || runA.err.includes('ERR_DLOPEN_DISABLED') || /allow-addons/i.test(runA.err);
  const codeSeen = report?.errCode ?? runA.err.match(/Error \[([A-Z_]+)\]/)?.[1] ?? '(进程层)';
  console.log(
    `[跑 A] 无 --allow-addons: 拒载=${denied ? '是' : '否'} 错误码=${codeSeen} → ${denied ? 'PASS' : 'FAIL'}`,
  );
  if (!denied) {
    fail = true;
    console.error('  （stderr 摘要）', runA.err.split('\n').slice(0, 4).join(' | '));
  }
}

/* ---- 跑 B：开闸面（--allow-addons）---- */
{
  const report = runB.out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
    .at(-1);
  const ok = report?.loaded === true && report?.roundTrip === 'row-1';
  console.log(
    `[跑 B] 带 --allow-addons: 装载=${report?.loaded} 读写回读=${report?.roundTrip} → ${ok ? 'PASS' : 'FAIL'}`,
  );
  if (!ok) {
    fail = true;
    console.error('  （stderr 摘要）', runB.err.split('\n').slice(0, 4).join(' | '));
  }
}

console.log(
  fail
    ? '== PoC ⑦ 结论: FAIL（PM addon 管辖与预期不符）=='
    : '== PoC ⑦ 结论: PASS（PM 下 addon 管辖不开即拒、开闸即通）==',
);
process.exit(fail ? 1 : 0);
