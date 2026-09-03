/**
 * 桌面引擎本体（十一律第 1/2/3/6/8 条的机制面）。
 *
 * - **帧管线**（律 1/2/3/6）：back.clear → root.render → diffRows(front, back) →
 *   writeDiff 增量段 + 光标段 → DECSET 2026 包裹 → io.write。双缓冲 ping-pong，
 *   resize 才重分配；`scheduleFrame()` 单入口：请求合并（脏旗标）+ FPS 帽
 *   （帧间隔下限）+ **按需渲染**（无请求零写出——OpenCode 连续帧泵反课的正解）。
 * - **全屏 alt-screen**（律 1）：start 进备屏、dispose 出备屏；无 scrollback。
 * - **换防收口面**（律 8 / 契约篇 §6.11，引擎侧机制单源）：
 *   - suspend 三件套：onInput(null) → pause() → setRawMode(先验态)；leaveModes
 *     出屏（kitty pop/粘贴关/光标显/备屏出）；requestRender 挂起静默短路。
 *   - resume 六步：enterModes 清屏进（备屏/模式重开/kitty 重推）→ setRawMode(true)
 *     → onInput 重装 → io.resume 放流（对家栈停屏显式 pause 过 stdin）→ 几何
 *     核对（挂起期 resize 事件被挂起态短路整批丢弃——失配即 handleResize 同款
 *     重分配，遗漏大扫 20260903 desktop D2-1）→ front 失真标脏 + 全量首帧重绘。
 *   - drainInput：退回 shell 前排空 stdin 缓冲（临时吞处理器 + 闲窗轮询）。
 *   - decoder.discardPending：换防瞬间在途转义一窗全丢。
 * - **输入接线**：decoder.feed → 事件队列排空 → emitter 'input'；lone-ESC 判定
 *   窗定时器由引擎装/卸。kitty 探测应答上抛 'keyboardProtocol'。
 */
import { CellBuffer } from './cell.js';
import { createRowDiff, diffRows, writeDiff, type RowDiff } from './diff.js';
import { InputDecoder } from './input.js';
import type {
  Area,
  DesktopEngineOptions,
  EngineEventMap,
  InputEvent,
  KeyboardProtocol,
  Renderable,
  TerminalIO,
} from './types.js';

/** 缺省帧率帽（60fps——律 3） */
const DEFAULT_FPS_CAP = 60;
/** 缺省 lone-ESC 判定窗（ms） */
const DEFAULT_ESCAPE_WINDOW_MS = 30;
/** drainInput 缺省窗（总帽/闲窗——spike 实证参数） */
const DRAIN_MAX_MS = 1000;
const DRAIN_IDLE_MS = 50;

/** 进屏模式串（start/resume 共用）：备屏 + 光标藏 + 粘贴开 + kitty 推送 + 探测 */
const ENTER_MODES =
  '\x1b[?1049h' + // 备屏进（律 1 全屏 alt-screen）
  '\x1b[?25l' + // 光标藏（帧尾按声明落位再显）
  '\x1b[?2004h' + // bracketed paste 开（律 7 严格粘贴）
  '\x1b[>1u' + // kitty 键盘协议推栈：disambiguate 位（Esc/alt/ctrl 无歧义化）
  '\x1b[?u' + // kitty 探测：查询当前增强位
  '\x1b[c'; // DA1：探测哨兵（应答先到无 kitty 应答 = legacy）

/** 出屏模式串（suspend/dispose 共用）：与 ENTER_MODES 严格对称反序 */
const LEAVE_MODES =
  '\x1b[<u' + // kitty 弹栈（恢复宿主栈态——kitty 规范）
  '\x1b[?2004l' + // 粘贴关
  '\x1b[?25h' + // 光标显
  '\x1b[?1049l'; // 备屏出（回主屏）

/** 极简类型化 emitter（引擎事件面——零 durable 事件的运行时侧通道） */
class Emitter<M> {
  /** 事件名 → 监听器集（装拆对称——返回卸载函数） */
  private readonly map = new Map<keyof M, Set<(payload: never) => void>>();

  on<K extends keyof M>(event: K, cb: (payload: M[K]) => void): () => void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(cb as (payload: never) => void);
    return () => set!.delete(cb as (payload: never) => void);
  }

  emit<K extends keyof M>(event: K, payload: M[K]): void {
    const set = this.map.get(event);
    if (!set) return;
    for (const cb of set) (cb as (payload: M[K]) => void)(payload);
  }
}

/** 缺省终端 IO 适配器：process stdin/stdout（批 C 组合根注入替代品的注入口） */
class ProcessTerminalIO implements TerminalIO {
  get columns(): number {
    return process.stdout.columns ?? 80;
  }

  get rows(): number {
    return process.stdout.rows ?? 24;
  }

