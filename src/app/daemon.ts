/**
 * L5 app — daemon 命令族与前台常驻（契约篇 §6.8 常驻执行体条·刀一，第三十八批）。
 *
 * 生命周期与客户端解耦的执行体宿主：TUI / Web SPA / curl 全为纯客户端，
 * daemon 进程内跑 createRuntime **同一装配入口**（零第二条装配路径），webui
 * 行随 daemon 形态常开回环面（缺省 7860）。状态半边（daemon.json/token/判活
 * 探针）在 daemon-state.ts（assembly 零环引用它——本文件引 createRuntime，
 * 两半分置消 ESM 环）。
 *
 * 命令族（技术栈篇 §5 四命令面）：
 * - `start`：spawn detached（stdio → daemon/daemon.log）+ **ready-gate**——
 *   须 token 端点真握手成功（GET /api/sessions 返 200）才 exit 0；health
 *   公开探活 {ok,version} 不构成活证（M4 两语义分立）；超时响亮非零杀子。
 * - `stop`：SIGTERM → 轮询确认消失（缺省 30s 预算）→ SIGKILL 兜底 → 清
 *   daemon.json（API shutdown 端点明确否决——stop 权 > submit 权）。
 * - `status`：读 daemon.json + 真握手披露（pid/port/持有会话/清单条数）。
 * - `doctor`（刀二）：七项体检——①pid 判活 ②health+真握手（顺手连一次
 *   /api/events 即关——503 = 连接帽满）③token 在场且 0600（**判活时只读
 *   禁 ensure 写**——防诊断面自造不符态）④库 readonly 可开 ⑤log 大小
 *   ⑥运行 vs 磁上版本 ⑦判死时端口占用探测；僵尸态（pid 活+HTTP 面无响应）
 *   入查。全绿 0 / 任一项红 1。
 * - `--foreground`：前台常驻（launchd/systemd 监视直接子进程的唯一正确
 *   形态——自 fork 会双实例循环）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { get as httpGet, request as httpRequest, type RequestOptions } from 'node:http';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AppError, DAEMON_START_TIMEOUT, DAEMON_STOP_TIMEOUT } from '../contracts/errors.js';
import { dataDir, dbPath } from './paths.js';
import { createRuntime } from './assembly.js';
import { installExitSignals } from './signals.js';
import { readAttachToken } from './attach-client.js';
import { VERSION } from './version.js';
import {
  acquireDaemonState,
  daemonDirOf,
  daemonTokenPath,
  defaultProcessProbe,
  ensureDaemonToken,
  isDaemonAlive,
  readDaemonState,
  releaseDaemonState,
  sweepStaleDaemonState,
  updateDaemonState,
  type DaemonState,
  type ProcessProbe,
} from './daemon-state.js';

/** daemon.log 文件名（后台形态 stdio 重定向目标） */
const LOG_FILE = 'daemon.log';

/** start ready-gate 预算（毫秒）——spawn 到真握手成功的上限，超时杀子响亮非零 */
export const DAEMON_START_GATE_BUDGET_MS = 30_000;
/** stop SIGTERM 后轮询预算（毫秒）——预算内未消失升格 SIGKILL */
export const DAEMON_STOP_BUDGET_MS = 30_000;
/** stop SIGKILL 后轮询预算（毫秒）——仍在 = D 状态/僵尸收养等罕见形态，人工介入出口 */
export const DAEMON_KILL_BUDGET_MS = 5_000;
/** 轮询节律（毫秒）——gate/stop 两循环共用 */
export const DAEMON_POLL_INTERVAL_MS = 250;
/** 单次握手探活的网络超时（毫秒）——status/stop 清场确认共用 */
const HANDSHAKE_TIMEOUT_MS = 2_000;

/** daemon.log 路径（后台形态 stdio 重定向目标） */
function daemonLogPath(dataRoot: string): string {
  return join(daemonDirOf(dataRoot), LOG_FILE);
}

/** 毫秒睡眠（循环节律——两命令面共用） */
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/* ------------------------------------------------------------------ */
/* 真握手探针（须 token 端点——health 公开探活不构成活证，M4）           */
/* ------------------------------------------------------------------ */

/**
 * 单次 HTTP GET 探活（node:http 零依赖形态；超时/连接失败 = undefined）。
 * ready-gate 与 status 的真握手共用：请求 **须 token 的端点**（GET
 * /api/sessions 带 Bearer）——200 才算「活」，401 = 进程在而 token 不符
 * （轮换竞窗），同样不算活证。
 */
