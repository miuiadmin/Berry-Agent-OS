/**
 * L1 context — NDJSON 行帧字节帽共享件（契约篇 §1.7 行帧卫生件①）。
 *
 * 宿主堆对「单行无界吸收」的上界钉死：readline 无行长上限，恶意/故障的
 * 对端（子进程 stdio 载体）不写换行即可让宿主 readline 缓冲无界膨胀——
 * 子进程侧 OS 沙箱/PM 内存旗都罩不到宿主侧的吸收面，上限是宿主自护。
 *
 * 共享件定位（遗漏大扫 20260903 runtime D1-1 修死）：同形修复跨模块未同步
 * 是已坐实的缺陷族（20260902 #9 只落 bridge、mcp stdio 桥漏同修——第八轮
 * 复扫再坐实一处）。收口成共享件结构性消灭：bridge port-stdio 与 mcp
 * client 两消费面同源单点，规范条款见契约篇 §6.6「行帧卫生同律」。
 *
 * 机制要点（沿 20260902 #9 落地实证形态）：
 * - 自挂 'data' 监听器与 readline 内部 'data' 监听共存各记各的，且**先于
 *   createInterface 挂上**（构造本件在前、createInterface 在后——同一 chunk
 *   的字节面先于行处理过账，超限可在 readline 派发该 chunk 内的行之前封读）；
 * - 逐段过账「距上一换行的累计字节」（分段符 = 换行 0x0A）而非首/尾换行
 *   整体算——多行同 chunk 时整体跨度会把多个好行的总长误当单行超限；
 * - 严格大于才执法（恰达帽不封）；超限即刻 destroy 入站流（不等行完成——
 *   宿主峰值吸收 = 上限 + 单 chunk 钉死）；
 * - destroy 不带 error 实参——避免向无 error 监听的入站流（PassThrough
 *   测试形态 / 宿主侧 child.stdout）发 unhandled 'error'；
 * - 封读后的收尾编舞（结清 pending / 杀子进程 / 域死结算）交各消费面
 *   onSeal 回调自理——本件只司「计数 + 封读」这一层。
 */

/**
 * 单行字节上限缺省（8MiB——契约篇 §1.7 行帧卫生件①）
 */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** LineByteGuard 构造参数 */
export interface LineByteGuardOptions {
  /**
   * 单行字节上限（严格大于才执法——恰达帽不封；缺省 8MiB）。
   */
  readonly maxLineBytes?: number;
  /**
   * 封读回调（一次性——超限收场的观测/执法口）：置旗后、destroy 前同步调用。
   * 收尾编舞（warn 日志/结清桥 pending/树杀子进程）由各消费面自理——本件
   * 零收尾知识（mcp 与 bridge 的域死编舞不同形，不在此合并）。
   */
  readonly onSeal?: (overBytes: number, maxLineBytes: number) => void;
}

/**
 * NDJSON 入站流的单行字节帽执法件。用法（消费面两步，序不可倒）：
 *
 * ```ts
 * const guard = new LineByteGuard(stream, { onSeal: ... }); // ① 先挂字节计数
 * const lines = createInterface({ input: stream }); // ② 后接行分发
 * lines.on('line', (line) => { if (guard.isSealed) return; ... }); // 残余行短路
 * ```
 */
export class LineByteGuard {
  /** 封读旗：超限置位后消费面的行分发顶短路（readline 先行缓冲的残余行不派发） */
  private sealed = false;
  /** 距上一换行的累计字节（跨 chunk 累计、换行重置——当前未完成行的全长账） */
  private lineBytes = 0;
  /** 单行字节上限（严格大于才执法——恰达帽不封） */
  private readonly maxLineBytes: number;
  /** 封读回调（缺省无观测——纯封读） */
  private readonly onSeal?: (overBytes: number, maxLineBytes: number) => void;

  /**
   * @param input 入站流（NDJSON 字节流——宿主侧 child.stdout / 测试 PassThrough）
   * @param options 上限与封读回调（见接口注释）
   */
  constructor(input: NodeJS.ReadableStream, options: LineByteGuardOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.onSeal = options.onSeal;
    input.on('data', (chunk: unknown) => this.countLineBytes(input, chunk));
  }

  /** 是否已封读（消费面行分发顶短路判据） */
  get isSealed(): boolean {
    return this.sealed;
  }

  /**
   * 字节计数与超限执法：逐段过账「距上一换行的累计字节」——完成行全长 =
   * 此前累计 + 段内字节，尾段（无换行收尾）续入累计跨 chunk 延续。任一段
   * 严格超上限即封读收场。
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
   * 封读收场：置旗 + onSeal 回调（观测/执法——先于 destroy 同步跑，消费面
   * 可在流死前完成记账）+ destroy 入站流（不带 error 实参——见类头注）。
   */
  private seal(input: NodeJS.ReadableStream, overBytes: number): void {
    this.sealed = true;
    this.onSeal?.(overBytes, this.maxLineBytes);
    (input as NodeJS.ReadableStream & { destroy?: (err?: Error) => void }).destroy?.();
  }
}
