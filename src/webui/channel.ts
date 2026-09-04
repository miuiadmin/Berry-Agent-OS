/**
 * L3 webui — SSE 连接管理器 + 广播后端（契约篇 §6.8 通道半边）。
 *
 * 职责：把三族信封源（session/event 总线镜像 / display 信封流 / 本件
 * UiBackend 自产 notify·status）扇出到全部在线 SSE 连接。帧合成钉死（冷读
 * m4）：每帧 data 载荷恒整体单次 JSON.stringify 单行——payload 内嵌换行由
 * JSON 转义承载，禁手工拼帧。
 *
 * 心跳看门狗（冷读 B1 勘正后的写侧语义）：SSE 客户端（EventSource）在 GET
 * 之后永不上行字节——「无读取活动」对健康连接恒为零，读侧判死不可实施；
 * 判死靠写路径暴露（内核 socket 缓冲积压/对端已死必然传导到 write）：每
 * 30s 注释行 ping，ping 写回调超 90s 未回流（write timeout）或写路径报错
 * 即 reap 该连接。
 *
 * 生命周期：随 webui 行 apply 构造、ctx.effect 回卷 dispose（/reload 卸行/
 * 全量重装载后旧实例整体废弃）。addDisplay 无注销器（chat 件 front 面是
 * Ring 1——/reload 不回卷），displaySink 以 closed 旗标自守：dispose 后
 * 恒 no-op，防旧 sink 残留泄漏事件。
 */

import type { ServerResponse } from 'node:http';
import type { UiBackend } from '../channels/types.js';
import {
  WEBUI_MAX_CONNECTIONS,
  WEBUI_PING_INTERVAL_MS,
  WEBUI_WRITE_TIMEOUT_MS,
  type WebuiDisplaySink,
  type WebuiSseEnvelope,
  type WebuiSessionBusPayload,
} from './types.js';

/** 单条 SSE 连接（GET /api/events 升级产物——server 侧开帧头，此后归本面管理） */
class WebuiConnection {
  /** 连接死亡回调（reap 单点归 channel——从连接表摘除 + destroy 底层响应流） */
  private readonly onDead: () => void;
  private readonly res: ServerResponse;
  /** 写超时看门狗句柄（ping 写回调未回流超 90s 即判死——写侧信号驱动） */
  private writeWatchdog: NodeJS.Timeout | undefined;

  constructor(res: ServerResponse, onDead: () => void) {
    this.res = res;
    this.onDead = onDead;
    // 写路径异常（socket 已死等）——res.write 对已毁流不抛而走 error 面，在此收口判死
    res.on('error', () => this.kill());
  }

  /** 推一帧（整体单次 stringify 单行——帧合成钉死，禁分段拼帧） */
  writeFrame(envelope: WebuiSseEnvelope): void {
    try {
      this.res.write(`data: ${JSON.stringify(envelope)}\n\n`);
    } catch {
      this.kill(); // 已毁流上的同步抛（理论上少见）——与 error 面同一收口
    }
  }

  /**
   * 心跳注释行 + 写超时看门狗：write 回调 = 数据已交内核（写路径活的证据）；
   * 90s 未回流 = 写路径阻塞/对端死——reap。看门狗追踪**最老未回流写**：已在
   * 册（上拍回调未回流）时本拍不叠钟（早退**不动**在册钟——A17 注释勘正
   * 〔第十一轮遗漏大扫 20260904-b〕：修前形态是每拍先清后设，清钟来源只剩
   * 下一拍 ping，30s 节拍恒先于 90s 到期重置时钟、僵死连接永不被判死——
   * 修后清钟来源只有写回调与 kill 两面，ping 不再触碰在册钟）。
   */
  ping(): void {
    // 判死计时已在跑：本拍 ping 照发（写路径积压由在册 watchdog 统一裁决）
    if (this.writeWatchdog !== undefined) return;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) this.kill(); // 写超时（B1：写侧信号驱动的判死）
    }, WEBUI_WRITE_TIMEOUT_MS);
    this.writeWatchdog = timer;
    try {
      this.res.write(': ping\n\n', () => {
        settled = true;
        // 句柄比对防迟到回调误清（kill 已清钟后到达的回调不得动新状态）
        if (this.writeWatchdog === timer) {
          clearTimeout(timer);
          this.writeWatchdog = undefined;
        }
      });
    } catch {
      this.kill();
    }
  }

  /** 立即判死（幂等——destroy 已毁流是 no-op） */
  kill(): void {
    if (this.writeWatchdog !== undefined) {
      clearTimeout(this.writeWatchdog);
      this.writeWatchdog = undefined;
    }
    this.onDead();
    this.res.destroy();
  }
}

