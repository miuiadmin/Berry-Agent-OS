/**
 * bridge — worker 域入口（契约篇 §1.7，2026-08-26 第二十七批刀二 K3-b2）。
 *
 * 「装载管线两半拆分」的 worker 半：本文件活在 worker_threads 子进程里，
 * 经 BridgeEndpoint 暴露三个固定 service 方法（svc.load / svc.apply /
 * svc.unload），并物化**代理桩 ctx**——应用 apply 拿到的 ctx 表面同
 * AppContext，底下一切跨域动作翻译为桥接消息：
 *
 * - ctx.get(name)          → 服务代理（方法调用 → ask('host','svc-invoke')）
 *   （'tools' 特例：本地桩——register 翻译为 tools-register、run 走宿主管道）
 * - ctx.tryGet(name)       → optionalInject 在场快照（激活时宿主侧探测随 apply
 *   载荷过界——同步返回语义靠快照保真，收窄清单注记）
 * - ctx.provide(name,impl) → 本地登记 + ask('host','svc-register')（宿主侧挂
 *   行作用域 provide——main 域消费方拿到的是方法转发代理）
 * - ctx.on/emit            → 本地登记 + 宿主侧行作用域 on/emit（事件总线唯一
 *   宿主侧；宿主 emit 回投 tell('evt') 由本端点 onTell 分派到本地处理器）
 * - ctx.effect             → 本地 LIFO 回卷栈（unload 时逐条执行——worker 侧
 *   定时器/句柄只有这里够得着）
 * - ctx.logger             → tell('log') 单向上行（worker 直打 stdout 会砸穿
 *   TUI 渲染——日志纪律单点：宿主 logger 统一格式与级别过滤）
 * - ctx.signal             → 行控制器（apply 取消（桥接入站 signal）/unload
 *   双源 abort——应用长任务对齐响应）
 *
 * v1 同步收窄面（BRIDGE_SURFACE_NARROWED 响亮 throw，契约篇 §1.7 清单）：
 * parallel/serial/waterfall / registerMessageRole / registerSessionEventType /
 * tools 桩的 get/list/listFor/stats/toAgentTool。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { AppError, BRIDGE_METHOD_NOT_FOUND, BRIDGE_SURFACE_NARROWED, APP_LOAD_FAILED } from '../contracts/errors.js';
import type { AppEventHandler } from '../contracts/app.js';
import type { ToolDefinition } from '../contracts/tools.js';
import {
  createAppJiti,
  importAppEntry,
  validateEventDefs,
  validateModuleShape,
  type ValidatedModule,
  type WorkerModuleMeta,
} from '../context/loader.js';
import { BridgeEndpoint, type BridgePort } from './session.js';

/* ------------------------------------------------------------------ */
/* 行状态（worker 域侧的行注册面——宿主作用域回卷经 svc.unload 联动到这里） */
/* ------------------------------------------------------------------ */

/** 单行 worker 域注册面：四大登记簿 + LIFO 回卷栈 + 行控制器 */
interface RowState {
  /** ctx.effect 压栈的清理函数（unload 按入栈逆序执行——与宿主 LIFO 同纪律） */
  readonly disposers: Array<() => void>;
  /** 本行 provide 的服务实现（worker 域真对象——宿主侧消费经 svc.invoke 到此分派） */
  readonly services: Map<string, Record<string, unknown>>;
  /** 本行注册的工具执行体（tool-invoke 分派目标——execute 不过界，留在本域） */
  readonly toolHandlers: Map<string, ToolDefinition['execute']>;
  /** 本行事件处理器（event → 处理器组；宿主 tell('evt') 回投到此） */
  readonly eventHandlers: Map<string, AppEventHandler[]>;
  /** 行控制器：apply 取消与 unload 双源 abort（ctx.signal 的真身） */
  readonly ctl: AbortController;
  /** unload 后为 true——注册面关闭，后续桩调用响亮拒绝（失败行不留残骸） */
  disposed: boolean;
}

/** 行 id → 行状态（一 worker 域可承载多行——键合在行 id 上） */
const rows = new Map<string, RowState>();

