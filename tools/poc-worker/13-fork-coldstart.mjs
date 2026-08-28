#!/usr/bin/env node
/**
 * PoC ⑬（第三十七批 PoC 台账·半炮）：宿主真实 RSS 下 fork 冷启实测。
 *
 * d37 研究引用 val.town 数据：14GB 父进程 fork 阻塞 ~300ms / 45MB 基线 94ms——
 * RSS 越大 fork 越慢（页表复制成本）。本半炮在本机（darwin / node v24）复测：
 *   组一：宿主基线 RSS 下连发 spawn（node -e 短命）量冷启耗时中位数；
 *   组二：故意驻留 256MB Buffer 抬高 RSS 后同法再量。
 * 判定：两组采集成功 + 数值方向记档即 PASS——本炮是数据采集非门槛断言
 * （darwin spawn 走 posix_spawn 路径，与 Linux fork() 成本模型不同，量级差异
 * 本身就是记档内容：external 域选型时「宿主胖瘦对子域冷启的影响」由此校准）。
 * 退出码：0 = 采集跑齐，1 = 采集面故障。
 */
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/** 量一发 spawn 冷启耗时（ms）：从 spawn 到 close 的墙钟 */
function once() {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const p = spawn(process.execPath, ['-e', 'process.exit(0)']);
    p.on('error', reject);
    p.on('close', () => resolve(performance.now() - t0));
  });
}

/** 采一组：预热 2 发（页缓存/首次 JIT 摊掉）+ 正式 5 发取中位数 */
async function sample() {
  for (let i = 0; i < 2; i++) await once();
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await once());
  runs.sort((a, b) => a - b);
  return { median: runs[2], all: runs.map((r) => Math.round(r)) };
}

// 组一：基线 RSS
const rss0 = process.memoryUsage().rss / 1024 / 1024;
const g1 = await sample();
console.log(`[组一·基线] 宿主RSS=${rss0.toFixed(0)}MB 冷启中位=${g1.median.toFixed(1)}ms（5 发：[${g1.all}]）`);

// 组二：驻留 256MB 再量（不释放——撑住 RSS 直到采样完）
const ballast = Buffer.alloc(256 * 1024 * 1024, 1);
const rss1 = process.memoryUsage().rss / 1024 / 1024;
const g2 = await sample();
console.log(`[组二·+256MB] 宿主RSS=${rss1.toFixed(0)}MB 冷启中位=${g2.median.toFixed(1)}ms（5 发：[${g2.all}]）`);
// 防优化性消除：读一个字节让 ballast 真正被触碰过（alloc 已 zero-fill/填充，此处显式引用）
if (ballast[0] === -1) console.error('（不会走到——防消除引用）');

const ok = g1.median > 0 && g2.median > 0 && Number.isFinite(g1.median) && Number.isFinite(g2.median);
console.log(
  `== PoC ⑬ 结论: ${ok ? '采集跑齐（增量 Δ=' + (g2.median - g1.median).toFixed(1) + 'ms——方向与量级记档：darwin posix_spawn 路径下 RSS 影响待与 Linux fork 对照）' : 'FAIL（采集面故障）'} ==`,
);
process.exit(ok ? 0 : 1);
