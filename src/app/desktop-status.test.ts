/**
 * app — 顶栏状态聚合器测试（第八十五批批 D，骨架篇 §1.2）。
 *
 * 测法 = 假钟 + 注入源（mock 停在源/时序边界）：五槽位采样数学（CPU 两次采样
 * 差分 / 内存直读 / 计数源透传）/ 按需渲染（值不变零通知——每拍各源恰调一次 +
 * 通知数 == 值变数的稳态成本回归锁，禁真 CPU 采样断言 flaky 形态）/ 凭证警示
 * 槽值变即时采样 / start-stop 生命周期（基线换新 + 定时器摘除）。
 */
import { describe, expect, it } from 'vitest';
import {
  createDesktopStatusAggregator,
  formatStatusClock,
  type CpuTimes,
  type DesktopCredentialIssue,
} from './desktop-status.js';

/** 假钟（advance 按到期序发火）。freeze 只钉「展示时刻」（时间槽恒定——稳态
 *  零通知断言的前提）；调度轴 vt 恒随发火推进——续排定时器落在发火时刻之后，
 *  advance 有限收口（冻结态若调度轴也不动，周期续排永远 ≤ target = 死循环）。
 *  非冻结态展示时刻随每次发火同步（tick 内采样看见逐拍时间进位）。 */
function fakeClock(startAt = 1_700_000_000_000) {
  let t = startAt; // 展示时刻（now() 的返回——freeze 后恒定）
  let vt = startAt; // 调度轴（到期判定与续排基准——恒推进）
  let frozen = false;
  let nextId = 1;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  return {
    now: (): number => t,
    /** 冻结展示时刻（时间槽恒定——稳态零通知断言的前提） */
    freeze: (): void => {
      frozen = true;
    },
    schedule: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.push({ id, at: vt + ms, fn });
      return id;
    },
    cancelSchedule: (handle: unknown): void => {
      const i = timers.findIndex((x) => x.id === handle);
      if (i >= 0) timers.splice(i, 1);
    },
    advance: (ms: number): void => {
      const target = vt + ms;
      for (;;) {
        const pick = timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (pick === undefined) break;
        vt = Math.max(vt, pick.at); // 发火即推进调度轴（续排 → 发火时刻之后——有限收口）
        if (!frozen) t = vt; // 非冻结：展示时刻随发火同步（tick 采样看见时间进位）
        timers.splice(timers.indexOf(pick), 1);
        pick.fn();
      }
      vt = target;
      if (!frozen) t = vt;
    },
    pending: (): number => timers.length,
  };
}

/** 计数注入源（每源调用计数——稳态成本锁的锚） */
function makeSources() {
  const counts = { jobs: 0, apps: 0, cpu: 0, mem: 0, cred: 0 };
  const state = {
    jobs: 2,
    apps: 3,
    mem: 42,
    /** CPU 采样序（逐拍取一；耗尽取末值——差分断言喂可控基线/次值） */
    cpuSeq: [{ idle: 900, total: 1000 }] as CpuTimes[],
    cred: undefined as DesktopCredentialIssue | undefined,
  };
  let cpuIdx = 0;
  return {
    counts,
    state,
    sources: {
      activeJobs: (): number => {
        counts.jobs++;
        return state.jobs;
      },
      installedApps: (): number => {
        counts.apps++;
        return state.apps;
      },
      cpuTimes: (): CpuTimes | undefined => {
        counts.cpu++;
        const sample = state.cpuSeq[Math.min(cpuIdx, state.cpuSeq.length - 1)]!;
        cpuIdx++;
        return sample;
      },
      memoryPercent: (): number => {
        counts.mem++;
        return state.mem;
      },
      credentialIssue: (): DesktopCredentialIssue | undefined => {
        counts.cred++;
        return state.cred;
      },
    },
  };
}