  write(data: string): void {
    process.stdout.write(data);
  }

  setRawMode(enabled: boolean): void {
    if (process.stdin.isTTY) process.stdin.setRawMode(enabled);
  }

  isRaw(): boolean {
    return process.stdin.isRaw ?? false;
  }

  pause(): void {
    process.stdin.pause();
  }

  resume(): void {
    process.stdin.resume();
  }

  onInput(handler: ((chunk: string) => void) | null): void {
    const stdin = process.stdin;
    stdin.setEncoding('utf8');
    if (handler) stdin.on('data', handler);
    else stdin.removeAllListeners('data');
  }

  onResize(handler: (() => void) | null): void {
    const stdout = process.stdout;
    if (handler) stdout.on('resize', handler);
    else stdout.removeAllListeners('resize');
  }
}

/** 桌面引擎（构造后 start 进屏；dispose 终退） */
export class DesktopEngine {
  /** 终端 IO（注入面） */
  private readonly io: TerminalIO;
  /** 帧率帽（帧间隔下限 = 1000/fpsCap ms） */
  private readonly minFrameMs: number;
  /** 时钟/调度注入（缺省 Date.now/setTimeout——测试假钟注入口） */
  private readonly now: () => number;
  private readonly scheduleFn: (fn: () => void, ms: number) => unknown;
  private readonly cancelFn: (handle: unknown) => void;

  /** 渲染树根（shell 经 setRoot 装载） */
  private root: Renderable | null = null;
  /** 双缓冲：front = 屏上真相（差分基线）/ back = 本帧渲染目标 */
  private front: CellBuffer;
  private back: CellBuffer;
  /** 行差分容器（resize 随缓冲重分配） */
  private rowDiff: RowDiff;

  /** 全量帧旗标（首帧/换防重进/resize——front 基线失真时置位） */
  private forceFull = true;
  /** 帧定时器句柄（null = 无在飞帧） */
  private frameHandle: unknown = null;
  /** 上帧时刻（FPS 帽锚——调度时刻滚；-Infinity = 首帧立即出） */
  private lastFrameAt = Number.NEGATIVE_INFINITY;

  /** 生命周期态：idle 未启 / running 持屏 / suspended 挂起 / disposed 终退 */
  private state: 'idle' | 'running' | 'suspended' | 'disposed' = 'idle';
  /** start 时的 raw 先验态（suspend/dispose 复原依据） */
  private priorRaw = false;

  /** 输入解码器（kitty/legacy 双轨 + IME 组字态） */
  private readonly decoder: InputDecoder;
  /** lone-ESC 判定窗（构造时留档——定时器装排用） */
  private readonly decoderEscapeWindowMs: number;
  /** lone-ESC 判定窗定时器句柄 */
  private escapeHandle: unknown = null;
  /** 引擎事件面 */
  private readonly events = new Emitter<EngineEventMap>();
  /** kitty 探测落定值（应答到达前缺省 legacy） */
  private protocol: KeyboardProtocol = 'legacy';

  constructor(opts: DesktopEngineOptions = {}) {
    this.io = opts.io ?? new ProcessTerminalIO();
    this.minFrameMs = 1000 / (opts.fpsCap ?? DEFAULT_FPS_CAP);
    this.now = opts.now ?? Date.now;
    this.scheduleFn = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelFn = opts.cancelSchedule ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.front = new CellBuffer(this.io.columns, this.io.rows);
    this.back = new CellBuffer(this.io.columns, this.io.rows);
    this.rowDiff = createRowDiff(this.io.rows);
    this.decoder = new InputDecoder({
      now: this.now,
      escapeWindowMs: opts.escapeWindowMs ?? DEFAULT_ESCAPE_WINDOW_MS,
      onProtocol: (p) => {
        this.protocol = p;
        this.events.emit('keyboardProtocol', p);
      },
    });
    this.decoderEscapeWindowMs = opts.escapeWindowMs ?? DEFAULT_ESCAPE_WINDOW_MS;
  }

  /** 当前网格宽（列） */
  get columns(): number {
    return this.io.columns;
  }

  /** 当前网格高（行） */
  get rows(): number {
    return this.io.rows;
  }

  /** 挂起中旗标（换防面查询） */
  get suspended(): boolean {
    return this.state === 'suspended';
  }

  /** 生命周期态（idle/running/suspended/disposed） */
  get lifecycle(): 'idle' | 'running' | 'suspended' | 'disposed' {
    return this.state;
  }

  /** kitty 探测落定值（应答前缺省 legacy） */
  get keyboardProtocol(): KeyboardProtocol {
    return this.protocol;
  }

  /** 事件订阅（返回卸载函数） */
  on<K extends keyof EngineEventMap>(event: K, cb: (payload: EngineEventMap[K]) => void): () => void {
    return this.events.on(event, cb);
  }

