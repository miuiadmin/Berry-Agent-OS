/**
 * app — 桌面壳后端测试（第八十五批批 C，契约篇 §6.11 换防编舞）。
 *
 * 测法 = 假终端 IO + 假钟（mock 停在终端/时序边界）：三视图键路由 / 分组切换 /
 * 菜单与详情换装 / 命令前缀分派 / 换防两动词的**调用序**（enterApp → 引擎
 * suspend → enterAppView；leaveAppView → 引擎 resume——序倒即两栈抢写）/ 起屏
 * 失败熔断上抛 + 挂起短路 / 时钟定时器。
 *
 * 引擎帧是调度产物（requestRender 合并 + 定时器出帧）——每次按键后必须推进
 * 假钟冲帧再断言；lone-ESC 有 30ms 判定窗（推 31ms）。dispose 内含 drainInput
 * 闲窗（假钟 50ms）——终退断言须并发推进。
 */
import { describe, expect, it } from 'vitest';
import { createDesktopShell, type DesktopShellDeps } from './desktop-shell.js';
import { createDesktopService } from './desktop-service.js';
import type { DesktopAppEntry } from './desktop-service.js';
import type { TerminalIO } from '../desktop/index.js';

/* ---------------- 测试替身 ---------------- */

/** 假终端 IO（引擎 IO 面测试替身——engine.test 同款收窄版） */
class FakeIO implements TerminalIO {
  readonly written: string[] = [];
  raw = false;
  paused = false;
  private handler: ((chunk: string) => void) | null = null;
  constructor(
    readonly columns = 80,
    readonly rows = 24,
  ) {}
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
    this.handler = handler;
  }
  onResize(): void {}
  /** 测试驱动：输入到达（字节直喂——走引擎真解码器） */
  push(chunk: string): void {
    this.handler?.(chunk);
  }
  get output(): string {
    return this.written.join('');
  }
}

/** 假钟（时序三件注入面——帧调度/判定窗/drain 闲窗全走它，advance 按到期序发火） */
function fakeClock() {
  let t = 0;
  let nextId = 1;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  return {
    now: (): number => t,
    schedule: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.push({ id, at: t + ms, fn });
      return id;
    },
    cancel: (handle: unknown): void => {
      const i = timers.findIndex((x) => x.id === handle);
      if (i >= 0) timers.splice(i, 1);
    },
    advance: (ms: number): void => {
      const target = t + ms;
      for (;;) {
        const pick = timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (pick === undefined) break;
        t = Math.max(t, pick.at);
        timers.splice(timers.indexOf(pick), 1);
        pick.fn();
      }
      t = target;
    },
    pending: (): number => timers.length,
  };
}
type FakeClock = ReturnType<typeof fakeClock>;

/** 标准三应用清单（官方二 + 第三方一——分组切换断言面） */
const APPS: DesktopAppEntry[] = [
  { id: 'chat', label: '对话', group: 'official', openable: true, isDefault: true },
  { id: 'berrycode', label: '代码', group: 'official', openable: true },
  { id: 'extra', label: '扩展', group: 'thirdparty', openable: false, note: '组件缺场（x、y）' },
];

/** 换防动作标记（调用序断言的物证面——mock 顺带写屏，indexOf 定序） */
const MARK_ENTER_VIEW = '⟦ENTER-APP-VIEW⟧';
const MARK_LEAVE_VIEW = '⟦LEAVE-APP-VIEW⟧';

/** 壳 deps 桩（恒挂假钟 + 调用账本；override 换动作实现） */
function makeDeps(overrides: Partial<DesktopShellDeps> = {}): {
  deps: DesktopShellDeps;
  io: FakeIO;
  clock: FakeClock;
  calls: string[];
} {
  const io = new FakeIO();
  const clock = fakeClock();
  const calls: string[] = [];
  const deps: DesktopShellDeps = {
    io,
    timing: { now: clock.now, schedule: clock.schedule, cancelSchedule: clock.cancel },
    listApps: () => APPS,
    enterApp: (appId: string) => {
      calls.push(`enterApp:${appId}`);
      return appId === 'extra' ? { ok: false, error: '组件缺场' } : { ok: true, sessionId: `s-${appId}` };
    },
    enterAppView: () => {
      calls.push('enterAppView');
      io.write(MARK_ENTER_VIEW); // 序物证：比 suspend 的 LEAVE_MODES 晚
    },
    leaveAppView: () => {
      calls.push('leaveAppView');
      io.write(MARK_LEAVE_VIEW); // 序物证：比 resume 的 ENTER_MODES 早
    },
    requestExit: () => {
      calls.push('requestExit');
    },
    ...overrides,
  };
  return { deps, io, clock, calls };
}