export function httpProbe(
  urlStr: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<{ status: number; body: string } | undefined> {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const opts: RequestOptions = {
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { ...headers },
      timeout: timeoutMs,
    };
    const req = httpGet(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve(undefined));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.on('error', () => resolve(undefined));
  });
}

/**
 * 应答头即回探针（状态码单值）：SSE 等长流端点不会自然 end——httpProbe 会
 * 挂到超时，本探针取到状态码即断流收场（doctor ②「顺手连一次 /api/events
 * 即关」与裸 berry 检测共用）。
 */
export function probeStatus(
  urlStr: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const opts: RequestOptions = {
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { ...headers },
      timeout: timeoutMs,
    };
    const req = httpGet(opts, (res) => {
      const status = res.statusCode ?? 0;
      res.resume(); // 排干已到应答体（若有）
      res.destroy(); // 长流即断——本探针只取状态码
      resolve(status);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.on('error', () => resolve(undefined)); // destroy 后的迟到 error 幂等吸收
  });
}

/* ------------------------------------------------------------------ */
/* 裸 berry 检测（刀二——daemon 在跑时裸 berry 提示 attach，契约篇 §6.8） */
/* ------------------------------------------------------------------ */

/**
 * 检测本机是否有活 daemon（裸 `berry` 起屏前置）：daemon.json 在场时对其
 * port 发**真握手**（GET /api/sessions 带**只读** token，200 = 唯一正判）。
 * 文件不在 / 探败（stale、僵尸、token 缺失 401）= undefined——照常起进程内
 * 形态零副作用（不清 stale 文件、不 ensure token）。
 * @returns 正判时的 daemon 端口（提示面用）；undefined = 无活 daemon
 */
export async function detectDaemonHandshake(
  deps: { dataRoot?: string; probeStatus?: typeof probeStatus } = {},
): Promise<{ port: number } | undefined> {
  const dataRoot = deps.dataRoot ?? dataDir();
  const state = readDaemonState(dataRoot);
  if (state === undefined) return undefined;
  const token = readAttachToken(dataRoot);
  if (token === undefined) return undefined; // token 缺失——401 面，非活证
  const status = await (deps.probeStatus ?? probeStatus)(
    `http://127.0.0.1:${state.port}/api/sessions`,
    { authorization: `Bearer ${token}` },
    HANDSHAKE_TIMEOUT_MS,
  );
  return status === 200 ? { port: state.port } : undefined;
}

/* ------------------------------------------------------------------ */
/* 命令族（start / stop / status / doctor）——main.ts 分派消费           */
/* ------------------------------------------------------------------ */

/** 命令面依赖注入（测试假面：探针/spawn/取数闭包全可换） */
export interface DaemonCommandDeps {
  /** 进程身份探针（缺省平台探针） */
  readonly probe?: ProcessProbe;
  /** spawn 注入面（start 用——缺省 node:child_process.spawn） */
  readonly spawnFn?: (
    cmd: string,
    args: readonly string[],
    opts: { detached: boolean; stdio: unknown[]; env: NodeJS.ProcessEnv },
  ) => ChildProcess;
  /** HTTP 探活注入面（缺省 httpProbe——测试可控应答） */
  readonly probeHttp?: typeof httpProbe;
  /** 数据目录根（缺省 dataDir()——测试钉扎） */
  readonly dataRoot?: string;
  /** 自身 argv（start 构造子进程命令行用；缺省 process.argv） */
  readonly selfArgv?: readonly string[];
  /** node 解释器旗标（tsx dev 形态 loader 随行；缺省 process.execArgv） */
  readonly execArgv?: readonly string[];
  /** gate 预算覆盖（测试收短） */
  readonly startGateBudgetMs?: number;
  /** stop 预算覆盖（测试收短） */
  readonly stopBudgetMs?: number;
  /** 轮询间隔覆盖（测试收短） */
  readonly pollIntervalMs?: number;
}

/**
 * daemon 命令族主流程（`berry daemon <start|stop|status>`）。
 * @returns 进程退出码（start 失败经 AppError 抛出由入口顶层收口为 1）
 */