  /**
   * 进屏启动：模式串写出 + raw 设定 + 输入/resize 监听装上 + 全量首帧。
   * 幂等保护：仅 idle 可启（挂起复位走 resume；两连崩熔断由批 C 壳层执法——
   * 引擎只保状态机干净）。
   */
  start(root: Renderable): void {
    if (this.state !== 'idle') return;
    this.priorRaw = this.io.isRaw();
    this.root = root;
    this.io.write(ENTER_MODES);
    this.io.setRawMode(true);
    this.io.onInput(this.handleInput);
    this.io.onResize(this.handleResize);
    this.state = 'running';
    this.forceFull = true;
    this.requestRender();
  }

  /** 换渲染树根（同帧请求合并——下帧生效） */
  setRoot(root: Renderable): void {
    this.root = root;
    this.requestRender();
  }

  /**
   * 渲染请求（律 3 单入口语义）：挂起态静默短路（律 8）；合并进脏旗标；
   * 帧定时器在飞则不另排（请求合并——多次请求一帧收）。
   */
  requestRender(): void {
    if (this.state === 'suspended' || this.state === 'disposed') return; // 挂起短路
    if (this.frameHandle === null) {
      // FPS 帽：距上帧不足一个帧间隔 → 排到帽点；否则下一拍即出
      const due = Math.max(0, this.lastFrameAt + this.minFrameMs - this.now());
      this.frameHandle = this.scheduleFn(() => {
        this.frameHandle = null;
        this.renderNow();
      }, due);
    }
  }

  /** 立即帧（测试与强制刷新面——绕过调度直出） */
  renderNow(): void {
    if (this.state !== 'running' || !this.root) return;
    this.lastFrameAt = this.now();
    // back 清屏 → 根渲染（全屏区域）→ 差分 → 增量段
    this.back.clear();
    const area: Area = { x: 0, y: 0, width: this.back.width, height: this.back.height };
    this.root.render(area, this.back);
    diffRows(this.front, this.back, this.rowDiff);
    let content = writeDiff(this.back, this.rowDiff, this.forceFull);
    this.forceFull = false;
    // 光标段：back.cursor 声明在场 → 定位 + 显；否则藏（状态去重——同态零冗余）
    let cursorSeq = '';
    const cursor = this.back.cursor;
    if (cursor) {
      cursorSeq = `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h`;
      this.cursorVisible = true;
    } else if (this.cursorVisible) {
      cursorSeq = '\x1b[?25l';
      this.cursorVisible = false;
    }
    if (content.length === 0 && cursorSeq.length === 0) return; // 零变更零写出
    if (content.length === 0) content = cursorSeq;
    else content += cursorSeq;
    // DECSET 2026 同步输出包裹：内容 + 光标同帧原子呈现（律 3）
    this.io.write(`\x1b[?2026h${content}\x1b[?2026l`);
    // 双缓冲换位：back 升格为屏上真相（新 back 为旧 front——复用内存零分配）
    const t = this.front;
    this.front = this.back;
    this.back = t;
  }

  /** 光标显隐已发态（帧间去重） */
  private cursorVisible = false;

  /**
   * 挂起（换防交出方——契约篇 §6.11 三件套）：
   * 出屏模式串 → onInput(null) → decoder 吞在途 → pause() → raw 复原先验态。
   * 挂起后 requestRender 静默短路；resize 监听保留（无副作用）。
   */
  suspend(): void {
    if (this.state !== 'running') return;
    this.io.write(LEAVE_MODES);
    this.io.onInput(null);
    this.decoder.discardPending(); // 在途转义一窗全丢
    this.io.pause();
    this.io.setRawMode(this.priorRaw);
    this.cancelFrame();
    this.state = 'suspended';
  }

  /**
   * 复位（换防接收方）：模式串清屏进 → raw 重设 → 监听重装 → 放流 → 几何核对
   * （失配即 handleResize 同款重分配——挂起期 resize 事件被挂起短路丢弃，
   * 遗漏大扫 20260903 desktop D2-1）→ 全量首帧重绘。front 基线在挂起期已
   * 失真（对方栈写过屏）——forceFull 全量重绘。
   *
   * 放流步（io.resume）不可省：对家栈（pi-tui）停屏时显式 pause 了 stdin——
   * Node 语义下「已被显式 pause 的流」再挂 data 监听不会自动回 flowing，
   * 缺放流则复位后引擎永久失聪（真终端可复现；假 IO 的 push 直调处理器
   * 遮蔽了这一位——pty 审计抓出）。
   */
  resume(): void {
    if (this.state !== 'suspended') return;
    this.io.write(ENTER_MODES);
    this.io.setRawMode(true);
    this.io.onInput(this.handleInput);
    this.io.resume();
    this.state = 'running';
    // 几何核对（遗漏大扫 20260903 desktop D2-1）：挂起期 resize 事件被
    // handleResize 首行挂起短路整个丢弃——resume 起手比对当前 io 尺寸，
    // 失配即走 handleResize 同款重分配（此时 state 已 running：新
    // CellBuffer×2 + rowDiff 重建 + 2J 清屏锤 + resize 事件 + forceFull）。
    // 修前不核对：按旧尺寸 forceFull 重绘——终端已缩则差分写出含越界光标
    // 定位/旧宽折行，已扩则桌面不扩张
    if (this.io.columns !== this.front.width || this.io.rows !== this.front.height) {
      this.handleResize(); // 尾部自带 requestRender——直接收口
      return;
    }
    this.forceFull = true;
    this.front.clear(); // 基线重置（全量差分起点）
    this.cursorVisible = false; // 显隐态重置（清屏后首帧重发）
    this.requestRender();
  }

