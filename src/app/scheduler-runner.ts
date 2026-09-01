/**
 * L5 app — tick runner 组装（spawn 组装上提组合根——内核边界篇 §4.1 席 13
 * 冷读 #2 裁决，exec「tools 不 import exec」先例同构：scheduler 件经闭包
 * 收 `runJob(prompt)`，结构上不见 exec，边表无 L3→L4 逆向边）。
 *
 * 三件组装：
 * - **argv 公式**：`[execPath, ...execArgv, argv[1], 'run', '--read-only', prompt]`
 *   ——重放基座三律（遗漏大扫 20260901-d #6 勘正，规范席 13 同笔）：只取入口
 *   脚本 argv[1]（argv[2:] 宿主形态旗标剔净——tick 子进程是全新单发不是宿主
 *   续命）、execArgv 必须随行（tsx dev 形态 loader 挂在 execArgv，丢了即
 *   ERR_MODULE_NOT_FOUND——host-sandbox/daemon 同款三形态统一先例）、基座含
 *   解释器 execPath（runArgv 消费全 argv 形态）。公式本体单源在
 *   tickRelaunchBaseArgv()（测试注入真实宿主形态 argv 即可单测）；
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
 * tick 重放宿主入口的基座 argv（遗漏大扫 20260901-d #6 修——规范席 13 勘正后
 * 公式的单源本体，scheduler-runner 与 tick-register 两消费面共用）：
 * `[argv[0], ...execArgv, argv[1]]`。三律：
 * ①只取入口脚本 argv[1]——argv[2:] 宿主形态旗标（--port 等）剔净不随行
 *  （重放进子进程必撞端口占用/旗标误读；tick 子进程是全新单发不是宿主续命）；
 * ②execArgv 必须随行——tsx dev 形态 loader（--require preflight +
 *   --import loader.mjs）挂在 execArgv，丢了裸 node 跑 .ts 源码即
 *   ERR_MODULE_NOT_FOUND（host-sandbox relaunchArgv / daemon spawn 同款
 *   三形态统一先例）；
 * ③基座含解释器 argv[0]——runArgv 消费全 argv 形态（argv[0] 即可执行）。
 * @param processArgv 宿主 process.argv（缺省真值——测试注入真实宿主形态）
 * @param execArgv 宿主 process.execArgv（缺省真值——测试注入 dev 形态 loader）
 */
export function tickRelaunchBaseArgv(
  processArgv: readonly string[] = process.argv,
  execArgv: readonly string[] = process.execArgv,
): string[] {
  return [processArgv[0]!, ...execArgv, processArgv[1]!];
}

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

/**
 * 宿主覆盖类变量（基建大扫 #29 拍板，内核与应用边界篇席 13）：tick 子进程
 * 同路 set 显式透传——有值才传、与凭证族同款不造空串。APP_MODEL 剥离会造
 * 「凭证到了模型没到」错配（宿主覆盖模型不达定时任务）；APP_BASH_PATH 丢
 * 则 bash 工具重走四级发现序（win32 显式覆盖失效）；APP_LOG_LEVEL 丢则
 * 轮账日志降级（宿主 debug 时子进程排障面缺）。APP_* 是禁运保留前缀，
 * 不在此显式列名的 APP_* 变量一律剥掉（不隐式扩面）。
 */
const HOST_OVERRIDE_ENV_NAMES: readonly string[] = ['APP_MODEL', 'APP_BASH_PATH', 'APP_LOG_LEVEL'];

/** runner 构造选项（argv/env 注入式——公式可单测） */
export interface TickRunnerOptions {
  /** 宿主 resolved 数据目录（子进程 APP_DATA_DIR——同一本账） */
  readonly dataDir: string;
  /** 宿主 resolved 库路径（子进程 APP_DB_PATH） */
  readonly dbPath: string;
  /** 基座 argv（缺省 tickRelaunchBaseArgv() = [execPath, ...execArgv, argv[1]]——测试注入宿主形态） */
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
  // 缺省基座 = 重放宿主入口三律公式（20260901-d #6 勘正——携 execArgv、只取入口脚本）
  const baseArgv = opts.baseArgv ?? tickRelaunchBaseArgv();
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
  // 宿主覆盖类同款循环（#29——有值才传不造空串；值来源纪律同凭证族）
  for (const name of HOST_OVERRIDE_ENV_NAMES) {
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