/** 已起屏壳（start + 冲掉引擎遗留零延迟帧） */
function started(overrides: Partial<DesktopShellDeps> = {}): {
  deps: DesktopShellDeps;
  io: FakeIO;
  clock: FakeClock;
  calls: string[];
  shell: ReturnType<typeof createDesktopShell>;
} {
  const made = makeDeps(overrides);
  const shell = createDesktopShell(made.deps);
  shell.start();
  made.clock.advance(0);
  return { ...made, shell };
}

/**
 * 按一键 + 冲帧。缺省推进 17ms：引擎帧受 FPS 帽调度（60fps ≈ 16.67ms 后出帧），
 * advance(0) 冲不掉在飞帧；lone-ESC 还要过 30ms 判定窗再等帧——用 50ms。
 */
function press(io: FakeIO, clock: FakeClock, chunk: string, ms = 17): void {
  io.push(chunk);
  clock.advance(ms);
}

/** 终退（drainInput 闲窗 50ms——并发推进假钟解悬） */
async function teardown(shell: ReturnType<typeof createDesktopShell>, clock: FakeClock): Promise<void> {
  const pending = shell.dispose();
  clock.advance(60);
  await pending;
}

/** 键字节（legacy 轨 xterm 形态——引擎真解码器可解） */
const KEY = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  /** lone-ESC：解码器持 30ms 判定窗后才出键——press 时须带窗推进（用 50） */
  escape: '\x1b',
  tab: '\t',
  backspace: '\x7f',
  m: 'm',
};

/* ---------------- 起屏与视图 ---------------- */

describe('desktop-shell：起屏与首帧', () => {
  it('start 首帧同步渲染：输出含品牌行/页签行/清单行（光标标记默认应用）', () => {
    const { io, shell } = started();
    expect(io.output).toContain('Berry 桌面');
    expect(io.output).toContain('[全部]');
    expect(io.output).toContain('官方');
    expect(io.output).toContain('第三方');
    // 首条目光标态：▸ 标记 + 默认位标注；第三方不可进入附说明
    expect(io.output).toContain('▸ 对话（chat）〔默认〕');
    expect(io.output).toContain('代码（berrycode）');
    expect(io.output).toContain('扩展（extra） — 组件缺场（x、y）');
    void shell.dispose();
  });

  it('空清单形态：分组空提示行（无应用不是死屏——装机指引在屏）', () => {
    const made = makeDeps({ listApps: () => [] });
    const shell = createDesktopShell(made.deps);
    shell.start();
    made.clock.advance(0);
    expect(made.io.output).toContain('全部分组无应用');
    void shell.dispose();
  });

  it('start 后服务面挂 face；未挂起态幂等空回执；dispose 摘面 + 幂等', async () => {
    const service = createDesktopService();
    const made = makeDeps({ service });
    const shell = createDesktopShell(made.deps);
    expect(service.backToDesktop().ok).toBe(false); // 起屏前无 face
    shell.start();
    made.clock.advance(0);
    expect(service.backToDesktop()).toEqual({ ok: true }); // 已在桌面——幂等空回执（不触 leaveAppView）
    expect(made.calls).toEqual([]);
    await teardown(shell, made.clock);
    expect(service.backToDesktop().ok).toBe(false); // 摘面后拒绝
    await shell.dispose(); // 幂等
  });
});

/* ---------------- 键路由与视图状态机 ---------------- */