  /**
   * 排空 stdin 缓冲（退回 shell 前——契约篇 §6.11）：临时吞处理器 + resume
   * 放流 → 闲窗（idleMs 无新数据）或总帽（maxMs）到点收手。返回后输入处理器
   * 保持卸载、stdin 暂停——干净交回 shell。
   */
  async drainInput(maxMs: number = DRAIN_MAX_MS, idleMs: number = DRAIN_IDLE_MS): Promise<void> {
    const wasRunning = this.state === 'running';
    if (wasRunning) this.io.onInput(null); // 运行态调用：先卸引擎处理器
    let lastData = this.now();
    const swallow = (): void => {
      lastData = this.now();
    };
    this.io.onInput(swallow);
    this.io.resume(); // 放流：缓冲数据事件化（被吞处理器吃掉）
    const deadline = this.now() + maxMs;
    while (this.now() < deadline && this.now() - lastData < idleMs) {
      await new Promise<void>((res) => this.scheduleFn(res, idleMs));
    }
    this.io.onInput(null);
    this.io.pause();
    if (wasRunning) {
      // 运行态调用（罕见）：恢复引擎处理器与流态
      this.io.onInput(this.handleInput);
      this.io.resume();
    }
  }

  /** 终退：出屏 + 一切复原（dispose 后引擎不可复用） */
  dispose(): void {
    if (this.state === 'disposed') return;
    if (this.state === 'running') {
      this.io.write(LEAVE_MODES);
      this.io.onInput(null);
      this.io.pause();
      this.io.setRawMode(this.priorRaw);
    }
    this.io.onResize(null);
    this.cancelFrame();
    this.cancelEscapeTimer();
    this.state = 'disposed';
  }

  /** 输入处理器（decoder 喂入 + 事件排空上抛 + lone-ESC 判定窗定时器装/卸） */
  private readonly handleInput = (chunk: string): void => {
    if (this.state !== 'running') return; // 挂起/终退后残听防御
    this.decoder.feed(chunk);
    if (this.decoder.hasPendingEscape && this.escapeHandle === null) {
      this.escapeHandle = this.scheduleFn(() => {
        this.escapeHandle = null;
        this.decoder.settle();
        this.flushDecoderEvents();
      }, this.decoderEscapeWindowMs);
    }
    this.flushDecoderEvents();
  };

  /** 排空 decoder 事件队列并上抛 emitter */
  private flushDecoderEvents(): void {
    for (const ev of this.decoder.take()) {
      this.events.emit('input', ev as InputEvent);
    }
  }

  /** resize 处理器：缓冲重分配 + 全量重绘 + 事件上抛 */
  private readonly handleResize = (): void => {
    if (this.state !== 'running') return;
    const cols = this.io.columns;
    const rows = this.io.rows;
    if (cols === this.front.width && rows === this.front.height) return;
    this.front = new CellBuffer(cols, rows); // 新尺寸新缓冲（front 清屏基线）
    this.back = new CellBuffer(cols, rows);
    this.rowDiff = createRowDiff(rows);
    this.forceFull = true;
    this.cursorVisible = false; // 光标显隐态重置（清屏后必重发）
    // 清屏锤：resize 后终端可能 reflow 残留——2J 全清 + 全量重绘兜底
    this.io.write('\x1b[2J');
    this.events.emit('resize', { columns: cols, rows });
    this.requestRender();
  };

  /** 取消在飞帧定时器 */
  private cancelFrame(): void {
    if (this.frameHandle !== null) {
      this.cancelFn(this.frameHandle);
      this.frameHandle = null;
    }
  }

  /** 取消 lone-ESC 判定窗定时器 */
  private cancelEscapeTimer(): void {
    if (this.escapeHandle !== null) {
      this.cancelFn(this.escapeHandle);
      this.escapeHandle = null;
    }
  }
}
