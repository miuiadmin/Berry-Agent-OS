/**
 * L5 app — tick runner 组装（spawn 组装上提组合根——内核边界篇 §4.1 席 13
 * 冷读 #2 裁决，exec「tools 不 import exec」先例同构：scheduler 件经闭包
 * 收 `runJob(prompt)`，结构上不见 exec，边表无 L3→L4 逆向边）。
 *
 * 三件组装：
 * - **argv 公式**：`[execPath, ...process.argv.slice(1), 'run', '--read-only', prompt]`
 *   ——宿主即主入口进程假设：dev（tsx）形态 argv[1] = tsx cli、装包（dist）
 *   形态 argv[1] = main.js，两种形态下重放宿主入口 + 子命令都恰好成立
 *  （测试注入假 argv 即可单测公式）；
 * - **env**：buildChildEnv 白名单 + set 显式注入——数据目录定位两变量
 *  （APP_DATA_DIR/APP_DB_PATH 宿主 resolved 值，子进程落同一本账）+ 模型
 *   凭证族（宿主自身 berry 入口 = 同信任域，宿主 env 有值才传；值不回显
 *   不落日志）；
 * - **超时**：缺省 10 分钟（模型流挂死护栏——bash 件 600s 钳制同数级）。
 */

import { runArgv, buildChildEnv, type CommandProcessLog } from '../exec/index.js';
import type { RunResult } from '../exec/index.js';

/** tick 单发缺省超时（毫秒）——一轮对话的宽松预算，到点树杀 */
export const TICK_TIMEOUT_MS = 10 * 60_000;

/**
 * 凭证族显式传递名单（宿主 env 有值才传——同信任域子进程的模型凭证）。
 * env.ts 禁运纪律挡的是 inherit 名单走私；set 显式值是正路（执法面①的
 * 值来源纪律由本调用方满足：值只从宿主 env 读、不回显不落日志）。
 */
const CREDENTIAL_ENV_NAMES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
];

/** runner 构造选项（argv/env 注入式——公式可单测） */
export interface TickRunnerOptions {
  /** 宿主 resolved 数据目录（子进程 APP_DATA_DIR——同一本账） */
  readonly dataDir: string;
  /** 宿主 resolved 库路径（子进程 APP_DB_PATH） */
  readonly dbPath: string;
  /** 基座 argv（缺省 [process.execPath, ...process.argv.slice(1)]——测试注入假 argv） */
  readonly baseArgv?: readonly string[];
  /** 宿主 env（缺省 process.env——测试注入脚本身） */
  readonly env?: NodeJS.ProcessEnv;
  /** 超时毫秒（缺省 TICK_TIMEOUT_MS） */
  readonly timeoutMs?: number;
  /** 命令进程登记簿（契约篇 §6.6 exec 腿——tick 子进程 = 长命模型循环，宿主猝死后最重孤儿形态） */
  readonly commandLog?: CommandProcessLog;
}

/**
 * 构造 tick 单发 runner：`(prompt) => Promise<RunResult>` 闭包。
 * env 在构造期合成一次（值固定）；每次调用只拼 argv 尾部（run --read-only prompt）。
 */
export function createTickRunner(opts: TickRunnerOptions): (prompt: string) => Promise<RunResult> {
  const baseArgv = opts.baseArgv ?? [process.execPath, ...process.argv.slice(1)];
  // set 显式值：数据目录定位 + 凭证族（宿主 env 有值才传——无值跳过，不造空串）
  const set: Record<string, string> = {
    APP_DATA_DIR: opts.dataDir,
    APP_DB_PATH: opts.dbPath,
  };
  const hostEnv = opts.env ?? process.env;
  for (const name of CREDENTIAL_ENV_NAMES) {
    const value = hostEnv[name];
    if (value !== undefined && value !== '') set[name] = value;
  }
  const env = buildChildEnv(hostEnv, { set });
  const timeoutMs = opts.timeoutMs ?? TICK_TIMEOUT_MS;
  // --background：tick 子进程的轮记账入后台道（席 13 第二刀 blocker 修——
  // canAfford 读 background 道，tick 烧的钱必须进同一本账才被闸见）
  return (prompt: string) =>
    runArgv([...baseArgv, 'run', '--read-only', '--background', prompt], {
      env,
      timeoutMs,
      // 命令进程登记簿透传（宿主猝死孤儿治理——见 TickRunnerOptions.commandLog 注）
      ...(opts.commandLog !== undefined ? { commandLog: opts.commandLog } : {}),
    });
}
