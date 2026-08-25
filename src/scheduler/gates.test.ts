/**
 * L3 scheduler — DiscoveryGates 纯函数单测（席 13 第一刀）。
 *
 * 两判据序与窗口边界：busy 优先（正跑必拒）→ recent_user_msg（30 秒窗）。
 * 全注入无 I/O——时钟冻结逐点断言。
 */

import { describe, expect, it } from 'vitest';
import { discoveryGates, RECENT_USER_MSG_WINDOW_MS } from './gates.js';

describe('discoveryGates：两判据序与窗口边界', () => {
  it('agent 忙即拒（reason=agent_busy）——优先于 recent 判据', () => {
    const decision = discoveryGates({ agentBusy: true, lastUserMessageAt: null, now: 1000 });
    expect(decision).toEqual({ ok: false, reason: 'agent_busy' });
  });

  it('agent 空闲 + 用户消息在窗口内即拒（reason=recent_user_msg）', () => {
    const now = 1_000_000;
    const decision = discoveryGates({
      agentBusy: false,
      lastUserMessageAt: now - (RECENT_USER_MSG_WINDOW_MS - 1),
      now,
    });
    expect(decision).toEqual({ ok: false, reason: 'recent_user_msg' });
  });

  it('窗口整点边界：恰好 30s 前的消息放行（now - last = 窗口值不小于窗口）', () => {
    const now = 1_000_000;
    const decision = discoveryGates({
      agentBusy: false,
      lastUserMessageAt: now - RECENT_USER_MSG_WINDOW_MS,
      now,
    });
    expect(decision).toEqual({ ok: true });
  });

  it('无会话消息（lastUserMessageAt=null）放行', () => {
    expect(discoveryGates({ agentBusy: false, lastUserMessageAt: null, now: 1 })).toEqual({ ok: true });
  });

  it('全闲放行（ok=true 无 reason 键）', () => {
    const decision = discoveryGates({ agentBusy: false, lastUserMessageAt: 0, now: 10 * RECENT_USER_MSG_WINDOW_MS });
    expect(decision.ok).toBe(true);
    expect(decision.reason).toBeUndefined();
  });
});
