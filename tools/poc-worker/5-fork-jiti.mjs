#!/usr/bin/env node
/**
 * PoC ⑤（第三十七批 PoC 台账·补炮一）：jiti 能否在 fork 子进程内装载 TS 应用。
 *
 * worker 批 ①已证 jiti-in-worker；external carrier 用 fork 腿（per-行域进程墙），
 * 同命题须在 fork 域重证——fork 与 worker 是两套 realm 机制（V8 isolate+libuv
 * 进程 vs isolate 同进程），装载器可用性不可互推。
 *
 * 流程与 ① 同构两段：fork 子进程内自建 jiti（moduleCache:false）装载 TS 金样
 * 应用 → 回传；改写应用文件后同实例再 import，验证 /reload 重载语义在 fork 域成立。
 * 退出码：0 = PASS，1 = FAIL。
 */
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 临时应用目录（realpath 归一——macOS /var→/private/var 符号链接） */
const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'poc-fork-jiti-')));
const appPath = join(dir, 'hello.ts');

/** 金样应用 v1（与 ① 同款形状：named name + default apply） */
writeFileSync(
  appPath,
  `/** 金样应用 v1 */\nexport const name = 'hello';\nexport default function apply() { return 'applied:v1'; }\n`,
);

// 30 秒硬超时：挂死本身就是失败信号（fork 内 jiti 死锁 = 证伪形态之一）
const timer = setTimeout(() => {
  console.error('FAIL: PoC 超时（30s）——fork 内 jiti 疑似挂死');
  process.exit(1);
}, 30_000);
timer.unref();

const child = fork(new URL('./5-fork-jiti.child.mjs', import.meta.url), [], { cwd: dir });
let fail = false;
let stage2Sent = false;

child.on('message', (m) => {
  if (m.stage === 'load1') {
    const ok = m.name === 'hello' && m.applied === 'applied:v1';
    console.log(`[阶段一] fork 内 jiti 装载 TS 应用: name=${m.name} apply()=${m.applied} → ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) fail = true;
    // 第二段：改写应用文件——moduleCache:false 的重载语义（/reload 基底）在 fork 域验证
    writeFileSync(
      appPath,
      `/** 金样应用 v2（改写后） */\nexport const name = 'hello';\nexport default function apply() { return 'applied:v2'; }\n`,
    );
    child.send({ cmd: 'reimport', appPath });
    stage2Sent = true;
  } else if (m.stage === 'load2') {
    const ok = m.applied === 'applied:v2';
    console.log(`[阶段二] 改写后同实例重载（moduleCache:false）: apply()=${m.applied} → ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) fail = true;
    child.send({ cmd: 'exit' });
  }
});

child.on('error', (e) => {
  console.error('FAIL: fork 子进程抛错——', e.message);
  fail = true;
  finish();
});

child.on('exit', (code) => {
  if (stage2Sent && code !== 0) {
    console.error(`FAIL: 子进程异常退出（code=${code}）`);
    fail = true;
  }
  finish();
});

function finish() {
  clearTimeout(timer);
  rmSync(dir, { recursive: true, force: true });
  console.log(fail ? '== PoC ⑤ 结论: FAIL（jiti-in-fork 证伪）==' : '== PoC ⑤ 结论: PASS（jiti-in-fork 成立）==');
  process.exit(fail ? 1 : 0);
}

child.send({ cmd: 'load', appPath });
