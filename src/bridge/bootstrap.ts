/**
 * bridge — 宿主半装配（契约篇 §1.7，2026-08-26 第二十七批刀二 K3-b2）。
 *
 * 「装载管线两半拆分」的宿主半：spawn worker 子进程 → 在宿主端点上注册六处理方
 * （svc-register / sub / emit / tools-register / svc-invoke / tool-run）→
 * 物化 WorkerRowLoader（loadPlugins 的 worker 分支 seam，context 模块只认
 * 接口不认本模块——拓扑边 bridge→context 单向）。
 *
 * 翻译纪律（与 worker.ts 桩一一对应）：
 * - svc-register [rowId, name]  → 行作用域 provide(name, 方法转发代理)——
 *   main 域消费方拿到服务即 Kahn 轮次可 inject 的普通对象（方法调用过桥）；
 * - sub [rowId, event]          → 行作用域 on(event, 转发器)——宿主 emit 触发
 *   转发器，tell('evt') 回投 worker 分派；
 * - emit [rowId, event, args]   → 行作用域 emit（per-scope 限流在宿主侧单一实现）；
 * - tools-register [rowId,meta] → tools.register（声明面本地、execute 过桥，
 *   timeoutMs 预算随行；onUpdate 函数不可过界——v1 收窄）；
 * - svc-invoke [name,method,…]  → 锚作用域 get(name) 后方法分派（CONTEXT_SERVICE_
 *   NOT_FOUND 保码回 worker——Kahn 已保证 inject 在场，此码即装配缺陷探针）；
 * - tool-run [name,args]        → tools.get + execute（worker 侧便捷面 run 的
 *   宿主终端——工具管道三段在宿主侧唯一实现）。
 *
 * 生命周期（K3-c 装配接线）：心跳监督 terminate / 域死回卷 / env 与 resourceLimits
 * 由组合根配置——本文件只提供 spawnWorkerDomain 机制面与 terminate 出口。
 */
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { AppError, BRIDGE_METHOD_NOT_FOUND, PLUGIN_LOAD_FAILED } from '../contracts/errors.js';
import type { ToolDefinition, ToolsService } from '../contracts/tools.js';
import type { PluginPlanRow } from '../contracts/plugin.js';
import type { ContextScope } from '../context/types.js';
import type { WorkerModuleMeta, WorkerRowLoader } from '../context/loader.js';
import { BridgeEndpoint } from './session.js';

/** 宿主侧行绑定（worker 行激活期间的宿主侧锚点——onTell/emit 后期消费） */
interface RowBinding {
  /** 行作用域（fork 产物——provide/on/emit 落点，随作用域回卷自动收） */
  readonly scope: ContextScope;
}

