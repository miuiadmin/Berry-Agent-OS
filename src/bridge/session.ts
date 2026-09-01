/**
 * bridge — 桥接端点：契约篇 §1.7 桥接协议 v0 的两侧编解码收敛单点
 * （2026-08-26 第二十七批刀二 K3-a）。
 *
 * 设计基线 = PoC 补票实证（tools/poc-worker/4-hello.*，eee3e45 六断言）：
 * 1. **同步阻抗**：结构化克隆无函数——同步函数过界结构性不可能，call() 的
 *    Promise 面是唯一形态（不是实现取舍是物理限制）；
 * 2. **取消消息化**：AbortSignal 不可克隆——abort 时本地立即结算（实测 4ms，
 *    不等对端往返）+ 发 {kind:'cancel', callId}，对端掐断在途入站调用；
 * 3. **迟到纪律**：已结算调用收到对端迟到 result 一律丢弃——迟到不复活、
 *    不二次结算、不进 unhandledRejection（onDropped 可观测）；
 * 4. **对称双向**：ask/result/cancel/tell 两方向同构（宿主调 worker 域注册项 /
 *    worker 域调宿主服务同一套消息面）；ping 任一端必答，心跳发送面由装配方
 *    配置——协议层无角色不对称；
 * 5. **carrier 无关**：消息一切字段 JSON 可编码——本端点只依赖 PortLike
 *    {postMessage, on('message')}（node:worker_threads MessagePort 结构性
 *    满足；案三 fork carrier NDJSON over stdio 预留同一份 schema）。
 *
 * 生命周期与监督（spawn 两时点 / 心跳缺失 terminate / 域死回卷）住组合根装配
 * 层（K3-c），不入本模块面——本模块是纯机制。
 */
import type { BridgeErrorEnvelope, BridgeMessage } from '../contracts/bridge.js';
import {
  AppError,
  BRIDGE_CALL_TIMEOUT,
  BRIDGE_CANCELLED,
  BRIDGE_ENCODE_FAILED,
  BRIDGE_HANDLER_FAILED,
  BRIDGE_METHOD_NOT_FOUND,
  BRIDGE_WORKER_EXITED,
} from '../contracts/errors.js';

/**
 * 载体抽象：MessagePort 形的最小面。宿主↔worker 走 node:worker_threads
 * MessagePort；测试走 MessageChannel 端口对（无需真起 worker）。
 */
export interface BridgePort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): void;
}

/**
 * 入站处理器：args 数组 + 该调用的取消信号（对端 cancel 消息翻译而来——
 * 取消契约在两个域间由这条翻译保真）。返回值必须是 JSON 可编码形
 * （或结构化克隆可过界形）。
 */
export type BridgeHandler = (args: unknown[], signal: AbortSignal) => unknown | Promise<unknown>;

/** 端点选项 */
export interface BridgeEndpointOptions {
  /** 本端错误信封归因（诊断面：跨域栈不假装连续，归因字段替代） */
  readonly origin?: { workerId?: string; app?: string };
  /** 心跳节律（毫秒）。设置即启动探针——装配方（宿主监督面）的配置项 */
  readonly heartbeatMs?: number;
  /** 连续丢拍阈值（超过即 onFreeze 并停表；缺省 3） */
  readonly heartbeatMissLimit?: number;
  /** 冻结判定回调（心跳缺失——terminate 决策在调用方，本层只报事实，一次性触发） */
  readonly onFreeze?: (info: { missed: number }) => void;
  /** tell 到达回调（单向通知上行——K3-b 接宿主事件总线） */
  readonly onTell?: (event: string, payload: unknown) => void;
  /** 丢弃观测（迟到 result / 迟到 cancel / dispose 后消息 / v0 未接线消息——测试与诊断面） */
  readonly onDropped?: (message: BridgeMessage) => void;
}

/** 出站在途调用条目：settled 标记实现迟到纪律（结算后同 callId 消息一律丢） */
interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  /** 是否已结算（取消/超时/域死/正常回应任一先到即 true） */
  settled: boolean;
  /** 超时定时器（有 timeoutMs 才挂；结算路径负责清） */
  timer?: ReturnType<typeof setTimeout>;
  /** abort 监听器（结算路径负责摘，防泄漏累积） */
  onAbort?: () => void;
  /** 调用方 signal（摘监听用） */
  signal?: AbortSignal;
}

