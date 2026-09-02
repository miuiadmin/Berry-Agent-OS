/**
 * L3 webui — pending 审批登记簿单元测试（契约篇 §6.8 刀三）。
 *
 * 全分支覆盖：asked 镜像注册/幂等、claim 富化/缺槽自注册/双 claim/已决、
 * decide 三态 + web 腿真消费值、decided 镜像五值映射 + 丢弃性结算、list/pending
 * 已决过滤、MAX_ENTRIES 只逐已决。含两条纪律级回归锁：
 * - settleAll **未决不结算**（行回卷 resolve 未决 claim promise = 抢答污染
 *   在途竞速——/reload 会把 TUI 未答审批误拒，本锁先红后修）；
 * - MAX_ENTRIES **未决绝不逐出**（帽是卫生不是丢卡）。
 */

import { describe, expect, it } from 'vitest';
import { createPendingApprovals } from './approvals.js';
import type { WebuiApprovalDecision, WebuiApprovalDetail } from './types.js';

/* ---------------- 桩件 ---------------- */

/** asked 镜像载荷（ctx 'session/event' 信封形状——onMirror 入参） */
function askedEnv(approvalId: string, summary?: string, sessionId = 'sess-1'): unknown {
  return {
    sessionId,
    event: { type: 'approval/asked', data: { approvalId, ...(summary !== undefined ? { summary } : {}) } },
  };
}

/** decided 镜像载荷（decision 值域 = durable 五值——web 闭集外的 cancel/ 也在册） */
function decidedEnv(approvalId: string, decision: string): unknown {
  return { sessionId: 'sess-1', event: { type: 'approval/decided', data: { approvalId, decision } } };
}

/** claim 载荷样例（enriched 全键形态） */
function detail(over: Partial<WebuiApprovalDetail> = {}): WebuiApprovalDetail {
  return {
    summary: '写文件',
    reason: 'workspace-write 档',
    suggestedEntry: { tool: 'write_file', pattern: '/tmp/a.txt' },
    ownership: { appId: 'berrycode', sessionId: 'sess-1' },
    priority: 'background',
    ...over,
  };
}

/** 微任务拍数（promise 结算沉降——await 一次即一拍，多拍保险） */
async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/* ---------------- asked 镜像注册 ---------------- */

describe('pending 审批登记簿：asked 镜像', () => {
  it('注册条目（summary 在场直取；list 吐未决全量）', () => {
    const reg = createPendingApprovals();
    reg.onMirror(askedEnv('a1', '写 /tmp/a.txt'));
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ approvalId: 'a1', sessionId: 'sess-1', summary: '写 /tmp/a.txt' });
  });

  it('summary 缺席补空串（防御位——decided 决不看 null）', () => {
    const reg = createPendingApprovals();
    reg.onMirror(askedEnv('a1'));
    expect(reg.list()[0]?.summary).toBe('');
  });

  it('幂等注册：重复 asked 不重写、不覆盖 claim 已富化键', () => {
    const reg = createPendingApprovals();
    reg.onMirror(askedEnv('a1', '摘要'));
    // claim 先富化（镜像注册在场的缺省键补齐路径）
    reg.claim('a1', detail({ summary: 'claim 摘要', suggestedEntry: { tool: 'bash', pattern: '*' } }));
    reg.onMirror(askedEnv('a1', '镜像摘要'));
    const pending = reg.pending('a1');
    expect(pending?.suggestedEntry).toEqual({ tool: 'bash', pattern: '*' }); // 不覆盖
    expect(reg.list()).toHaveLength(1); // 不重写 = 不增行
  });

  it('claim 载荷 summary 缺席的镜像补位（空串 → 有值）', () => {
    const reg = createPendingApprovals();
    reg.claim('a1', detail({ summary: '' })); // 缺槽自注册空摘要
    reg.onMirror(askedEnv('a1', '镜像补位摘要'));
    expect(reg.pending('a1')?.summary).toBe('镜像补位摘要');
  });

  it('形状不符载荷静默丢（无 sessionId / 无 approvalId / 非审批词）', () => {
    const reg = createPendingApprovals();
    reg.onMirror(undefined);
    reg.onMirror({ event: { type: 'approval/asked', data: { approvalId: 'a1' } } }); // 无 sessionId
    reg.onMirror({ sessionId: 's', event: { type: 'user/message', data: { approvalId: 'a1' } } }); // 非审批词
    reg.onMirror({ sessionId: 's', event: { type: 'approval/asked', data: {} } }); // 无 approvalId
    expect(reg.list()).toHaveLength(0);
  });
});

