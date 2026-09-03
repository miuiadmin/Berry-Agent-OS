/**
 * 引擎单元测试（十一律第 2/3/6/8 条）：scheduleFrame 单入口（请求合并/FPS 帽/
 * 按需零写出）、全量/增量帧、光标段、suspend/resume 换防收口面、resize、
 * 输入接线 + 性能回归锁（方案 §六：冷启动首帧 <100ms / 按键回显 <16ms /
 * resize 重排首帧 <50ms）。
 */
import { describe, expect, it } from 'vitest';
import { DesktopEngine } from './engine.js';
import { Text, SingleLineInput } from './components.js';
import type { TerminalIO } from './types.js';

/** 假终端 IO：记录写出/监听装拆/流态——引擎 IO 面的测试替身 */
class FakeIO implements TerminalIO {
  private nCols: number;
  private nRows: number;
  /** 每次 write 的分段记录（帧粒度断言面） */
  readonly written: string[] = [];
  raw = false;
  paused = false;
  inputHandler: ((chunk: string) => void) | null = null;
  resizeHandler: (() => void) | null = null;

  constructor(cols = 80, rows = 24) {
    this.nCols = cols;
    this.nRows = rows;
  }

  get columns(): number {
    return this.nCols;
  }

  get rows(): number {
    return this.nRows;
  }

  write(data: string): void {
    this.written.push(data);
  }

  setRawMode(enabled: boolean): void {
    this.raw = enabled;
  }

  isRaw(): boolean {
    return this.raw;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  onInput(handler: ((chunk: string) => void) | null): void {
    this.inputHandler = handler;
  }

  onResize(handler: (() => void) | null): void {
    this.resizeHandler = handler;
  }

  /** 测试驱动：stdin 数据到达 */
  push(chunk: string): void {
    this.inputHandler?.(chunk);
  }

  /** 测试驱动：终端尺寸变更 */
  resize(cols: number, rows: number): void {
    this.nCols = cols;
    this.nRows = rows;
    this.resizeHandler?.();
  }

  /** 累计输出全文 */
  get output(): string {
    return this.written.join('');
  }
}

/** 假钟：可注入 now/schedule/cancel——到点序触发（帧调度/FPS 帽断言面） */
function makeFakeClock() {
  let t = 0;
  let nextId = 1;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  return {
    now: (): number => t,
    schedule: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.push({ id, at: t + Math.max(0, ms), fn });
      return id;
    },
    cancel: (handle: unknown): void => {
      const i = timers.findIndex((x) => x.id === handle);
      if (i >= 0) timers.splice(i, 1);
    },
    /** 推进 ms 毫秒：按到期时刻序逐个触发（触发中排的新到期钟也吃进） */
    advance: (ms: number): void => {
      const target = t + ms;
      for (;;) {
        let pick: (typeof timers)[number] | undefined;
        for (const tm of timers) {
          if (tm.at <= target && (!pick || tm.at < pick.at || (tm.at === pick.at && tm.id < pick.id))) {
            pick = tm;
          }
        }
        if (!pick) break;
        t = Math.max(t, pick.at);
        timers.splice(timers.indexOf(pick), 1);
        pick.fn();
      }
      t = target;
    },
    /** 在飞钟数（请求合并/挂起短路断言面） */
    pending: (): number => timers.length,
  };
}

/** 装配引擎 + 假钟 + 假 IO（常用短路） */
function makeEngine(cols = 10, rows = 4) {
  const io = new FakeIO(cols, rows);
  const clock = makeFakeClock();
  const engine = new DesktopEngine({ io, now: clock.now, schedule: clock.schedule, cancelSchedule: clock.cancel });
  return { io, clock, engine };
}

/** 与 engine.ts 常量对称的契约锁串（漂移即红） */
const ENTER_MODES = '\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[>1u\x1b[?u\x1b[c';
const LEAVE_MODES = '\x1b[<u\x1b[?2004l\x1b[?25h\x1b[?1049l';

