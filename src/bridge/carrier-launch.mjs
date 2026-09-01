/**
 * 载体域 TS 源形态引导器（刀四载体去 tsx 化——CI 首跑红根因①修面）。
 *
 * 背景：tsx 在 node 22 载体域双缺陷——①`--import=tsx` 的 module.register
 * 钩子在 worker_threads 内不生效（worker spawn 即 MODULE_NOT_FOUND）；
 * ②tsx 变换走 esbuild 子进程，被 external 域 PM 旗 `--permission`（无
 * --allow-child-process）直接拒杀。node ≥24.11 的 registerHooks 路线无此
 * 两问题（本机 24 绿/CI 22 红即版本差）。载体域改经本引导器：纯 JS 零依赖
 * ——注册自写 `.js→.ts` 兜底 resolve 钩子后动态 import 域入口（TS 源由
 * node ≥22.19 原生 type-strip 直载）。
 *
 * 两消费腿的传参协议（与 spawnWorkerDomain/spawnExternalDomain 对账）：
 * - worker 线程腿：workerData = { workerId, realmEntry }（realmEntry =
 *   域入口 .ts 文件 URL）；
 * - external fork 腿：process.argv[2] = 域 id（与 external-entry.ts 的
 *   argv[2] 协议位一致——引导器 transparent，域代码零改动）、argv[3] =
 *   域入口路径。
 *
 * 编译产物形态（dist .js）不经本文件——spawn 侧按入口尾缀判形态直载。
 * 本文件不静态 import 任何 TS（bootstrap.ts 也只经 URL 字符串引用本文件，
 * 无静态 import 边）——tsc 编译面与 check-topology 边表均不涉及。
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { workerData } from 'node:worker_threads';

// 兜底 resolve 钩子（独立文件：module.register 需模块路径，不能是内联函数）
register('./carrier-resolve.mjs', import.meta.url);

// 域入口定位：worker 腿走 workerData.realmEntry；external 腿走 argv[3]
// （argv[2] 是域 id——external-entry.ts 的协议位，透传不改写）
const realmEntry =
  workerData !== undefined && workerData !== null && workerData.realmEntry !== undefined
    ? workerData.realmEntry
    : process.argv[3] !== undefined
      ? pathToFileURL(process.argv[3]).href
      : undefined;

if (realmEntry === undefined) {
  // 引导器被直接误起（无 workerData.realmEntry 也无 argv[3]）——fail-loud
  process.stderr.write('carrier-launch: 缺域入口参数（workerData.realmEntry 或 argv[3]）\n');
  process.exit(1);
}

// 动态 import 域入口：TS 源经原生 type-strip 直载 + 兜底钩子改写 .js 指示符
await import(realmEntry);
