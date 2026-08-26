/**
 * app — worker 域舰队（契约篇 §1.7 K3-c 编舞件，2026-08-26 第二十七批刀二）。
 *
 * 「每 worker 行一域」的装配形态落码：把 spawnWorkerDomain 的机制面收编成
 * loadPlugins 可注入的 WorkerRowLoader——worker 行 load 时即 spawn 专属域
 * （boot 解析即 spawn），并给组合根三件编舞出口：
 *
 * - reapUnapplied：清割「装载成功但从未 apply」的域（Kahn 零进展残留行——行
 *   已按 PLUGIN_INJECT_UNRESOLVED 进失败清单，域是孤儿，即刻刻意收尾防漏）；
 * - terminateAll：域级刻意收尾（/reload 随插件锚重装载、进程关停两时点）；
 * - stats：观测打点（观测锚⑨心跳超时/⑩装机计数——打点先行，事件面随预算
 *   内存维度〔刀三〕另批；先例：tools stats() counters）。
 *
 * 死亡结算（契约篇 §1.7）：域意外死亡（自崩溃/watchdog kill/resourceLimits
 * 超限）→ bootstrap exit 监听已完成域死回卷（行作用域 LIFO）→ 本舰队逐行
 * 广播 plugin/failed（复用装载失败同一观测词汇，code = BRIDGE_WORKER_EXITED）
 * ——不自动重启，「宁可死得响亮」，operator 裁量重开。
 *
 * env 白名单（K3-c 决定）：v1 不过滤——缺省继承宿主 env 全量。理由：main 域
 * 插件本可直读 process.env，给 worker 过滤无安全增益（worker 分域是故障域
 * 分域非安全边界）；拷贝不回漏底线由 Node worker 语义天然保证。机会面
 * （最小化披露）随案三进程墙再裁。
 */
import { AppError, BRIDGE_WORKER_EXITED, PLUGIN_LOAD_FAILED } from '../contracts/errors.js';
import type { PluginPlanRow } from '../contracts/plugin.js';
import type { ToolsService } from '../contracts/tools.js';
import type { ContextScope } from '../context/types.js';
import type { WorkerModuleMeta, WorkerRowLoader } from '../context/loader.js';
import { spawnWorkerDomain, bridgeWorkerUrl, type WorkerDomain } from '../bridge/bootstrap.js';

/** 舰队参数（组合根注入——编舞值〔心跳节律/资源上限〕由装配层定，本件只收编） */
export interface BridgeFleetOptions {
  /** 服务解析根（spawnWorkerDomain 的 root——ctx 真根，服务表根共享全树可见） */
  readonly root: ContextScope;
  /** 装载锚 accessor（plugin/failed 死亡结算的落点；/reload 会重 fork，恒取活锚） */
  readonly anchor: () => ContextScope;
  /** worker 同伴入口（缺省 bridge 模块自描述位置） */
  readonly workerUrl?: URL;
  /** 子进程 Node 参数（测试面注入 tsx 预载；生产面缺省继承父进程参数） */
  readonly execArgv?: readonly string[];
  /** 工具服务（缺省由 bootstrap 懒解析 root 的 'tools'——装载序晚期行友好） */
  readonly tools?: ToolsService;
  /** svc.load 在途超时毫秒（缺省 bootstrap 的 60s） */
  readonly loadTimeoutMs?: number;
  /** 心跳节律毫秒（undefined = 不起监督探针——监督编舞由装配层启用） */
  readonly heartbeatMs?: number;
  /** 连续丢拍阈值（缺省端点 3） */
  readonly heartbeatMissLimit?: number;
  /** resourceLimits 宿主全局缺省（预算内存维度——只限 JS 堆，非安全墙） */
  readonly resourceLimits?: Readonly<Record<string, number>>;
  /**
   * 运行时行失败回写面（ctx.plugins.markFailed 注入物——契约篇 §1.7 死亡
   * 结算：plugin/failed 事件广播 + list 状态源同步转 failed，两件同一时点）。
   * 事件归本舰队、状态归插件管理服务——分工不重不漏。
   */
  readonly markFailed?: (id: string, code: string, message: string) => void;
  /** 域死追加上报钩子（死亡结算内建 plugin/failed 广播之后；装配层观测面） */
  readonly onDomainExit?: (info: {
    readonly workerId: string;
    readonly code: number;
    readonly rows: readonly string[];
    readonly reason?: string;
    readonly diagnostic?: string;
  }) => void;
}