describe('启动与首帧', () => {
  it('start：模式串 + raw + 监听装上；首帧全量（2026 包裹）', () => {
    const { io, clock, engine } = makeEngine();
    engine.start(new Text({ content: 'hello' }));
    expect(io.written[0]).toBe(ENTER_MODES); // 进屏模式串（契约锁）
    expect(io.raw).toBe(true);
    expect(io.inputHandler).not.toBeNull();
    expect(io.resizeHandler).not.toBeNull();
    expect(engine.lifecycle).toBe('running');
    clock.advance(0); // 首帧（-Infinity 锚 → 立即到期）
    expect(io.written.length).toBe(2);
    expect(io.written[1]!.startsWith('\x1b[?2026h')).toBe(true); // 同步输出包裹
    expect(io.written[1]!.endsWith('\x1b[?2026l')).toBe(true);
    expect(io.written[1]!.includes('hello')).toBe(true);
  });

  it('start 幂等保护：仅 idle 可启', () => {
    const { engine } = makeEngine();
    engine.start(new Text({ content: 'a' }));
    engine.start(new Text({ content: 'b' })); // 二次启静默
    expect(engine.lifecycle).toBe('running');
  });
});

describe('按需渲染与请求合并（律 3）', () => {
  it('无变更零写出：空闲推进不产帧', () => {
    const { io, clock, engine } = makeEngine();
    engine.start(new Text({ content: 'x' }));
    clock.advance(0);
    const n = io.written.length;
    clock.advance(1000); // 无请求 → 零写出
    expect(io.written.length).toBe(n);
  });

  it('请求合并：5 次 requestRender 一帧收', () => {
    const { io, clock, engine } = makeEngine();
    engine.start(new Text({ content: 'a' }));
    clock.advance(0);
    const framesBefore = io.written.length;
    for (let i = 0; i < 5; i++) engine.setRoot(new Text({ content: `v${i}` }));
    expect(clock.pending()).toBe(1); // 单定时器在飞（合并）
    clock.advance(20);
    expect(io.written.length).toBe(framesBefore + 1); // 一帧
    expect(io.written[io.written.length - 1]!.includes('v4')).toBe(true);
  });

  it('FPS 帽：帧间隔下限内的请求排到帽点', () => {
    const { io, clock, engine } = makeEngine();
    engine.start(new Text({ content: 'a' }));
    clock.advance(0); // t=0 首帧
    engine.setRoot(new Text({ content: 'b' }));
    clock.advance(10); // 距上帧 10ms < 16.67 → 不出帧
    expect(io.written.length).toBe(2);
    clock.advance(10); // 到帽点 → 出帧
    expect(io.written.length).toBe(3);
  });
});

describe('光标段', () => {
  it('有光标件帧带 CUP+显；撤光标帧发藏（去重：同态零冗余）', () => {
    const { io, clock, engine } = makeEngine();
    const input = new SingleLineInput({ prompt: '>' });
    input.setText('ab');
    engine.start(input);
    clock.advance(0);
    const frame1 = io.written[1]!;
    expect(frame1.includes('\x1b[?25h')).toBe(true); // 显
    expect(frame1.includes('\x1b[1;4H')).toBe(true); // 光标在 '>ab' 尾（x=3 → 1 基 4）
    engine.setRoot(new Text({ content: 'plain' })); // 无光标件
    clock.advance(20);
    const frame2 = io.written[2]!;
    expect(frame2.includes('\x1b[?25l')).toBe(true); // 藏
    // 再来一帧仍无光标：不重复发藏
    engine.setRoot(new Text({ content: 'plain2' }));
    clock.advance(20);
    expect(io.written[3]!.includes('\x1b[?25l')).toBe(false);
  });
});

