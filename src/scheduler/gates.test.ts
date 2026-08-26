/**
 * L3 scheduler — DiscoveryGates 纯函数单测（席 13；第二刀④扩四判据）。
 *
 * 判据序与边界：busy（turn 配对深度）→ recent_user_msg（30 秒窗）→
 * canAfford（后台道余额）→ 自激预算（唤醒连击帽）。全注入无 I/O——
 * 时钟冻结逐点断言。
 */

import { describe, expect, it } from 'vitest';
import { discoveryGates, RECENT_USER_MSG_WINDOW_MS, WAKE_CHAIN_CAP } from './gates.js';

/** 全闲基线输入（各用例按需覆写单判据——四值注入无 I/O） */
const idle = {
  turnDepth: 0,
  lastUserMessageAt: null as number | null,
  backgroundAffordable: true,
  wakeCount: null as number | null,
  now: 1_000_000,
};

describe('discoveryGates：busy 判据（turn/start·turn/end 配对深度）', () => {
  it('深度 > 0 即拒（reason=agent_busy）——优先于其余三判据', () => {
    const decision = discoveryGates({
      ...idle,
      turnDepth: 1,
      lastUserMessageAt: idle.now - 1, // recent 判据同时命中——busy 先拒
      backgroundAffordable: false,
      wakeCount: WAKE_CHAIN_CAP,
    });
    expect(decision).toEqual({ ok: false, reason: 'agent_busy' });
  });

  it('深度 0 放行（全部轮闭合/跨进程无敞开轮）', () => {
    expect(discoveryGates({ ...idle })).toEqual({ ok: true });
  });
});

describe('discoveryGates：recent_user_msg 判据（30 秒窗）', () => {
  it('窗口内用户消息即拒', () => {
    const decision = discoveryGates({ ...idle, lastUserMessageAt: idle.now - (RECENT_USER_MSG_WINDOW_MS - 1) });
    expect(decision).toEqual({ ok: false, reason: 'recent_user_msg' });
  });

  it('窗口整点边界放行；无消息（null）放行——定时子进程路恒 null 同形', () => {
    expect(discoveryGates({ ...idle, lastUserMessageAt: idle.now - RECENT_USER_MSG_WINDOW_MS })).toEqual({ ok: true });
    expect(discoveryGates({ ...idle })).toEqual({ ok: true });
  });
});

describe('discoveryGates：canAfford 判据（never-unbounded 执法）', () => {
  it('后台道不可负担即拒（reason=over_budget）——优先于自激预算', () => {
    const decision = discoveryGates({
      ...idle,
      backgroundAffordable: false,
      wakeCount: WAKE_CHAIN_CAP, // 自激判据同时命中——预算先拒
    });
    expect(decision).toEqual({ ok: false, reason: 'over_budget' });
  });

  it('可负担且其余闲放行', () => {
    expect(discoveryGates({ ...idle, backgroundAffordable: true })).toEqual({ ok: true });
  });
});

describe('discoveryGates：自激预算判据（唤醒连击帽）', () => {
  it('连击达帽即拒（reason=wake_cap）；帽下一档放行', () => {
    expect(discoveryGates({ ...idle, wakeCount: WAKE_CHAIN_CAP })).toEqual({
      ok: false,
      reason: 'wake_cap',
    });
    expect(discoveryGates({ ...idle, wakeCount: WAKE_CHAIN_CAP - 1 })).toEqual({ ok: true });
  });

  it('null 不判（定时/手动路不计自激——外部钟非自激链）', () => {
    expect(discoveryGates({ ...idle, wakeCount: null })).toEqual({ ok: true });
  });
});
