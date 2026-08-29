/**
 * bridge — external（fork 进程）域宿主半（契约篇 §1.7 external 载体，external
 * carrier 落码批——第三十七批增补 2/8 的执行面）。
 *
 * 与 spawnWorkerDomain 同构的域句柄面：spawn 子进程 → NDJSON 载体端口 →
 * BridgeEndpoint → **六宿主处理方与 worker 腿同一份**（registerHostHandlers
 * 共享——「不换协议只换 carrier」的宿主半）。差异全在 spawn 与死亡编舞：
 *
 * - **spawn**：child_process.spawn + `detached: true` 建组（子自成组长
 *   pgid==pid、孙进程继承——树杀唯一正解，PoC ⑨；非 detached 与父同组，
 *   负 pid 杀会误伤父域）；stdio 全 pipe（stdin/stdout = NDJSON 协议通道，
 *   stderr = 崩溃栈收集面——worker 腿 'error' 事件的对应物）。
 * - **安全参数全注入**：PM 旗/execArgv（safety/pm-flags 推导产物）、OS 层
 *   argv 包裹器（seatbelt/bwrap confine 产物）、env（buildChildEnv 白名单
 *   产物）都由装配层组装传入——本模块零 safety/exec 依赖（拓扑边不动，
 *   bridge 纯机制：spawn/协议/树杀/结算）。
 * - **死亡结算**：exit → 端点 dispose（在途全结算 WORKER_EXITED）+ 组杀兜底
 *   （孙进程随组收割——域死 = 组死语义）+ 域死回卷 + onExit（worker 同款；
 *   diagnostic = stderr 尾部缓存，自崩溃第一手栈）。
 * - **关停编舞**（PoC ⑪ 三段）：terminate（编舞终点）= SIGTERM 组 → 宽限
 *   → SIGKILL 组——给域内告别窗；kill（watchdog 执法，域已冻结收不到信号）
 *   = 直接 SIGKILL 组，按意外死亡全流程结算。
 *
 * 预算维度：fork 无 worker resourceLimits——调用方经 execArgv 携
 * `--max-old-space-size`（budget.memoryMb 映射，装配面组装）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AppError, APP_LOAD_FAILED } from '../contracts/errors.js';
import type { AppPlanRow } from '../contracts/app.js';
import type { ToolsService } from '../contracts/tools.js';
import type { ContextScope } from '../context/types.js';
import type { WorkerModuleMeta, WorkerRowLoader } from '../context/loader.js';
import { BridgeEndpoint } from './session.js';
import { StdioBridgePort } from './port-stdio.js';
import { registerHostHandlers, type RowBinding } from './bootstrap.js';

/** stderr 诊断缓存上界（尾部保尾——崩溃栈的最后几行是判据面） */
const STDERR_TAIL_LIMIT = 8 * 1024;

