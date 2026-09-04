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
import { createDesktopShell, type DesktopAdminFace, type DesktopShellDeps } from './desktop-shell.js';
import { createDesktopService } from './desktop-service.js';
import type { DesktopAppEntry, DesktopStatusService } from './desktop-service.js';
import type { AssistantAnswer, AssistantService } from './assistant-app.js';
import type { DesktopMonitorFace, MonitorPanel, MonitorTab } from './desktop-monitor.js';
import type { DesktopStatusSnapshot } from './desktop-status.js';
import { POWER_KILL_FAMILY_TEXT } from './host-power.js';
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
  g: 'g',
};

/* ---------------- 批 D 测试替身（状态服务/管理面） ---------------- */

/** 状态服务假面（快照钉值 + start/stop 记账 + emit 模拟聚合器值变通知） */
function fakeStatus(initial: DesktopStatusSnapshot) {
  let snapshot = initial;
  const calls: string[] = [];
  let listener: (() => void) | undefined;
  return {
    calls,
    /** 测试驱动：换快照 + 通知（模拟聚合器值变——壳应 rerender 顶栏） */
    emit(next: DesktopStatusSnapshot): void {
      snapshot = next;
      listener?.();
    },
    service: {
      attach: () => undefined,
      detach: () => undefined,
      snapshot: () => snapshot,
      onChange(cb: () => void): () => void {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      start: () => {
        calls.push('start');
      },
      stop: () => {
        calls.push('stop');
      },
    } satisfies DesktopStatusService,
  };
}

/** 标准快照（五槽位定值——顶栏断言面） */
const SNAP: DesktopStatusSnapshot = {
  time: '08:30:00',
  cpuPercent: 12,
  memoryPercent: 34,
  backgroundJobs: 2,
  installedApps: 3,
};

/** 管理面假面（调用记账 + 三形回执：结构/带确认段/单行提示） */
function fakeAdmin() {
  const calls: string[] = [];
  const admin: DesktopAdminFace = {
    async configure(id, patchJson) {
      calls.push(`configure:${id}:${patchJson}`);
      return { title: `已配置 ${id}`, lines: ['  写入键：k'] };
    },
    async uninstallInspect(id) {
      calls.push(`inspect:${id}`);
      return {
        title: `卸载检视 ${id}`,
        lines: ['  引用：file:./x'],
        confirm: {
          label: '确认卸载（保留数据域）',
          run: async () => {
            calls.push(`execute:${id}:keep`);
            return { title: `卸载完成 ${id}`, lines: ['  装机物已删'] };
          },
        },
      };
    },
    async uninstallExecute(id, dataAction) {
      calls.push(`execute:${id}:${dataAction}`);
      return { title: `卸载完成 ${id}`, lines: ['  装机物已删'] };
    },
    async unmount(rowId) {
      calls.push(`unmount:${rowId}`);
      return { title: `已卸挂载 ${rowId}`, lines: ['  已删行'] };
    },
    async mount(installId, apps) {
      calls.push(`mount:${installId}:${apps.join('+')}`);
      return '挂载完成（单行提示形）';
    },
  };
  return { admin, calls };
}

/** 微任务冲刷（管理面 async 假面 → .then 回执链两拍——假钟测试不 await 真时序） */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** 系统助手假面（批 E 默认应答替身：问句记账 + 可脚本应答——引导面带序物证标记） */
function fakeAssistant(opts: { answer?: (question: string) => Promise<AssistantAnswer> } = {}) {
  const calls: string[] = [];
  const face: AssistantService = {
    answer(question) {
      calls.push(question);
      return opts.answer ? opts.answer(question) : Promise.resolve({ kind: 'model', lines: ['答：命令面清单如下…'] });
    },
    guide: () => ['⟦助手引导面⟧ 首启引导——凭证指引', 'export ANTHROPIC_API_KEY=…'],
  };
  return { face, calls };
}

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
      // 详情身份按内容行 + 菜单指路提示行断言（差分真实形状）
      expect(io.output).toContain('id：chat');
      expect(io.output).toContain('名称：对话');
      expect(io.output).toContain('默认位：是');
      expect(io.output).toContain('管理动作经菜单（m）');
      press(io, clock, KEY.escape, 50); // 详情 → 桌面（判定窗 + 帧两段）
      expect(io.output).toContain('[全部]');
    } finally {
      void shell.dispose();
    }
  });

  it('菜单「打开」执行换防；管理四项在 admin 缺席时诚实拒（不假执行）', () => {
    const { io, clock, calls, shell } = started();
    try {
      press(io, clock, KEY.m);
      press(io, clock, KEY.enter); // 菜单项 0 = 打开
      expect(calls).toEqual(['enterApp:chat', 'enterAppView']);
      expect(shell.suspended).toBe(true);
      // 回桌面后再进菜单试「配置」（第 2 项）——admin 未注入：诚实拒因
      shell.backToDesktop();
      clock.advance(17);
      press(io, clock, KEY.m);
      press(io, clock, KEY.down);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('管理面未接线（宿主未注入 admin 服务）');
      // 三动词账：打开（enterApp+enterAppView）+ 测试直调回桌面（leaveAppView）
      expect(calls).toEqual(['enterApp:chat', 'enterAppView', 'leaveAppView']);
    } finally {
      void shell.dispose();
    }
  });

  it('命令前缀：/exit 真退 / 未知命令与裸文本提示 / /shutdown 过 confirm 原语', () => {
    const powerCalls: string[] = []; // 编舞记账（本测 Esc 取消——恒空）
    const { io, clock, calls, shell } = started({
      requestPower: (action) => {
        powerCalls.push(action);
        return Promise.resolve({ action, outcome: 'self-exiting', exitCode: 0, message: '' });
      },
    });
    try {
      for (const ch of '/exit') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(calls).toEqual(['requestExit']);
      // /shutdown 不再占位——恒杀全家二次确认视图（详见动词专测）
      for (const ch of '/shutdown') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('确认关停？');
      expect(io.output).toContain('恒杀全家');
      press(io, clock, KEY.escape, 50); // 确认视图取消回桌面
      expect(io.output).toContain('[全部]');
      expect(powerCalls).toEqual([]); // 未确认零编舞
      for (const ch of '/frobnicate') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('未知命令：/frobnicate');
      for (const ch of 'hello') press(io, clock, ch);
      press(io, clock, KEY.enter);
      // 批 E：无前缀文本默认问系统助手；本测未接助手面 → 缺席帮助卡（carve-out ④ 回落）
      expect(io.output).toContain('系统助手不在场');
      expect(io.output).toContain('/apps-toggle assistant');
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

/* ---------------- 顶栏五槽位与首启引导（批 D） ---------------- */

describe('desktop-shell：顶栏五槽位状态行', () => {
  it('status 在场：五槽位单行呈现（时间/CPU/内存/后台/应用）+ 聚合器驱动（占位时钟停用）', () => {
    const status = fakeStatus(SNAP);
    const { io, clock, shell } = started({ status: status.service });
    try {
      expect(io.output).toContain(' Berry 桌面 · 08:30:00 · CPU 12% · 内存 34% · 后台 2 · 应用 3');
      expect(clock.pending()).toBe(0); // 占位时钟停用（聚合器驱动——无 30s 定时器）
      expect(status.calls).toEqual(['start']); // 起屏即起表
    } finally {
      void shell.dispose();
    }
  });

  it('status 缺席：回落占位时钟（批 C 形态不假死）', () => {
    const { io, shell } = started();
    try {
      expect(io.output).toContain('Berry 桌面'); // 无五槽位段
      expect(io.output).not.toContain('CPU ');
    } finally {
      void shell.dispose();
    }
  });

  it('值变通知驱动重绘：emit 换快照 → 顶栏差分帧出新值', () => {
    const status = fakeStatus(SNAP);
    const { io, clock, shell } = started({ status: status.service });
    try {
      const before = io.written.length;
      status.emit({ ...SNAP, cpuPercent: 56, backgroundJobs: 7 });
      clock.advance(17); // 冲差分帧
      expect(io.written.length).toBeGreaterThan(before);
      // pi-tui 差分帧只重写变化列起的尾段（' · CPU ' 前缀未变——'12%'→'56%'），
      // 断言按帧内连续片段锚新值（整行 'CPU 56%' 在字节流中不连续出现）
      expect(io.output).toContain('56% · 内存 34% · 后台 7');
    } finally {
      void shell.dispose();
    }
  });

  it('换防生命周期：进应用 stop 停表、回桌面 start 续表（挂起期零轮询）', () => {
    const status = fakeStatus(SNAP);
    const { io, clock, shell } = started({ status: status.service });
    press(io, clock, KEY.enter); // 进应用（挂起）
    expect(status.calls).toEqual(['start', 'stop']);
    shell.backToDesktop();
    clock.advance(17);
    expect(status.calls).toEqual(['start', 'stop', 'start']);
    void shell.dispose();
  });
});

describe('desktop-shell：凭证警示槽与首启引导', () => {
  it('警示槽恒显红条 + /guide 进引导视图（guidance 真文案同源呈现）', () => {
    const status = fakeStatus({
      ...SNAP,
      credentialIssue: {
        provider: 'anthropic',
        guidance: '模型 provider「anthropic」未配置凭证。\n配置途径：export ANTHROPIC_API_KEY=…',
      },
    });
    const { io, clock, shell } = started({ status: status.service });
    try {
      expect(io.output).toContain('⚠ 凭证未配置（anthropic）——/guide 进引导');
      for (const ch of '/guide') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('首启引导——模型凭证未配置');
      expect(io.output).toContain('未配置凭证');
      expect(io.output).toContain('ANTHROPIC_API_KEY'); // guidance 真文案在场（同源非抄写）
      expect(io.output).toContain('Esc 返回桌面');
      press(io, clock, KEY.escape, 50);
      expect(io.output).toContain('[全部]');
    } finally {
      void shell.dispose();
    }
  });

  it('g 热键：警示在场空输入即进引导；无警示时 g 照常打字', () => {
    // 警示在场：g 热键直达引导
    const withIssue = fakeStatus({ ...SNAP, credentialIssue: { provider: 'anthropic', guidance: 'g' } });
    const made1 = makeDeps({ status: withIssue.service });
    const shell1 = createDesktopShell(made1.deps);
    shell1.start();
    made1.clock.advance(0);
    try {
      press(made1.io, made1.clock, KEY.g);
      expect(made1.io.output).toContain('首启引导——模型凭证未配置');
      press(made1.io, made1.clock, KEY.escape, 50);
    } finally {
      void shell1.dispose();
    }
    // 无警示：g 当打字入框——批 E 起无前缀提交问助手（本测未接助手面 → 缺席帮助卡，非引导）
    const clean = fakeStatus(SNAP);
    const { io, clock, shell } = started({ status: clean.service });
    try {
      press(io, clock, KEY.g);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('系统助手不在场');
      expect(io.output).not.toContain('首启引导——模型凭证未配置');
    } finally {
      void shell.dispose();
    }
  });

  it('/guide 无警示形态：已配置说明 + 指路（引导不只在警示态可达）', () => {
    const status = fakeStatus(SNAP);
    const { io, clock, shell } = started({ status: status.service });
    try {
      for (const ch of '/guide') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('模型凭证已配置');
      expect(io.output).toContain('使用指南');
      press(io, clock, KEY.escape, 50);
    } finally {
      void shell.dispose();
    }
  });
});

/* ---------------- 系统助手默认应答（批 E，价值主张篇/核心命题篇 §3.5） ---------------- */

describe('desktop-shell：无前缀文本默认应答（批 E 系统助手）', () => {
  it('助手在场：占位「询问中…」→ 异步应答换装 → Esc 回桌面续问', async () => {
    const assistant = fakeAssistant();
    const { io, clock, shell } = started({ assistant: () => assistant.face });
    try {
      for (const ch of 'how to use') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(assistant.calls).toEqual(['how to use']); // 问句原样进服务面
      expect(io.output).toContain('问：how to use');
      expect(io.output).toContain('询问系统助手中…'); // 占位先上屏（异步未决不空白）
      await flushMicrotasks();
      clock.advance(17); // 冲应答换装帧
      expect(io.output).toContain('答：命令面清单如下…');
      press(io, clock, KEY.escape, 50); // 回桌面（继续提问：无前缀再输即问）
      expect(io.output).toContain('[全部]');
    } finally {
      void shell.dispose();
    }
  });

  it('助手缺席（carve-out ④ 默认应答者）：帮助文案卡——命令面照常 + 装回指引（非死路）', () => {
    const { io, clock, shell } = started(); // 未接 assistant dep = 行缺席形态
    try {
      for (const ch of 'hello') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('系统助手不在场（行已禁用或未装载）');
      expect(io.output).toContain('/apps-toggle assistant'); // 装回指引在场
      expect(io.output).toContain('/guide'); // 其他命令面照常披露
      press(io, clock, KEY.escape, 50);
      expect(io.output).toContain('[全部]'); // 回桌面可继续用命令
    } finally {
      void shell.dispose();
    }
  });

  it('迟到应答不串卡：用户已离卡 → 令牌拦下换装、提示行告知（不抢当前视图）', async () => {
    let release!: (v: AssistantAnswer) => void;
    const assistant = fakeAssistant({
      answer: () =>
        new Promise((resolve) => {
          release = resolve; // 手动闸：先离卡再放行应答
        }),
    });
    const { io, clock, shell } = started({ assistant: () => assistant.face });
    try {
      for (const ch of 'q1') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('询问系统助手中…');
      press(io, clock, KEY.escape, 50); // 应答未决先回桌面
      expect(io.output).toContain('[全部]');
      release({ kind: 'model', lines: ['LATE-ANSWER'] });
      await flushMicrotasks();
      clock.advance(17);
      expect(io.output).toContain('系统助手已应答（重发问题即可再看）'); // 提示行告知
      expect(io.output).not.toContain('LATE-ANSWER'); // 不串卡不抢视图
    } finally {
      void shell.dispose();
    }
  });

  it('服务面异常：诚实转述提示行 + 回桌面（三路判定之外的意外兜底）', async () => {
    const assistant = fakeAssistant({ answer: () => Promise.reject(new Error('face blew up')) });
    const { io, clock, shell } = started({ assistant: () => assistant.face });
    try {
      for (const ch of 'boom') press(io, clock, ch);
      press(io, clock, KEY.enter);
      await flushMicrotasks();
      clock.advance(17);
      expect(io.output).toContain('系统助手异常：face blew up');
      expect(io.output).toContain('[全部]'); // 异常态回桌面不留死卡
    } finally {
      void shell.dispose();
    }
  });

  it('g 热键与 /guide 在助手在场时走助手引导面（与应答同源——委托取值非抄写）', () => {
    const assistant = fakeAssistant();
    const withIssue = fakeStatus({ ...SNAP, credentialIssue: { provider: 'anthropic', guidance: 'g' } });
    const { io, clock, shell } = started({ status: withIssue.service, assistant: () => assistant.face });
    try {
      press(io, clock, KEY.g); // 热键直达（警示在场形态）
      expect(io.output).toContain('⟦助手引导面⟧'); // 假面标记物证：行取自助手面
      press(io, clock, KEY.escape, 50);
      for (const ch of '/guide') press(io, clock, ch);
      press(io, clock, KEY.enter); // 命令面同走助手面（同源两入口）
      expect(io.output).toContain('⟦助手引导面⟧');
      press(io, clock, KEY.escape, 50);
    } finally {
      void shell.dispose();
    }
  });
});

/* ---------------- 恒杀全家动词（批 D，骨架篇 §1.3） ---------------- */

describe('desktop-shell：/shutdown //reboot 恒杀全家', () => {
  /** requestPower 假面（调用记账 + self-exiting 成功形） */
  function powerDeps() {
    const powerCalls: string[] = [];
    const deps: Partial<DesktopShellDeps> = {
      requestPower: (action) => {
        powerCalls.push(action);
        return Promise.resolve({ action, outcome: 'self-exiting', exitCode: 0, message: '' });
      },
    };
    return { powerCalls, deps };
  }

  it('/shutdown：confirm 原语二次确认（单源恒杀语）→ Enter 才触编舞；Esc 取消零调用', () => {
    const { powerCalls, deps } = powerDeps();
    const { io, clock, shell } = started(deps);
    try {
      for (const ch of '/shutdown') press(io, clock, ch);
      press(io, clock, KEY.enter);
      // 确认视图：标题 + 单源恒杀全家确认语（host-power 同源，禁抄第二份）
      expect(io.output).toContain('确认关停？');
      expect(io.output).toContain(POWER_KILL_FAMILY_TEXT);
      expect(io.output).toContain('Enter 确认关停');
      expect(powerCalls).toEqual([]); // 未确认零编舞
      press(io, clock, KEY.escape, 50); // 取消
      expect(powerCalls).toEqual([]);
      expect(io.output).toContain('[全部]');
      // 再走全程：Enter 确认 → 单源编舞入口触达
      for (const ch of '/shutdown') press(io, clock, ch);
      press(io, clock, KEY.enter);
      press(io, clock, KEY.enter);
      expect(powerCalls).toEqual(['shutdown']);
    } finally {
      void shell.dispose();
    }
  });

  it('/reboot：确认语同单源 + 确认触编舞（spawn 接力语义在宿主编舞内）', () => {
    const { powerCalls, deps } = powerDeps();
    const { io, clock, shell } = started(deps);
    try {
      for (const ch of '/reboot') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('确认重启？');
      expect(io.output).toContain(POWER_KILL_FAMILY_TEXT);
      press(io, clock, KEY.enter);
      expect(powerCalls).toEqual(['reboot']);
    } finally {
      void shell.dispose();
    }
  });

  it('编舞拒/接力失败（进程未退）：回桌面 + 消息转述（诚实回执面）', async () => {
    const { io, clock, shell } = started({
      requestPower: () =>
        Promise.resolve({
          action: 'reboot' as const,
          outcome: 'spawn-failed' as const,
          exitCode: 1,
          message: '重启接力 spawn 失败——本进程未退出，可重试 /reboot',
        }),
    });
    try {
      for (const ch of '/reboot') press(io, clock, ch);
      press(io, clock, KEY.enter);
      press(io, clock, KEY.enter);
      await flushMicrotasks();
      clock.advance(17);
      expect(io.output).toContain('spawn 失败');
      expect(io.output).toContain('[全部]');
    } finally {
      void shell.dispose();
    }
  });

  it('requestPower 未接线：诚实拒（不假执行关停）', () => {
    const { io, clock, shell } = started();
    try {
      for (const ch of '/shutdown') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('编舞未接线');
      expect(io.output).toContain('requestPower');
    } finally {
      void shell.dispose();
    }
  });
});

/* ---------------- 菜单管理面接线（批 D——admin 服务薄壳） ---------------- */

describe('desktop-shell：菜单管理面（配置/卸载/卸挂载/挂载）', () => {
  it('配置：prompt 补参（JSON patch）→ admin.configure → 回执视图', async () => {
    const { admin, calls } = fakeAdmin();
    const { io, clock, shell } = started({ admin });
    try {
      press(io, clock, KEY.m);
      press(io, clock, KEY.down); // 配置
      press(io, clock, KEY.enter);
      expect(io.output).toContain('配置「对话（chat）」');
      expect(io.output).toContain('JSON patch');
      for (const ch of '{"k":1}') press(io, clock, ch);
      press(io, clock, KEY.enter);
      await flushMicrotasks();
      clock.advance(17);
      expect(calls).toEqual(['configure:chat:{"k":1}']);
      expect(io.output).toContain('已配置 chat');
    } finally {
      void shell.dispose();
    }
  });

  it('配置 prompt：Esc 取消零调用 / 空提交拒', async () => {
    const { admin, calls } = fakeAdmin();
    const { io, clock, shell } = started({ admin });
    try {
      press(io, clock, KEY.m);
      press(io, clock, KEY.down);
      press(io, clock, KEY.enter);
      press(io, clock, KEY.escape, 50); // 取消
      expect(calls).toEqual([]);
      expect(io.output).toContain('[全部]');
      // 空提交：拒因提示
      press(io, clock, KEY.m);
      press(io, clock, KEY.down);
      press(io, clock, KEY.enter);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('空输入——未执行');
      expect(calls).toEqual([]);
    } finally {
      void shell.dispose();
    }
  });

  it('卸载两段式：inspect 检视回执 → Enter 确认执行（keep）→ 完成回执', async () => {
    const { admin, calls } = fakeAdmin();
    const { io, clock, shell } = started({ admin });
    try {
      press(io, clock, KEY.m);
      press(io, clock, KEY.down);
      press(io, clock, KEY.down); // 卸载
      press(io, clock, KEY.enter);
      await flushMicrotasks();
      clock.advance(17);
      expect(calls).toEqual(['inspect:chat']); // 第一段只检视
      // 差分帧形态：过渡帧含「卸载检视「对话」」，回执帧与过渡帧共享前缀
      // 「卸载检视」——整行 '卸载检视 chat' 在字节流不连续，锚帧内连续片段
      expect(io.output).toContain('卸载检视「对话」'); // 过渡帧（检视中占位）
      expect(io.output).toContain('引用：file:./x');
      expect(io.output).toContain('确认卸载（保留数据域）');
      press(io, clock, KEY.enter); // 二次确认（confirm 原语复用）
      await flushMicrotasks();
      clock.advance(17);
      expect(calls).toEqual(['inspect:chat', 'execute:chat:keep']);
      // 完成回执与检视回执共享前缀「卸载」——锚尾段片段 + 回执正文行
      expect(io.output).toContain('完成 chat');
      expect(io.output).toContain('装机物已删');
    } finally {
      void shell.dispose();
    }
  });

  it('卸载两段式：Esc 在检视回执处取消——不执行（恒杀类动作的取消面）', async () => {
    const { admin, calls } = fakeAdmin();
    const { io, clock, shell } = started({ admin });
    try {
      press(io, clock, KEY.m);
      press(io, clock, KEY.down);
      press(io, clock, KEY.down);
      press(io, clock, KEY.enter);
      await flushMicrotasks();
      clock.advance(17);
      press(io, clock, KEY.escape, 50); // 检视回执处取消
      expect(calls).toEqual(['inspect:chat']); // 零执行
      expect(io.output).toContain('[全部]');
    } finally {
      void shell.dispose();
    }
  });

  it('卸挂载：直执行回执（只读回执任意键返回）', async () => {
    const { admin, calls } = fakeAdmin();
    const { io, clock, shell } = started({ admin });
    try {
      press(io, clock, KEY.m);
      for (let i = 0; i < 3; i++) press(io, clock, KEY.down); // 卸挂载
      press(io, clock, KEY.enter);
      await flushMicrotasks();
      clock.advance(17);
      expect(calls).toEqual(['unmount:chat']);
      expect(io.output).toContain('已卸挂载 chat');
      expect(io.output).toContain('任意键返回');
      press(io, clock, 'x'); // 只读回执任意键返回
      expect(io.output).toContain('[全部]');
    } finally {
      void shell.dispose();
    }
  });

  it('挂载：prompt 补参（目标应用 id）→ admin.mount（逗号/空格分隔）', async () => {
    const { admin, calls } = fakeAdmin();
    const { io, clock, shell } = started({ admin });
    try {
      press(io, clock, KEY.m);
      for (let i = 0; i < 4; i++) press(io, clock, KEY.down); // 挂载
      press(io, clock, KEY.enter);
      expect(io.output).toContain('挂载「对话（chat）」');
      for (const ch of 'chat, extra') press(io, clock, ch);
      press(io, clock, KEY.enter);
      await flushMicrotasks();
      clock.advance(17);
      expect(calls).toEqual(['mount:chat:chat+extra']);
      expect(io.output).toContain('挂载完成（单行提示形）'); // string 形回执 = 桌面提示行
    } finally {
      void shell.dispose();
    }
  });

  it('管理动作异常：诚实转述失败（回桌面不悬在中间态）', async () => {
    const admin: DesktopAdminFace = {
      configure: async () => {
        throw new Error('配置炸了');
      },
      uninstallInspect: async () => '卸载检视失败：未知 id',
      uninstallExecute: async () => '卸载执行失败',
      unmount: async () => '卸挂载失败',
      mount: async () => '挂载失败',
    };
    const { io, clock, shell } = started({ admin });
    try {
      press(io, clock, KEY.m);
      press(io, clock, KEY.down);
      press(io, clock, KEY.enter);
      for (const ch of '{"k":1}') press(io, clock, ch);
      press(io, clock, KEY.enter);
      await flushMicrotasks();
      clock.advance(17);
      expect(io.output).toContain('管理动作失败：配置炸了');
      expect(io.output).toContain('[全部]');
    } finally {
      void shell.dispose();
    }
  });
});

/* ---------------- 刀四：统一管理器 /monitor（三页签） ---------------- */

/**
 * 断言纪律（帧 diff 产物）：引擎按单元格 diff 重写——与上一帧相同的字符不
 * 重发（如桌面页签行与 monitor 页签行共享前缀时 '[' 不重写）。跨样式边界
 * 的整串 toContain 会断；断言取「含首差字符起的连续重写段」或短标记词，
 * 视图归属断言用「动词键只有该视图响应」的行为证据（ledger）。
 */
describe('desktop-shell：/monitor 统一管理器（刀四三页签）', () => {
  /** 监视面假面（调用记账 + 三页签各一条仪表行两条动作行——宾语 key-1/key-2） */
  function fakeMonitor() {
    const calls: string[] = [];
    // 上下文返回类型（DesktopMonitorFace 注解）保字面量窄型——无需 as const
    const kindOf = (tab: MonitorTab) => (tab === 'proc' ? 'job' : tab === 'jobs' ? 'tick' : 'memory');
    const face: DesktopMonitorFace = {
      async panel(tab) {
        calls.push(`panel:${tab}`);
        return {
          title: `管理面板 ${tab}`,
          rows: [
            { text: ` ${tab} 仪表行` },
            { text: ` ${tab} 动作行一`, item: { kind: kindOf(tab), key: 'key-1', label: '宾语一' } },
            { text: ` ${tab} 动作行二`, item: { kind: kindOf(tab), key: 'key-2', label: '宾语二' } },
          ],
        };
      },
      async cancelJob(id) {
        calls.push(`cancel:${id}`);
        return `已请求取消 ${id}`;
      },
      async reloadAll() {
        calls.push('reload');
        return { title: '全量 reload 完成', lines: ['  行一'] };
      },
      async tick(verb, name) {
        calls.push(`tick:${verb}:${name}`);
        return `tick ${verb} ${name} 回执`;
      },
      async memoryToggleFrozen(id) {
        calls.push(`frozen:${id}`);
        return `已冻结 ${id}`;
      },
      async memoryForget(id) {
        calls.push(`forget:${id}`);
        return `已忘掉 ${id}`;
      },
      async memoryRestore(id) {
        calls.push(`restore:${id}`);
        return `已恢复 ${id}`;
      },
      async memoryExport() {
        calls.push('export');
        return { title: '已导出 0 条', lines: ['  /tmp/x.jsonl'] };
      },
    };
    return { face, calls };
  }

  /** 起屏 + 命令面进管理器（/monitor [tab] 全程——异步步进后冲帧） */
  async function enterMonitor(
    face: DesktopMonitorFace,
    arg = '',
  ): Promise<{
    io: FakeIO;
    clock: FakeClock;
    shell: ReturnType<typeof createDesktopShell>;
  }> {
    const made = started({ monitor: face });
    for (const ch of `/monitor${arg}`) press(made.io, made.clock, ch);
    press(made.io, made.clock, KEY.enter);
    await flushMicrotasks();
    made.clock.advance(17);
    return made;
  }

  it('/monitor：首帧面板 + ▸ 光标首条动作行 + 页签行；Esc 回桌面', async () => {
    const { face } = fakeMonitor();
    const { io, clock, shell } = await enterMonitor(face);
    try {
      expect(io.output).toContain('管理面板 proc');
      expect(io.output).toContain('▸  proc 动作行一'); // 光标 = 首条动作行（reverse 标记）
      expect(io.output).toContain('任务 / 内存（←→ 切换）'); // 页签行（含首差字符起的重写段）
      expect(io.output).toContain('k 取消 Job'); // proc 键位提示
      press(io, clock, KEY.escape, 50);
      expect(io.output).toContain('[全部]'); // 回桌面
    } finally {
      void shell.dispose();
    }
  });

  it('直达页签 /monitor jobs；非法页签诚实拒（留桌面）', async () => {
    const { face } = fakeMonitor();
    const made = started({ monitor: face });
    try {
      // 非法值先行：不进管理器（命令面在桌面仍可达）
      for (const ch of '/monitor bogus') press(made.io, made.clock, ch);
      press(made.io, made.clock, KEY.enter);
      expect(made.io.output).toContain('未知页签：bogus（认 proc / jobs / mem）');
      expect(made.io.output).toContain('[全部]'); // 仍桌面
      for (const ch of '/monitor jobs') press(made.io, made.clock, ch);
      press(made.io, made.clock, KEY.enter);
      await flushMicrotasks();
      made.clock.advance(17);
      expect(made.io.output).toContain('jobs 仪表行'); // jobs 面板内容在场
      expect(made.io.output).toContain('e OS 注册'); // jobs 键位提示
    } finally {
      void made.shell.dispose();
    }
  });

  it('monitor 未接线：/monitor 诚实拒（面缺席非死路）', async () => {
    const { io, clock, shell } = started();
    try {
      for (const ch of '/monitor') press(io, clock, ch);
      press(io, clock, KEY.enter);
      expect(io.output).toContain('管理器面未接线（宿主未注入 monitor 面）');
    } finally {
      void shell.dispose();
    }
  });

  it('←→/Tab 切页签重取数（panel 按页签各取；Tab = 反向）', async () => {
    const { face, calls } = fakeMonitor();
    const { io, clock, shell } = await enterMonitor(face);
    try {
      const settle = async (): Promise<void> => {
        await flushMicrotasks();
        clock.advance(17);
      };
      press(io, clock, KEY.right); // proc → jobs
      await settle();
      press(io, clock, KEY.tab); // jobs → proc（Tab = cycle(-1)）
      await settle();
      press(io, clock, KEY.right); // proc → jobs
      press(io, clock, KEY.right); // jobs → mem
      await settle();
      expect(io.output).toContain('任务 / [内存]'); // mem 页签激活（页签行重写段）
      expect(io.output).toContain('mem 仪表行');
      // 取数序：进(1) + jobs(2) + proc(3) + jobs(4) + mem(5)——每切必重取
      expect(calls.filter((c) => c.startsWith('panel:'))).toEqual([
        'panel:proc',
        'panel:jobs',
        'panel:proc',
        'panel:jobs',
        'panel:mem',
      ]);
    } finally {
      void shell.dispose();
    }
  });

  it('proc 动词：k 取消光标宾语（↓ 后 key-2、再 ↓ 环绕回 key-1）+ 动作后重取面板', async () => {
    const { face, calls } = fakeMonitor();
    const { io, clock, shell } = await enterMonitor(face);
    try {
      const settle = async (): Promise<void> => {
        await flushMicrotasks();
        clock.advance(17);
      };
      press(io, clock, KEY.down);
      expect(io.output).toContain('▸  proc 动作行二'); // 光标下移
      press(io, clock, 'k');
      await settle();
      expect(calls).toContain('cancel:key-2'); // ↓ 一格 → 第二条动作行
      expect(io.output).toContain('已请求取消 key-2'); // 单行回执 = notice 落 monitor
      press(io, clock, KEY.down); // 环绕：二 → 一
      press(io, clock, 'k');
      await settle();
      expect(calls).toContain('cancel:key-1');
      // 动作后重取：panel:proc 三次（进入 + 两次动作后刷新）
      expect(calls.filter((c) => c === 'panel:proc')).toHaveLength(3);
    } finally {
      void shell.dispose();
    }
  });

  it('proc 动词：r 全量 reload → 结构回执 confirm（backTo monitor——回执后动词仍活）', async () => {
    const { face, calls } = fakeMonitor();
    const { io, clock, shell } = await enterMonitor(face);
    try {
      press(io, clock, 'r');
      expect(io.output).toContain('管理动作执行中…'); // busy 占位（双发防护）
      await flushMicrotasks();
      clock.advance(17);
      expect(calls).toContain('reload');
      expect(io.output).toContain('全量 reload 完成'); // 结构回执 = confirm 只读链
      press(io, clock, KEY.enter); // 只读回执任意键返回——Enter 落 back 槽
      await flushMicrotasks();
      clock.advance(17);
      // 行为证据：回 monitor 非 desktop——k 动词只有 monitor 视图响应
      const cancelsBefore = calls.filter((c) => c.startsWith('cancel:')).length;
      press(io, clock, 'k');
      await flushMicrotasks();
      clock.advance(17);
      expect(calls.filter((c) => c.startsWith('cancel:')).length).toBe(cancelsBefore + 1);
    } finally {
      void shell.dispose();
    }
  });

  it('页签动词分域：proc 期 n 无效；jobs 页签 e/d/n 经面动词（守卫单源在面）', async () => {
    const { face, calls } = fakeMonitor();
    const { io, clock, shell } = await enterMonitor(face);
    try {
      const settle = async (): Promise<void> => {
        await flushMicrotasks();
        clock.advance(17);
      };
      press(io, clock, 'n'); // proc 期 n 不是动词（Job cancel 只住 proc——B5）
      await settle();
      expect(calls.filter((c) => c.startsWith('tick:'))).toEqual([]);
      press(io, clock, KEY.right); // → jobs
      await settle();
      press(io, clock, 'n');
      await settle();
      expect(calls).toContain('tick:run:key-1');
      press(io, clock, 'e');
      await settle();
      expect(calls).toContain('tick:enable:key-1');
      press(io, clock, 'd');
      await settle();
      expect(calls).toContain('tick:disable:key-1');
      expect(io.output).toContain('tick disable key-1 回执');
    } finally {
      void shell.dispose();
    }
  });

  it('mem 页签动词：f 翻转 / v 恢复 / e 导出回执；x 忘掉两段式（Esc 零调用 / Enter 落账）', async () => {
    const { face, calls } = fakeMonitor();
    const { io, clock, shell } = await enterMonitor(face);
    try {
      const settle = async (): Promise<void> => {
        await flushMicrotasks();
        clock.advance(17);
      };
      press(io, clock, KEY.right); // → jobs
      await settle();
      press(io, clock, KEY.right); // → mem
      await settle();
      press(io, clock, 'f');
      await settle();
      expect(calls).toContain('frozen:key-1');
      press(io, clock, 'v');
      await settle();
      expect(calls).toContain('restore:key-1');
      press(io, clock, 'e');
      await settle();
      expect(calls).toContain('export');
      expect(io.output).toContain('已导出 0 条'); // 导出回执 = confirm 链
      press(io, clock, KEY.escape, 50); // 回执链退出 → 回 monitor（非桌面）
      // x 忘掉 = 唯一两段式动词：先确认卡
      press(io, clock, 'x');
      expect(io.output).toContain('忘掉记忆 宾语一？');
      expect(io.output).toContain('确认忘掉');
      press(io, clock, KEY.escape, 50); // 取消：零调用 + 行为证据（f 动词仍活 = 已回 monitor）
      expect(calls.filter((c) => c.startsWith('forget:'))).toEqual([]);
      const frozenBefore = calls.filter((c) => c.startsWith('frozen:')).length;
      press(io, clock, 'f');
      await settle();
      expect(calls.filter((c) => c.startsWith('frozen:')).length).toBe(frozenBefore + 1);
      press(io, clock, 'x');
      press(io, clock, KEY.enter); // 确认执行
      await settle();
      expect(calls).toContain('forget:key-1');
      expect(io.output).toContain('已忘掉 key-1');
    } finally {
      void shell.dispose();
    }
  });

  it('面板取数失败：错误面板诚实示（不炸视图、可 Esc 退）', async () => {
    const face = {
      ...fakeMonitor().face,
      panel: async (): Promise<MonitorPanel> => {
        throw new Error('库炸了');
      },
    };
    const { io, clock, shell } = await enterMonitor(face);
    try {
      expect(io.output).toContain('取数失败：库炸了');
      press(io, clock, KEY.escape, 50);
      expect(io.output).toContain('[全部]');
    } finally {
      void shell.dispose();
    }
  });
});
