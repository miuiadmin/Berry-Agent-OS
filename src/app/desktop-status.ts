/**
 * L5 app — 顶栏状态聚合器（第八十五批批 D，骨架篇 §1.2）。
 *
 * 五槽位单拍采样：时间 / CPU 占用 / 内存占用 / 后台运行数 / 已装应用数。
 * - 时间 = 本地时钟 1s（秒粒度 HH:MM:SS——顶栏槽位呈秒）。
 * - CPU / 内存 = node:os 轮询（1s 节流）：CPU 用 os.cpus() 两次采样差分
 *   （空闲增量 / 总增量 → 占用百分比），内存用 freemem/totalmem。
 * - 后台运行数 = 注入源活取值（宿主接 ctx.jobs 活跃 Job 计——事件面已有，
 *   此处只消费不建账）。
 * - 已装应用数 = 注入源活取值（宿主接 appsService.list() 装机对账面同源——
 *   禁第二真相源）。
 * - 凭证警示槽（首启引导闭环，§1.4 精神）：注入源活取值——宿主 boot 期探针
 *   落值，聚合器只转述。
 *
 * **按需渲染**（性能预算执法面）：每拍全槽采样一次，值不变不通知——稳态
 * （值全不变）零通知零帧。预算进回归锁（desktop-status.test：每拍各源恰调
 * 一次 + 通知次数 == 值变次数——假钟计数形态，禁真 CPU 采样断言 flaky 形态）。
 *
 * 数据面零新增表族、零 durable 落账——纯运行时活体面。时序三件注入
 * （缺省真时钟——测试假钟缝合位，与壳/引擎注入面同构）。
 */
import * as os from 'node:os';
import type { ShellTiming } from './desktop-shell.js';

/** CPU 累计时间采样（毫秒——os.cpus() times 聚合） */
export interface CpuTimes {
  /** 空闲累计（所有核 idle + iowait 并入 idle 口径由采样方决定，本聚合器只做差分） */
  readonly idle: number;
  /** 总累计（user+nice+sys+idle+irq 全和） */
  readonly total: number;
}

/** 凭证警示（首启引导闭环——provider 未配置时的引导文案载体） */
export interface DesktopCredentialIssue {
  /** 未配置凭证的模型 provider id（如 anthropic） */
  readonly provider: string;
  /** 中文引导文案（与 berry run stderr 同源——describeProviderFailure 产出） */
  readonly guidance: string;
}

/** 顶栏快照（五槽位 + 可选警示槽；值语义快照——等值即无通知） */
export interface DesktopStatusSnapshot {
  /** 本地时间 HH:MM:SS */
  readonly time: string;
  /** CPU 占用百分比（0-100 整数；首拍/采样缺席 = 0） */
  readonly cpuPercent: number;
  /** 内存占用百分比（0-100 整数） */
  readonly memoryPercent: number;
  /** 后台运行数（活跃 Job 计——running/stopping） */
  readonly backgroundJobs: number;
  /** 已装应用数（装机对账面计数） */
  readonly installedApps: number;
  /** 凭证警示（在场 = 顶栏恒显警示槽） */
  readonly credentialIssue?: DesktopCredentialIssue;
}

/** 状态源注入面（宿主组合根接线；os 类源缺省走 node:os——测试注假源） */
export interface DesktopStatusSources {
  /** 后台运行数（活取值——宿主接 ctx.jobs 活跃面） */
  readonly activeJobs: () => number;
  /** 已装应用数（活取值——宿主接 appsService.list() 同源） */
  readonly installedApps: () => number;
  /** CPU 时间采样（缺席/undefined = 本拍 CPU 记 0 不差分） */
  readonly cpuTimes?: () => CpuTimes | undefined;
  /** 内存占用百分比（缺省 node:os freemem/totalmem） */
  readonly memoryPercent?: () => number;
  /** 凭证警示（缺省恒 undefined——宿主探针落值面） */
  readonly credentialIssue?: () => DesktopCredentialIssue | undefined;
}

/** 聚合器面（宿主经 desktop 行 provide 的 holder attach 本体） */
export interface DesktopStatusAggregator {
  /** 当前快照（活取值——值语义，等值两次调用无副作用） */
  snapshot(): DesktopStatusSnapshot;
  /** 值变订阅（返回注销器——壳 start 装 / dispose 摘） */
  onChange(cb: () => void): () => void;
  /** 起表（换 CPU 基线 + 首拍即采样 + 1s 周期续排；幂等） */
  start(): void;
  /** 停表（摘周期定时器；挂起/终退用）；幂等 */
  stop(): void;
  /** 单拍采样（值变 → 通知；返回是否变化——宿主探针落值后即时刷新用） */
  sampleOnce(): boolean;
}

/** 轮询节流间隔（毫秒——骨架篇 §1.2「1s 节流」） */
export const STATUS_POLL_MS = 1_000;