/** 行 id → 校验后模块（svc.load 登记、svc.apply 消费、unload 清除） */
const modules = new Map<string, ValidatedModule>();

/**
 * 本 realm 的 jiti 实例（懒建）：虚拟面第五/六键为空对象面（与 loadApps
 * 缺省同构——注入物是宿主 realm 函数不可过界，worker 域按需开面另批）。
 */
let realmJiti: ReturnType<typeof createAppJiti> | undefined;

/** 日志单向上行（fire-and-forget——tell 无回应面；宿主 onTell 分派到行 logger） */
function logUp(
  endpoint: BridgeEndpoint,
  rowId: string,
  level: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  endpoint.tell('log', { rowId, level, message, fields });
}

/** 收窄面统一 throw（v1 同步收窄清单——宁响亮不静默假实现） */
function narrowed(surface: string): never {
  throw new AppError(
    BRIDGE_SURFACE_NARROWED,
    `worker 域 v1 收窄面：${surface} 暂不可用（同步收窄清单见契约篇 §1.7——需要时走宿主侧等价面）`,
  );
}

/** 注册面存活断言（unload 后注册簿已死——迟到的桩调用响亮失败不留暗残骸） */
function assertAlive(state: RowState, surface: string): void {
  if (state.disposed) {
    throw new AppError(BRIDGE_SURFACE_NARROWED, `worker 域行已卸载：${surface} 注册面已关闭`);
  }
}

/** 单行收尾：标记死亡 → abort 行控制器 → LIFO 回卷 effect 栈（异常隔离逐条吞日志） */
function disposeRow(endpoint: BridgeEndpoint, rowId: string): void {
  const state = rows.get(rowId);
  if (state === undefined) return;
  state.disposed = true;
  state.ctl.abort();
  // LIFO 逆序执行；单条回卷异常不阻断其余（与宿主作用域回卷同语义——吞掉留日志）
  for (const disposer of state.disposers.reverse()) {
    try {
      disposer();
    } catch (err) {
      logUp(endpoint, rowId, 'warn', 'worker 域 effect 回卷抛错（已吞——不阻断其余回卷）', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  state.disposers.length = 0;
  state.services.clear();
  state.toolHandlers.clear();
  state.eventHandlers.clear();
  rows.delete(rowId);
  modules.delete(rowId);
}

/* ------------------------------------------------------------------ */
/* 代理桩 ctx 物化                                                      */
/* ------------------------------------------------------------------ */

/**
 * worker 域工具桩（ctx.get('tools') 的拦截返回——ToolsService 的收窄投影）：
 * register = 声明面过界 + 执行体留本域；run = 便捷面（宿主工具经管道执行）。
 * 其余面（executor/get/list/listFor/toAgentTool/stats）v1 收窄。
 */
function makeToolsStub(
  endpoint: BridgeEndpoint,
  state: RowState,
  rowId: string,
  registrations: Promise<unknown>[],
): {
  register(def: ToolDefinition, opts?: { domain?: string }): void;
  run(name: string, args: Record<string, unknown>): Promise<unknown>;
} {
  return {
    register(def, opts) {
      assertAlive(state, 'tools.register');
      // 执行体留 worker 域（函数不可过界）；声明面五字段结构化克隆过界，
      // 宿主侧 execute 翻译为 tool-invoke 桥接调用（超时预算随 def 原样携带）
      state.toolHandlers.set(def.name, def.execute);
      const meta: Record<string, unknown> = {
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      };
      if (def.effect !== undefined) meta['effect'] = def.effect;
      if (def.timeoutMs !== undefined) meta['timeoutMs'] = def.timeoutMs;
      if (def.label !== undefined) meta['label'] = def.label;
      registrations.push(endpoint.call('host', 'tools-register', [rowId, meta, opts?.domain]));
    },
    run(name, args) {
      // 便捷面：宿主工具走真管道（schema→守门→执行三段在宿主侧唯一实现）；
      // 帧携带 rowId（RPC 帧调用方列——宿主执行段按链归因，与 svc-invoke 同批）
      return endpoint.call('host', 'tool-run', [rowId, name, args], { signal: state.ctl.signal });
    },
  };
}

/**
 * 宿主服务代理（ctx.get(name) 的缺省返回）：任意方法调用 → ask('host',
 * 'svc-invoke', [rowId, name, method, args])——同步阻抗下 Promise 面是唯一
 * 形态。帧携带 rowId（RPC 帧调用方列——external carrier 落码批销账：宿主
 * 服务面按 chainCaller 拿到行归因，与 sessionId 链同族）。
 * then/catch/finally 与 symbol 属性返回 undefined：防 Promise.resolve(proxy)
 * 把代理误判 thenable（await 假结算的结构性陷阱）。
 */
function makeHostServiceProxy(
  endpoint: BridgeEndpoint,
  rowId: string,
  name: string,
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
        return (...args: unknown[]) => endpoint.call('host', 'svc-invoke', [rowId, name, prop, args]);
      },
    },
  );
}

