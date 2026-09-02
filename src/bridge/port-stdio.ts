/**
 * bridge — NDJSON over stdio 载体适配器（契约篇 §1.7 external 载体，external carrier 落码批）。
 *
 * BridgePort 的 fork 域实现：worker 腿走 node:worker_threads MessagePort
 * （结构化克隆通道），external 腿走子进程 stdin/stdout 字节流——本件把
 * 「一行一 JSON 消息」的 NDJSON 行协议适配成 BridgePort 形，协议层
 * （BridgeEndpoint/startWorkerRealm）零改复用（「不换协议只换 carrier」的
 * 传输半边）。
 *
 * 实证底座 = PoC ⑩（fork 域台账）：
 * - 大 payload：1MiB 单行 JSON 过 pipe 无损（上限缺省 8MiB——行帧卫生件①
 *   给 readline 的无界缓冲钉上界，遗漏大扫 20260902 #9）；
 * - 洪泛背压：write() 返 false 是缓冲提示非丢弃——内核缓冲排队不丢行
 *   不乱序，无需 drain 编舞（背压自愈）；
 * - 消息一切字段 JSON 可编码（session.ts 头注纪律）——JSON.stringify 通道
 *   与结构化克隆通道在本协议面上等价（PoC ②⑥ symbol 键存活数 = 0）。
 *
 * 两向同构：域入口侧包 (process.stdin, process.stdout)，宿主侧包
 * (child.stdout, child.stdin)——同一类两个方向都能用。
 */

import { createInterface } from 'node:readline';
import { AppError, BRIDGE_ENCODE_FAILED } from '../contracts/errors.js';
import type { BridgePort } from './session.js';

/**
 * 单行字节上限缺省（8MiB——契约篇 §1.7 行帧卫生件①）：宿主堆对单行无界
 * 吸收的上界钉死（子进程 OS 沙箱/PM 内存旗罩不到宿主侧 readline 缓冲与
 * JSON.parse——上限是宿主自护）。
 */
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** StdioBridgePort 构造参数 */
export interface StdioBridgePortOptions {
  /**
   * 坏行观测（一行 JSON.parse 失败时回调——只可能是对端协议 bug 或管道
   * 撕裂；本层静默跳过保通道活性，观测面交调用方记日志/诊断）。
   */
  readonly onBadLine?: (line: string, err: unknown) => void;
  /**
   * 单行字节上限（严格大于才执法——恰达帽不封；缺省 8MiB）。字节计数在
   * 流面逐段过账（见构造器头注），超限按载体级失败收场非单行丢弃。
   */
  readonly maxLineBytes?: number;
}

/**
 * NDJSON 载体端口：入站流逐行解析派发 'message'，出站写手逐消息一行写出。
 * 生命周期归调用方（域入口随进程生死；宿主侧随 child 管道生死）——本类
 * 不 close 流，只接读写。
 */
export class StdioBridgePort implements BridgePort {
  /** 出站写手（宿主侧 = child.stdin；域入口侧 = process.stdout） */
  private readonly out: NodeJS.WritableStream;
  /** 坏行观测回调（缺省静默跳过） */
  private readonly onBadLine?: (line: string, err: unknown) => void;
  /** 单行字节上限（严格大于才执法——见构造器头注行帧卫生段） */
  private readonly maxLineBytes: number;
  /** 封读旗：超限置位后 dispatch 顶短路（后续行不派发——载体级失败语义） */
  private sealed = false;
  /** 距上一换行的累计字节（跨 chunk 累计、换行重置——当前未完成行的全长账） */
  private lineBytes = 0;
  /** 'message' 监听器组（readline 'line' 逐条派发——BridgePort 契约面） */
  private readonly listeners: Array<(message: unknown) => void> = [];