/** spawnWorkerDomain 参数 */
export interface WorkerDomainOptions {
  /** worker 入口 URL（缺省 = 编译产物 ./worker.js 同目录；测试传 TS 源 + execArgv） */
  readonly workerUrl?: URL;
  /** 域标识（诊断归因/错误信封 origin；缺省自动生成） */
  readonly workerId?: string;
  /** 子进程 Node 参数（测试面传 tsx 预载两段参数 --import tsx 跑 TS 源；生产编译产物不需要。注：示例不写成数组字面量——拓扑门禁的裸导入扫描是词法级的，注释里的引号邻接会误触发） */
  readonly execArgv?: readonly string[];
  /** 子进程资源上限（K3-c 预算内存维度——缺省不设，随监督装配配置） */
  readonly resourceLimits?: Readonly<Record<string, number>>;
  /** 子进程环境变量差异面（缺省继承宿主 env——env 拷贝不回漏，K3-c 白名单口径） */
  readonly env?: Readonly<Record<string, string>>;
  /** 插件锚作用域（宿主侧 get/emit 的落点——svc-invoke 的服务解析源） */
  readonly root: ContextScope;
  /** 工具服务（缺省懒解析 root 的 'tools' 服务——Ring 1 装载序里工具行可能晚于 worker 行激活，捕获期解析会拿到 undefined） */
  readonly tools?: ToolsService;
  /** svc.load 在途超时（毫秒，缺省 60s——jiti 全图转译 + import 的合理上限） */
  readonly loadTimeoutMs?: number;
  /** 心跳节律（毫秒；设置即宿主端点起探针——K3-c 监督编舞的配置面，端点机制见 session.ts） */
  readonly heartbeatMs?: number;
  /** 连续丢拍阈值（缺省沿用端点 3） */
  readonly heartbeatMissLimit?: number;
  /** 冻结判定回调（心跳缺失——terminate 决策在调用方〔装配层〕，端点只报事实） */
  readonly onFreeze?: (info: { missed: number }) => void;
  /**
   * 域退出通知（死亡结算挂钩，契约篇 §1.7「不自动重启 + 失败结算」）：意外死亡
   * （崩溃/被杀/resourceLimits 超限/watchdog kill）才回调——terminate 主动收尾
   * 不叫（那条路是编舞既知终点非事故）。**域死回卷（绑定行作用域 dispose）已
   * 在本模块内先行完成**后回调；装配层在此挂诊断广播与 operator 可见面。
   * rows = 死亡时点仍挂在本域的行 id 清单（归因面）；reason 仅 kill 执法路径
   * 携带（自崩溃无执法归因——code 即事实）。
   */
  readonly onExit?: (info: {
    readonly workerId: string;
    readonly code: number;
    readonly rows: readonly string[];
    readonly reason?: string;
  }) => void;
}

/** worker 域句柄（宿主侧唯一操作面） */
export interface WorkerDomain {
  /** 域标识（诊断归因） */
  readonly workerId: string;
  /** 宿主端点（监督面心跳/诊断只读消费；terminate 前先 dispose） */
  readonly endpoint: BridgeEndpoint;
  /** 底层 worker（诊断面；生命周期归本句柄 terminate） */
  readonly worker: Worker;
  /** worker 半装载（loadPlugins 阶段① 消费） */
  load(row: PluginPlanRow): Promise<WorkerModuleMeta>;
  /** 宿主半激活（loadPlugins activateOne 消费——经 makeRowLoader 包装） */
  applyRow(row: PluginPlanRow, scope: ContextScope, opts?: { signal?: AbortSignal }): Promise<void>;
  /**
   * 域收尾（**刻意收尾**——编舞既知终点非事故）：端点 dispose（在途全结算
   * WORKER_EXITED）→ worker terminate。不触发 onExit、不做域死回卷（行作用域
   * 随锚/行回卷自行收）。行级卸载不走这里，域级退出（/reload/关停）才用。
   */
  terminate(reason?: string): void;
  /**
   * watchdog 杀域（**意外死亡路径**——心跳冻结/resourceLimits 超限等的执法收尾）：
   * 硬 terminate 但按域死结算——exit 监听器走端点 dispose + 域死回卷 + onExit
   * 通知全流程（与自崩溃同路：terminate 是编舞终点，kill 是监督执法）。reason
   * 随 exit 通知透出（归因面——观测锚⑨「心跳超时」的打点数据源）。
   */
  kill(reason: string): void;
}

/**
 * 宿主半入口的 worker 同伴 URL：按宿主半自身形态判别——TS 源形态（dev/测试）
 * → 同目录 worker.ts，编译产物形态 → worker.js。execArgv 未显式传时 Node
 * worker 自动继承父进程参数：dev 下 tsx 预载链延续（worker 直跑 TS 源）、
 * build 下父进程无预载参数（缺省即对）——两种形态零配置自适应。
 */
export function workerEntryUrl(selfUrl: string): URL {
  return new URL(selfUrl.endsWith('.ts') ? './worker.ts' : './worker.js', selfUrl);
}

/**
 * 起一个 worker 域：spawn 子进程 + 宿主端点 + 六处理方一次性注册。
 * worker exit（崩溃/被杀）→ 端点 dispose「worker 退出」——在途调用全数
 * WORKER_EXITED 结算，后续调用即刻拒绝（监督面的判据源之一）。
 */