/**
 * 代理桩 ctx（结构对齐 contracts AppContext——apply 的 ctx 实参）。
 * registrations：apply 期间发起的一切过界注册（svc-register/sub/tools-register）
 * 的 promise 集合——svc.apply 在 default 返还后 await 全体，保证 activated 事件
 * 时宿主侧注册已全部落定（时序确定性；单个注册失败 = apply 失败同路回卷）。
 */
function makeStubCtx(
  endpoint: BridgeEndpoint,
  state: RowState,
  rowId: string,
  config: Readonly<Record<string, unknown>>,
  presence: Readonly<Record<string, boolean>>,
  registrations: Promise<unknown>[],
): Record<string, unknown> {
  const logger = {
    debug: (message: string, fields?: Record<string, unknown>) => logUp(endpoint, rowId, 'debug', message, fields),
    info: (message: string, fields?: Record<string, unknown>) => logUp(endpoint, rowId, 'info', message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => logUp(endpoint, rowId, 'warn', message, fields),
    error: (message: string, fields?: Record<string, unknown>) => logUp(endpoint, rowId, 'error', message, fields),
  };
  return {
    effect(fn: () => unknown) {
      assertAlive(state, 'effect');
      const disposer = fn();
      // typeof 收窄只得 Function——显式断言到清理函数形（AppContext.effect 契约：返回清理函数或 undefined）
      if (typeof disposer === 'function') state.disposers.push(disposer as () => void);
      // 手动注销：从栈摘除后执行（幂等性由调用方自律——与宿主 effect 同形）
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const idx = state.disposers.indexOf(disposer as () => void);
        if (idx >= 0) state.disposers.splice(idx, 1);
        if (typeof disposer === 'function') disposer();
      };
    },
    on(event: string, handler: AppEventHandler, opts?: { prepend?: boolean }) {
      assertAlive(state, `on(${event})`);
      // 本地登记先行（宿主侧 sub 落定前事件回投不可能——tell 晚于注册往返）
      const list = state.eventHandlers.get(event) ?? [];
      if (opts?.prepend) list.unshift(handler);
      else list.push(handler);
      state.eventHandlers.set(event, list);
      registrations.push(endpoint.call('host', 'sub', [rowId, event]));
      return () => {
        const current = state.eventHandlers.get(event);
        if (current === undefined) return;
        const idx = current.indexOf(handler);
        if (idx >= 0) current.splice(idx, 1);
        if (current.length === 0) state.eventHandlers.delete(event);
      };
    },
    emit(event: string, ...args: unknown[]) {
      assertAlive(state, `emit(${event})`);
      // fire-and-forget：宿主 emit 同步 void 语义——迟到失败只留日志不打断调用方
      void endpoint.call('host', 'emit', [rowId, event, args]).catch((err: unknown) => {
        logger.warn('ctx.emit 过界失败（已吞）', { event, error: err instanceof Error ? err.message : String(err) });
      });
    },
    parallel: () => narrowed('ctx.parallel'),
    serial: () => narrowed('ctx.serial'),
    waterfall: () => narrowed('ctx.waterfall'),
    get(name: string) {
      // 'tools' 特例拦截：本地桩（register/run 两面）；其余服务走宿主代理
      if (name === 'tools') return makeToolsStub(endpoint, state, rowId, registrations);
      return makeHostServiceProxy(endpoint, rowId, name);
    },
    tryGet(name: string) {
      // optionalInject 在场快照（宿主激活时探测随 apply 载荷过界）——名单外
      // 词汇（未声明 optionalInject 的名字）一律 undefined（同步探测不可过界，
      // 收窄语义：要探测就先声明 optionalInject——声明面零变化下唯一合理口径）
      return presence[name] === true ? makeHostServiceProxy(endpoint, rowId, name) : undefined;
    },
    provide(name: string, impl: unknown) {
      assertAlive(state, `provide(${name})`);
      state.services.set(name, impl as Record<string, unknown>);
      registrations.push(endpoint.call('host', 'svc-register', [rowId, name]));
      return () => {
        state.services.delete(name);
      };
    },
    registerMessageRole: () => narrowed('ctx.registerMessageRole'),
    registerSessionEventType: () => narrowed('ctx.registerSessionEventType'),
    config: Object.freeze({ ...config }),
    logger,
    signal: state.ctl.signal,
  };
}

