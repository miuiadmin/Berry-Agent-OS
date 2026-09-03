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
import { LineByteGuard } from '../context/index.js';
import type { BridgePort } from './session.js';

/**
 * StdioBridgePort 构造参数
 */
export interface StdioBridgePortOptions {
  /**
   * 坏行观测（一行 JSON.parse 失败时回调——只可能是对端协议 bug 或管道
   * 撕裂；本层静默跳过保通道活性，观测面交调用方记日志/诊断）。
   * 封读收场（单行超限）同走此口：line 空串 + 超限 Error（超限行未完成
   * 无全文可截）。
   */
  readonly onBadLine?: (line: string, err: unknown) => void;
  /**
   * 单行字节上限（严格大于才执法——恰达帽不封；缺省 8MiB）。字节计数在
   * 流面逐段过账（见行帧帽共享件 line-guard），超限按载体级失败收场非
   * 单行丢弃。
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
  /** 坏行观测回调（缺省静默跳过——dispatch 坏行腿与封读观测共用此口） */
  private readonly onBadLine?: (line: string, err: unknown) => void;
  /** 行帧帽执法件（共享件——与 mcp stdio 桥同源单点，遗漏大扫 20260903 D1-1） */
  private readonly guard: LineByteGuard;
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
    // 行帧卫生件①（契约篇 §1.7；共享件化 = 遗漏大扫 20260903 runtime D1-1——
    // 20260902 #9 的同形修复只落本件、mcp stdio 桥漏同修的缺陷族收口）：
    // 守卫**先于 createInterface 挂 data 监听**（同一 chunk 的字节面先于行
    // 处理过账，超限可在 readline 派发该 chunk 内的行之前封读——dispatch 顶
    // isSealed 短路兜住残余行事件）。超限即刻 destroy 入站流（不等行完成——
    // 宿主峰值吸收 = 上限 + 单 chunk 钉死）；封读后域死走既有编舞（宿主侧
    // child SIGPIPE→exit→域死结算；域入口侧 stdin 断→孤儿防线），本层零新增
    // 收尾代码。计数/封读语义锁在 line-guard.test.ts（两消费面共同行为锁）。
    this.guard = new LineByteGuard(input, {
      ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
      onSeal: (overBytes, maxLineBytes) => {
        // 封读观测走坏行口（line 空串——超限行未完成无全文可截）
        options.onBadLine?.('', new Error(`单行累计字节 ${overBytes} 超上限 ${maxLineBytes}——封读收场（载体级失败）`));
      },
    });
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
    if (this.guard.isSealed) return; // 已封读——同 chunk 内 readline 先行缓冲的残余行不派发
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
