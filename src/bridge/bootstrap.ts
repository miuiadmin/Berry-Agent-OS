/**
 * bridge — 宿主半装配（契约篇 §1.7，2026-08-26 第二十七批刀二 K3-b2）。
 *
 * 「装载管线两半拆分」的宿主半：spawn worker 子进程 → 在宿主端点上注册六处理方
 * （svc-register / sub / emit / tools-register / svc-invoke / tool-run）→
 * 物化 WorkerRowLoader（loadApps 的 worker 分支 seam，context 模块只认
 * 接口不认本模块——拓扑边 bridge→context 单向）。
 *
 * 翻译纪律（与 worker.ts 桩一一对应）：
 * - svc-register [rowId, name]  → 行作用域 provide(name, 方法转发代理)——
 *   main 域消费方拿到服务即 Kahn 轮次可 inject 的普通对象（方法调用过桥）；
 * - sub [rowId, event]          → 行作用域 on(event, 转发器)——宿主 emit 触发
 *   转发器，tell('evt') 回投 worker 分派；
 * - emit [rowId, event, args]   → 行作用域 emit（per-scope 限流在宿主侧单一实现）；
 * - tools-register [rowId,meta] → tools.register（声明面本地、execute 过桥，
 *   timeoutMs 预算随行；onUpdate 函数不可过界——v1 收窄；注册罩
 *   runInCallerChain(行 id) 帧——D1 路由按行 app 键，domain 自报仅诊断）；
 * - svc-invoke [rowId,name,method,…] → 行绑定验（跨墙 rowId 纯自报不可信为
 *   归因——requireBinding 同四处执法）+ 锚作用域 get(name) 后方法分派
 *   （CONTEXT_SERVICE_NOT_FOUND 保码回 worker——Kahn 已保证 inject 在场，
 *   此码即装配缺陷探针）；
 * - tool-run [rowId,name,args]    → 行绑定验 + tools.get 后**经宿主管道执行器**
 *   执行（工具管道三段在宿主侧唯一实现——schema 校验/守门瀑布/审批
 *   carve-out/timeout/64KiB 出量护栏生效，origin='service'
 *   宿主服务面复入；worker 侧便捷面 run 的宿主终端。R1 复盘批 2026-08-29
 *   管道化——原直调 def.execute 绕三段管道违 registry 自钉纪律）。
 *   诚实边界（R1 复盘批二 11d）：durable 落账**不生效**——桥帧（caller 有帧
 *   session 无帧）经转发壳桥帧守卫 no-op（宁缺勿错位），宿主级桥审计账挂账。
 *
 * 生命周期（K3-c 装配接线）：心跳监督 terminate / 域死回卷 / env 与 resourceLimits
 * 由组合根配置——本文件只提供 spawnWorkerDomain 机制面与 terminate 出口。
 */
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { AppError, BRIDGE_METHOD_NOT_FOUND, APP_LOAD_FAILED } from '../contracts/errors.js';
import type { ToolDefinition, ToolsService } from '../contracts/tools.js';
import type { AppPlanRow } from '../contracts/app.js';
import type { ContextScope } from '../context/types.js';
import { runInCallerChain } from '../context/chain.js';
import type { WorkerModuleMeta, WorkerRowLoader } from '../context/loader.js';
import { BridgeEndpoint } from './session.js';

/** 宿主侧行绑定（worker 行激活期间的宿主侧锚点——onTell/emit 后期消费） */
export interface RowBinding {
  /** 行作用域（fork 产物——provide/on/emit 落点，随作用域回卷自动收） */
  readonly scope: ContextScope;
  /**
   * 行内已挂转发器簿：事件名 → scope.on 退订器（遗漏大扫 20260901 O-1）。
   * sub 帧幂等判据——同 (行,事件) 已有转发器则不再挂（N 订阅 N 转发器 = 主域
   * 扇出 parity 破）；unsub 帧到来时先出簿再退订（出簿先行：退订器重入安全）。
   * 行作用域回卷时随绑定簿整体消亡，簿内残留不泄漏（dispose 幂等）。
   */
  readonly forwardedEvents: Map<string, () => void>;
}

/**
 * 六宿主处理方的共享装配目标（external carrier 落码批抽取——「不换协议
 * 只换 carrier」的宿主半：worker 线程域与 fork 进程域两 spawn **同一套**
 * 处理方与行绑定簿记，spawn 形态差异（Worker vs child_process、IPC vs
 * NDJSON）不外溢到翻译层）。bindings/metaCache 是 per-domain 状态——由
 * 各 spawn 构造后传入，本函数只接线。
 */