describe('desktop-shell：键路由（desktop 视图）', () => {
  it('↑↓ 移动光标（循环）+ 空 Enter 打开当前应用（换防序执法）', () => {
    const { io, clock, calls, shell } = started();
    try {
      press(io, clock, KEY.down);
      expect(io.output).toContain('▸ 代码（berrycode）'); // 光标到第二行
      press(io, clock, KEY.enter);
      // 换防序：enterApp 先行（失败不换防）→ 引擎 suspend（LEAVE_MODES）→ enterAppView
      expect(calls).toEqual(['enterApp:berrycode', 'enterAppView']);
      expect(shell.suspended).toBe(true);
      // 序物证：enterAppView 标记在 suspend 出屏串之后（先交 TTY 再起对家屏）
      expect(io.output.lastIndexOf('\x1b[?1049l')).toBeLessThan(io.output.indexOf(MARK_ENTER_VIEW));
    } finally {
      void shell.dispose();
    }
  });

  it('不可进入应用空 Enter：提示行披露原因、零换防', () => {
    const { io, clock, calls, shell } = started();
    try {
      press(io, clock, KEY.down);
      press(io, clock, KEY.down); // 到 extra（openable false）
      const before = io.written.length;
      press(io, clock, KEY.enter);
      expect(calls).toEqual([]); // 未触 enterApp（壳侧 openable 前置拒）
      // 提示行落在按键后的新帧（notice = 缺场说明——与清单行同文，看增量）
      expect(io.written.slice(before).join('')).toContain('组件缺场（x、y）');
    } finally {
      void shell.dispose();
    }
  });

  it('进入失败（runtime 拒）：提示行转述错误、零换防', () => {
    // override 不走 makeDeps 缺省记账——自记 seen（失败形态也要有调用物证）
    const seen: string[] = [];
    const made = makeDeps({
      enterApp: (appId) => {
        seen.push(appId);
        return { ok: false, error: '无持久层' };
      },
    });
    const shell = createDesktopShell(made.deps);
    shell.start();
    made.clock.advance(0);
    try {
      press(made.io, made.clock, KEY.enter);
      expect(seen).toEqual(['chat']);
      expect(made.calls).toEqual([]); // enterAppView 不在（零换防）
      expect(made.io.output).toContain('进入失败：无持久层');
      expect(shell.suspended).toBe(false);
    } finally {
      void shell.dispose();
    }
  });

  it('← → Tab 循环切分组：官方/第三方过滤 + 光标归零', () => {
    const { io, clock, shell } = started();
    try {
      press(io, clock, KEY.right); // 全部 → 官方
      expect(io.output).toContain('[官方]');
      press(io, clock, KEY.right); // 官方 → 第三方
      expect(io.output).toContain('[第三方]');
      // 光标归零 = 第三方唯一条目：差分帧里光标行带反视频段（▸ 前缀在差分里
      // 与旧行同格不重发——断言按差分真实形状取反视频 + 行文）
      expect(io.output).toContain('\x1b[7m扩展（extra）');
      press(io, clock, KEY.left); // 第三方 → 全部
      expect(io.output).toContain('[全部]');
      press(io, clock, KEY.tab); // Tab 同右切
      expect(io.output).toContain('[官方]');
    } finally {
      void shell.dispose();
    }
  });

  it('m 开菜单 → 详情视图 → Esc 层层返回', () => {
    const { io, clock, shell } = started();
    try {
      press(io, clock, KEY.m);
      expect(io.output).toContain('应用菜单');
      expect(io.output).toContain('打开');
      // 菜单 ↓ 到「详情」（第 6 项）→ Enter
      for (let i = 0; i < 5; i++) press(io, clock, KEY.down);
      press(io, clock, KEY.enter);
      // 头行 'Berry 桌面 — 应用详情' 与菜单头共前缀——差分只发 '详情' 尾段；
      // 详情身份按内容行 + 批 D 管理提示行断言（差分真实形状）
      expect(io.output).toContain('id：chat');
      expect(io.output).toContain('名称：对话');
      expect(io.output).toContain('默认位：是');
      expect(io.output).toContain('管理动作（配置/卸载/挂载族）随批 D');
      press(io, clock, KEY.escape, 50); // 详情 → 桌面（判定窗 + 帧两段）
      expect(io.output).toContain('[全部]');
    } finally {
      void shell.dispose();
    }
  });

  it('菜单「打开」执行换防；管理四项占位回应（批 C 不造管理逻辑）', () => {
    const { io, clock, calls, shell } = started();
    try {
      press(io, clock, KEY.m);
      press(io, clock, KEY.enter); // 菜单项 0 = 打开
      expect(calls).toEqual(['enterApp:chat', 'enterAppView']);
      expect(shell.suspended).toBe(true);
      // 回桌面后再进菜单试「配置」（第 2 项）
      shell.backToDesktop();
      clock.advance(17);
      press(io, clock, KEY.m);
      press(io, clock, KEY.down);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('配置：随批 D 接 admin 工具面');
      // 三动词账：打开（enterApp+enterAppView）+ 测试直调回桌面（leaveAppView）
      expect(calls).toEqual(['enterApp:chat', 'enterAppView', 'leaveAppView']);
    } finally {
      void shell.dispose();
    }
  });

  it('命令前缀：/exit 真退 / 未知命令与裸文本提示 / /shutdown 批 D 占位', () => {
    const { io, clock, calls, shell } = started();
    try {
      for (const ch of '/exit') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(calls).toEqual(['requestExit']);
      for (const ch of '/shutdown') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('批 D');
      for (const ch of '/frobnicate') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('未知命令：/frobnicate');
      for (const ch of 'hello') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('未知输入');
    } finally {
      void shell.dispose();
    }
  });

  it('Ctrl+D = /exit（全视图恒可退）', () => {
    const { io, clock, calls, shell } = started();
    try {
      press(io, clock, KEY.m); // 进菜单（非 desktop 视图也恒可退）
      press(io, clock, '\x04'); // Ctrl+D
      expect(calls).toEqual(['requestExit']);
    } finally {
      void shell.dispose();
    }
  });

  it('输入框编辑：backspace 删字符', () => {
    const { io, clock, shell } = started();
    try {
      for (const ch of '/ab') press(io, clock, ch);
      press(io, clock, KEY.backspace);
      press(io, clock, 'c');
      press(io, clock, KEY.enter);
      // 剩 '/ac' → 未知命令面（回执披露实际内容）
      expect(io.output).toContain('未知命令：/ac');
    } finally {
      void shell.dispose();
    }
  });
});

