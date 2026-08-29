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
 * - 大 payload：1MiB 单行 JSON 过 pipe 无损（readline 无行长上限）；
 * - 洪泛背压：write() 返 false 是缓冲提示非丢弃——内核缓冲排队不丢行
 *   不乱序，无需 drain 编舞（背压自愈）；
 * - 消息一切字段 JSON 可编码（session.ts 头注纪律）——JSON.stringify 通道
 *   与结构化克隆通道在本协议面上等价（PoC ②⑥ symbol 键存活数 = 0）。
 *
 * 两向同构：域入口侧包 (process.stdin, process.stdout)，宿主侧包
 * (child.stdout, child.stdin)——同一类两个方向都能用。
 */

import { createInterface } from 'node:readline';
import type { BridgePort } from './session.js';

/** StdioBridgePort 构造参数 */
export interface StdioBridgePortOptions {
  /**
   * 坏行观测（一行 JSON.parse 失败时回调——只可能是对端协议 bug 或管道
   * 撕裂；本层静默跳过保通道活性，观测面交调用方记日志/诊断）。
   */
  readonly onBadLine?: (line: string, err: unknown) => void;
}

/**
 * NDJSON 载体端口：入站流逐行解析派发 'message'，出站写手逐消息一行写出。
 * 生命周期归调用方（域入口随进程生死；宿主侧随 child 管道生死）——本类
 * 不 close 流，只接读写。
 */
export class StdioBridgePort implements BridgePort {
  /** 出站写手（宿主侧 = child.stdin；域入口侧 = process.stdout） */
  private readonly out: NodeJS.WritableStream;
  /** 入站流（宿主侧 = child.stdout；域入口侧 = process.stdin） */
  private readonly input: NodeJS.ReadableStream;
  /** 坏行观测回调（缺省静默跳过） */
  private readonly onBadLine?: (line: string, err: unknown) => void;
  /** 'message' 监听器组（readline 'line' 逐条派发——BridgePort 契约面） */
  private readonly listeners: Array<(message: unknown) => void> = [];

  /**
   * @param input 入站流（逐行读）
   * @param out 出站写手（逐消息一行写）
   * @param options 坏行观测等可选项
   */
  constructor(input: NodeJS.ReadableStream, out: NodeJS.WritableStream, options: StdioBridgePortOptions = {}) {
    this.input = input;
    this.out = out;
    this.onBadLine = options.onBadLine;
    // 入站流端到端接 readline（行边界协议自扛字节流切分；无行长上限——
    // 1MiB 级单行 payload 实证可过）。流 close 即接口关闭（域死/管道断）。
    const lines = createInterface({ input: input as never });
    lines.on('line', (line) => this.dispatch(line));
  }

  /** BridgePort.postMessage：一行一消息写出（背压自愈——见头注 PoC ⑩） */
  postMessage(message: unknown): void {
    this.out.write(`${JSON.stringify(message)}\n`);
  }

  /** BridgePort.on('message')：登记监听器（本类自 dispatch 逐行派发） */
  on(event: 'message', listener: (message: unknown) => void): void {
    if (event === 'message') this.listeners.push(listener);
  }

  /** 单行解析与派发（坏行静默跳过 + 可选观测——通道活性优先） */
  private dispatch(line: string): void {
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
}