export interface HostHandlersTarget {
  /** 宿主端点（处理方挂载面） */
  readonly endpoint: BridgeEndpoint;
  /** 域标识（toolCallId 前缀 / 诊断归因） */
  readonly workerId: string;
  /** 行绑定簿（applyRow 登记、行作用域回卷时清——onTell/emit 的行锚点） */
  readonly bindings: Map<string, RowBinding>;
  /** load 缓存（applyRow 取 optionalInject 快照用；load→apply 之间必持） */
  readonly metaCache: Map<string, WorkerModuleMeta>;
  /** tool-run 的调用序号（toolCallId 生成——桥接调用也要可归因可审计） */
  toolRunSeq: number;
  /** 应用锚作用域（svc-invoke 的服务解析源） */
  readonly root: ContextScope;
  /** 工具服务（缺省懒解析 root 的 'tools'——装载序晚期行友好） */
  readonly tools?: ToolsService;
}

/**
 * 注册六宿主处理方（svc-register / sub / emit / tools-register / svc-invoke /
 * tool-run——两载体共用，翻译纪律见本文件头注，与 worker.ts 桩一一对应）。
 */
export function registerHostHandlers(t: HostHandlersTarget): void {
  /**
   * 工具服务解析：显式注入优先，缺省懒解析 root 的 'tools' 服务（调用时点解析
   * 而非捕获时点——Ring 1 装载序里工具行可能晚于 worker 行激活，boot 期捕获会
   * 拿到 undefined 假裁剪形态；服务集两时点恒定不变式下运行期解析恒定）。
   */
  const resolveTools = (): ToolsService | undefined => t.tools ?? t.root.tryGet<ToolsService>('tools');

  const requireBinding = (rowId: string, surface: string): RowBinding => {
    const binding = t.bindings.get(rowId);
    if (binding === undefined) {
      throw new AppError(APP_LOAD_FAILED, `${surface}：行 ${rowId} 无宿主绑定（apply 未先行或已回卷）`);
    }
    return binding;
  };

  t.endpoint
    /* 域行 provide：宿主侧挂行作用域（main 域消费方拿方法转发代理——
     * thenable 陷阱防护见 makeWorkerServiceProxy；服务值面/同步 getter 不
     * 过界，v1 收窄：分域行提供的服务是异步方法面） */
    .handle('host', 'svc-register', ([rowIdArg, nameArg]) => {
      const rowId = String(rowIdArg);
      const binding = requireBinding(rowId, 'svc-register');
      binding.scope.provide(String(nameArg), makeWorkerServiceProxy(t.endpoint, rowId, String(nameArg)));
    })
    /* 域行订阅：行作用域 on + 转发器（args 过界 tell 回投域分派）。
     * sub 帧幂等（遗漏大扫 20260901 O-1）：同 (行,事件) 已挂转发器则直接
     * 返还——worker 半 0→1 单发使常态下簿内无重复，此处是对重复帧/竞窗
     * 重放的宿主侧防御（N 转发器 = 宿主 emit 扇出 N 次，主域 parity 破） */
    .handle('host', 'sub', ([rowIdArg, eventArg]) => {
      const rowId = String(rowIdArg);
      const event = String(eventArg);
      const binding = requireBinding(rowId, 'sub');
      if (binding.forwardedEvents.has(event)) return;
      binding.forwardedEvents.set(
        event,
        binding.scope.on(event, (...args: unknown[]) => {
          t.endpoint.tell('evt', { rowId, event, args });
        }),
      );
    })
    /* 域行退订：出簿先行再退订（遗漏大扫 20260901 O-1——退订对称面）。
     * worker 半 1→0 时发恰一条 unsub；无簿项时静默（行卸载竞窗里行回卷
     * 已清转发器，迟到的 unsub 不得炸——幂等面）。帧序 FIFO 保证
     * unsub→sub 重订阅竞速的序安全（后到的 sub 必见已空的簿项） */
    .handle('host', 'unsub', ([rowIdArg, eventArg]) => {
      const binding = t.bindings.get(String(rowIdArg));
      if (binding === undefined) return; // 行已回卷——转发器随作用域已收
      const off = binding.forwardedEvents.get(String(eventArg));
      if (off === undefined) return; // 无簿项（重复 unsub / 未订阅过）——静默
      binding.forwardedEvents.delete(String(eventArg));
      off();
    })
    /* 域行 emit：走宿主行作用域 emit（per-scope 限流单点） */
    .handle('host', 'emit', ([rowIdArg, eventArg, argsArg]) => {
      const binding = requireBinding(String(rowIdArg), 'emit');
      binding.scope.emit(String(eventArg), ...((argsArg ?? []) as unknown[]));
    })
    /* 域行工具注册：声明面本地落注册表，execute 翻译为 tool-invoke 桥接
     * 调用（signal 透传 + timeoutMs 预算随行——超时本地结算发 cancel 让域停工） */
    .handle('host', 'tools-register', ([rowIdArg, metaArg, domainArg]) => {
      const tools = resolveTools();
      if (tools === undefined) {
        throw new AppError(
          BRIDGE_METHOD_NOT_FOUND,
          'tools-register：本装配面未提供工具服务（裁剪形态——分域行不可注册工具）',
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
          t.endpoint.call('svc', 'tool-invoke', [rowId, meta.name, args, { toolCallId: ctx.toolCallId }], {
            signal: ctx.signal,
            ...(meta.timeoutMs !== undefined ? { timeoutMs: meta.timeoutMs } : {}),
          }),
      };
      // D1 注册面路由（契约篇 §5.1 挂载目标两档，SF9）：路由权威 = host 侧按行
      // app 键——注册罩 runInCallerChain(行 id) 帧，registry 经 chainCaller 归因
      // 行挂载目标（行带 app 键 → 应用域层）。域自报 domainArg 不采信为
      // 路由权威，仅 debug 注记（应用自报面降级诊断——冷读 SF9）。
      const unregister = runInCallerChain(rowId, () => tools.register(def));
      if (domainArg !== undefined) {
        binding.scope.logger.debug(
          `分域行 ${rowId} 注册工具 ${meta.name} 自报 domain=${String(domainArg)}（诊断注记——路由按行 app 键，不采信自报）`,
        );
      }
      // 行级清理：register 返回的注销器挂行作用域 effect——行回卷（apply 失败/
      // /reload/域死 exit 回卷）同步摘除注册（真注册表 remove + tools_change 广播）
      binding.scope.effect(() => () => unregister());
    })
    /* 域应用调宿主服务（会话与存储篇 §1.5 导入者归因——RPC 帧携带调用方列，
     * external carrier 落码批销账）：帧 [rowId, name, method, args]，宿主分派
     * 罩 runInCallerChain(rowId)——域应用经 ctx.get(...).method(...) 调宿主
     * 服务时，宿主侧服务面（createSession 读 chainCaller 等）拿到行归因。
     * 行绑定验（R1 复盘批 2026-08-29 补）：跨进程墙的 rowId 是不可信方自报
     * 值——不验绑定即容伪造归因身份污染清算面（宪章八），与同文件四处执法
     * （svc-register/sub/emit/tools-register）同形收口 */
    .handle('host', 'svc-invoke', ([rowIdArg, nameArg, methodArg, argsArg]) => {
      const rowId = String(rowIdArg);
      requireBinding(rowId, 'svc-invoke');
      // 'tools' 名响亮拒（R1 复盘批二侧门双封——契约篇 §1.7 第 11a 条）：
      // ToolsService 是宿主内部件非桥面服务——svc-invoke 直派其方法（尤其
      // executor）= 绕三段管道的第三条路（toolCallId/origin/def 全自报）。
      // 域内工具面唯一入口 = worker 半 get/tryGet 特判返回的本地桩 + 桩 run
      // 走 tool-run 真管道；本闸与 worker 半特判互为冗余防线（防任何代理
      // 构造路径——假端点/协议复放不含 worker 半拦截）
      if (String(nameArg) === 'tools') {
        throw new AppError(
          BRIDGE_METHOD_NOT_FOUND,
          "svc-invoke：'tools' 非桥面服务（工具面唯一入口 = 域内桩 run → tool-run 真管道——契约篇 §1.7 第 11a 条侧门双封）",
        );
      }
      const svc = t.root.get<Record<string, unknown>>(String(nameArg));
      const fn = svc?.[String(methodArg)];
      if (typeof fn !== 'function') {
        throw new AppError(BRIDGE_METHOD_NOT_FOUND, `宿主服务无此方法：${String(nameArg)}.${String(methodArg)}`);
      }
      return runInCallerChain(rowId, () => (fn as (...a: unknown[]) => unknown).apply(svc, argsArg as unknown[]));
    })
    /* 域便捷面 run 的宿主终端：宿主工具走真管道（schema→守门→执行唯一实现——
     * R1 复盘批 2026-08-29 管道化，原直调 def.execute 绕三段管道属违规面）；
     * 帧行绑定验（同 svc-invoke——归因不可伪造）+ 帧 rowId 罩
     * runInCallerChain（宿主执行段的归因面，exec/会话路由按链取数——
     * exec 服务按 chainCaller 行 id 收窄 confinement 即消费此帧） */
    .handle('host', 'tool-run', ([rowIdArg, nameArg, argsArg], signal) => {
      const tools = resolveTools();
      if (tools === undefined) {
        throw new AppError(BRIDGE_METHOD_NOT_FOUND, 'tool-run：本装配面未提供工具服务（裁剪形态）');
      }
      const rowId = String(rowIdArg);
      requireBinding(rowId, 'tool-run');
      const def = tools.get(String(nameArg));
      if (def === undefined) {
        throw new AppError(BRIDGE_METHOD_NOT_FOUND, `宿主无此工具：${String(nameArg)}`);
      }
      // 管道执行器（ToolsService 携带面）：无执行器 = 装配缺陷形态——响亮拒绝，
      // 不回退直调 execute（回退即重开绕管道漏洞）
      const executor = tools.executor;
      if (executor === undefined) {
        throw new AppError(BRIDGE_METHOD_NOT_FOUND, 'tool-run：工具服务无管道执行器（装配缺陷——禁直调 execute）');
      }
      const toolCallId = `bridge:${t.workerId}:${(t.toolRunSeq += 1)}`;
      // origin='service'（宿主服务面复入判别词——同 exec 服务先例）；调用面
      // 区分的审计归因由 toolCallId 前缀 bridge:<域>:<序> 承载（比 origin 更
      // 精确的身份面）。整个 executor 调用罩行帧——行收窄/委派链传导拿行归因；
      // durable 落账例外（R1 复盘批二 11d）：桥帧无宿主会话语境，转发壳
      // 桥帧守卫 no-op（宁缺勿错位——不落进不相干前台会话账本）
      return runInCallerChain(rowId, () =>
        executor(def, toolCallId, argsArg as Record<string, unknown>, signal, undefined, 'service'),
      );
    });
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
  /** 应用锚作用域（宿主侧 get/emit 的落点——svc-invoke 的服务解析源） */
  readonly root: ContextScope;
  /** 工具服务（缺省懒解析 root 的 'tools' 服务——Ring 1 装载序里工具行可能晚于 worker 行激活，捕获期解析会拿到 undefined） */
  readonly tools?: ToolsService;
  /** svc.load 在途超时（毫秒，缺省 60s——jiti 全图转译 + import 的合理上限） */
  readonly loadTimeoutMs?: number;
  /** 心跳节律（毫秒；**首次 svc.load 成功后起表**——boot 窗〔tsx 编译/模块装载〕ping 无应答属正常不计拍，该窗由 loadTimeoutMs 监督；运行期冻结由本探针执法，K3-c 监督编舞的配置面，端点机制见 session.ts） */
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
   * 携带（自崩溃无执法归因——code 即事实）；diagnostic = worker 'error' 事件
   * 的原始错误（构造名: 消息——自崩溃异常/内存超限签名，观测锚⑤判据源；
   * 无 error 事件即缺省不携带）。
   */
  readonly onExit?: (info: {
    readonly workerId: string;
    readonly code: number;
    readonly rows: readonly string[];
    readonly reason?: string;
    readonly diagnostic?: string;
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
  /** worker 半装载（loadApps 阶段① 消费） */
  load(row: AppPlanRow): Promise<WorkerModuleMeta>;
  /** 宿主半激活（loadApps activateOne 消费——经 makeRowLoader 包装） */
  applyRow(row: AppPlanRow, scope: ContextScope, opts?: { signal?: AbortSignal }): Promise<void>;
  /**
   * 域收尾（**刻意收尾**——编舞既知终点非事故）：不触发 onExit 通知（terminated
   * 旗标拦），行作用域回卷仍由 exit 监听器统一执行（P7：exit/error/terminate 即
   * 回卷——运行时骨架篇；terminate() 恒诱发 'exit'，监听器对 bindings 全行
   * scope.dispose，与 kill 同一监听器）。/reload/关停编舞中 terminate 与锚/ctx
   * LIFO 回卷竞速、dispose 幂等先到先收（遗漏大扫 20260901-d #14 勘正——原
   * 「不做域死回卷」子句与实现/规范 P7/关停序兄弟注释三方相反）。行级卸载不走
   * 这里，域级退出（/reload/关停）才用。
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
 * → 同目录 worker.ts，编译产物形态 → worker.js。TS 形态下 worker 预载参数见
 * spawnWorkerDomain 的 execArgv 自适应（tsx 补载）；编译产物形态零参数即对
 * ——两种形态零配置自适应。
 */
export function workerEntryUrl(selfUrl: string): URL {
  return new URL(selfUrl.endsWith('.ts') ? './worker.ts' : './worker.js', selfUrl);
}

/**
 * 本桥模块自带的 worker 同伴入口（组合根/舰队装配用）：按 bootstrap 自身形态
 * 判别（dev/TS 源 → 同目录 worker.ts；编译产物 → worker.js）。「worker 住在
 * bootstrap 旁」这条位置知识只在 bridge 模块内自描述——外部装配不重复推导。
 */
export function bridgeWorkerUrl(): URL {
  return workerEntryUrl(import.meta.url);
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
    // TS 源形态零配置自适应：Node type-stripping 不重写 .js→.ts 指示符，
    // 直跑 TS 源必 MODULE_NOT_FOUND——须有 tsx 预载链。dev（tsx 直跑）经
    // execArgv 继承自然延续；vitest 变换进程 execArgv 无 tsx，故 TS 形态且
    // 调用方未显式传参时自补 --import=tsx（TS 形态只在 dev/test 出现、tsx
    // 恒为在场 devDep；编译产物形态不进此分支零参数；显式注入面优先不受影响）
    ...(opts.execArgv !== undefined
      ? { execArgv: [...opts.execArgv] }
      : workerUrl.pathname.endsWith('.ts')
        ? { execArgv: ['--import=tsx'] }
        : {}),
    ...(opts.resourceLimits !== undefined ? { resourceLimits: { ...opts.resourceLimits } } : {}),
    ...(opts.env !== undefined ? { env: { ...opts.env } } : {}),
  });

  /** 行绑定簿（applyRow 登记、行作用域回卷时清——onTell/emit 的行锚点） */
  const bindings = new Map<string, RowBinding>();
  /** load 缓存（applyRow 取 optionalInject 快照用；load→apply 之间必持） */
  const metaCache = new Map<string, WorkerModuleMeta>();

  let endpoint!: BridgeEndpoint;
  endpoint = new BridgeEndpoint(worker, {
    origin: { workerId },
    // 心跳 missLimit/onFreeze 先挂（探针不在此起——boot 窗不计数，见下方
    // domain.load 成功后的起表点；机制住 session.ts，编舞分窗在此）
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
  // 心跳是否已起表（首次 svc.load 成功起表——防多行共域重复起表）
  let heartbeatArmed = false;

  // worker 内未捕获异常：Node 把 'error' 事件投给 Worker 对象——无监听器则按
  // EventEmitter 语义冒泡主进程 uncaughtException（worker 崩溃反杀宿主 = 违背
  // 故障域分域本义）。吸收冒泡；exit 事件随后到达走域死回卷 + 死亡结算全流程。
  // 同时收编为诊断面（观测锚⑤判据源，刀三）：存档原始错误（构造名: 消息），
  // 随 onExit.diagnostic 透出——自崩溃第一手异常/内存超限签名（probe-oom 实证
  // 签名 "Worker terminated due to reaching memory limit"，exit code 与普通崩溃
  // 同码 1，签名是唯一判据）
  let lastWorkerError: string | undefined;
  worker.on('error', (err) => {
    lastWorkerError = `${err.constructor.name}: ${err.message}`;
  });

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
        opts.onExit?.({
          workerId,
          code,
          rows: rowIds,
          ...(killReason !== undefined ? { reason: killReason } : {}),
          ...(lastWorkerError !== undefined ? { diagnostic: lastWorkerError } : {}),
        });
      }
    });
  });

  // 六宿主处理方注册（两载体共享面——external carrier 落码批抽取）
  registerHostHandlers({
    endpoint,
    workerId,
    bindings,
    metaCache,
    toolRunSeq: 0,
    root: opts.root,
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
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
          [{ id: row.id, entry: row.entry, config: row.config, sandbox: row.sandbox }],
          { timeoutMs: opts.loadTimeoutMs ?? 60_000 },
        )
        .then((meta) => {
          // 心跳起表点（一次性）：首次装载成功 = 域就绪（处理方挂好 + 事件循环
          // 活）。boot 窗的 ping 无应答属冷启正常，不计拍——该窗由 load 超时
          // 监督；此后运行期冻结才归本探针执法（两窗分工，K3-c 监督编舞）
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
      bindings.set(row.id, { scope, forwardedEvents: new Map() });
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
 * 物化 WorkerRowLoader（loadApps opts.workerLoader 注入物——组合根装配序
 * 把 bridge 域接到 context 装载管线的唯一缝）。
 */
export function makeRowLoader(domain: WorkerDomain): WorkerRowLoader {
  return {
    load: (row) => domain.load(row),
    apply: (row, scope, opts) => domain.applyRow(row, scope, opts),
  };
}