describe('换防收口面（律 8 / 契约篇 §6.11）', () => {
  it('suspend 三件套 + 挂起短路；resume 全量重绘', async () => {
    const { io, clock, engine } = makeEngine();
    engine.start(new Text({ content: 'desk' }));
    clock.advance(0);
    const framesBefore = io.written.length;

    engine.suspend();
    expect(engine.suspended).toBe(true);
    expect(io.written[framesBefore]).toBe(LEAVE_MODES); // 出屏模式串（契约锁）
    expect(io.inputHandler).toBeNull(); // onInput(null)
    expect(io.paused).toBe(true); // pause()
    expect(io.raw).toBe(false); // raw 复原先验态（FakeIO 初始 false）
    expect(clock.pending()).toBe(0); // 在飞帧取消
    engine.requestRender(); // 挂起静默短路
    expect(clock.pending()).toBe(0);

    engine.resume();
    expect(engine.suspended).toBe(false);
    expect(io.written[io.written.length - 1]).toBe(ENTER_MODES); // 清屏重进
    expect(io.raw).toBe(true); // raw 重设
    expect(io.inputHandler).not.toBeNull(); // 监听重装
    // 放流步回归锁（pty 审计抓出的真缺陷）：对家栈（pi-tui）停屏时显式
    // pause 过 stdin——Node 语义下被显式 pause 的流再挂 data 监听不自动回
    // flowing，resume 必须补 io.resume()，否则复位后引擎永久失聪
    expect(io.paused).toBe(false);
    clock.advance(20); // FPS 帽：距上帧一帧间隔内排到帽点
    const last = io.written[io.written.length - 1]!;
    expect(last.startsWith('\x1b[?2026h')).toBe(true); // 全量重绘首帧
    expect(last.includes('desk')).toBe(true);
  });

  it('换防瞬间在途转义一窗全丢：残尾不当键不丢键', async () => {
    const { io, clock, engine } = makeEngine();
    const events: unknown[] = [];
    engine.on('input', (ev) => events.push(ev));
    engine.start(new Text({ content: 'x' }));
    clock.advance(0);
    io.push('\x1b[97'); // CSI 半截在途
    engine.suspend();
    engine.resume();
    clock.advance(0);
    io.push('u'); // 残尾：按地面态重解 → 文本
    expect(events).toEqual([{ kind: 'text', text: 'u' }]);
  });

  it('挂起期输入零派发（残听防御）', async () => {
    const { io, clock, engine } = makeEngine();
    const events: unknown[] = [];
    engine.on('input', (ev) => events.push(ev));
    engine.start(new Text({ content: 'x' }));
    clock.advance(0);
    engine.suspend();
    io.push('abc'); // handler 已卸——FakeIO 直调残听防御路径
    engine.resume();
    expect(events).toEqual([]);
  });
});

describe('resize', () => {
  it('尺寸变更：2J 清屏锤 + 缓冲重分配 + 全量帧 + 事件上抛', () => {
    const { io, clock, engine } = makeEngine(10, 4);
    const sizes: { columns: number; rows: number }[] = [];
    engine.on('resize', (s) => sizes.push(s));
    engine.start(new Text({ content: 'wide' }));
    clock.advance(0);
    io.resize(20, 6);
    expect(io.written[io.written.length - 1]).toBe('\x1b[2J'); // 清屏锤
    expect(sizes).toEqual([{ columns: 20, rows: 6 }]);
    expect(engine.columns).toBe(20);
    expect(engine.rows).toBe(6);
    clock.advance(20); // FPS 帽一帧间隔后全量重绘
    const last = io.written[io.written.length - 1]!;
    expect(last.includes('wide')).toBe(true); // 全量重绘
  });

  it('同尺寸 resize 幂等：零动作', () => {
    const { io, clock, engine } = makeEngine(10, 4);
    engine.start(new Text({ content: 'x' }));
    clock.advance(0);
    const n = io.written.length;
    io.resize(10, 4);
    expect(io.written.length).toBe(n);
  });
});