describe('desktop-status：五槽位采样数学', () => {
  it('快照 = 时间 HH:MM:SS / CPU 差分百分比 / 内存 / 后台 / 应用（构造首拍 CPU 0——基线未立）', () => {
    const clock = fakeClock();
    const made = makeSources();
    const agg = createDesktopStatusAggregator({ timing: clock, sources: made.sources });
    // 构造首拍：CPU 基线未立记 0；其余槽直读
    expect(agg.snapshot()).toEqual({
      time: formatStatusClock(clock.now()),
      cpuPercent: 0,
      memoryPercent: 42,
      backgroundJobs: 2,
      installedApps: 3,
    });
    // start 换新基线：吃掉 cpuSeq 首样本后的下一样本（此处 {idle:900,total:1000}
    // ——构造已吃 [0]，start 基线吃 [1]，起表首拍差分吃 [2] 起的同值 = 零差分）
    made.state.cpuSeq.push({ idle: 900, total: 1000 });
    agg.start();
    expect(agg.snapshot().cpuPercent).toBe(0); // 起表首拍 = 新基线当拍（零差分）
    // 下一拍样本：totalΔ 10 / idleΔ 5 → 忙 5/10 = 50%
    made.state.cpuSeq.push({ idle: 905, total: 1010 });
    clock.advance(1_000);
    expect(agg.snapshot().cpuPercent).toBe(50);
    expect(agg.snapshot().time).toBe(formatStatusClock(clock.now()));
    agg.stop();
  });

  it('CPU 采样缺席/总增量非正 = 0（防御位——不产出 NaN/负值）', () => {
    const clock = fakeClock();
    let cpu: CpuTimes | undefined = undefined;
    const agg = createDesktopStatusAggregator({
      timing: clock,
      sources: {
        activeJobs: () => 0,
        installedApps: () => 0,
        cpuTimes: () => cpu,
        memoryPercent: () => 0,
      },
    });
    agg.start();
    clock.advance(1_000);
    expect(agg.snapshot().cpuPercent).toBe(0); // 采样缺席
    cpu = { idle: 500, total: 1000 };
    agg.stop();
    agg.start();
    clock.advance(1_000);
    expect(agg.snapshot().cpuPercent).toBe(0); // 同值样本（总增量 0）
    cpu = { idle: 400, total: 900 }; // 倒走样本（总增量负）——防御钳 0
    clock.advance(1_000);
    expect(agg.snapshot().cpuPercent).toBe(0);
    agg.stop();
  });

  it('百分比钳制 0-100（超界差分防御）', () => {
    const clock = fakeClock();
    // 采样序：构造吃 [0]、start 基线吃 [1]、起表首拍差分吃 [2]（600% 超界 → 钳 100）
    const seq = [
      { idle: 0, total: 100 },
      { idle: 0, total: 100 },
      { idle: -50, total: 110 }, // idleDelta -50 > totalDelta 10 → 忙 600% → 钳 100
    ];
    let idx = 0;
    const agg = createDesktopStatusAggregator({
      timing: clock,
      sources: {
        activeJobs: () => 0,
        installedApps: () => 0,
        cpuTimes: () => seq[Math.min(idx++, seq.length - 1)],
        memoryPercent: () => 120, // 越界内存 → 钳 100
      },
    });
    agg.start();
    expect(agg.snapshot().cpuPercent).toBe(100);
    expect(agg.snapshot().memoryPercent).toBe(100);
    agg.stop();
  });
});

