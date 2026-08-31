/**
 * L5 app — attach 审批应答器单元测试（全面复盘 #51 回归锁 + 应答政策面）。
 *
 * 应答器从 attach-main 提为命名导出（pickAttachSession 同款先例——入口文件
 * 的可测子件）：三消费点（ask/settle/sync）同闭包，应答政策（何时投 decide、
 * 何时不投）单点可锁。本文件只测应答器与 pickAttachSession 纯逻辑——attach
 * 主流程接线由 daemon/attach 测试面覆盖（复盘 #31）。
 */

import { describe, expect, it, vi } from 'vitest';
import { createApprovalAnswerer, pickAttachSession } from './attach-main.js';
import type { WebuiPendingApproval, WebuiSessionSummary } from '../webui/index.js';

/** 最小审批卡（应答器只读 summary/reason/ownership/suggestedEntry 四面） */
function makeApproval(overrides: Partial<WebuiPendingApproval> = {}): WebuiPendingApproval {
  return {
    approvalId: 'ap-1',
    summary: '写入 workspace/test.txt',
    ...overrides,
  } as WebuiPendingApproval;
}

/** 脚本化应答器依赖面：confirm/decide 可编程、decide 调用全录（断言面） */
function makeDeps(overrides: Partial<Parameters<typeof createApprovalAnswerer>[0]> = {}) {
  const decided: Array<{ approvalId: string; decision: string }> = [];
  const deps = {
    confirm: vi.fn(async () => true as boolean | undefined),
    notify: vi.fn(),
    decide: vi.fn(async (approvalId: string, decision: 'approve' | 'reject' | 'always') => {
      decided.push({ approvalId, decision });
      return { status: 200, accepted: true };
    }),
    isQuitting: () => false,
    ...overrides,
  };
  return { deps, decided };
}

describe('createApprovalAnswerer — attach 审批应答政策（复盘 #51 回归锁）', () => {
  it('y 应答投 approve：decide 单发、卡摘除', async () => {
    const { deps, decided } = makeDeps();
    const answerer = createApprovalAnswerer(deps);
    answerer.ask(makeApproval());
    await vi.waitFor(() => expect(decided).toHaveLength(1));
    expect(decided[0]).toEqual({ approvalId: 'ap-1', decision: 'approve' });
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('n 应答投 reject（用户在场明确拒绝——合法路径）', async () => {
    const { deps, decided } = makeDeps({ confirm: vi.fn(async () => false) });
    createApprovalAnswerer(deps).ask(makeApproval());
    await vi.waitFor(() => expect(decided).toHaveLength(1));
    expect(decided[0]!.decision).toBe('reject');
  });

  it('【回归锁】Ctrl+D 收尾（quitting）时在身卡不投 decide——撤销 ≠ 拒绝，留 daemon 侧待决', async () => {
    // 复盘 #51 链条：cancelAsks → confirm 收场 false（signal 未 aborted）→
    // 修复前 quitting 守卫不覆盖 decide 路 → 把用户从未做出的拒绝投给 daemon
    //（daemon 侧账本落 reject 决定，违背「Ctrl+D = 仅退 attach 不动 daemon」）
    const { deps, decided } = makeDeps({
      confirm: vi.fn(async () => false), // cancelAsks 语义下 confirm 收场为 false
      isQuitting: () => true,
    });
    const answerer = createApprovalAnswerer(deps);
    answerer.ask(makeApproval());
    // confirm 已收场（微任务后）但 decide 必须零调用
    await vi.waitFor(() => expect(deps.confirm).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decided).toEqual([]);
  });

  it('【回归锁】quitting 收场同样不追问 always（y + 草案在场也不投）', async () => {
    const { deps, decided } = makeDeps({ isQuitting: () => true });
    const answerer = createApprovalAnswerer(deps);
    answerer.ask(makeApproval({ suggestedEntry: { tool: 'write' } as never }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deps.confirm).toHaveBeenCalledTimes(1); // 只首问，无 always 追问
    expect(decided).toEqual([]);
  });

  it('decided 镜像竞速败腿：settle 摘卡 + abort signal，confirm 收场后不投 decide', async () => {
    let release!: (value: boolean | undefined) => void;
    const confirm = vi.fn(
      () =>
        new Promise<boolean | undefined>((resolve) => {
          release = resolve;
        }),
    );
    const { deps, decided } = makeDeps({ confirm });
    const answerer = createApprovalAnswerer(deps);
    answerer.ask(makeApproval());
    answerer.settle('ap-1'); // 他腿已决——abort 在身提问
    release(false); // confirm 以 false 收（aborted 守卫应拦截）
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decided).toEqual([]);
  });

  it('sync 幂等：同一卡重复投递只建一卡（清单重拉/镜像竞窗）', async () => {
    let release!: (value: boolean | undefined) => void;
    const confirm = vi.fn(
      () =>
        new Promise<boolean | undefined>((resolve) => {
          release = resolve;
        }),
    );
    const { deps, decided } = makeDeps({ confirm });
    const answerer = createApprovalAnswerer(deps);
    answerer.sync([makeApproval(), makeApproval()]);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    release(true);
    await vi.waitFor(() => expect(decided).toHaveLength(1));
  });
});

describe('pickAttachSession — 会话选择律（cwd 匹配 active 优先、无匹配取最新）', () => {
  const base = { id: 's1', active: true, cwd: '/w/x', createdAt: 10, updatedAt: 10 };
  const session = (o: Partial<WebuiSessionSummary>): WebuiSessionSummary => ({ ...base, ...o }) as WebuiSessionSummary;

  it('cwd 匹配者优先且取最新 updatedAt', () => {
    const picked = pickAttachSession(
      [
        session({ id: 'a', cwd: '/w/x', updatedAt: 5 }),
        session({ id: 'b', cwd: '/w/x', updatedAt: 9 }),
        session({ id: 'c', cwd: '/other', updatedAt: 99 }),
      ],
      '/w/x',
    );
    expect(picked?.id).toBe('b');
  });

  it('无匹配取最新 active；零 active = undefined', () => {
    expect(pickAttachSession([session({ id: 'c', cwd: '/other', updatedAt: 1 })], '/w/x')?.id).toBe('c');
    expect(pickAttachSession([session({ id: 'z', active: false, updatedAt: 50 })], '/w/x')).toBeUndefined();
  });
});