describe('输入接线', () => {
  it('stdin → 解码 → 引擎事件；kitty 探测落定上抛', () => {
    const { io, clock, engine } = makeEngine();
    const events: unknown[] = [];
    const protocols: string[] = [];
    engine.on('input', (ev) => events.push(ev));
    engine.on('keyboardProtocol', (p) => protocols.push(p));
    engine.start(new Text({ content: 'x' }));
    clock.advance(0);
    io.push('\x1b[A');
    io.push('hi');
    expect(events).toEqual([
      { kind: 'key', key: 'up', mods: { ctrl: false, alt: false, shift: false, meta: false } },
      { kind: 'text', text: 'hi' },
    ]);
    io.push('\x1b[?1u'); // kitty 应答
    expect(protocols).toEqual(['kitty']);
    expect(engine.keyboardProtocol).toBe('kitty');
  });

  it('lone-ESC 判定窗由引擎装钟：窗到点出 Esc', () => {
    const { io, clock, engine } = makeEngine();
    const events: unknown[] = [];
    engine.on('input', (ev) => events.push(ev));
    engine.start(new Text({ content: 'x' }));
    clock.advance(0);
    io.push('\x1b');
    expect(clock.pending()).toBe(1); // 判定窗钟在飞
    clock.advance(30);
    expect(events).toEqual([
      { kind: 'key', key: 'escape', mods: { ctrl: false, alt: false, shift: false, meta: false } },
    ]);
  });
});

describe('drainInput（退回 shell 前排空）', () => {
  it('排空窗吃掉缓冲残流；返回后输入处理器按运行态复原', async () => {
    // 本面用真钟（drain 的闲窗轮询走真实异步——假钟会死锁）
    const io = new FakeIO();
    const engine = new DesktopEngine({ io });
    const events: unknown[] = [];
    engine.on('input', (ev) => events.push(ev));
    engine.start(new Text({ content: 'x' }));
    io.push('a'); // 启动期正常键
    const drained = engine.drainInput(500, 20);
    io.push('junk'); // 排空窗内残流——被吞处理器吃掉
    await drained;
    expect(events).toEqual([{ kind: 'text', text: 'a' }]); // junk 不派发
    expect(io.paused).toBe(false); // 运行态复原：resume
    expect(io.inputHandler).not.toBeNull(); // 处理器重装
    io.push('b'); // 排空后恢复派发
    expect(events).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);
  });
});

describe('性能回归锁（方案 §六预算）', () => {
  /** 大网格填充根：每行写满文本（最坏全量帧工作量） */
  class FillAll {
    desiredHeight(): number {
      return 1;
    }
    render(
      area: { x: number; y: number; width: number; height: number },
      buf: { writeString: (x: number, y: number, t: string) => void },
    ): void {
      for (let y = 0; y < area.height; y++) {
        buf.writeString(area.x, area.y + y, '中a'.repeat(Math.ceil(area.width / 6)) + '='.repeat(area.width));
      }
    }
  }

  it('冷启动首帧 <100ms（500x200 大网格全量帧）', () => {
    const { clock, engine } = makeEngine(500, 200);
    const t0 = performance.now();
    engine.start(new FillAll());
    clock.advance(0);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(100);
  });

  it('按键回显 <16ms（单字变更加帧）', () => {
    const { io, clock, engine } = makeEngine(80, 24);
    engine.start(new Text({ content: 'hello' }));
    clock.advance(0);
    const t0 = performance.now();
    engine.setRoot(new Text({ content: 'hello!' })); // 一字符变更
    clock.advance(20);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(16);
    expect(io.written[io.written.length - 1]!.includes('!')).toBe(true);
  });

  it('resize 重排首帧 <50ms（大网格重排 + 全量重绘）', () => {
    const { io, clock, engine } = makeEngine(300, 100);
    engine.start(new FillAll());
    clock.advance(0);
    const t0 = performance.now();
    io.resize(400, 120);
    clock.advance(0);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(50);
  });
});
