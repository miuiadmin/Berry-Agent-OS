#!/usr/bin/env node
/**
 * PoC ⑩（第三十七批 PoC 台账·补炮六）：NDJSON stdio 背压与大 payload。
 *
 * d37 研究判词：external 域与宿主的通信若走 spawn stdio（非 IPC channel），
 * NDJSON 行协议是通用形态——64KiB 会话护栏的「跨进程语义」须实证三件事：
 *   ① 大 payload：单行 1MiB JSON（远超 64KiB）过 pipe 完整无碎（sha256 对照）；
 *   ② 洪泛不丢行：连续 500 行带序号，父侧收齐无缺口无乱序（pipe 是字节流，
 *     行边界协议自扛，内核缓冲不吃行）；
 *   ③ 背压可观测：子侧 process.stdout.write() 在缓冲满时返 false——子不崩、
 *     暂停后全量仍到达（父子协同排水语义）。
 * 退出码：0 = PASS，1 = FAIL。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const childPath = fileURLToPath(new URL('./10-fork-ipc.child.mjs', import.meta.url));

// 30 秒硬超时
const timer = setTimeout(() => {
  console.error('FAIL: PoC 超时（30s）——stdio 洪泛疑似挂死');
  process.exit(1);
}, 30_000);
timer.unref();

// spawn 纯 stdio 形态（无 IPC 席位——NDJSON 是唯一通道，正合 external 域设想）
const child = spawn(process.execPath, [childPath], { stdio: ['pipe', 'pipe', 'inherit'] });

// 父侧逐行读子 stdout（readline 无行长上限——1MiB 单行可过）
const lines = createInterface({ input: child.stdout });
let fail = false;
const checks = { big: false, flood: false };

/** 发一条指令给子（stdin NDJSON） */
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');

// 三探测的完成回调汇总处（lines 'close' 时统一裁决）
const bigResult = { sentHash: null, recvHash: null, recvLen: 0 };
const floodResult = { seqs: [], done: null, backpressureHits: null };

lines.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return; // 大 payload 行单独处理（下面 big 分支）
  let m;
  try {
    m = JSON.parse(trimmed);
  } catch {
    return; // 非 JSON 行（理论不至）忽略
  }
  if (m.cmd === 'big') {
    // ① 大 payload：子回报 sha256 与行字节长——父自己重算对照
    bigResult.sentHash = m.hash;
    bigResult.recvHash = createHash('sha256').update(m.payload, 'utf8').digest('hex');
    bigResult.recvLen = Buffer.byteLength(m.payload, 'utf8');
    const pass = m.hash === bigResult.recvHash && bigResult.recvLen > 1024 * 1024;
    console.log(
      `[①大payload] 单行 ${Math.round(bigResult.recvLen / 1024)}KiB sha256 对照=${m.hash === bigResult.recvHash ? '一致' : '不一致'} → ${pass ? 'PASS' : 'FAIL'}`,
    );
    checks.big = pass;
    if (!pass) fail = true;
    // 接力下一探测
    send({ cmd: 'flood', n: 500 });
  } else if (m.cmd === 'flood-seq') {
    floodResult.seqs.push(m.seq);
  } else if (m.cmd === 'flood-done') {
    // ② 洪泛：序号 0..n-1 无缺口无乱序；③ 背压：子侧 write() false 次数 > 0 = 背压真实发生且未丢
    const n = m.n;
    const noGap = floodResult.seqs.length === n && floodResult.seqs.every((s, i) => s === i);
    checks.flood = noGap;
    console.log(
      `[②洪泛] ${n} 行收齐=${floodResult.seqs.length === n} 无缺口无乱序=${noGap} → ${noGap ? 'PASS' : 'FAIL'}`,
    );
    if (!noGap) fail = true;
    const bp = m.backpressureHits;
    console.log(
      `[③背压] 子侧 write() 返 false 次数=${bp}（>0 = 缓冲满真实发生）全量到达=${noGap} → ${bp > 0 && noGap ? 'PASS' : 'FAIL'}`,
    );
    if (!(bp > 0 && noGap)) fail = true;
    send({ cmd: 'exit' });
  }
});

child.on('exit', (code) => {
  clearTimeout(timer);
  if (code !== 0) {
    console.error(`FAIL: 子进程异常退出（code=${code}）`);
    fail = true;
  }
  if (!checks.big || !checks.flood) {
    console.error('FAIL: 探测未跑齐（stdio 消息面不完整）');
    fail = true;
  }
  console.log(
    fail
      ? '== PoC ⑩ 结论: FAIL（NDJSON stdio 跨进程语义证伪）=='
      : '== PoC ⑩ 结论: PASS（1MiB 单行无损 + 洪泛不丢行 + 背压可观测不崩）==',
  );
  process.exit(fail ? 1 : 0);
});

child.on('error', (e) => {
  console.error('FAIL: spawn 抛错——', e.message);
  process.exit(1);
});

// 开场：先跑大 payload
send({ cmd: 'big' });