/** 桥接端点：一个载体端口上的协议编解码 + 调用簿记 */
export class BridgeEndpoint {
  /** 出站 callId 发号器（每端独立——按 kind 分派无歧义，见 contracts/bridge.ts 头注） */
  private nextCallId = 1;
  /** 出站在途：callId → 条目（result 只匹配这里） */
  private readonly pending = new Map<number, PendingCall>();
  /** 入站在途：callId → 取消控制器（ask 登记于此，cancel 只作用于这里） */
  private readonly inbound = new Map<number, AbortController>();
  /** 入站处理器：service → method → fn（注册面，K3-b 由代理物化接线） */
  private readonly handlers = new Map<string, Map<string, BridgeHandler>>();
  /** 本端归因（错误信封附带） */
  private readonly origin?: { workerId?: string; app?: string };
  /** 心跳定时器（heartbeatMs 设置才有） */
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  /** 连续丢拍计数（pong 归零；超 missLimit 即 freeze，一次性） */
  private missedPongs = 0;
  /** 已冻结标记（onFreeze 只触发一次） */
  private frozen = false;
  /** dispose 后为 true：出站调用即刻拒绝，入站消息走丢弃观测 */
  private disposed = false;
  private readonly options: BridgeEndpointOptions;
  /** 载体端口（生命周期归调用方——本端点不 close 端口，只清自己的簿记）。
   *  显式字段声明 + 构造器赋值（非形参数属性）：载体值图须全可 type-strip——
   *  构造器形参数属性是 strip-only 模式不支持的语法（刀四载体去 tsx 化，
   *  node 原生直载 .ts 的唯一障碍点） */
  private readonly port: BridgePort;

  constructor(port: BridgePort, options: BridgeEndpointOptions = {}) {
    this.port = port;
    this.options = options;
    this.origin = options.origin;
    // 载体唯一接线点：一切入站消息从这里进分派器
    this.port.on('message', (m) => this.receive(m));
    if (options.heartbeatMs !== undefined) this.startHeartbeat(options.heartbeatMs);
  }

  /**
   * 注册入站处理器（幂等覆盖——/reload 重装载时同 service/method 再注册
   * 直接换新）。返回 this 供链式。
   */
  handle(service: string, method: string, fn: BridgeHandler): this {
    let byMethod = this.handlers.get(service);
    if (!byMethod) {
      byMethod = new Map();
      this.handlers.set(service, byMethod);
    }
    byMethod.set(method, fn);
    return this;
  }