/* ---------------- claim ---------------- */

describe('pending 审批登记簿：claim', () => {
  it('镜像在册 → claim 富化缺省键（suggestedEntry/ownership/priority/reason）', () => {
    const reg = createPendingApprovals();
    reg.onMirror(askedEnv('a1', '摘要'));
    const promise = reg.claim('a1', detail());
    expect(promise).toBeInstanceOf(Promise);
    const pending = reg.pending('a1');
    expect(pending?.suggestedEntry).toEqual({ tool: 'write_file', pattern: '/tmp/a.txt' });
    expect(pending?.ownership).toEqual({ appId: 'berrycode', sessionId: 'sess-1' });
    expect(pending?.priority).toBe('background');
    expect(pending?.reason).toBe('workspace-write 档');
  });

  it('在场不覆盖：二次 claim 语义下镜像已富化键保持首值', () => {
    const reg = createPendingApprovals();
    // 缺槽自注册带全键（首 claim）
    reg.claim('a1', detail({ priority: 'background' }));
    // decided 前条目已在册——但已 claim（resolver 在）→ 第二次 claim undefined，
    // 富化不覆盖路径由镜像注册 + claim 组合覆盖：
    reg.onMirror(askedEnv('a1', '镜像摘要')); // 幂等注册不覆盖
    expect(reg.pending('a1')?.summary).toBe('写文件');
  });

  it('双 claim 防御位：一 ask 恰一 answerer——第二次 undefined', () => {
    const reg = createPendingApprovals();
    reg.onMirror(askedEnv('a1', '摘要'));
    expect(reg.claim('a1', detail())).toBeInstanceOf(Promise);
    expect(reg.claim('a1', detail())).toBeUndefined();
  });

  it('已决条目 claim = undefined（TUI 腿已胜，无 web 腿）', () => {
    const reg = createPendingApprovals();
    reg.onMirror(askedEnv('a1', '摘要'));
    reg.onMirror(decidedEnv('a1', 'approve'));
    expect(reg.claim('a1', detail())).toBeUndefined();
  });

  it('缺槽自注册（行重载后镜像已过——claim 载荷自带全量归属）', () => {
    const reg = createPendingApprovals();
    const promise = reg.claim('a9', detail());
    expect(promise).toBeInstanceOf(Promise);
    const pending = reg.pending('a9');
    expect(pending).toMatchObject({
      approvalId: 'a9',
      summary: '写文件',
      suggestedEntry: { tool: 'write_file', pattern: '/tmp/a.txt' },
      ownership: { appId: 'berrycode', sessionId: 'sess-1' },
    });
  });

  it('根路审批（无 ownership）缺槽自注册：sessionId 缺省 undefined 档', () => {
    const reg = createPendingApprovals();
    reg.claim('a0', detail({ ownership: undefined, suggestedEntry: undefined }));
    const pending = reg.pending('a0');
    expect(pending?.sessionId).toBeUndefined();
    expect(pending?.suggestedEntry).toBeUndefined();
  });
});

/* ---------------- decide 三态 + web 腿真消费 ---------------- */

describe('pending 审批登记簿：decide', () => {
  it('web 腿胜：accepted + claim promise resolve 真消费值（非丢弃）', async () => {
    const reg = createPendingApprovals();
    reg.onMirror(askedEnv('a1', '摘要'));
    const promise = reg.claim('a1', detail())!;
    const judged = reg.decide('a1', 'always');
    expect(judged).toEqual({ accepted: true });
    await expect(promise).resolves.toBe('always');
  });

  it('二次 decide 回 superseded（已决旗先置——幂等回执不二写）', () => {
    const reg = createPendingApprovals();
    reg.onMirror(askedEnv('a1', '摘要'));
    expect(reg.decide('a1', 'reject')).toEqual({ accepted: true });
    expect(reg.decide('a1', 'approve')).toEqual({ accepted: false, reason: 'superseded' });
  });

  it('槽从未存在 → undefined（404 语义由端点译）', () => {
    const reg = createPendingApprovals();
    expect(reg.decide('nope', 'approve')).toBeUndefined();
  });

  it('decide 后 list/pending 均不可见（已决过滤）', () => {
    const reg = createPendingApprovals();
    reg.onMirror(askedEnv('a1', '摘要'));
    reg.onMirror(askedEnv('a2', '摘要 2'));
    reg.decide('a1', 'approve');
    expect(reg.pending('a1')).toBeUndefined();
    expect(reg.list().map((e) => e.approvalId)).toEqual(['a2']);
  });
});