/** spawnExternalDomain 参数（安全参数全注入——见头注） */
export interface ExternalDomainOptions {
  /** 域入口 URL（缺省 = 同目录 external-entry.ts/.js 自适应；测试可显式指） */
  readonly externalUrl?: URL;
  /** 域标识（诊断归因/错误信封 origin；缺省自动生成——舰队装配传 `e:<行id>`） */
  readonly workerId?: string;
  /**
   * 子进程 Node 旗（PM 旗 + 预算旗由装配层推导传入）。TS 源形态且无 tsx
   * 预载时自补 `--import=tsx`（与 spawnWorkerDomain 同款自适应：Node
   * type-stripping 不重写 .js→.ts 指示符，直跑 TS 源须预载链）。
   */
  readonly execArgv?: readonly string[];
  /**
   * OS 层 argv 包裹器（seatbelt/bwrap confine 产物——装配层组装后注入；
   * 缺省不包裹 = PM-only 逃生门形态，装配层把关）。输入完整 argv
   * [node, ...旗, 入口, 域id]，返回包装后 argv（runner 前缀已在）。
   */
  readonly argvWrapper?: (argv: string[]) => string[];
  /** 子进程环境（buildChildEnv 白名单产物——缺省继承宿主 env 全量） */
  readonly env?: Readonly<Record<string, string>>;
  /** 应用锚作用域（svc-invoke 的服务解析源） */
  readonly root: ContextScope;
  /** 工具服务（缺省懒解析 root 的 'tools'） */
  readonly tools?: ToolsService;
  /** svc.load 在途超时（毫秒，缺省 60s——fork 冷启 + jiti 全图转译） */
  readonly loadTimeoutMs?: number;
  /** 心跳节律（毫秒；首次 svc.load 成功后起表——与 worker 腿同款两窗分工） */
  readonly heartbeatMs?: number;
  /** 连续丢拍阈值（缺省沿用端点 3） */
  readonly heartbeatMissLimit?: number;
  /** 冻结判定回调（terminate 决策在调用方——端点只报事实） */
  readonly onFreeze?: (info: { missed: number }) => void;
  /**
   * 域退出通知（死亡结算挂钩——与 spawnWorkerDomain.onExit 同契约：意外
   * 死亡才回调、域死回卷已先行完成、rows = 死亡时点绑定行、reason 仅 kill
   * 执法路径携带、diagnostic = stderr 尾部缓存）。
   */
  readonly onExit?: (info: {
    readonly workerId: string;
    readonly code: number;
    readonly rows: readonly string[];
    readonly reason?: string;
    readonly diagnostic?: string;
  }) => void;
  /** terminate 的 SIGTERM→SIGKILL 组杀宽限（毫秒，缺省 5000——域告别窗） */
  readonly killGraceMs?: number;
}

/** external 域句柄（宿主侧唯一操作面——与 WorkerDomain 同形，worker 字段换 child） */
export interface ExternalDomain {
  /** 域标识（诊断归因——`e:<行id>`） */
  readonly workerId: string;
  /** 宿主端点（监督面心跳/诊断只读消费） */
  readonly endpoint: BridgeEndpoint;
  /** 底层子进程（诊断面；生命周期归本句柄 terminate/kill） */
  readonly child: ChildProcess;
  /** 域半装载（loadApps 阶段① 消费） */
  load(row: AppPlanRow): Promise<WorkerModuleMeta>;
  /** 宿主半激活（loadApps activateOne 消费——经 makeRowLoader 包装） */
  applyRow(row: AppPlanRow, scope: ContextScope, opts?: { signal?: AbortSignal }): Promise<void>;
  /** 域收尾（刻意收尾——编舞既知终点非事故：SIGTERM 组 → 宽限 → SIGKILL 组） */
  terminate(reason?: string): void;
  /** watchdog 杀域（意外死亡路径——直接 SIGKILL 组，按域死结算全流程） */
  kill(reason: string): void;
}

/**
 * external 域入口的 URL 自适应：按宿主半自身形态判别（dev/TS 源 → 同目录
 * external-entry.ts；编译产物 → external-entry.js）——「入口住在 bootstrap
 * 旁」的位置知识单点（与 workerEntryUrl 同族）。
 */
export function externalEntryUrl(selfUrl: string): URL {
  return new URL(selfUrl.endsWith('.ts') ? './external-entry.ts' : './external-entry.js', selfUrl);
}

/**
 * 起一个 external（fork 进程）域：spawn 子进程 + NDJSON 端点 + 六宿主处理方
 * （与 worker 腿共享）+ 死亡结算/树杀编舞。子进程 exit（崩溃/被杀/自然退）→
 * 端点 dispose「域退出」——在途调用全数 WORKER_EXITED 结算。
 */
