/**
 * L3 checkpoint — git/range Output 锚测试（第六十一批，会话篇 §5.3 git 锚条款）。
 *
 * 纯编排件单测：fake probe + fake 落账面，锁七分支 + 两异常锁——区间落账 /
 * 无产出不记 / 诚实缺席 / 装配无探测面 no-op / routed 匹配门（宁缺毋错投）/
 * files 截帽 / run 级去重；首探测异常免锚 / 结算复探异常免落账。
 * 末尾 CR-8 载体隔离验证锁：宿主面注册词汇（import 副作用）三词在册。
 */

import { describe, expect, it } from 'vitest';
import { createGitAnchorTracker, type GitProbeFace, type GitProbeState } from './git-anchor.js';
import { CHECKPOINT_EVENT_TYPES } from './events.js';
import { getSessionEventType } from '../contracts/session-events.js';

/** 假探测面：脚本化状态序列 + 区间增量应答 */
function fakeProbe(states: Array<GitProbeState | undefined>, delta?: { commits: number; files: string[] }) {
  let i = 0;
  const stateCalls: string[] = [];
  const deltaCalls: Array<[string, string]> = [];
  const probe: GitProbeFace = {
    state: async (cwd) => {
      stateCalls.push(cwd);
      return states[i++] ?? states[states.length - 1];
    },
    delta: async (_cwd, before, after) => {
      deltaCalls.push([before, after]);
      return delta;
    },
  };
  return { probe, stateCalls, deltaCalls };
}

/** 最小 deps 装配（routed 可变——测试路由匹配门） */
function rig(probe: GitProbeFace | undefined, routed = 'sess-A') {
  let routedNow: string | undefined = routed;
  const events: Array<{ type: string; data: unknown }> = [];
  const warns: string[] = [];
  const tracker = createGitAnchorTracker({
    routedSessionId: () => routedNow,
    appendEvent: (type, data) => {
      events.push({ type, data });
      return undefined;
    },
    workspaceRoot: () => '/ws',
    probe,
    logger: {
      debug: () => {},
      warn: (_msg, meta) => warns.push(String((meta as { error?: unknown })?.error ?? _msg)),
    },
  });
  return { tracker, events, warns, setRouted: (id: string | undefined) => (routedNow = id) };
}

