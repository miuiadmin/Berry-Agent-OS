#!/usr/bin/env node
/**
 * PoC ②（第二十七批刀一可证伪项二）：typebox schema 对象跨 MessagePort 结构化克隆保真。
 *
 * 两个 realm 各自 import typebox（同物理包 = 跨 realm 双实例——正是「每 realm 单实例」
 * 约束要验证的形态）。方向一：worker 建的 schema postMessage 过界，主 realm 用自己的
 * typebox 实例 Value.Check 校验；方向二：主 realm 建的 schema 过界到 worker 校验。
 *
 * 判定：两方向的「合法值」都必须校验通过（克隆保真），「非法值」都必须被拒（校验力
 * 保留）——任一不成立 = 可证伪项②证伪 → 契约篇 §1.7 的「schema 对象过界」路径不成立，
 * worker 侧插件须退到「JSON 直传 schema 描述」形态。symbol 键存活数只记录不判死
 * （typebox 1.x 若纯 JSON 形则 symbol 本为零）。
 * 退出码：0 = PASS，1 = FAIL。
 */
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { Worker } from 'node:worker_threads';

// 主 realm 对照 schema（与 worker 侧同形状——跨 realm 双实例各自构造）
const localSchema = Type.Object({ name: Type.String(), age: Type.Optional(Type.Number()) });

const timer = setTimeout(() => {
  console.error('FAIL: PoC 超时（30s）');
  process.exit(1);
}, 30_000);
timer.unref();

const worker = new Worker(new URL('./2-typebox.worker.mjs', import.meta.url));
let fail = false;
let round = 0;

worker.on('message', (m) => {
  if (m.cmd === 'schema') {
    // 方向一：worker 造的 schema，主 realm 校验
    const ok = Value.Check(m.schema, { name: 'berry', age: 1 });
    const badAccepted = Value.Check(m.schema, { name: 42 }); // 非法值：name 应为 string
    console.log(
      `[方向一 worker→主] 合法值过=${ok} 非法值拒=${!badAccepted} symbol 键: ${m.symCount}（worker 侧）→ ${Object.getOwnPropertySymbols(m.schema).length}（克隆后）`,
    );
    if (!ok || badAccepted) fail = true;
    // 方向二：主 realm 造的 schema，worker 校验
    worker.postMessage({ cmd: 'check', schema: localSchema });
  } else if (m.cmd === 'check-result') {
    console.log(`[方向二 主→worker] 合法值过=${m.ok} 非法值拒=${!m.bad}`);
    if (!m.ok || m.bad) fail = true;
    round = 2;
    worker.terminate();
  }
});

worker.on('error', (e) => {
  console.error('FAIL: worker 抛错——', e.message);
  fail = true;
  worker.terminate();
});

worker.on('exit', () => {
  clearTimeout(timer);
  if (round === 2) {
    console.log(
      fail ? '== PoC ② 结论: FAIL（可证伪项②证伪）==' : '== PoC ② 结论: PASS（typebox 跨 MessagePort 克隆保真）==',
    );
  }
  process.exit(fail ? 1 : 0);
});

worker.postMessage({ cmd: 'schema' });
