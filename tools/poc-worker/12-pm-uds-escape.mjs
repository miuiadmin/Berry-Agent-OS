#!/usr/bin/env node
/**
 * PoC ⑫（第三十七批 PoC 台账·补炮八）：UDS bind 逃逸负向炮（CVE-2026-21711 同型）。
 *
 * d37 研究判词：PM 的 fs 白名单语义是「路径访问管辖」——但 Unix Domain Socket
 * 的 bind() 创建 socket 文件这条路径若不受 --allow-fs-write 管辖，则沙箱内应用
 * 可在白名单外的目录落 socket 文件 =「PM 只能当中层」的实证。
 *
 * 本炮两跑对照（写白名单只给 allowedDir）：
 *   跑 A（逃逸面）：PM 子在 outsideDir（白名单外）bind UDS + 同目录普通文件写
 *     作隔离变量对照——若 bind 成而普通写拒 = PM 对 UDS bind 不设防（逃逸实证，
 *     负向结论记档）；若 bind 也拒 = PM 已管住（结论反转，同样记档）；
 *   跑 B（正常面）：白名单内 bind + 客户端连通（正路可用性复证）。
 * 无论 A 走向哪边都是有效结论——本炮判定的对象是「PM 的真实边界在哪」。
 * 退出码：0 = 跑齐并记档，1 = 探测面没跑齐（脚本自身故障）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const childPath = fileURLToPath(new URL('./12-pm-uds-escape.child.mjs', import.meta.url));

// 30 秒硬超时
const timer = setTimeout(() => {
  console.error('FAIL: PoC 超时（30s）');
  process.exit(1);
}, 30_000);
timer.unref();

// 场景：allowed（写白名单内）/ outside（写白名单外）——realpath 归一（darwin symlink 坑，⑧ 同款）
const stageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'poc12-uds-')));
const allowedDir = join(stageRoot, 'allowed');
const outsideDir = join(stageRoot, 'outside');
mkdirSync(allowedDir);
mkdirSync(outsideDir);

/** 跑一发 PM 子：写白名单只给 allowedDir，读面全开（隔离变量——只考写管辖） */
function runPmChild(args) {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      ['--permission', '--allow-fs-read=*', `--allow-fs-write=${allowedDir}`, childPath, ...args],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.on('close', () => resolve(out));
  });
}

// 跑 A：白名单外 bind UDS + 同目录普通写对照
const outA = await runPmChild(['escape', outsideDir]);
const reportA = JSON.parse(
  outA
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .at(-1),
);
// escape 场景三探测：bindOutside（socket 文件落在白名单外目录）+ plainWriteOutside（隔离变量）
const bindEscaped = reportA.bindOutside === 'bound';
const plainWriteDenied = reportA.plainWriteOutside?.code === 'ERR_ACCESS_DENIED';
console.log(
  `[跑 A·白名单外] UDS bind=${reportA.bindOutside}(${reportA.bindOutsideErr ?? '-'}) 普通写=${reportA.plainWriteOutside?.code} → ${bindEscaped && plainWriteDenied ? '逃逸实证：PM 对 UDS bind 不设防（同目录普通写拒、bind 通）' : bindEscaped ? 'bind 通但普通写也通（白名单整体失效——脚本环境异常）' : 'PM 已管住 bind（ERR_ACCESS_DENIED 族）——结论反转记档'}`,
);

// 跑 B：白名单内 bind + 客户端连通
const outB = await runPmChild(['normal', allowedDir]);
const reportB = JSON.parse(
  outB
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .at(-1),
);
const normalOk = reportB.bindInside === 'bound' && reportB.connectEcho === 'echo-ok';
console.log(
  `[跑 B·白名单内] UDS bind=${reportB.bindInside} 客户端回环=${reportB.connectEcho} → ${normalOk ? 'PASS' : 'FAIL'}`,
);

clearTimeout(timer);
rmSync(stageRoot, { recursive: true, force: true });

// 跑 B 是正路必须过；跑 A 两走向都是有效记档（结论方向写进输出行）
console.log(
  normalOk
    ? '== PoC ⑫ 结论: 跑齐（跑 A 边界走向见上行记档；跑 B 正路 PASS）=='
    : '== PoC ⑫ 结论: FAIL（正路 bind/连通异常）==',
);
process.exit(normalOk ? 0 : 1);