export function spawnExternalDomain(opts: ExternalDomainOptions): ExternalDomain {
  const workerId = opts.workerId ?? `e-${randomUUID().slice(0, 8)}`;
  const entryUrl = opts.externalUrl ?? externalEntryUrl(import.meta.url);
  const isTs = entryUrl.pathname.endsWith('.ts');
  // execArgv：显式注入优先；TS 形态且无 tsx 预载时自补（spawnWorkerDomain 同款）
  const explicitArgv = opts.execArgv ?? [];
  const execArgv =
    isTs && !explicitArgv.some((a) => a.includes('tsx')) ? [...explicitArgv, '--import=tsx'] : [...explicitArgv];

  // 完整 argv：node + 旗 + 入口 + 域id（argv[2] 协议位——见 external-entry.ts）
  const rawArgv = [process.execPath, ...execArgv, fileURLToPath(entryUrl), workerId];
  // OS 层包裹（seatbelt/bwrap confine——runner 前缀 argv；缺省直跑 = PM-only 逃生门）
  const argv = opts.argvWrapper !== undefined ? opts.argvWrapper(rawArgv) : rawArgv;

  // 建组 spawn（PoC ⑨：detached:true 子自成组长，孙进程继承 pgid——负 pid
  // 组杀收割整树；stdio 三 pipe：stdin/stdout 协议通道、stderr 诊断收集）
  const child = spawn(argv[0]!, argv.slice(1), {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: opts.env !== undefined ? { ...opts.env } : process.env,
  });

  /** stderr 尾部缓存（崩溃栈第一手——worker 腿 'error' 事件对应物；保尾丢头） */
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT);
  });
  // 子进程 stdin 写失败（子已死/管道断）不冒泡 unhandled——端点 dispose 已结算
  child.stdin?.on('error', () => {});

  /** 行绑定簿（applyRow 登记、行作用域回卷时清——onTell/emit 的行锚点） */
  const bindings = new Map<string, RowBinding>();
  /** load 缓存（applyRow 取 optionalInject 快照用；load→apply 之间必持） */
  const metaCache = new Map<string, WorkerModuleMeta>();

  const port = new StdioBridgePort(child.stdout!, child.stdin!);
  let endpoint!: BridgeEndpoint;
  endpoint = new BridgeEndpoint(port, {
    origin: { workerId },
    heartbeatMissLimit: opts.heartbeatMissLimit,
    onFreeze: opts.onFreeze,
    // 宿主 onTell：log 上行分发到行作用域 logger（域直打 stdout 会砸穿协议
    // 通道——日志纪律单点，与 worker 腿同款）
    onTell: (event, payload) => {
      if (event !== 'log') return;
      const { rowId, level, message, fields } = payload as {
        rowId: string;
        level: string;
        message: string;
        fields?: Record<string, unknown>;
      };
      const binding = bindings.get(rowId);
      if (binding === undefined) return; // 行已回卷——迟到日志静默丢弃
      const logger = binding.scope.logger as unknown as Record<
        string,
        ((m: string, f?: Record<string, unknown>) => void) | undefined
      >;
      const fn = logger[level];
      if (typeof fn === 'function') fn.call(binding.scope.logger, message, fields);
    },
  });

  // 六宿主处理方（与 worker 腿同一份——registerHostHandlers 共享）
  registerHostHandlers({
    endpoint,
    workerId,
    bindings,
    metaCache,
    toolRunSeq: 0,
    root: opts.root,
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
  });

  // 主动收尾标记（terminate 置位——exit 处理据此区分编舞终点与意外死亡）
  let terminated = false;
  // watchdog kill 的执法归因（exit 通知透出；自崩溃恒 undefined）
  let killReason: string | undefined;
  // 心跳是否已起表（首次 svc.load 成功起表——与 worker 腿同款两窗分工）
  let heartbeatArmed = false;

  /**
   * 组杀原语：负 pid 信号投给进程组（孙进程全收——PoC ⑨ 实证组死透）。
   * 组已不存在（ESRCH）静默——exit 后组员先散是正常形态。
   */
  const killGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // ESRCH：组已散——无需收割
    }
  };

  /**
   * 子进程判活：exitCode 与 signalCode 双空 = 还活着（PoC ⑪ 教学点——
   * child.killed 只表示「发过信号」不表示「死了」，升级判据不得用它）
   */
  const childAlive = (): boolean => child.exitCode === null && child.signalCode === null;

  // 域死（崩溃/被杀/自然退）全流程：端点收尾 + 组杀兜底 + 域死回卷 + 结算通知
  child.on('exit', (code) => {
    endpoint.dispose('external 域退出（exit 事件）——在途调用按域死结算');
    // 组杀兜底：域死 = 组死语义——子先退而孙进程仍持组（应用 spawn 的后代）
    // 一并收割；SIGKILL 直杀（主已死，孙的告别窗无意义）
    killGroup('SIGKILL');
    const rowIds = [...bindings.keys()];
    const rollbacks = [...rowIds].reverse().map((rowId) => {
      const binding = bindings.get(rowId);
      bindings.delete(rowId);
      return binding?.scope.dispose().catch(() => {}) ?? Promise.resolve(); // 回卷异常不阻断其余行
    });
    metaCache.clear();
    void Promise.allSettled(rollbacks).then(() => {
      if (!terminated) {
        opts.onExit?.({
          workerId,
          code: code ?? -1,
          rows: rowIds,
          ...(killReason !== undefined ? { reason: killReason } : {}),
          ...(stderrTail !== '' ? { diagnostic: stderrTail } : {}),
        });
      }
    });
  });

  const domain: ExternalDomain = {
    workerId,
    endpoint,
    child,
    load(row) {
      // 只投影克隆面字段（builtin 函数引用绝不进消息——external 行恒无 builtin）
      return endpoint
        .call<WorkerModuleMeta>(
          'svc',
          'load',
          [{ id: row.id, entry: row.entry, config: row.config, sandbox: row.sandbox }],
          { timeoutMs: opts.loadTimeoutMs ?? 60_000 },
        )
        .then((meta) => {
          // 心跳起表点（一次性）：首次装载成功 = 域就绪——boot 窗（fork 冷启/
          // tsx 编译/jiti 装载）ping 无应答不计拍，由 load 超时监督（两窗分工）
          if (opts.heartbeatMs !== undefined && !heartbeatArmed) {
            heartbeatArmed = true;
            endpoint.startHeartbeat(opts.heartbeatMs);
          }
          metaCache.set(row.id, meta);
          return meta;
        });
    },
    applyRow(row, scope, callOpts) {
      const meta = metaCache.get(row.id);
      if (meta === undefined) {
        return Promise.reject(new AppError(APP_LOAD_FAILED, `applyRow：行 ${row.id} 未先行 load（装载管线不变量）`));
      }
      bindings.set(row.id, { scope });
      // 行级卸载联动：行作用域回卷 → 通知域清该行注册簿 + 解除宿主绑定
      scope.effect(() => () => {
        bindings.delete(row.id);
        void endpoint.call('svc', 'unload', [row.id]).catch(() => {}); // 域死时静默
      });
      // optionalInject 在场快照（域侧 tryGet 的同步收窄补偿——激活时点定档）
      const presence: Record<string, boolean> = {};
      for (const name of meta.optionalInject ?? []) presence[name] = opts.root.tryGet(name) !== undefined;
      return endpoint.call('svc', 'apply', [row.id, row.config ?? {}, presence], { signal: callOpts?.signal });
    },
    terminate(reason) {
      terminated = true; // exit 处理据此跳过意外死亡通知（主动收尾非事故）
      endpoint.dispose(reason ?? '域收尾（terminate）');
      // 三段编舞（PoC ⑪）：SIGTERM 组（告别窗——域内 handler 可收尾自然退）→
      // 宽限内未退 → SIGKILL 组收割。判活只看 exitCode/signalCode（头注）
      killGroup('SIGTERM');
      const grace = setTimeout(() => {
        if (childAlive()) killGroup('SIGKILL');
      }, opts.killGraceMs ?? 5_000);
      grace.unref(); // 宿主关停路径不被宽限定时器拖命
    },
    kill(reason) {
      // 不置 terminated——kill 是监督执法不是编舞终点：exit 处理走意外死亡
      // 全流程（端点 dispose 幂等 + 组杀 + 域死回卷 + onExit 携 reason 通知）。
      // 直接 SIGKILL：冻结域（同步死循环）收不到 SIGTERM，宽限无意义
      killReason = reason;
      endpoint.dispose(`watchdog 杀域：${reason}`);
      killGroup('SIGKILL');
    },
  };
  return domain;
}
