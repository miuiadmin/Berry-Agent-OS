// 刀三探针：Node worker resourceLimits.maxOldGenerationSizeMb 超限死亡形态
// —— 观测锚⑤（内存超限事件）判据源实证：exit code / error 事件 / 可归因性
import { Worker } from 'node:worker_threads';

const src = `
const { parentPort } = require('node:worker_threads');
// 分配超过 maxOldGenerationSizeMb 的堆 → V8 强制 GC 循环/超限
const balls = [];
try {
  for (let i = 0; i < 200; i++) {
    balls.push(new Array(1024 * 1024).fill('x')); // 每球 ~8MB（compressed ptr 下 ~4-8MB）
    if (i % 10 === 0) parentPort.postMessage(['alive', i]);
  }
  parentPort.postMessage(['done', balls.length]);
} catch (e) {
  parentPort.postMessage(['caught', String(e)]);
}
`;

const w = new Worker(src, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 48 } });
const t0 = Date.now();
w.on('message', (m) => console.log('[message]', JSON.stringify(m)));
w.on('error', (e) => console.log('[error]', e.constructor.name, '|', String(e.message).slice(0, 200)));
w.on('exit', (code) => console.log('[exit] code =', code, '| elapsed', Date.now() - t0, 'ms'));
setTimeout(() => {
  console.log('[probe] 5s 到时仍未退——强制收尾');
  process.exit(0);
}, 5000);