/* ---------------- decided 镜像 ---------------- */

describe('pending 审批登记簿：decided 镜像', () => {
  it('五值映射：always/approve 透传，reject/cancel/unavailable → reject（丢弃性结算）', async () => {
    const cases: Array<[string, WebuiApprovalDecision | undefined, WebuiApprovalDecision]> = [
      ['always', 'always', 'always'],
      ['approve', 'approve', 'approve'],
      ['reject', 'reject', 'reject'],
      ['cancel', 'reject', 'reject'],
      ['unavailable', 'reject', 'reject'],
    ];
    for (const [durable, , expected] of cases) {
      const reg = createPendingApprovals();
      reg.onMirror(askedEnv('a1', '摘要'));
      const promise = reg.claim('a1', detail())!;
      reg.onMirror(decidedEnv('a1', durable));
      // 镜像标决即丢弃性结算——值无人消费仅防悬 await，但值域仍按映射律收口
      await expect(promise).resolves.toBe(expected);
      expect(reg.pending('a1')).toBeUndefined();
      expect(reg.decide('a1', 'approve')).toEqual({ accepted: false, reason: 'superseded' });
    }
  });

  it('簿外已决（行重载竞速）不计', () => {
    const reg = createPendingApprovals();
    reg.onMirror(decidedEnv('ghost', 'approve'));
    expect(reg.list()).toHaveLength(0);
  });

  it('重复 decided 镜像不二次结算（幂等）', async () => {
    const reg = createPendingApprovals();
    reg.onMirror(askedEnv('a1', '摘要'));
    const promise = reg.claim('a1', detail())!;
    reg.onMirror(decidedEnv('a1', 'approve'));
    reg.onMirror(decidedEnv('a1', 'reject')); // 迟到重复帧
    await expect(promise).resolves.toBe('approve'); // 首值保持
  });
});

/* ---------------- 行回卷卫生（纪律级回归锁） ---------------- */

describe('pending 审批登记簿：settleAll 未决不结算', () => {
  it('回归锁：claim → settleAll → decide 后 promise 仍 pending（resolve 会抢答污染在途竞速）', async () => {
    const reg = createPendingApprovals();
    reg.onMirror(askedEnv('a1', '摘要'));
    const promise = reg.claim('a1', detail())!;
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    reg.settleAll(); // 行回卷（/reload）
    // 回卷后 decide 理论不可达（行已卸载）——防御位直调验证不结算语义
    reg.decide('a1', 'reject');
    await flushMicrotasks();
    expect(settled).toBe(false); // 未决 promise 悬置——竞速由 TUI 腿收敛
  });

  it('镜像结算路径不受 settleAll 影响（回卷先于镜像到达 = 悬置无害）', async () => {
    const reg = createPendingApprovals();
    reg.onMirror(askedEnv('a1', '摘要'));
    const promise = reg.claim('a1', detail())!;
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    reg.settleAll();
    reg.onMirror(decidedEnv('a1', 'approve'));
    await flushMicrotasks();
    expect(settled).toBe(false); // 回卷后镜像也不可达（订阅已退）——防御位同律
  });
});

/* ---------------- 软帽 ---------------- */

describe('pending 审批登记簿：MAX_ENTRIES 软帽', () => {
  it('超帽只逐出最旧已决条目，未决绝不逐出', () => {
    const reg = createPendingApprovals();
    // 100 已决（插入序即时间序——最旧者先逐）+ 1 未决
    for (let i = 0; i < 100; i++) {
      reg.onMirror(askedEnv(`d${i}`, `摘要 ${i}`));
      reg.decide(`d${i}`, 'approve');
    }
    reg.onMirror(askedEnv('live-1', '未决摘要'));
    expect(reg.list().map((e) => e.approvalId)).toEqual(['live-1']); // 未决可见
    reg.onMirror(askedEnv('d100', '第 101 条')); // 101 在册 → 逐出最旧已决 d0
    reg.decide('d100', 'approve');
    const list = reg.list();
    expect(list.map((e) => e.approvalId)).toEqual(['live-1']); // 未决仍在
    // 超帽两枚（101 注册 live-1 未触发清理——evict 只在标决/decide 路；102 再
    // 标决 d100 触发）→ 逐出最旧已决 d0/d1 回帽；d2 仍在册（superseded）
    expect(reg.decide('d0', 'approve')).toBeUndefined();
    expect(reg.decide('d1', 'approve')).toBeUndefined();
    expect(reg.decide('d2', 'approve')).toEqual({ accepted: false, reason: 'superseded' });
  });
});