/* ---------------- 换防两动词（序的执法面） ---------------- */

describe('desktop-shell：换防两动词', () => {
  it('回桌面序：leaveAppView 先于引擎 resume（停屏 → 复位）——复位后全量首帧含清单', () => {
    const { io, clock, calls, shell } = started();
    press(io, clock, KEY.enter); // 进应用（挂起）
    const before = io.written.length;
    const result = shell.backToDesktop();
    expect(result).toEqual({ ok: true });
    clock.advance(17); // 冲复位后全量首帧（FPS 帽调度）
    expect(calls).toContain('leaveAppView');
    expect(shell.suspended).toBe(false);
    // 序物证：leaveAppView 标记在 resume 进屏串（\x1b[?1049h 再现）之前
    const lastEnter = io.output.lastIndexOf('\x1b[?1049h');
    expect(io.output.indexOf(MARK_LEAVE_VIEW)).toBeLessThan(lastEnter);
    // 复位后全量首帧已写出（新字节 > 0 且含桌面内容）
    expect(io.written.length).toBeGreaterThan(before);
    expect(io.written.slice(before).join('')).toContain('Berry 桌面');
    void shell.dispose();
  });

  it('leaveAppView 抛错：诚实回执 ok:false + error（宿主可提示）', () => {
    const made = makeDeps({
      leaveAppView: () => {
        throw new Error('停屏炸了');
      },
    });
    const shell = createDesktopShell(made.deps);
    shell.start();
    made.clock.advance(0);
    made.io.push(KEY.enter);
    const result = shell.backToDesktop();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('停屏炸了');
    void shell.dispose();
  });

  it('应用视图起屏失败回滚：engine.resume 复原 + 提示行（两栈不悬在中间态）', () => {
    const made = makeDeps({
      enterAppView: () => {
        throw new Error('起屏炸了');
      },
    });
    const shell = createDesktopShell(made.deps);
    shell.start();
    made.clock.advance(0);
    press(made.io, made.clock, KEY.enter);
    expect(shell.suspended).toBe(false); // 回滚已 resume
    expect(made.io.output).toContain('应用视图起屏失败');
    void shell.dispose();
  });

  it('挂起期渲染静默：suspend 后残余输入/时钟都不产帧（pi-tui 在屏不抢写）', () => {
    const { io, clock, shell } = started();
    press(io, clock, KEY.enter); // 进应用（挂起——cancelClock + 引擎短路）
    const writtenAtSuspend = io.written.length;
    io.push('xyz'); // 挂起期输入已卸处理器（onInput(null)）——零路由
    clock.advance(100); // 假想中的重绘请求窗——挂起态零帧
    expect(io.written.length).toBe(writtenAtSuspend); // 零新帧
    void shell.dispose();
  });
});

/* ---------------- 时钟与熔断 ---------------- */

describe('desktop-shell：时钟定时器与起屏失败', () => {
  it('时钟 30s 周期重排：跨分钟进位出帧 + 续排下一周期', () => {
    const { io, clock } = started();
    expect(clock.pending()).toBe(1); // 起屏即武装（唯一在飞——引擎帧已冲掉）
    const before = io.written.length;
    clock.advance(61_000); // 跨分钟（顶栏 HH:MM 进位——同分钟零差分不出帧）
    expect(io.written.length).toBeGreaterThan(before); // 顶栏差分帧已出
    expect(clock.pending()).toBe(1); // 续排（下一周期）
  });

  it('起屏失败（渲染树异常）：同步上抛供熔断计数 + 服务摘面 + 终端复原', () => {
    // listApps 抛错 = 建树失败形态（引擎首帧渲染前的同步失败）
    const service = createDesktopService();
    const made = makeDeps({
      listApps: () => {
        throw new Error('清单炸了');
      },
      service,
    });
    const shell = createDesktopShell(made.deps);
    expect(() => shell.start()).toThrow('清单炸了');
    // 收口面：服务面已摘（或从未挂）+ 引擎终退（raw 复原）——壳不可复用
    expect(service.backToDesktop().ok).toBe(false);
    expect(made.io.raw).toBe(false);
    // dispose 不二炸
    void shell.dispose().catch(() => undefined);
  });
});