export async function daemonCommandMain(
  sub: 'start' | 'stop' | 'status',
  port: number,
  deps: DaemonCommandDeps = {},
): Promise<number> {
  const probe = deps.probe ?? defaultProcessProbe;
  const dataRoot = deps.dataRoot ?? dataDir();
  const pollMs = deps.pollIntervalMs ?? DAEMON_POLL_INTERVAL_MS;

  if (sub === 'start') {
    mkdirSync(daemonDirOf(dataRoot), { recursive: true });
    // M6 时点钉之一：O_EXCL 前先行清扫上一轮的判死残留（acquire 内还有二道自检）
    sweepStaleDaemonState(dataRoot, probe);
    // token 先于 spawn：父进程 gate 握手与子进程鉴权同一份（两进程各读同文件）
    const token = ensureDaemonToken(dataRoot);
    // stdio → daemon.log（append——多次 boot 的日志续尾不截断，排障面保全）
    const logFd = openSync(daemonLogPath(dataRoot), 'a');
    // 子进程命令行 = [node, ...execArgv（tsx loader 随行）, 脚本, daemon, --foreground, --port, N]
    //（与 host-sandbox relaunchArgv 同款三形态统一：node 直跑 / bin shim / tsx dev）
    const selfArgv = deps.selfArgv ?? process.argv;
    const execArgv = deps.execArgv ?? process.execArgv;
    const childArgs = [...execArgv, selfArgv[1]!, 'daemon', '--foreground', '--port', String(port)];
    const spawnFn = deps.spawnFn ?? spawn;
    const child = spawnFn(selfArgv[0]!, childArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    child.unref();
    closeSync(logFd);
    // ready-gate：须 token 端点真握手（GET /api/sessions 返 200）——health 探活
    // 不构成活证（M4）；子进程启动即退也在此响亮失败（带日志路径）
    const probeHttp = deps.probeHttp ?? httpProbe;
    const deadline = Date.now() + (deps.startGateBudgetMs ?? DAEMON_START_GATE_BUDGET_MS);
    for (;;) {
      if (child.exitCode !== null) {
        throw new AppError(
          DAEMON_START_TIMEOUT,
          `daemon 子进程启动即退（exit ${child.exitCode}）——日志见 ${daemonLogPath(dataRoot)}`,
        );
      }
      const res = await probeHttp(
        `http://127.0.0.1:${port}/api/sessions`,
        { authorization: `Bearer ${token}` },
        HANDSHAKE_TIMEOUT_MS,
      );
      if (res !== undefined && res.status === 200) break; // 真握手成立——活证
      if (Date.now() >= deadline) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退——无需杀 */
        }
        throw new AppError(
          DAEMON_START_TIMEOUT,
          `daemon 启动超时（${DAEMON_START_GATE_BUDGET_MS / 1000}s 内未达成真握手）——已杀子进程，` +
            `日志见 ${daemonLogPath(dataRoot)}（EADDRINUSE/端口冲突先 berry daemon status 查占用）`,
        );
      }
      await sleep(pollMs);
    }
    const pidHint = readDaemonState(dataRoot)?.pid ?? '未知';
    process.stdout.write(
      `daemon 就绪：pid ${pidHint}、http://127.0.0.1:${port}（token：${daemonTokenPath(dataRoot)}，日志：${daemonLogPath(dataRoot)}）\n`,
    );
    return 0;
  }

  if (sub === 'stop') {
    const state = readDaemonState(dataRoot);
    if (state === undefined) {
      process.stdout.write('daemon 未运行（无 daemon.json）\n');
      return 0; // 幂等成功——脚本面重复 stop 不是错误
    }
    if (!isDaemonAlive(state, probe)) {
      // 判死残留（SIGKILL 后未清/机器重启残留）——清扫即收场
      sweepStaleDaemonState(dataRoot, probe);
      process.stdout.write('daemon 已死亡，清理残留 daemon.json\n');
      return 0;
    }
    // 信号序：SIGTERM（优雅全序列）→ 轮询 → SIGKILL 兜底 → 清 daemon.json
    process.kill(state.pid, 'SIGTERM');
    const termDeadline = Date.now() + (deps.stopBudgetMs ?? DAEMON_STOP_BUDGET_MS);
    while (probe.startId(state.pid) === state.processStartId) {
      if (Date.now() >= termDeadline) break;
      await sleep(pollMs);
    }
    if (probe.startId(state.pid) !== state.processStartId) {
      releaseDaemonState(dataRoot, state);
      process.stdout.write(`daemon 已停止（pid ${state.pid}）\n`);
      return 0;
    }
    process.kill(state.pid, 'SIGKILL');
    const killDeadline = Date.now() + DAEMON_KILL_BUDGET_MS;
    while (probe.startId(state.pid) === state.processStartId) {
      if (Date.now() >= killDeadline) break;
      await sleep(pollMs);
    }
    if (probe.startId(state.pid) !== state.processStartId) {
      releaseDaemonState(dataRoot, state);
      process.stdout.write(`daemon 已被 SIGKILL 强停（pid ${state.pid}——优雅预算内未退出）\n`);
      return 0;
    }
    throw new AppError(
      DAEMON_STOP_TIMEOUT,
      `daemon（pid ${state.pid}）SIGKILL 后仍存活——D 状态进程/僵尸被收养等罕见形态，` +
        `请人工处置（ps -o stat= -p ${state.pid} 核对；Z 僵尸可忽略，daemon.json 已不再清理）`,
    );
  }

  // status：读态 + 真握手披露（升级窗口 = bootId 变化可辨识）
  const state = readDaemonState(dataRoot);
  if (state === undefined) {
    process.stdout.write('daemon 未运行（无 daemon.json）\n');
    return 3; // systemd is-active 惯例：非运行态非零
  }
  if (!isDaemonAlive(state, probe)) {
    process.stdout.write(`daemon.json 残留但进程已死（pid ${state.pid}）——berry daemon start 将先行清扫\n`);
    return 3;
  }
  const token = ensureDaemonToken(dataRoot);
  const probeHttp = deps.probeHttp ?? httpProbe;
  const res = await probeHttp(
    `http://127.0.0.1:${state.port}/api/sessions`,
    { authorization: `Bearer ${token}` },
    HANDSHAKE_TIMEOUT_MS,
  );
  let sessionsCount = -1;
  if (res !== undefined && res.status === 200) {
    try {
      // /api/sessions 回包是会话清单数组；形状异常保持 -1（仍报运行中）
      const list = JSON.parse(res.body) as unknown;
      sessionsCount = Array.isArray(list) ? list.length : -1;
    } catch {
      /* 保持 -1（清单形状异常仍报运行中） */
    }
  }
  const handshake =
    sessionsCount >= 0
      ? `正常（清单 ${sessionsCount} 条）`
      : '未达成（token 可能已轮换——删 daemon-token 与 daemon 同重启）';
  process.stdout.write(
    `daemon 运行中：pid ${state.pid}、端口 ${state.port}、boot ${state.bootId.slice(0, 8)}、` +
      `持有会话 ${state.heldSessions.length} 个、真握手 ${handshake}\n`,
  );
  return 0;
}

