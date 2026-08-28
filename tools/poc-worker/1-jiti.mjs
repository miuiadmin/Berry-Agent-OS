#!/usr/bin/env node
/**
 * PoC ①（第二十七批刀一可证伪项一）：jiti 能否在 worker_threads 内装载 TS 应用。
 *
 * 流程：主线程建临时 hello.ts 应用 → worker 内自建 jiti 实例（moduleCache:false）
 * 装载并调用 → 回传结果；第二段改写应用文件后同实例再 import，验证 /reload 语义
 * （moduleCache:false = 改动可重载）在 worker 域成立。
 *
 * 判定：任一段失败 = 可证伪项①证伪 → 按契约篇 §1.7 回拍板桌重选路线。
 * 退出码：0 = PASS，1 = FAIL。
 */
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

/** 临时应用目录（realpath 归一——macOS /var→/private/var 符号链接） */
const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'poc-jiti-')));
const appPath = join(dir, 'hello.ts');

/** 金样应用 v1：default 导出 apply 函数 + named 导出 name（装载器形状校验的最小面） */
writeFileSync(
  appPath,
  `/** 金样应用 v1 */\nexport const name = 'hello';\nexport default function apply() { return 'applied:v1'; }\n`,
);

// 30 秒硬超时：PoC 挂死本身就是失败信号（worker 内 jiti 死锁 = 证伪形态之一）
const timer = setTimeout(() => {
  console.error('FAIL: PoC 超时（30s）——worker 内 jiti 疑似挂死');
  process.exit(1);
}, 30_000);
timer.unref();

const worker = new Worker(new URL('./1-jiti.worker.mjs', import.meta.url));
let fail = false;

worker.on('message', (m) => {
  if (m.stage === 'load1') {
    const ok = m.name === 'hello' && m.applied === 'applied:v1';
    console.log(`[阶段一] worker 内 jiti 装载 TS 应用: name=${m.name} apply()=${m.applied} → ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) fail = true;
    // 第二段：改写应用文件，验证 moduleCache:false 的重载语义（/reload 基底）在 worker 成立
    writeFileSync(
      appPath,
      `/** 金样应用 v2（改写后） */\nexport const name = 'hello';\nexport default function apply() { return 'applied:v2'; }\n`,
    );
    worker.postMessage({ cmd: 'reimport', appPath });
  } else if (m.stage === 'load2') {
    const ok = m.applied === 'applied:v2';
    console.log(`[阶段二] 改写后同实例重载（moduleCache:false）: apply()=${m.applied} → ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) fail = true;
    worker.terminate();
  }
});

worker.on('error', (e) => {
  console.error('FAIL: worker 抛错——', e.message);
  worker.terminate();
  fail = true;
  finish();
});

worker.on('exit', () => finish());

function finish() {
  clearTimeout(timer);
  rmSync(dir, { recursive: true, force: true });
  console.log(fail ? '== PoC ① 结论: FAIL（可证伪项①证伪）==' : '== PoC ① 结论: PASS（jiti-in-worker 成立）==');
  process.exit(fail ? 1 : 0);
}

worker.postMessage({ cmd: 'load', appPath });
