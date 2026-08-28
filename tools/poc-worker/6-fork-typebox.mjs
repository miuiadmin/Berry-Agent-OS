#!/usr/bin/env node
/**
 * PoC ⑥（第三十七批 PoC 台账·补炮二）：typebox schema 过 fork IPC channel 保真。
 *
 * worker 批 ②已证 schema 过 MessagePort 结构化克隆无损；fork 腿的通道是
 * nodejs IPC（process.send / process.on('message')）——同为 v8 结构化克隆
 * 实现但属另一代码路径（libuv pipe 载荷 vs MessagePort），须独立重证。
 *
 * 双向两股：fork 子进程构造 schema 过界给宿主校验（宿主用自己的 typebox 实例）；
 * 宿主构造过界给子进程校验。symbol 键存活数两侧清点——typebox 1.3.7 预期纯 JSON
 * 形零 symbol（② 的 worker 结论在 fork 域复核）。
 * 退出码：0 = PASS，1 = FAIL。
 */
import { fork } from 'node:child_process';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

// 30 秒硬超时
const timer = setTimeout(() => {
  console.error('FAIL: PoC 超时（30s）——fork IPC 疑似挂死');
  process.exit(1);
}, 30_000);
timer.unref();

const child = fork(new URL('./6-fork-typebox.child.mjs', import.meta.url));
let fail = false;
// 宿主侧观测：双向两股的判定结果
const seen = { childSchema: false, childCheck: false };

child.on('message', (m) => {
  if (m.cmd === 'schema') {
    // 方向一：子进程造的 schema 过界 → 宿主自己的实例 Value.Check
    const ok = Value.Check(m.schema, { name: 'berry', age: 1 });
    const bad = Value.Check(m.schema, { name: 42 });
    const symHere = Object.getOwnPropertySymbols(m.schema).length;
    const pass = ok && !bad && m.symCount === 0 && symHere === 0;
    console.log(
      `[方向一] 子→宿主 schema 校验: 合法过=${ok} 非法拒=${!bad} symbol(子侧=${m.symCount}/宿主侧=${symHere}) → ${pass ? 'PASS' : 'FAIL'}`,
    );
    if (!pass) fail = true;
    seen.childSchema = true;
    // 方向二：宿主构造 → 过界 → 子进程用自己的实例校验
    const hostSchema = Type.Object({ id: Type.String(), tags: Type.Array(Type.String()) });
    child.send({ cmd: 'check', schema: hostSchema, symCount: Object.getOwnPropertySymbols(hostSchema).length });
  } else if (m.cmd === 'check-result') {
    // 子侧 bad = 坏值过校验的结果（true = 坏值被接受 = 执法失效）——非法拒 = !bad
    const pass = m.ok && !m.bad && m.symCount === 0;
    console.log(
      `[方向二] 宿主→子 schema 校验: 合法过=${m.ok} 非法拒=${!m.bad} symbol(子侧接收后=${m.symCount}) → ${pass ? 'PASS' : 'FAIL'}`,
    );
    if (!pass) fail = true;
    seen.childCheck = true;
    child.send({ cmd: 'exit' });
  }
});

child.on('exit', (code) => {
  clearTimeout(timer);
  if (code !== 0) {
    console.error(`FAIL: 子进程异常退出（code=${code}）`);
    fail = true;
  }
  if (!seen.childSchema || !seen.childCheck) {
    console.error('FAIL: 双向两股未跑齐（IPC 消息面不完整）');
    fail = true;
  }
  console.log(
    fail ? '== PoC ⑥ 结论: FAIL（typebox 过 fork channel 证伪）==' : '== PoC ⑥ 结论: PASS（schema 过 fork IPC 无损）==',
  );
  process.exit(fail ? 1 : 0);
});

child.on('error', (e) => {
  console.error('FAIL: fork 抛错——', e.message);
  process.exit(1);
});

// 开场指令：让子进程先构造 schema 过界（方向一）
child.send({ cmd: 'schema' });