  /**
   * @param input 入站流（逐行读）
   * @param out 出站写手（逐消息一行写）
   * @param options 坏行观测 / 单行字节上限等可选项
   */
  constructor(input: NodeJS.ReadableStream, out: NodeJS.WritableStream, options: StdioBridgePortOptions = {}) {
    this.out = out;
    this.onBadLine = options.onBadLine;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    // 行帧卫生件①（遗漏大扫 20260902 #9）：readline 无行长上限——本监听器
    // 在字节面给宿主堆钉上界。自挂 'data' 监听器（与 readline 内部 'data'
    // 监听共存各记各的），且**先于 createInterface 挂上**：同一 chunk 的字节
    // 面先于行处理过账，超限可在 readline 派发该 chunk 内的行之前封读
    // （dispatch 顶 sealed 短路兜住残余行事件）。逐段过账（分段符 = 换行
    // 0x0A）而非首/尾换行整体算——多行同 chunk 时整体跨度会把多个好行的
    // 总长误当单行超限（误封好流量）。超限即刻 destroy 入站流（不等行完
    // 成——宿主峰值吸收 = 上限 + 单 chunk 钉死）；封读后域死走既有编舞
    // （宿主侧 child SIGPIPE→exit→域死结算；域入口侧 stdin 断→孤儿防线），
    // 本层零新增收尾代码。
    input.on('data', (chunk: unknown) => this.countLineBytes(input, chunk));
    // 入站流端到端接 readline（行边界协议自扛字节流切分）。流 close 即接口
    // 关闭（域死/管道断）。
    const lines = createInterface({ input: input as never });
    lines.on('line', (line) => this.dispatch(line));
  }

  /** BridgePort.postMessage：一行一消息写出（背压自愈——见头注 PoC ⑩）。
   * 编码失败在此打型为 BRIDGE_ENCODE_FAILED 上抛——**消息级属性**（该消息含
   * BigInt/循环引用等 JSON 编不过的值，载体本身健康），端点 send() 据此分桶
   * 「单消息丢弃」而非误判载体死 dispose（20260901-c #4：旧形误 dispose 后
   * 子进程仍活、exit 永不来 = 宿主侧僵尸域）。 */
  postMessage(message: unknown): void {
    let line: string;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch (err) {
      throw new AppError(
        BRIDGE_ENCODE_FAILED,
        `消息编码失败（JSON 不可编码字段——BigInt/循环引用）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.out.write(line);
  }

  /** BridgePort.on('message')：登记监听器（本类自 dispatch 逐行派发） */
  on(event: 'message', listener: (message: unknown) => void): void {
    if (event === 'message') this.listeners.push(listener);
  }

  /** 单行解析与派发（坏行静默跳过 + 可选观测——通道活性优先） */
  private dispatch(line: string): void {
    if (this.sealed) return; // 已封读——同 chunk 内 readline 先行缓冲的残余行不派发
    const trimmed = line.trim();
    if (trimmed === '') return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      this.onBadLine?.(trimmed, err);
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(message);
      } catch {
        // 监听器异常不阻断其余监听器（与宿主 emit 单点隔离同纪律）
      }
    }
  }

  /**
   * 字节计数与超限执法（构造器头注行帧卫生段）：逐段过账「距上一换行的
   * 累计字节」——完成行全长 = 此前累计 + 段内字节，尾段（无换行收尾）续入
   * 累计跨 chunk 延续。任一段严格超上限（恰达帽不封）即封读收场。
   */
  private countLineBytes(input: NodeJS.ReadableStream, chunk: unknown): void {
    if (this.sealed) return; // 已封读——destroy 后残余 data 事件窗不再过账
    // stdio/PassThrough 流 chunk 恒 Buffer；字符串形态（上游 setEncoding 的
    // 边角）按 UTF-8 折回字节面计数（字节语义与字符数有差——多字节字符）
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    let start = 0;
    let nl = buf.indexOf(10, 0); // 换行 0x0A 的字节下标（-1 = 无换行）
    while (nl !== -1) {
      this.lineBytes += nl - start; // 本段收尾 = 一行完成
      if (this.lineBytes > this.maxLineBytes) {
        this.seal(input, this.lineBytes);
        return;
      }
      this.lineBytes = 0; // 换行重置——下一行从零起账
      start = nl + 1;
      nl = buf.indexOf(10, start);
    }
    this.lineBytes += buf.length - start; // 尾段续入累计（未完成行）
    if (this.lineBytes > this.maxLineBytes) this.seal(input, this.lineBytes);
  }

  /**
   * 封读收场（载体级失败）：置 sealed + 合成坏行观测（line 空串——超限行
   * 未完成无全文可截）+ destroy 入站流。destroy 不带 error 实参——避免向
   * 无 error 监听的入站流（PassThrough 测试形态 / 宿主侧 child.stdout）发
   * unhandled 'error'；'close' 事件足以让 readline 与上层收线。
   */
  private seal(input: NodeJS.ReadableStream, overBytes: number): void {
    this.sealed = true;
    this.onBadLine?.('', new Error(`单行累计字节 ${overBytes} 超上限 ${this.maxLineBytes}——封读收场（载体级失败）`));
    (input as NodeJS.ReadableStream & { destroy?: (err?: Error) => void }).destroy?.();
  }
}
