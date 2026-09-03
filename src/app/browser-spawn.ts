/**
 * browser 引擎裸 spawn 组装（组合根——契约篇 §6.10 引擎生命周期段 M1 裁决，
 * 2026-08-31 第四十九批刀一）。
 *
 * exec 件的 runArgv 是 run-to-completion 语义（等退出、收 stdout、60KiB
 * 保尾）——对长命浏览器引擎不适用（启动即返回、引擎活到闲置回收）。本闭包
 * 只复用 exec 两原语：
 * - `buildChildEnv`：env 白名单 deny-by-default（引擎子进程不见宿主凭证族）；
 * - `killTree`（engine.ts 消费侧注入）：负 pid 进程组树杀。
 *
 * 物理载体 = `child_process.spawn` detached（引擎自成进程组领导——killTree
 * 负 pid 语义的前提；stdio ignore：引擎日志不进宿主管道，诊断走 CDP 面）。
 */

import { spawn } from 'node:child_process';
import { buildChildEnv } from '../exec/env.js';
import type { EngineChild } from '../browser/index.js';

/**
 * 引擎 spawn 闭包（builtin-deps 组装 browserDeps 时消费）。
 * 同步返回（spawn 即回）——就绪等待（DevToolsActivePort 轮询）在 engine.ts。
 */
export function spawnEngineProcess(opts: { command: string; args: readonly string[] }): EngineChild {
  const child = spawn(opts.command, opts.args, {
    detached: true, // 组领导——killTree(-pid) 整组终结的前提
    stdio: 'ignore', // 引擎日志不收（CDP 面是诊断真相；管道不持活宿主）
    env: buildChildEnv(process.env), // 白名单透传——凭证族不出宿主
  });
  // 异步送达的 spawn 失败腿吸收（遗漏大扫 20260904 #1，契约篇 §6.10 ⑧）：
  // ENOENT/EACCES 类失败（发现序过检后的 TOCTOU 窗内同样可达）Node 在 child
  // 上**异步**发 'error' 事件（无进程即无 exit 事件）——不挂监听则 unhandled
  // 'error' = uncaughtException 直接杀宿主（六入口无一幸免）。失败的可观察性
  // 由返回的 pid === undefined 承担（启动等待超帽走 BROWSER_CONNECT_FAILED
  // 干净失败路），不靠进程崩溃；空监听即吸收（错误本身不入日志面——pid 缺席
  // 已是消费面的完整信号）
  child.on('error', () => {});
  // 引擎进程活探测（killTree 竞态判据——exitCode === null 即活）
  const alive = (): boolean => child.exitCode === null && child.signalCode === null;
  // 子进程引用脱钩（宿主不 wait 引擎退出——收场走树杀，防 zombie 也不归我们）
  child.unref();
  // pid 直返不产哨兵（全面复盘 20260903 #18，契约篇 §6.10 ⑧）：spawn 失败腿
  // （EACCES/ENOEXEC——无进程）child.pid 为 undefined，`?? -1` 代偿会被
  // killTree(-1) 归一成 process.kill(1) = 杀 init/自身（批 90 pid 哨兵毒化
  // 裁定的同律漏网）；undefined 判缺席交消费面早退（engine.ts 三处守门）
  return { pid: child.pid, alive };
}