/* ------------------------------------------------------------------ */
/* worker 域启动（svc 三方法 + onTell 分派）                             */
/* ------------------------------------------------------------------ */

/**
 * 启动 worker 域桥接端：注册 svc.load/apply/unload/invoke/tool-invoke 五处理方
 * + tell 分派（evt 事件回投）。导出供单测用 MessageChannel 直连（不必真起
 * worker_threads 子进程）。
 */
export function startWorkerRealm(port: BridgePort, workerId: string): BridgeEndpoint {
  // 先声明后构造：onTell 闭包需要 endpoint 引用（回卷失败日志上行用）
  let endpoint!: BridgeEndpoint;
  const dispatchTell = (event: string, payload: unknown): void => {
    if (event !== 'evt') return;
    const { rowId, event: evtName, args } = payload as { rowId: string; event: string; args: unknown[] };
    const handlers = rows.get(rowId)?.eventHandlers.get(evtName);
    if (handlers === undefined) return; // 迟到回投（已退订/已卸载行）——静默丢弃
    for (const handler of [...handlers]) {
      try {
        const ret = handler(...(args ?? []));
        // 异步处理器：失败隔离留日志（与宿主 emit 的单点隔离同语义）
        if (ret instanceof Promise) {
          ret.catch((err: unknown) => {
            logUp(endpoint, rowId, 'error', 'worker 域事件处理器异步失败（已吞——不阻断其余处理器）', {
              event: evtName,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } catch (err) {
        logUp(endpoint, rowId, 'error', 'worker 域事件处理器同步抛错（已吞——不阻断其余处理器）', {
          event: evtName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  endpoint = new BridgeEndpoint(port, { origin: { workerId }, onTell: dispatchTell });
  endpoint
    /* svc.load：jiti import + 形状/事件校验（worker 半的全部装载职责），
     * 元数据过界回宿主（结构化克隆——schema 是纯数据对象，PoC 实证无损） */
    .handle('svc', 'load', async ([row]) => {
      const lite = row as { id: string; entry?: string };
      if (typeof lite.id !== 'string' || typeof lite.entry !== 'string') {
        throw new AppError(APP_LOAD_FAILED, 'svc.load 载荷缺 id/entry（装载管线不变量被破坏）');
      }
      realmJiti ??= createAppJiti();
      const mod = await importAppEntry(realmJiti, lite.entry);
      const module = validateModuleShape(mod, lite.id);
      validateEventDefs(module.events, lite.id);
      modules.set(lite.id, module);
      const meta: WorkerModuleMeta = {
        name: module.name,
        // 条件展开：只携带声明面真实存在的字段（宿主侧按 undefined 判缺省）
        ...(module.inject !== undefined ? { inject: module.inject } : {}),
        ...(module.optionalInject !== undefined ? { optionalInject: module.optionalInject } : {}),
        ...(module.config !== undefined ? { config: module.config } : {}),
        ...(module.events !== undefined ? { events: module.events } : {}),
        ...(module.skills !== undefined ? { skills: module.skills } : {}),
      };
      return meta;
    })
    /* svc.apply：重建行状态 → 桩 ctx → default(ctx, config) → 注册排水。
     * signal = 桥接入站取消（宿主 apply 超时/域死）→ 联动行控制器 abort */
    .handle('svc', 'apply', async ([rowIdArg, configArg, presenceArg], signal) => {
      const rowId = rowIdArg as string;
      const config = (configArg ?? {}) as Readonly<Record<string, unknown>>;
      const presence = (presenceArg ?? {}) as Readonly<Record<string, boolean>>;
      const module = modules.get(rowId);
      if (module === undefined) {
        throw new AppError(APP_LOAD_FAILED, `svc.apply 先行装载缺失（行 ${rowId}——load 必先于 apply）`);
      }
      // 重装先行清旧（/reload 全新装载语义——旧行状态若在即回卷，幂等）
      disposeRow(endpoint, rowId);
      const state: RowState = {
        disposers: [],
        services: new Map(),
        toolHandlers: new Map(),
        eventHandlers: new Map(),
        ctl: new AbortController(),
        disposed: false,
      };
      rows.set(rowId, state);
      signal.addEventListener('abort', () => state.ctl.abort(), { once: true });
      const registrations: Promise<unknown>[] = [];
      const ctx = makeStubCtx(endpoint, state, rowId, config, presence, registrations);
      try {
        await module.default(ctx as unknown as Parameters<typeof module.default>[0], config);
        // 注册排水：全部过界注册落定才算 apply 完成（activated 时序确定）
        await Promise.all(registrations);
      } catch (err) {
        // 失败同路回卷：worker 侧行状态清掉（宿主侧 scope.dispose 由装载器做）
        disposeRow(endpoint, rowId);
        throw err;
      }
    })
    /* svc.unload：宿主侧行作用域回卷的联动终端（LIFO effect 栈逆序执行） */
    .handle('svc', 'unload', ([rowIdArg]) => {
      disposeRow(endpoint, rowIdArg as string);
    })
    /* svc.invoke：宿主（main 域消费方）调 worker 行 provide 的服务——
     * 本地实现分派；缺实现/缺方法响亮 METHOD_NOT_FOUND */
    .handle('svc', 'invoke', ([rowIdArg, nameArg, methodArg, argsArg]) => {
      const impl = rows.get(rowIdArg as string)?.services.get(nameArg as string);
      const fn = impl?.[methodArg as string];
      if (typeof fn !== 'function') {
        throw new AppError(
          BRIDGE_METHOD_NOT_FOUND,
          `worker 域无此服务方法：${String(rowIdArg)}/${String(nameArg)}.${String(methodArg)}`,
        );
      }
      return (fn as (...a: unknown[]) => unknown).apply(impl, argsArg as unknown[]);
    })
    /* svc.tool-invoke：宿主工具管道 → worker 行注册的工具执行体 */
    .handle('svc', 'tool-invoke', ([rowIdArg, toolArg, argsArg, ctxLiteArg], signal) => {
      const execute = rows.get(rowIdArg as string)?.toolHandlers.get(toolArg as string);
      if (execute === undefined) {
        throw new AppError(BRIDGE_METHOD_NOT_FOUND, `worker 域无此工具执行体：${String(rowIdArg)}/${String(toolArg)}`);
      }
      const lite = (ctxLiteArg ?? {}) as { toolCallId?: string };
      // onUpdate 函数不可过界（v1 收窄——进度流式上报留宿主侧管道面）
      return execute(argsArg as Record<string, unknown>, { toolCallId: lite.toolCallId ?? 'bridge-unknown', signal });
    });
  return endpoint;
}

/* ----------------------- 真 worker 进程入口（测试直 import 时 no-op） ----------------------- */
if (parentPort !== null) {
  const data = workerData as { workerId?: string } | undefined;
  const workerId = typeof data?.workerId === 'string' ? data.workerId : 'worker';
  startWorkerRealm(parentPort, workerId);
}