describe('desktop-status：按需渲染（稳态成本回归锁——假钟计数形态）', () => {
  it('时间恒定 + 值全不变：10 拍零通知（每拍各源恰调一次——无空转通知）', () => {
    const clock = fakeClock();
    clock.freeze(); // 时间槽恒定（隔离时间位——纯测「值不变零通知」）
    const made = makeSources();
    made.state.cpuSeq = [{ idle: 900, total: 1000 }];
    const agg = createDesktopStatusAggregator({ timing: clock, sources: made.sources });
    let notified = 0;
    agg.onChange(() => {
      notified++;
    });
    agg.start();
    expect(notified).toBe(0); // 起表首拍零值变（构造与起表同拍等值——CPU 双零差分）
    const before = { ...made.counts };
    clock.advance(10_000); // 10 拍
    expect(notified).toBe(0); // 零通知（稳态：值全不变——按需渲染的零帧形态）
    expect(made.counts.jobs - before.jobs).toBe(10); // 每拍各源恰调一次（采样照常）
    expect(made.counts.apps - before.apps).toBe(10);
    expect(made.counts.cpu - before.cpu).toBe(10);
    expect(made.counts.mem - before.mem).toBe(10);
    expect(made.counts.cred - before.cred).toBe(10);
    agg.stop();
  });

  it('值变即通知、值变数 == 通知数：jobs 1→2→2→3 = 3 次值变通知', () => {
    const clock = fakeClock();
    clock.freeze();
    const made = makeSources();
    made.state.jobs = 1;
    const agg = createDesktopStatusAggregator({ timing: clock, sources: made.sources });
    let notified = 0;
    agg.onChange(() => {
      notified++;
    });
    agg.start(); // 首拍（构造快照同为 jobs 1——起表零值变）
    clock.advance(1_000); // jobs 仍 1
    made.state.jobs = 2;
    clock.advance(1_000); // 值变 → 通知
    clock.advance(1_000); // 不变
    made.state.jobs = 3;
    clock.advance(1_000); // 值变 → 通知
    expect(notified).toBe(2); // 起表首拍零变 + 两值变（通知数 == 值变数）
    expect(agg.snapshot().backgroundJobs).toBe(3);
    agg.stop();
  });

  it('时间推进形态：每秒一通知（时间槽恒变——顶栏 1fps 上界的计数形态呈现）', () => {
    const clock = fakeClock();
    const made = makeSources();
    const agg = createDesktopStatusAggregator({ timing: clock, sources: made.sources });
    let notified = 0;
    agg.onChange(() => {
      notified++;
    });
    agg.start();
    clock.advance(3_000); // 3 拍、时间每拍进位
    expect(notified).toBe(3); // 3 拍各一帧（时间位每拍值变——每秒至多一帧的计数形态）
    expect(agg.snapshot().time).toBe(formatStatusClock(clock.now()));
    agg.stop();
  });
});

describe('desktop-status：凭证警示槽与生命周期', () => {
  it('警示落值 → sampleOnce 值变通知；再拍等值零新通知', () => {
    const clock = fakeClock();
    clock.freeze();
    const made = makeSources();
    const agg = createDesktopStatusAggregator({ timing: clock, sources: made.sources });
    let notified = 0;
    agg.onChange(() => {
      notified++;
    });
    agg.start();
    expect(agg.snapshot().credentialIssue).toBeUndefined();
    made.state.cred = { provider: 'anthropic', guidance: '配置途径…' };
    expect(agg.sampleOnce()).toBe(true); // 值变（宿主探针落值后的即时刷新路）
    expect(notified).toBe(1);
    expect(agg.snapshot().credentialIssue?.provider).toBe('anthropic');
    expect(agg.sampleOnce()).toBe(false); // 等值零通知
    expect(notified).toBe(1);
    agg.stop();
  });

  it('stop 摘定时器 + 再 start 续拍（幂等停/起）', () => {
    const clock = fakeClock();
    clock.freeze();
    const made = makeSources();
    const agg = createDesktopStatusAggregator({ timing: clock, sources: made.sources });
    agg.start();
    expect(clock.pending()).toBe(1);
    agg.stop();
    expect(clock.pending()).toBe(0); // 定时器已摘
    agg.start();
    agg.start(); // 幂等（双 start 不双排）
    expect(clock.pending()).toBe(1);
    agg.stop();
    expect(clock.pending()).toBe(0);
  });

  it('onChange 注销器摘监听（通知不再达）', () => {
    const clock = fakeClock();
    const made = makeSources();
    const agg = createDesktopStatusAggregator({ timing: clock, sources: made.sources });
    let notified = 0;
    const off = agg.onChange(() => {
      notified++;
    });
    agg.start();
    off();
    made.state.jobs = 99;
    agg.sampleOnce();
    expect(notified).toBe(0); // 注销后零达（起表首拍本就零值变——全程零通知）
    agg.stop();
  });
});