/** 舰队单域登记项（一行一域——行 id 即键） */
interface FleetEntry {
  readonly domain: WorkerDomain;
  /** apply 是否已成功返还（reapUnapplied 的判别面） */
  applied: boolean;
}

/** 舰队操作面（组合根三件编舞出口 + 装载器注入物） */
export interface BridgeFleet {
  /** loadPlugins opts.workerLoader 注入物（worker 行装载管线入口） */
  readonly loader: WorkerRowLoader;
  /** 清割未应用域（loadPlugins 返回后调用——Kahn 残留行防漏）；返回清割数 */
  reapUnapplied(reason: string): number;
  /** 全域刻意收尾（/reload/关停编舞——不走死亡结算）；返回收编数 */
  terminateAll(reason: string): number;
  /** 观测打点：spawned/ooms/crashed/heartbeatFreezes/terminated 累计、live 现存（ooms = crashed 的内存超限归因子集） */
  stats(): {
    spawned: number;
    live: number;
    crashed: number;
    ooms: number;
    heartbeatFreezes: number;
    terminated: number;
  };
}

/**
 * 建 worker 域舰队。装载失败/apply 失败的域即刻刻意收尾（行已进失败清单，
 * 域不留孤儿——防漏是本件的存在理由之一）；意外死亡走 bootstrap 域死回卷 +
 * 本件 plugin/failed 死亡结算。
 */