/** 百分比钳制（0-100 整数——负差分/超界防御） */
function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** node:os CPU 聚合采样（无核 = undefined） */
function osCpuTimes(): CpuTimes | undefined {
  const cpus = os.cpus();
  if (cpus.length === 0) return undefined;
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

/** node:os 内存占用百分比（totalmem 非法 = 0） */
function osMemoryPercent(): number {
  const total = os.totalmem();
  if (total <= 0) return 0;
  return clampPercent((100 * (total - os.freemem())) / total);
}

/** 毫秒时刻 → HH:MM:SS（本地时制——toTimeString 前 8 位） */
export function formatStatusClock(nowMs: number): string {
  return new Date(nowMs).toTimeString().slice(0, 8);
}

/** 快照等值判（全槽位逐项；警示槽按 provider+guidance 值比——无身份语义） */
function snapshotsEqual(a: DesktopStatusSnapshot, b: DesktopStatusSnapshot): boolean {
  return (
    a.time === b.time &&
    a.cpuPercent === b.cpuPercent &&
    a.memoryPercent === b.memoryPercent &&
    a.backgroundJobs === b.backgroundJobs &&
    a.installedApps === b.installedApps &&
    a.credentialIssue?.provider === b.credentialIssue?.provider &&
    a.credentialIssue?.guidance === b.credentialIssue?.guidance
  );
}

/**
 * 构造顶栏状态聚合器。构造即采首拍快照（CPU 零差分记 0——基线未立）；
 * start 才起周期。时序注入走壳同款三件面（测试假钟缝合位）。
 */
export function createDesktopStatusAggregator(deps: {
  /** 时序三件（缺省真时钟） */
  readonly timing: ShellTiming;
  /** 状态源（os 类源可注缺省） */
  readonly sources: DesktopStatusSources;
  /** 轮询间隔（缺省 1s——测试可缩拍） */
  readonly pollMs?: number;
}): DesktopStatusAggregator {
  const pollMs = deps.pollMs ?? STATUS_POLL_MS;
  const timing = deps.timing;
  // 源缺省回填（node:os 直读——宿主只接 jobs/apps/credential 三源即可）
  const cpuTimes: () => CpuTimes | undefined = deps.sources.cpuTimes ?? osCpuTimes;
  const memoryPercent: () => number = deps.sources.memoryPercent ?? osMemoryPercent;
  const credentialIssue: () => DesktopCredentialIssue | undefined = deps.sources.credentialIssue ?? (() => undefined);
  /** 值变监听器集（装拆对称） */
  const listeners = new Set<() => void>();
  /** 周期定时器句柄（null = 未排） */
  let handle: unknown = null;
  /** 起表旗标（stop 后可再 start——挂起/回桌面对称） */
  let running = false;
  /** CPU 差分基线（start 换新——挂起期旧基线跨窗太长差分失真） */
  let prevCpu: CpuTimes | undefined;
  /** 当前快照（构造即首拍——CPU 零差分记 0） */
  let current = sample();

  /** CPU 差分（本拍采样 vs 基线；总增量非正 = 0） */
  function diffCpu(): number {
    const sampleTimes = cpuTimes();
    const prev = prevCpu;
    if (sampleTimes !== undefined) prevCpu = sampleTimes;
    if (sampleTimes === undefined || prev === undefined) return 0;
    const totalDelta = sampleTimes.total - prev.total;
    if (totalDelta <= 0) return 0;
    return clampPercent((100 * (totalDelta - (sampleTimes.idle - prev.idle))) / totalDelta);
  }

  /** 单拍全槽采样（各源恰调一次——回归锁的调用计数锚） */
  function sample(): DesktopStatusSnapshot {
    const cpuPercent = diffCpu();
    const jobs = Math.max(0, Math.trunc(deps.sources.activeJobs()));
    const apps = Math.max(0, Math.trunc(deps.sources.installedApps()));
    const issue = credentialIssue();
    const memory = clampPercent(memoryPercent());
    return {
      time: formatStatusClock(timing.now()),
      cpuPercent,
      memoryPercent: memory,
      backgroundJobs: jobs,
      installedApps: apps,
      // 警示槽可选键展开（undefined 不落键——快照形状稳定）
      ...(issue !== undefined ? { credentialIssue: issue } : {}),
    };
  }

  /** 值变通知（快照已换新后调用） */
  function notify(): void {
    for (const cb of [...listeners]) cb();
  }

  /** 单拍采样 + 值变通知（闭包函数——start/tick/导出面三处共用） */
  function sampleOnce(): boolean {
    const next = sample();
    const changed = !snapshotsEqual(current, next);
    current = next;
    if (changed) notify();
    return changed;
  }

  /** 周期拍：采样 + 续排（stop 后不再续） */
  function tick(): void {
    handle = null;
    if (!running) return;
    sampleOnce();
    handle = timing.schedule(tick, pollMs);
  }

  return {
    snapshot: () => current,
    onChange(cb: () => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    start(): void {
      if (running) return;
      running = true;
      prevCpu = cpuTimes(); // 换新基线（停表期跨窗差分失真防御）
      sampleOnce(); // 起表首拍（值变即通知——顶栏即刻活）
      handle = timing.schedule(tick, pollMs);
    },
    stop(): void {
      running = false;
      if (handle !== null) {
        timing.cancelSchedule(handle);
        handle = null;
      }
    },
    sampleOnce,
  };
}