/** webui 通道半边（连接扇出 + 广播后端 + 订阅侧三 sink 的容器） */
export class WebuiChannel {
  /** 在线连接表（全局帽 16 的执法对象——超帽新连接 503） */
  private readonly connections = new Set<WebuiConnection>();
  /** 心跳节拍器句柄（dispose 清除——防裸 timer 泄漏） */
  private heartbeat: NodeJS.Timeout | undefined;
  /** 通道已废弃旗标（dispose 后全部入向调用 no-op——addDisplay 无注销器的自守） */
  private closed = false;

  /**
   * 注册一条新连接（server 侧 SSE 升级后调用）。@returns 超帽 = undefined
   * （调用方回 503）；成功返回写帧接口。
   */
  register(res: ServerResponse): { writeFrame: (envelope: WebuiSseEnvelope) => void } | undefined {
    if (this.closed || this.connections.size >= WEBUI_MAX_CONNECTIONS) return undefined;
    const conn = new WebuiConnection(res, () => {
      this.connections.delete(conn);
    });
    this.connections.add(conn);
    // 客户端断开（res close = 连接终结——正常关流，直接摘除，无 watchdog 参与）
    res.on('close', () => this.connections.delete(conn));
    if (this.heartbeat === undefined) {
      this.heartbeat = setInterval(() => this.pingAll(), WEBUI_PING_INTERVAL_MS);
    }
    return conn;
  }

  /** 广播一帧到全部在线连接（写失败由各连接自收口判死，不毒其余） */
  broadcast(envelope: WebuiSseEnvelope): void {
    if (this.closed) return;
    for (const conn of this.connections) conn.writeFrame(envelope);
  }

  /** 心跳扇出（仅存活连接——写超时/写失败者已在 watchdog 内自 reap） */
  private pingAll(): void {
    if (this.closed) return;
    for (const conn of this.connections) conn.ping();
  }

  /**
   * display 族订阅 sink（经组合根 addDisplay 接入点转投）：信封 sessionId
   * 上提到 SSE 信封层，payload = 事件本体（线格式省一字段，SPA 侧同构）。
   */
  readonly displaySink: WebuiDisplaySink = (envelope) => {
    this.broadcast({ kind: 'display', sessionId: envelope.sessionId, payload: envelope.event });
  };

  /**
   * session 族总线 sink（ctx.on('session/event') 的 handler 体——载荷
   * {sessionId, event} 信封，durable 镜像全词上流：词汇注册表执法在写入侧，
   * 已落 durable 的事件天然合法，本面不再二次过滤）。
   */
  readonly onSessionEvent = (payload: unknown): void => {
    const env = payload as Partial<WebuiSessionBusPayload> | undefined;
    if (env === undefined || typeof env.sessionId !== 'string' || env.event === undefined) return; // 形状不符静默丢（总线契约外载荷）
    this.broadcast({ kind: 'session', sessionId: env.sessionId, payload: env.event });
  };

  /**
   * webui 广播后端（UiBackend 能力面钉死：只实现 notify/setStatus 两广播面 +
   * hasAudience 观众探针面；不实现 confirm/input/select——防 UiService 首个
   * 支持后端接序抢走 TUI 审批应答；setWidget 缺席 = 聚合器按 §4.3 降级规则
   * 自动降 notify，非本面职责。hasAudience 非交互面不参与接序——只自报
   * 「有没有人可收」：在线连接数 > 0，daemon 常开零连接 = 无观众，#44）。
   */
  readonly backend: UiBackend = {
    id: 'webui',
    notify: (message, opts) => {
      this.broadcast({
        kind: 'notify',
        payload: { message, ...(opts?.level !== undefined ? { level: opts.level } : {}) },
      });
    },
    setStatus: (status) => {
      this.broadcast({ kind: 'status', payload: { status } });
    },
    hasAudience: () => this.size > 0,
  };

  /** 废弃通道（行回卷）：停心跳、毁全部连接；此后一切入向调用 no-op */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    for (const conn of this.connections) conn.kill();
    this.connections.clear();
  }

  /** 在线连接数（daemon 刀二升格：armed 判据数据源——answerer ask 时点活取，>0 = 有在场腿不武装） */
  get size(): number {
    return this.connections.size;
  }
}
