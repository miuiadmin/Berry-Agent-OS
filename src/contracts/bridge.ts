/**
 * L0 contracts — 桥接协议 v0 消息面（契约篇 §1.7，2026-08-26 第二十七批刀二）。
 *
 * 一份协议两 carrier：worker 分域走 MessagePort（结构化克隆直传），案三外部
 * 进程域预留 NDJSON over stdio **同一份 schema**（协议双轨漂移是硬反模式——
 * 规范立法在先）。载荷纪律：一切字段 JSON 可编码——这是 carrier 无关性的
 * 实现面（结构化克隆是 JSON 可编码形的真子集，无损双向成立）。
 *
 * 消息双向对称：ask/result/cancel/tell 任一方向可发（宿主调 worker 域注册项 /
 * worker 域调宿主服务同一套消息面）；ping 宿主按节律发、任一端必答（心跳是
 * 监督面配置，协议层无角色不对称）。callId 由调用方分配——两方向各自编号，
 * 按 kind 分派无歧义（result 只匹配本端出站、ask/cancel 只作用于本端入站）。
 */

/**
 * 运行域归因（错误信封附带）：跨线程/跨进程栈不假装连续——归因字段替代
 * （哪个 worker 域、哪个应用出的错）。
 */
export interface BridgeErrorOrigin {
  /** worker 域标识（宿主侧 spawn 时分配） */
  readonly workerId?: string;
  /** 应用名（行归因——词汇随第三十六批 plugin→app） */
  readonly app?: string;
}

/**
 * 跨界错误信封（契约篇 §1.7 错误面）：AppError 家族词过界保码——{code, message}
 * 纯 JSON 可克隆，两侧各自回卷为 AppError；非 AppError 异常统一入桶码。
 */
export interface BridgeErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly origin?: BridgeErrorOrigin;
}

/**
 * 方法调用请求：service/method 两级命名空间（如 service='apps' method='invokeTool'，
 * service='sessions' method='appendEvent'）+ args 数组（结构化克隆可过界）。
 */
export interface BridgeAsk {
  readonly kind: 'ask';
  readonly callId: number;
  readonly service: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * 方法调用回应：ok 二值 + value | error 信封。迟到纪律：调用方本地结算（取消/
 * 超时/域死）后到达的 result 一律丢弃——迟到不复活、不二次结算。
 */
export interface BridgeResult {
  readonly kind: 'result';
  readonly callId: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: BridgeErrorEnvelope;
}

/**
 * 单向通知（fire-and-forget，不期待回应）：event = 宿主事件词汇——不引入
 * topic 第二词（冷读词汇统一裁决）。worker 域 ctx.emit 与宿主侧变更 push
 * 镜像（tell 序列）同走本消息。
 */
export interface BridgeTell {
  readonly kind: 'tell';
  readonly event: string;
  readonly payload: unknown;
}

/**
 * 拦截往返（请求-改写-回传一跳一往返；语义不塌缩进 ask——三语义保真）：
 * 回应复用 BridgeResult（同 callId）。v0 预留词——拦截面消费者出现时接线。
 */
export interface BridgeIntercept {
  readonly kind: 'intercept';
  readonly callId: number;
  readonly event: string;
  readonly patch: unknown;
}

/**
 * 取消：AbortSignal 不可克隆不可转移——**取消一律消息化**。调用方 abort 时
 * 本地立即结算（不等对端往返）+ 发本消息；对端据此掐断该 callId 的在途入站
 * 调用（run 取消 / ToolCtx.signal 的取消契约在 worker 域由这条翻译保真）。
 */
export interface BridgeCancel {
  readonly kind: 'cancel';
  readonly callId: number;
}

/** 心跳探针（宿主监督按节律发；t = 发送时刻 Date.now()——延迟测量诊断面） */
export interface BridgePing {
  readonly kind: 'ping';
  readonly t: number;
}

/** 心跳应答（必答；t 原样回传——单钟测往返，不假设两域时钟同步） */
export interface BridgePong {
  readonly kind: 'pong';
  readonly t: number;
}

/** 协议 v0 消息全集 */
export type BridgeMessage =
  BridgeAsk | BridgeResult | BridgeTell | BridgeIntercept | BridgeCancel | BridgePing | BridgePong;