export function createBridgeFleet(opts: BridgeFleetOptions): BridgeFleet {
  /** 行 id → 域登记项（一行一域） */
  const entries = new Map<string, FleetEntry>();
  /** 观测打点计数器（观测锚⑨⑩——装机计数 spawned、心跳超时 heartbeatFreezes；⑤ ooms = crashed 的内存超限归因子集） */
  let spawned = 0;
  let crashed = 0;
  let ooms = 0;
  let heartbeatFreezes = 0;
  let terminated = 0;

  const loader: WorkerRowLoader = {
    /* worker 半装载 = spawn 专属域 + 委托 domain.load（boot 解析即 spawn） */
    load(row) {
      // onFreeze 闭包需引用域自身（spawn 后才存在）——先声明后接线的同款两步
      let self!: WorkerDomain;
      const domain = spawnWorkerDomain({
        root: opts.root,
        ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
        workerUrl: opts.workerUrl ?? bridgeWorkerUrl(),
        // 域 id 用行 id 归因（诊断面：日志/事件信封可直查组合树行）
        workerId: `w:${row.id}`,
        ...(opts.execArgv !== undefined ? { execArgv: opts.execArgv } : {}),
        ...(opts.resourceLimits !== undefined ? { resourceLimits: opts.resourceLimits } : {}),
        ...(opts.loadTimeoutMs !== undefined ? { loadTimeoutMs: opts.loadTimeoutMs } : {}),
        // 心跳监督编舞（契约篇 §1.7）：冻结 → watchdog 杀域（kill 走意外死亡
        // 全流程——域死回卷 + plugin/failed 结算；terminate 是编舞终点不适用）
        ...(opts.heartbeatMs !== undefined
          ? {
              heartbeatMs: opts.heartbeatMs,
              ...(opts.heartbeatMissLimit !== undefined ? { heartbeatMissLimit: opts.heartbeatMissLimit } : {}),
              onFreeze: (info: { missed: number }) => {
                heartbeatFreezes += 1; // 观测锚⑨ 打点（kill 后 exit 通知带 reason 不再计 crashed——防双计）
                // 观测锚⑨ 事件面：kill 前派发（订阅方先见冻结归因再见死亡结算）
                opts.anchor().emit('worker/froze', { rowId: row.id, workerId: `w:${row.id}`, missed: info.missed });
                self.kill(`心跳缺失（连续 ${info.missed} 拍无应答）——同步死循环或事件循环冻结，watchdog 杀域`);
              },
            }
          : {}),
        // 域死结算钩子：bootstrap 已完成域死回卷（回卷先行完成后才通知）——
        // 此处摘登记 + 计数 + 逐行 plugin/failed（复用装载失败同一观测词汇）
        onExit: (info) => {
          entries.delete(row.id);
          if (info.reason === undefined) crashed += 1; // 无执法归因 = 自崩溃（kill 路径已计 heartbeatFreezes）
          // 观测锚⑤ 内存超限归因：error 事件签名命中（probe-oom 实证——exit code
          // 与普通崩溃同码，签名是唯一判据）→ ooms 计数 + worker/oom 事件
          if (info.diagnostic !== undefined && info.diagnostic.includes('reaching memory limit')) {
            ooms += 1; // crashed 的归因子集（维度正交——既计 crashed 又计 ooms）
            opts.anchor().emit('worker/oom', { rowId: row.id, workerId: info.workerId, diagnostic: info.diagnostic });
          }
          for (const id of info.rows) {
            const detail = info.reason !== undefined ? `，归因：${info.reason}` : '';
            // 诊断面终点（契约篇 §1.7 结算消息携带 diagnostic）：第一手错误缀入
            // 结算消息——plugin/failed 广播与 markFailed 回写同一字符串，operator
            // 看 plugins.list() 行状态即见原始异常/内存超限签名，不只知 code 1
            const diag = info.diagnostic !== undefined ? `，diagnostic：${info.diagnostic}` : '';
            const message = `worker 域意外退出（code ${info.code}${detail}${diag}）——域死回卷已完成，不自动重启（宁可死得响亮，契约篇 §1.7）`;
            // 事件广播（观测面）+ 状态回写（list 状态源不漂移）同一时点落定
            opts.anchor().emit('plugin/failed', { id, code: BRIDGE_WORKER_EXITED, message });
            opts.markFailed?.(id, BRIDGE_WORKER_EXITED, message);
          }
          opts.onDomainExit?.(info);
        },
      });
      self = domain;
      entries.set(row.id, { domain, applied: false });
      spawned += 1; // 观测锚⑩ 装机计数
      // 观测锚⑩ 事件面：spawn 即派发（订阅方计量装机——boot//reload 各 worker 行一发）
      opts.anchor().emit('worker/spawned', { rowId: row.id, workerId: `w:${row.id}` });
      return domain.load(row).catch((err: unknown) => {
        // 装载失败防漏：行已进失败清单，域即刻刻意收尾（无死亡结算——编舞既知终点）
        entries.delete(row.id);
        domain.terminate(`行 ${row.id} 装载失败防漏收尾`);
        terminated += 1;
        throw err;
      }) as Promise<WorkerModuleMeta>;
    },
    /* 宿主半激活 = 委托 domain.applyRow（行作用域由 loadPlugins fork 后传入） */
    apply(row, scope, callOpts) {
      const entry = entries.get(row.id);
      if (entry === undefined) {
        // 装载后域已死（意外死亡已结算）/已收编——行按失败收尾，响亮不静默
        return Promise.reject(
          new AppError(PLUGIN_LOAD_FAILED, `worker 行 ${row.id} 的域不在舰队（装载后死亡或已收编——装载管线不变量）`),
        );
      }
      return entry.domain.applyRow(row, scope, callOpts).then(
        () => {
          entry.applied = true;
        },
        (err: unknown) => {
          // apply 失败防漏：loadPlugins 已回卷行作用域 + 行进失败清单，域即刻收尾
          entries.delete(row.id);
          entry.domain.terminate(`行 ${row.id} apply 失败防漏收尾`);
          terminated += 1;
          throw err;
        },
      );
    },
  };

  return {
    loader,
    /** 清割未应用域：Kahn 零进展残留行（loadPlugins 已判 PLUGIN_INJECT_UNRESOLVED）的孤儿域 */
    reapUnapplied(reason) {
      let reaped = 0;
      for (const [rowId, entry] of [...entries]) {
        if (entry.applied) continue;
        entries.delete(rowId);
        entry.domain.terminate(reason);
        terminated += 1;
        reaped += 1;
      }
      return reaped;
    },
    /** 全域刻意收尾（/reload 随插件锚重装载、进程关停——jobs drain 后 persistence.close 前） */
    terminateAll(reason) {
      let count = 0;
      for (const [rowId, entry] of [...entries]) {
        entries.delete(rowId);
        entry.domain.terminate(reason);
        terminated += 1;
        count += 1;
      }
      return count;
    },
    stats() {
      return { spawned, live: entries.size, crashed, ooms, heartbeatFreezes, terminated };
    },
  };
}