/* ------------------------------------------------------------------ */
/* --foreground 前台常驻（daemon 子进程本体——start spawn 的目标）       */
/* ------------------------------------------------------------------ */

/** 前台主流程依赖注入（测试假面） */
export interface DaemonForegroundDeps {
  /** 进程身份探针（缺省平台探针——自 id 计算与 acquire 判活共用） */
  readonly probe?: ProcessProbe;
  /** 数据目录根（缺省 dataDir()——测试钉扎） */
  readonly dataRoot?: string;
}

/**
 * 前台常驻主流程（`berry daemon --foreground`）：acquire 态文件 → createRuntime
 * （daemon 形态：interactive false + resumeSession false〔会话惰性 resume〕+
 * webui 常开）→ 信号编舞（SIGINT/SIGTERM/SIGHUP 恒全序列退出——daemon 无 TUI
 * 交互语义，不分档）→ 常驻等待。heldSessions 随注册表 open/retire 通知重写
 * （窄竞窗文档化：登记滞后窗内他进程开同会话由库 cursor/incarnation 护栏
 * 第二防线兜住）。
 * @returns 进程退出码（正常路径恒 0——信号优雅退出；二次信号 130 由 signals 记账）
 */
export async function daemonForegroundMain(port: number, deps: DaemonForegroundDeps = {}): Promise<number> {
  const probe = deps.probe ?? defaultProcessProbe;
  const dataRoot = deps.dataRoot ?? dataDir();
  mkdirSync(daemonDirOf(dataRoot), { recursive: true });
  // M6 时点钉之二：直起前清扫判死残留（launchd 重启竞窗——上次 daemon.json 未清）
  sweepStaleDaemonState(dataRoot, probe);
  // 自身进程起始标识（acquire 落账 + 退出清理身份双用；探针失败兜底 pid: 形态）
  const selfStartId = probe.startId(process.pid) ?? `pid:${process.pid}`;
  const identity = { pid: process.pid, processStartId: selfStartId };
  const state: DaemonState = {
    ...identity,
    bootId: randomUUID(),
    port,
    heldSessions: [],
  };
  acquireDaemonState(dataRoot, state, probe); // 已有活 daemon = 响亮抛 DAEMON_ALREADY_RUNNING
  const token = ensureDaemonToken(dataRoot);

  // 同一装配入口（骨架篇 §1.2 daemon 装配序）：形态是装配的选择非代码分叉
  const runtime = await createRuntime({
    interactive: false,
    resumeSession: false,
    daemon: { token, port },
    // 进程形态（刀三）：daemon boot 回放 resume 走 goal 降级照常（激活权不跨
    // 进程——重启后待人类 /goal resume；豁免面只有 tick，骨架篇 §6.8）
    processKind: 'daemon',
  });

  // heldSessions 同步：open/retire 通知驱动（通知面随刀一加进 DriverRegistry）；
  // 持有集 = 非退役条目 ∪ 退役但在飞条目（迟到结算仍可能落原会话账——写意图集）
  let lastHeldKey = '';
  const syncHeldSessions = (): void => {
    const held = [...runtime.drivers.entries.values()]
      .filter((e) => !e.retired || e.driver.isRunning)
      .map((e) => e.session.header.sessionId)
      .sort();
    const key = held.join(',');
    if (key === lastHeldKey) return; // 同值零写（通知风暴防抖）
    lastHeldKey = key;
    try {
      updateDaemonState(dataRoot, { ...state, heldSessions: held });
    } catch (err) {
      runtime.ctx.logger.warn('daemon.json heldSessions 刷新失败（下次 open/retire 重试）', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const disposeEntriesSubscription = runtime.drivers.onEntriesChange(syncHeldSessions);

  // 信号编舞：与 TUI 同款 installExitSignals（首次优雅 0 / 二次 130），差异在
  // interrupt 不分档——daemon 收 SIGINT 即 operator 退出意图，恒走全序列
  const signals = installExitSignals({
    onGracefulQuit: () => {
      runtime.front.requestQuit();
    },
    onFatal: async (error, kind) => {
      runtime.ctx.logger.error(`daemon 致命异常（${kind}），尽力落盘后退出`, {
        kind,
        error: error instanceof Error ? error.stack : String(error),
      });
      await runtime.persistence?.flush().catch(() => undefined);
    },
  });

  try {
    // 常驻：等退出请求（信号 → front.requestQuit → 全驱动 abort → quit resolve）
    await runtime.front.quit;
    await runtime.front.settle();
  } finally {
    signals.dispose();
    disposeEntriesSubscription();
    await runtime.shutdown();
    // 退出清理在 shutdown 之后：进程存续的最后身份动作（双清幂等——stop 侧同款）
    releaseDaemonState(dataRoot, identity);
  }
  return signals.exitCode;
}

/* ------------------------------------------------------------------ */
/* doctor 七项体检（刀二——`berry daemon doctor`，契约篇 §6.8）           */
/* ------------------------------------------------------------------ */

/** doctor 依赖注入（测试假面——探针/库文件/端口探测全可换） */
export interface DoctorDeps {
  /** 进程身份探针（缺省平台探针） */
  readonly probe?: ProcessProbe;
  /** HTTP 体探针（health 用——须读 JSON 体） */
  readonly probeHttp?: typeof httpProbe;
  /** HTTP 状态码探针（握手/SSE 用——应答头即回） */
  readonly probeStatus?: typeof probeStatus;
  /** 数据目录根（缺省 dataDir()——测试钉扎） */
  readonly dataRoot?: string;
  /** 会话库文件路径（缺省 dbPath()——env 覆盖链同主力路径） */
  readonly dbFile?: string;
  /** 端口监听探测（⑦ 判死路用——true = 有监听者） */
  readonly portProbe?: (port: number) => Promise<boolean>;
}

/** 单项体检结论（ok=false 计入非零退；detail 为人话披露行） */
interface DoctorFinding {
  readonly ok: boolean;
  readonly text: string;
}

/** 缺省端口监听探测：TCP connect 成功 = 有监听者（连上即断） */
const defaultPortProbe = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

/**
 * daemon 七项体检主流程。序与语义（规范 :1020）：
 * ① daemon.json 在场 + pid 判活（processStartId 匹配——防 pid 复用假阳）
 * ② 服务面：health 公开探活 + 活证真握手（**须 token 端点** 200；401 =
 *    盘上 token 与运行 daemon 持有不符——处置 = stop 后 start 重签发）
 *    + 顺手连一次 /api/events 即关（503 = 16 连接帽满）
 * ③ token 文件在场且 0600（**判活时只读禁 ensure 写**——status 的复活/
 *    换发行为是诊断面自己制造不符态，doctor 钉死不做）
 * ④ 会话库 readonly 可开 + user_version 披露（零锁竞争——readonly 不触
 *    WAL 写路）
 * ⑤ daemon.log 大小披露（信息项恒 ok）
 * ⑥ 版本对齐：health.version vs 磁上 CLI（升级未重启的辨识面）
 * ⑦ 端口占用态：**仅判死路**探测（pid 死而端口有监听者 → 报占用 + lsof
 *    建议——另一进程顶号/双开竞窗）；僵尸态（pid 活 + HTTP 面无响应）入查
 * @returns 进程退出码（全绿 0 / 任一项红 1 / 无 daemon.json 1）
 */
export async function daemonDoctorMain(deps: DoctorDeps = {}): Promise<number> {
  const probe = deps.probe ?? defaultProcessProbe;
  const dataRoot = deps.dataRoot ?? dataDir();
  const probeHttp = deps.probeHttp ?? httpProbe;
  const statusProbe = deps.probeStatus ?? probeStatus;
  const portProbe = deps.portProbe ?? defaultPortProbe;
  const findings: DoctorFinding[] = [];

  /* ---- ① daemon.json + pid 判活 ---- */
  const state = readDaemonState(dataRoot);
  if (state === undefined) {
    process.stdout.write('daemon 未运行（无 daemon.json）——`berry daemon start` 拉起后再体检。\n');
    return 1;
  }
  const pidAlive = isDaemonAlive(state, probe);
  findings.push({
    ok: pidAlive,
    text: pidAlive
      ? `① 进程：daemon.json 在场、pid ${state.pid} 存活（processStartId 匹配）`
      : `① 进程：daemon.json 残留但 pid ${state.pid} 已死（processStartId 不匹配或进程消失）——start 将先行清扫`,
  });

  /* ---- ② 服务面三探（health 公开 / 真握手 / events 即连即关） ---- */
  const token = readAttachToken(dataRoot); // 只读——诊断面禁 ensure 写（规范钉死）
  const bearer: Readonly<Record<string, string>> = token === undefined ? {} : { authorization: `Bearer ${token}` };
  const healthRes = await probeHttp(`http://127.0.0.1:${state.port}/api/health`, {}, HANDSHAKE_TIMEOUT_MS);
  const handshakeStatus = await statusProbe(
    `http://127.0.0.1:${state.port}/api/sessions`,
    bearer,
    HANDSHAKE_TIMEOUT_MS,
  );
  // events 即连即关：200 = 流面正常；503 = 16 连接帽满（SPA/attach/监控尾堆积）
  const eventsStatus = await statusProbe(`http://127.0.0.1:${state.port}/api/events`, bearer, HANDSHAKE_TIMEOUT_MS);
  let health: { version?: unknown; degraded?: unknown } | undefined;
  if (healthRes !== undefined && healthRes.status === 200) {
    try {
      health = JSON.parse(healthRes.body) as { version?: unknown; degraded?: unknown };
    } catch {
      health = undefined;
    }
  }
  findings.push({
    ok: healthRes !== undefined && healthRes.status === 200 && handshakeStatus === 200,
    text: (() => {
      const healthText = healthRes === undefined ? 'health 无响应' : `health HTTP ${healthRes.status}`;
      const handshakeText =
        handshakeStatus === 200
          ? '真握手 200（token 符）'
          : handshakeStatus === 401
            ? '真握手 401——盘上 token 与运行中 daemon 持有不符（处置：`berry daemon stop` 后 start 重签发）'
            : handshakeStatus === undefined
              ? '真握手连接失败'
              : `真握手 HTTP ${handshakeStatus}`;
      const eventsText =
        eventsStatus === 200
          ? '事件流 200'
          : eventsStatus === 503
            ? '事件流 503——16 连接帽满（SPA/attach/监控尾堆积，关几个再试）'
            : '事件流未达（服务面不健康）';
      return `② 服务面：${healthText}、${handshakeText}、${eventsText}`;
    })(),
  });
  // 僵尸态辨识（规范入查项）：pid 活 + HTTP 面无响应
  if (pidAlive && healthRes === undefined && handshakeStatus === undefined) {
    findings.push({
      ok: false,
      text:
        `②′ 僵尸态嫌疑：pid ${state.pid} 活但 HTTP 面全无响应（卡死/D 状态/端口被抢）——` +
        `\`berry daemon stop\` 后 start；仍复现查 lsof -i :${state.port}`,
    });
  }

  /* ---- ③ token 文件面（在场 + 0600） ---- */
  const tokenPath = daemonTokenPath(dataRoot);
  try {
    const mode = statSync(tokenPath).mode & 0o777;
    findings.push({
      ok: mode === 0o600,
      text:
        mode === 0o600
          ? `③ token：在场且 0600（${tokenPath}）`
          : `③ token：在场但权限 ${mode.toString(8)}（应 0600——chmod 600 ${tokenPath}）`,
    });
  } catch {
    findings.push({
      ok: false,
      text: `③ token：缺失（${tokenPath}）——daemon 活而 token 被删（处置：stop 后 start 重签发）`,
    });
  }

  /* ---- ④ 会话库（readonly 可开 + user_version） ---- */
  const dbFile = deps.dbFile ?? dbPath();
  try {
    const db = new Database(dbFile, { readonly: true });
    const userVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0;
    db.close();
    findings.push({
      ok: true,
      text: `④ 会话库：readonly 可开（${dbFile}，user_version ${userVersion}）`,
    });
  } catch (err) {
    findings.push({
      ok: false,
      text: `④ 会话库：readonly 开启失败（${dbFile}——${err instanceof Error ? err.message : String(err)}）`,
    });
  }

  /* ---- ⑤ daemon.log 大小（信息项） ---- */
  try {
    const size = statSync(daemonLogPath(dataRoot)).size;
    const human = size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MiB` : `${Math.round(size / 1024)} KiB`;
    findings.push({ ok: true, text: `⑤ 日志：daemon.log ${human}（${daemonLogPath(dataRoot)}）` });
  } catch {
    findings.push({ ok: true, text: '⑤ 日志：daemon.log 缺席（未 boot 过——信息项不计红）' });
  }

  /* ---- ⑥ 版本对齐（health.version vs 磁上 CLI） ---- */
  const runningVersion = typeof health?.version === 'string' ? health.version : undefined;
  findings.push({
    ok: runningVersion === undefined ? false : runningVersion === VERSION,
    text:
      runningVersion === undefined
        ? '⑥ 版本：health 无应答不可比'
        : runningVersion === VERSION
          ? `⑥ 版本：对齐（运行 ${runningVersion} = 磁上 ${VERSION}）`
          : `⑥ 版本：漂移（运行 ${runningVersion} ≠ 磁上 ${VERSION}——升级后未重启，stop 后 start 换新）`,
  });

  /* ---- ⑦ 端口占用态（仅判死路） ---- */
  if (!pidAlive) {
    const occupied = await portProbe(state.port);
    if (occupied) {
      findings.push({
        ok: false,
        text:
          `⑦ 端口：daemon 判死但 ${state.port} 仍有监听者（另一进程顶号/双开竞窗）——` +
          `lsof -i :${state.port} 认主后处置`,
      });
    } else {
      findings.push({ ok: true, text: `⑦ 端口：${state.port} 无监听者（判死一致，无占用）` });
    }
  }

  /* ---- 汇总披露 ---- */
  for (const finding of findings) {
    process.stdout.write(`${finding.ok ? '✓' : '✗'} ${finding.text}\n`);
  }
  const failed = findings.filter((finding) => !finding.ok).length;
  process.stdout.write(failed === 0 ? 'doctor：七项全绿。\n' : `doctor：${failed} 项红（见 ✗ 行）。\n`);
  return failed === 0 ? 0 : 1;
}