export function spawnWorkerDomain(opts: WorkerDomainOptions): WorkerDomain {
  const workerId = opts.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const workerUrl = opts.workerUrl ?? workerEntryUrl(import.meta.url);
  const worker = new Worker(workerUrl, {
    workerData: { workerId },
    ...(opts.execArgv !== undefined ? { execArgv: [...opts.execArgv] } : {}),
    ...(opts.resourceLimits !== undefined ? { resourceLimits: { ...opts.resourceLimits } } : {}),
    ...(opts.env !== undefined ? { env: { ...opts.env } } : {}),
  });

  /** 行绑定簿（applyRow 登记、行作用域回卷时清——onTell/emit 的行锚点） */
  const bindings = new Map<string, RowBinding>();
  /** load 缓存（applyRow 取 optionalInject 快照用；load→apply 之间必持） */
  const metaCache = new Map<string, WorkerModuleMeta>();
  /** tool-run 的调用序号（toolCallId 生成——桥接调用也要可归因可审计） */
  let toolRunSeq = 0;

  let endpoint!: BridgeEndpoint;
  endpoint = new BridgeEndpoint(worker, {
    origin: { workerId },
    // 心跳三件透传（未设置即不起探针——机制住 session.ts，编舞住 fleet/装配层）
    heartbeatMs: opts.heartbeatMs,
    heartbeatMissLimit: opts.heartbeatMissLimit,
    onFreeze: opts.onFreeze,
    // 宿主 onTell：log 上行分发到行作用域 logger（级别面全保留——宿主统一过滤）
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

  // 主动收尾标记：terminate 先置位再 terminate——exit 处理据此区分「编舞既知
  // 终点」（不叫 onExit）与「意外死亡」（叫 onExit——死亡结算挂钩）
  let terminated = false;
  // watchdog kill 的执法归因（exit 通知透出——观测锚⑨「心跳超时」打点数据源；
  // 自崩溃恒 undefined：code 即事实，不虚构归因）
  let killReason: string | undefined;

  // worker 崩溃/被杀/资源超限 = 域死：端点收尾（在途全结算 WORKER_EXITED）+
  // 该域全部行作用域回卷（契约篇 §1.7「worker 死 = 作用域 dispose」宿主侧：
  // 宿主物化注册〔provide 代理/事件订阅/工具注册 disposer〕随行作用域 LIFO
  // 回卷收走；行作用域回卷触发的 svc.unload 联动因端点已 dispose 即拒、
  // catch 静默——非合作死亡的正确性不依赖 worker 配合，反模式 #4）
  worker.on('exit', (code) => {
    endpoint.dispose('worker 退出（exit 事件）——在途调用按域死结算');
    const rowIds = [...bindings.keys()];
    const rollbacks = [...rowIds].reverse().map((rowId) => {
      const binding = bindings.get(rowId);
      bindings.delete(rowId);
      return binding?.scope.dispose().catch(() => {}) ?? Promise.resolve(); // 回卷异常不阻断其余行
    });
    metaCache.clear();
    // 回卷全落定后才通知（onExit 契约「回卷已先行完成」——dispose 是异步面，
    // allSettled 汇合；单行回卷异常不 withhold 死亡结算）
    void Promise.allSettled(rollbacks).then(() => {
      if (!terminated) {
        opts.onExit?.({ workerId, code, rows: rowIds, ...(killReason !== undefined ? { reason: killReason } : {}) });
      }
    });
  });

  /**
   * 工具服务解析：显式注入优先，缺省懒解析 root 的 'tools' 服务（调用时点解析
   * 而非捕获时点——Ring 1 装载序里工具行可能晚于 worker 行激活，boot 期捕获会
   * 拿到 undefined 假裁剪形态；服务集两时点恒定不变式下运行期解析恒定）。
   */
  const resolveTools = (): ToolsService | undefined => opts.tools ?? opts.root.tryGet<ToolsService>('tools');

  const requireBinding = (rowId: string, surface: string): RowBinding => {
    const binding = bindings.get(rowId);
    if (binding === undefined) {
      throw new AppError(PLUGIN_LOAD_FAILED, `${surface}：行 ${rowId} 无宿主绑定（apply 未先行或已回卷）`);
    }
    return binding;
  };

  endpoint
    /* worker 行 provide：宿主侧挂行作用域（main 域消费方拿方法转发代理——
     * thenable 陷阱防护见 makeWorkerServiceProxy；服务值面/同步 getter 不
     * 过界，v1 收窄：worker 提供的服务是异步方法面） */
    .handle('host', 'svc-register', ([rowIdArg, nameArg]) => {
      const rowId = String(rowIdArg);
      const binding = requireBinding(rowId, 'svc-register');
      binding.scope.provide(String(nameArg), makeWorkerServiceProxy(endpoint, rowId, String(nameArg)));
    })
    /* worker 行订阅：行作用域 on + 转发器（args 过界 tell 回投 worker 分派） */
    .handle('host', 'sub', ([rowIdArg, eventArg]) => {
      const binding = requireBinding(String(rowIdArg), 'sub');
      binding.scope.on(String(eventArg), (...args: unknown[]) => {
        endpoint.tell('evt', { rowId: String(rowIdArg), event: String(eventArg), args });
      });
    })
    /* worker 行 emit：走宿主行作用域 emit（per-scope 限流单点） */
    .handle('host', 'emit', ([rowIdArg, eventArg, argsArg]) => {
      const binding = requireBinding(String(rowIdArg), 'emit');
      binding.scope.emit(String(eventArg), ...((argsArg ?? []) as unknown[]));
    })
    /* worker 行工具注册：声明面本地落注册表，execute 翻译为 tool-invoke 桥接
     * 调用（signal 透传 + timeoutMs 预算随行——超时本地结算发 cancel 让 worker 停工） */
    .handle('host', 'tools-register', ([rowIdArg, metaArg, domainArg]) => {
      const tools = resolveTools();
      if (tools === undefined) {
        throw new AppError(
          BRIDGE_METHOD_NOT_FOUND,
          'tools-register：本装配面未提供工具服务（裁剪形态——worker 行不可注册工具）',
        );
      }
      const rowId = String(rowIdArg);
      const meta = metaArg as {
        name: string;
        description: string;
        parameters: object;
        effect?: 'read' | 'write';
        timeoutMs?: number;
        label?: string;
      };
      const binding = requireBinding(rowId, 'tools-register');
      const def: ToolDefinition = {
        name: meta.name,
        description: meta.description,
        parameters: meta.parameters,
        ...(meta.effect !== undefined ? { effect: meta.effect } : {}),
        ...(meta.timeoutMs !== undefined ? { timeoutMs: meta.timeoutMs } : {}),
        ...(meta.label !== undefined ? { label: meta.label } : {}),
        execute: (args, ctx) =>
          endpoint.call('svc', 'tool-invoke', [rowId, meta.name, args, { toolCallId: ctx.toolCallId }], {
            signal: ctx.signal,
            ...(meta.timeoutMs !== undefined ? { timeoutMs: meta.timeoutMs } : {}),
          }),
      };
      const unregister = tools.register(def, domainArg !== undefined ? { domain: String(domainArg) } : undefined);
      // 行级清理：register 返回的注销器挂行作用域 effect——行回卷（apply 失败/
      // /reload/域死 exit 回卷）同步摘除注册（真注册表 remove + tools_change 广播）
      binding.scope.effect(() => () => unregister());
    })
    /* worker 调宿主服务：锚作用域 get 后方法分派（AppError 家族保码回 worker） */
    .handle('host', 'svc-invoke', ([nameArg, methodArg, argsArg]) => {
      const svc = opts.root.get<Record<string, unknown>>(String(nameArg));
      const fn = svc?.[String(methodArg)];
      if (typeof fn !== 'function') {
        throw new AppError(BRIDGE_METHOD_NOT_FOUND, `宿主服务无此方法：${String(nameArg)}.${String(methodArg)}`);
      }
      return (fn as (...a: unknown[]) => unknown).apply(svc, argsArg as unknown[]);
    })
    /* worker 便捷面 run 的宿主终端：宿主工具走真管道（schema→守门→执行唯一实现） */
    .handle('host', 'tool-run', ([nameArg, argsArg], signal) => {
      const tools = resolveTools();
      if (tools === undefined) {
        throw new AppError(BRIDGE_METHOD_NOT_FOUND, 'tool-run：本装配面未提供工具服务（裁剪形态）');
      }
      const def = tools.get(String(nameArg));
      if (def === undefined) {
        throw new AppError(BRIDGE_METHOD_NOT_FOUND, `宿主无此工具：${String(nameArg)}`);
      }
      return def.execute(argsArg as Record<string, unknown>, {
        toolCallId: `bridge:${workerId}:${(toolRunSeq += 1)}`,
        signal,
      });
    });

  const domain: WorkerDomain = {
    workerId,
    endpoint,
    worker,
    load(row) {
      // 只投影克隆面字段（builtin 函数引用绝不进消息——worker 行恒无 builtin）
      return endpoint
        .call<WorkerModuleMeta>(
          'svc',
          'load',
          [{ id: row.id, entry: row.entry, config: row.config, runtime: row.runtime }],
          { timeoutMs: opts.loadTimeoutMs ?? 60_000 },
        )
        .then((meta) => {
          metaCache.set(row.id, meta);
          return meta;
        });
    },
    applyRow(row, scope, callOpts) {
      const meta = metaCache.get(row.id);
      if (meta === undefined) {
        return Promise.reject(new AppError(PLUGIN_LOAD_FAILED, `applyRow：行 ${row.id} 未先行 load（装载管线不变量）`));
      }
      bindings.set(row.id, { scope });
      // 行级卸载联动：行作用域回卷（apply 失败 //reload）→ 通知 worker 清该行
      // 注册簿（effect 栈/服务/工具/事件处理器）+ 解除宿主绑定。effect 登记在
      // apply 最前 → LIFO 回卷时最后执行（worker 侧行注册先于宿主 provide 等收尾）
      scope.effect(() => () => {
        bindings.delete(row.id);
        void endpoint.call('svc', 'unload', [row.id]).catch(() => {}); // 域死时静默（dispose 已结算在途）
      });
      // optionalInject 在场快照（worker 侧 tryGet 的同步收窄补偿——激活时点定档）
      const presence: Record<string, boolean> = {};
      for (const name of meta.optionalInject ?? []) presence[name] = opts.root.tryGet(name) !== undefined;
      return endpoint.call('svc', 'apply', [row.id, row.config ?? {}, presence], { signal: callOpts?.signal });
    },
    terminate(reason) {
      terminated = true; // exit 处理据此跳过意外死亡通知（主动收尾非事故）
      endpoint.dispose(reason ?? '域收尾（terminate）');
      void worker.terminate();
    },
    kill(reason) {
      // 不置 terminated——kill 是监督执法不是编舞终点：exit 处理走意外死亡
      // 全流程（端点 dispose 幂等 + 域死回卷 + onExit 携 reason 通知）
      killReason = reason;
      endpoint.dispose(`watchdog 杀域：${reason}`);
      void worker.terminate();
    },
  };
  return domain;
}

/**
 * worker 提供服务的宿主侧代理：任意方法调用过桥（svc.invoke 按 [rowId, name,
 * method, args] 分派到 worker 域真实现）。then/catch/finally 与 symbol 属性
 * 返回 undefined——Promise.resolve(proxy) 不得把代理误判 thenable（await 假
 * 结算的结构性陷阱）。
 */
function makeWorkerServiceProxy(
  endpoint: BridgeEndpoint,
  rowId: string,
  name: string,
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
        return (...args: unknown[]) => endpoint.call('svc', 'invoke', [rowId, name, prop, args]);
      },
    },
  );
}

/**
 * 物化 WorkerRowLoader（loadPlugins opts.workerLoader 注入物——组合根装配序
 * 把 bridge 域接到 context 装载管线的唯一缝）。
 */
export function makeRowLoader(domain: WorkerDomain): WorkerRowLoader {
  return {
    load: (row) => domain.load(row),
    apply: (row, scope, opts) => domain.applyRow(row, scope, opts),
  };
}