describe('git/range Output 锚（第六十一批）', () => {
  it('头移动 → 落账全量载荷（before/after/commits/files/dirty 双时点）', async () => {
    const { probe, deltaCalls } = fakeProbe(
      [
        { head: 'aaa111', dirtyCount: 0 },
        { head: 'bbb222', dirtyCount: 1 },
      ],
      { commits: 2, files: ['src/a.ts', 'src/b.ts'] },
    );
    const { tracker, events } = rig(probe);
    await tracker.onFirstMutation();
    tracker.onRunSettled('sess-A');
    await new Promise((r) => setTimeout(r, 10)); // fire-and-forget 落账微任务
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('git/range');
    expect(events[0]!.data).toEqual({
      before: 'aaa111',
      after: 'bbb222',
      commits: 2,
      files: ['src/a.ts', 'src/b.ts'],
      dirtyBefore: 0,
      dirtyAfter: 1,
    });
    expect(deltaCalls).toEqual([['aaa111', 'bbb222']]);
  });

  it('头未动且 dirty 未变 → 无产出不记（零事件）', async () => {
    const { probe } = fakeProbe([
      { head: 'aaa111', dirtyCount: 2 },
      { head: 'aaa111', dirtyCount: 2 },
    ]);
    const { tracker, events } = rig(probe);
    await tracker.onFirstMutation();
    tracker.onRunSettled('sess-A');
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(0);
  });

  it('诚实缺席：非 git 仓（state undefined）→ 免锚零事件零异常', async () => {
    const { probe } = fakeProbe([undefined, undefined]);
    const { tracker, events, warns } = rig(probe);
    await tracker.onFirstMutation();
    tracker.onRunSettled('sess-A');
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  it('装配无探测面（probe undefined）→ 整锚 no-op', async () => {
    const { tracker, events } = rig(undefined);
    await tracker.onFirstMutation();
    tracker.onRunSettled('sess-A');
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toHaveLength(0);
  });

  it('routed 匹配门：结算会话 ≠ 路由会话（后台结算）→ 宁缺毋错投', async () => {
    const { probe } = fakeProbe(
      [
        { head: 'aaa111', dirtyCount: 0 },
        { head: 'bbb222', dirtyCount: 0 },
      ],
      {
        commits: 1,
        files: [],
      },
    );
    const { tracker, events, setRouted } = rig(probe, 'sess-A');
    await tracker.onFirstMutation();
    setRouted('sess-B'); // 后台 A 结算时路由已指 B
    tracker.onRunSettled('sess-A');
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(0);
  });

  it('run 级去重：同键二次首探测 no-op；结算即消费（下轮重新探测）', async () => {
    const { probe, stateCalls } = fakeProbe([{ head: 'aaa111', dirtyCount: 0 }]);
    const { tracker, events } = rig(probe);
    await tracker.onFirstMutation();
    await tracker.onFirstMutation(); // 同 run 第二身份/第二工具
    expect(stateCalls).toHaveLength(1);
    tracker.onRunSettled('sess-A'); // 结算消费（dirty 未变 → 无事件）
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(0);
  });

  it('files 截帽 50（64KiB 纪律）', async () => {
    const many = Array.from({ length: 80 }, (_, i) => `f${i}.ts`);
    const { probe } = fakeProbe(
      [
        { head: 'aaa111', dirtyCount: 0 },
        { head: 'bbb222', dirtyCount: 0 },
      ],
      {
        commits: 3,
        files: many,
      },
    );
    const { tracker, events } = rig(probe);
    await tracker.onFirstMutation();
    tracker.onRunSettled('sess-A');
    await new Promise((r) => setTimeout(r, 10));
    expect((events[0]!.data as { files: string[] }).files).toHaveLength(50);
  });

  it('字节帽 60KiB（遗漏大扫 20260903 fresh D1-2 修死）：条数帽之内超长路径串保头丢尾 + filesTruncated 披露', async () => {
    // 50 条 × ~1400 字符 ≈ 70KiB > 60KiB 字节预算——条数帽（50）放行、字节帽
    // 拦腰。修前红位：序列化撞 64KiB 事件护栏 → appendEvent 抛
    // SESSION_EVENT_TOO_LARGE 有产出零落账（events 空 + 落账 warn）。
    const fat = Array.from({ length: 50 }, (_, i) => `d/${'x'.repeat(1390)}-${i}.ts`);
    const { probe } = fakeProbe(
      [
        { head: 'aaa111', dirtyCount: 0 },
        { head: 'bbb222', dirtyCount: 0 },
      ],
      { commits: 1, files: fat },
    );
    const { tracker, events } = rig(probe);
    await tracker.onFirstMutation();
    tracker.onRunSettled('sess-A');
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1); // 修前 0（护栏拒绝）
    const data = events[0]!.data as { files: string[]; filesTruncated?: number };
    expect(data.files.length).toBeGreaterThan(0);
    expect(data.files.length).toBeLessThan(50); // 字节预算在条数帽之内再拦一刀
    expect(data.filesTruncated).toBe(50 - data.files.length); // 截断面诚实披露
    expect(data.files[0]).toBe(fat[0]); // 保头（git 清单序前缀保留）
    // 序列化体积恒在预算内（护栏余量成立）
    expect(Buffer.byteLength(JSON.stringify(data.files))).toBeLessThanOrEqual(60 * 1024);
  });

  it('落账腿单独分桶（fresh D1-2 修死）：appendEvent 抛错 warn 归因「落账失败」不误标「结算复探异常」', async () => {
    // 探测腿全成功、只有落账 appendEvent 抛（护栏 SESSION_EVENT_TOO_LARGE /
    // 写侧拒绝形态）——修前红位：落进外层 catch 被 warn 成「结算复探异常」，
    // 归因撒谎误导排障方向。
    const { probe } = fakeProbe(
      [
        { head: 'aaa111', dirtyCount: 0 },
        { head: 'bbb222', dirtyCount: 0 },
      ],
      { commits: 1, files: ['src/a.ts'] },
    );
    const warnMsgs: string[] = [];
    const tracker = createGitAnchorTracker({
      routedSessionId: () => 'sess-A',
      appendEvent: () => {
        throw new Error('SESSION_EVENT_TOO_LARGE: 66560 > 65536');
      },
      workspaceRoot: () => '/ws',
      probe,
      logger: {
        debug: () => {},
        warn: (msg) => warnMsgs.push(msg),
      },
    });
    await tracker.onFirstMutation();
    tracker.onRunSettled('sess-A');
    await new Promise((r) => setTimeout(r, 10));
    expect(warnMsgs.some((m) => m.includes('落账失败'))).toBe(true); // 修前：文案是「结算复探异常」
    expect(warnMsgs.some((m) => m.includes('结算复探异常'))).toBe(false);
  });

  it('异常锁一：首探测抛异常免锚不阻工具', async () => {
    const boom: GitProbeFace = {
      state: async () => {
        throw new Error('git down');
      },
      delta: async () => undefined,
    };
    const { tracker, events, warns } = rig(boom);
    await tracker.onFirstMutation();
    tracker.onRunSettled('sess-A');
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(0);
    expect(warns.some((w) => w.includes('git down'))).toBe(true);
  });

  it('异常锁二：结算复探抛异常免落账', async () => {
    let i = 0;
    const flaky: GitProbeFace = {
      state: async () => {
        if (i++ === 0) return { head: 'aaa111', dirtyCount: 0 };
        throw new Error('settle boom');
      },
      delta: async () => undefined,
    };
    const { tracker, events, warns } = rig(flaky);
    await tracker.onFirstMutation();
    tracker.onRunSettled('sess-A');
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(0);
    expect(warns.some((w) => w.includes('settle boom'))).toBe(true);
  });
});

describe('CR-8 载体隔离验证锁（宿主面注册词汇——import 副作用）', () => {
  it('三词在册且类别正确（fork 载体装载同一模块图——注册结构性成立）', () => {
    expect(CHECKPOINT_EVENT_TYPES.map((d) => d.type)).toEqual([
      'checkpoint/snapshot',
      'checkpoint/rewind',
      'git/range',
    ]);
    for (const def of CHECKPOINT_EVENT_TYPES) {
      // 注册表可查（import 副作用已生效——本测试文件的 import 即载体装载模拟）
      expect(getSessionEventType(def.type)).toBeDefined();
    }
    expect(getSessionEventType('git/range')?.category).toBe('log-only');
  });
});