  /**
   * 出站调用（唯一调用形态——Promise 面，同步阻抗见模块头注 1）。
   * - signal：abort 时本地立即结算 BRIDGE_CANCELLED + 发 cancel（不等对端）；
   * - timeoutMs：在途超时本地立即结算 BRIDGE_CALL_TIMEOUT + 发 cancel；
   * - 对端迟到 result 由迟到丢弃分支吸收。
   */
  call<T = unknown>(
    service: string,
    method: string,
    args: readonly unknown[],
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new AppError(BRIDGE_WORKER_EXITED, '桥已 dispose，拒绝新调用'));
    }
    const callId = this.nextCallId++;
    return new Promise<T>((resolve, reject) => {
      // 先登记后发消息：对端回应可能在 postMessage 返回前异步到达，顺序不可反
      const entry: PendingCall = {
        // 泛型 T 在簿记层收敛为 unknown——resolve 侧断言回 T（协议值本就是 unknown 面）
        resolve: (v) => resolve(v as T),
        reject,
        settled: false,
      };
      this.pending.set(callId, entry);

      // 调用方 abort → 本地结算 + 通知对端停工
      if (opts?.signal) {
        entry.signal = opts.signal;
        entry.onAbort = () => {
          if (entry.settled) return;
          this.settleFailure(entry, callId, BRIDGE_CANCELLED, '调用方已取消（本地结算，不等对端）');
          this.send({ kind: 'cancel', callId });
        };
        opts.signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      // 在途超时 → 与取消同路径（停表 + 本地结算 + 发 cancel）
      if (opts?.timeoutMs !== undefined) {
        entry.timer = setTimeout(
          () => {
            if (entry.settled) return;
            this.settleFailure(entry, callId, BRIDGE_CALL_TIMEOUT, `在途调用超时（${opts.timeoutMs}ms）`);
            this.send({ kind: 'cancel', callId });
          },
          Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 0,
        );
      }

      // ask 帧编码失败（args 含 BigInt/循环引用等）：**只结算本调用**，端点
      // 与其余在途调用不株连——消息未发出、对端无入站调用，无 cancel 必要
      //（20260901-c #4：旧形 catch 一律 dispose——单条坏消息株连全端点，
      // 且 stdio 腿子进程仍活 → exit 永不来 = 僵尸域）
      if (this.send({ kind: 'ask', callId, service, method, args }) === 'message-dropped') {
        this.settleFailure(
          entry,
          callId,
          BRIDGE_ENCODE_FAILED,
          '调用参数不可编码（JSON 通道：BigInt/循环引用）——消息未发出',
        );
      }
    });
  }

  /** 单向通知（fire-and-forget，不期待回应；接收面 onTell） */
  tell(event: string, payload: unknown): void {
    this.send({ kind: 'tell', event, payload });
  }

  /** 启动心跳探针（构造时 heartbeatMs 已设则自动启动；重复调用先停旧表） */
  startHeartbeat(ms: number): void {
    this.stopHeartbeat();
    this.missedPongs = 0;
    this.frozen = false;
    this.heartbeatTimer = setInterval(() => this.tick(), ms);
  }

  /** 停表（不改变 disposed 状态——/reload 换端点时宿主侧主动停旧表用） */
  stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * 收尾：一切在途出站调用以 BRIDGE_WORKER_EXITED 结算、入站控制器掐断、
   * 心跳停表。此后出站调用即刻拒绝、入站消息走丢弃观测。端口本身不 close
   * （载体生命周期归调用方）。幂等。
   */
  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopHeartbeat();
    // 出站在途：域死结算（副本遍历——settleFailure 会改 Map）
    for (const [callId, entry] of [...this.pending]) {
      this.settleFailure(entry, callId, BRIDGE_WORKER_EXITED, reason);
    }
    // 入站在途：掐断信号（处理器若守 signal 契约会自行收尾）
    for (const ctl of [...this.inbound.values()]) ctl.abort();
    this.inbound.clear();
  }

  /** 是否已 dispose（监督面查询） */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 在途出站调用数（监督面诊断：域死结算前的影响面清点） */
  get pendingCount(): number {
    return this.pending.size;
  }

  // ------------------------------------------------------------------
  // 内部：入站分派
  // ------------------------------------------------------------------

  /** 入站消息分派器（载体唯一接线点的回调） */
  private receive(message: unknown): void {
    if (this.disposed) {
      this.dropped(message);
      return;
    }
    const m = message as BridgeMessage;
    switch (m.kind) {
      case 'result': {
        // 迟到纪律：无条目或已结算 = 迟到 result，丢弃（不复活、不二次结算）
        const entry = this.pending.get(m.callId);
        if (entry === undefined || entry.settled) {
          this.dropped(m);
          return;
        }
        if (m.ok) {
          this.settleSuccess(entry, m.callId, m.value);
        } else {
          const env = m.error ?? { code: BRIDGE_HANDLER_FAILED, message: '回应缺错误信封' };
          this.settleFailure(entry, m.callId, env.code, formatEnvelopeMessage(env));
        }
        return;
      }
      case 'ask': {
        this.handleAsk(m.callId, m.service, m.method, m.args);
        return;
      }
      case 'cancel': {
        // 对端取消其出站调用 = 掐断本端的对应入站调用；无条目 = 迟到 cancel，丢弃
        const ctl = this.inbound.get(m.callId);
        if (ctl === undefined) {
          this.dropped(m);
          return;
        }
        this.inbound.delete(m.callId);
        ctl.abort();
        return;
      }
      case 'tell': {
        this.options.onTell?.(m.event, m.payload);
        return;
      }
      case 'ping': {
        // 必答（t 原样回传——单钟测往返）
        this.send({ kind: 'pong', t: m.t });
        return;
      }
      case 'pong': {
        this.missedPongs = 0;
        return;
      }
      default: {
        // intercept（v0 预留词）与未来消息：可观测丢弃，不静默
        this.dropped(m);
      }
    }
  }

  /** 入站 ask 执行：找不到处理器即以 BRIDGE_METHOD_NOT_FOUND 回应（不静默） */
  private handleAsk(callId: number, service: string, method: string, args: readonly unknown[]): void {
    const fn = this.handlers.get(service)?.get(method);
    if (fn === undefined) {
      this.send({
        kind: 'result',
        callId,
        ok: false,
        error: { code: BRIDGE_METHOD_NOT_FOUND, message: `无处理方：${service}.${method}`, origin: this.origin },
      });
      return;
    }
    // 登记入站控制器：对端 cancel → 掐断（协作式处理器守 signal 契约）
    const ctl = new AbortController();
    this.inbound.set(callId, ctl);
    // 异步执行不阻塞分派器；结局（含异常）一律回 result——try/catch 全包，
    // 处理器异常永不进本端 unhandledRejection
    void (async () => {
      try {
        const value = await fn([...args], ctl.signal);
        // 执行中途被取消也照发 result：调用方已本地结算，这条「迟到 result」
        // 由对端丢弃分支吸收——结局必达的消息对称性优于就地吞掉。
        // result 帧编码失败（处理方返回值不可编码）：降级为可编码的错误信封
        // 回应——对端调用不挂死；信封恒字符串面，降级帧再失败不可达
        if (this.send({ kind: 'result', callId, ok: true, value }) === 'message-dropped') {
          this.send({
            kind: 'result',
            callId,
            ok: false,
            error: {
              code: BRIDGE_HANDLER_FAILED,
              message: '处理方返回值不可编码（JSON 通道：BigInt/循环引用）——已降级为错误信封',
              origin: this.origin,
            },
          });
        }
      } catch (err) {
        this.send({ kind: 'result', callId, ok: false, error: toEnvelope(err, this.origin) });
      } finally {
        this.inbound.delete(callId);
      }
    })();
  }

  // ------------------------------------------------------------------
  // 内部：结算与发送
  // ------------------------------------------------------------------

  /** 正常结算：清簿记后 resolve */
  private settleSuccess(entry: PendingCall, callId: number, value: unknown): void {
    entry.settled = true;
    this.cleanupEntry(entry);
    this.pending.delete(callId);
    entry.resolve(value);
  }

  /** 失败结算：清簿记后 reject(AppError(code))——取消/超时/域死/错误信封共用 */
  private settleFailure(entry: PendingCall, callId: number, code: string, message: string): void {
    entry.settled = true;
    this.cleanupEntry(entry);
    this.pending.delete(callId);
    entry.reject(new AppError(code, message));
  }

  /** 结算公共清理：摘 abort 监听、清超时表（防泄漏累积） */
  private cleanupEntry(entry: PendingCall): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (entry.onAbort !== undefined && entry.signal !== undefined) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
  }

  /** 发送唯一出口（三态返回——20260901-c #4 分桶）：
   * - 'sent'：消息已交载体；
   * - 'message-dropped'：**消息级失败**（dispose 后丢弃 / 编码失败 BRIDGE_ENCODE_FAILED）
   *   ——单消息丢弃 + onDropped 可观测，调用方按帧语义决定是否补结算
   *   （ask 帧结算本调用 / result 帧降级错误信封）；
   * - 'carrier-failed'：**载体级失败**——按域死 dispose 收尾（在途全结算），
   *   调用方无需再动（本端点条目已随 dispose 结算）。
   * 分桶判据 = 载体在编码边界打的 BRIDGE_ENCODE_FAILED 型（stdio 腿
   * JSON.stringify 同步抛点；worker 腿结构化克隆失败集只剩函数/symbol 等宿主
   * 代码 bug 形，维持载体死 fail-loud——契约篇 §1.7 消息面分桶条款）。 */
  private send(message: BridgeMessage): 'sent' | 'message-dropped' | 'carrier-failed' {
    if (this.disposed) {
      this.dropped(message);
      return 'message-dropped';
    }
    try {
      this.port.postMessage(message);
      return 'sent';
    } catch (err) {
      if (err instanceof AppError && err.code === BRIDGE_ENCODE_FAILED) {
        // 消息级编码失败：只丢这条消息（可观测），端点与其余在途调用不株连
        this.dropped(message);
        return 'message-dropped';
      }
      this.dispose(`载体发送失败：${err instanceof Error ? err.message : String(err)}`);
      return 'carrier-failed';
    }
  }

  /** 丢弃观测（onDropped 未设则静默——迟到/域死消息的归宿） */
  private dropped(message: unknown): void {
    if (this.options.onDropped) this.options.onDropped(message as BridgeMessage);
  }

  /** 心跳节拍：发探针 + 丢拍计数超限即一次性 freeze 上报 */
  private tick(): void {
    if (this.disposed || this.frozen) return;
    this.missedPongs++;
    this.send({ kind: 'ping', t: Date.now() });
    const limit = this.options.heartbeatMissLimit ?? 3;
    if (this.missedPongs > limit) {
      this.frozen = true;
      this.stopHeartbeat();
      this.options.onFreeze?.({ missed: this.missedPongs });
    }
  }
}

/**
 * 异常 → 错误信封：AppError 家族词保码过界（code 原样）；非家族异常统一入桶
 * BRIDGE_HANDLER_FAILED（对端回卷为 AppError 后按码分派不受影响）。
 */
function toEnvelope(err: unknown, origin?: { workerId?: string; app?: string }): BridgeErrorEnvelope {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, origin };
  }
  return {
    code: BRIDGE_HANDLER_FAILED,
    message: err instanceof Error ? err.message : String(err),
    origin,
  };
}

/** 信封 → 人读 message（归因前缀拼进文本——诊断面一眼定位哪个域出的错） */
function formatEnvelopeMessage(env: BridgeErrorEnvelope): string {
  if (env.origin?.workerId || env.origin?.app) {
    const parts = [env.origin.workerId, env.origin.app].filter(Boolean).join('/');
    return `[${parts}] ${env.message}`;
  }
  return env.message;
}
