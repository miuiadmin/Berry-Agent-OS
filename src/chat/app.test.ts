/**
 * L4 chat 单元测试 — 审批 answerer 三态归一（§8.4 增补 2 落码形态③⑥）。
 * answerApproval 纯函数直测：三选呈现 / 降级两态 / 无效答案保守 reject /
 * F10 文案纪律（明示条目内容与永久性）。接线面（driverScope.on）走全栈
 * 装配测试覆盖，不在本文件重复。
 */

import { describe, expect, it } from 'vitest';
import { answerApproval } from './app.js';
import type { ApprovalRequest } from '../safety/types.js';

/** 可编程原语桩：记录 select 收到的选项面（文案纪律断言用） */
function primitives(opts?: { confirmAnswer?: boolean; selectAnswer?: string; withSelect?: boolean }) {
  const confirmCalls: string[] = [];
  const selectCalls: { message: string; choices: readonly { value: string; label: string }[] }[] = [];
  return {
    confirmCalls,
    selectCalls,
    primitives: {
      confirm: async (text: string) => {
        confirmCalls.push(text);
        return opts?.confirmAnswer ?? true;
      },
      ...(opts?.withSelect === false
        ? {}
        : {
            select: async (message: string, choices: readonly { value: string; label: string }[]) => {
              selectCalls.push({ message, choices });
              return opts?.selectAnswer ?? '';
            },
          }),
    },
  };
}

/** 带草案的最小审批请求 */
const draftReq: ApprovalRequest = {
  summary: '写入 /repo/.git/config（命中 carve-out 遮罩 .git）',
  suggestedEntry: { tool: 'write', pattern: '/repo/.git/config' },
};

describe('answerApproval — 三选呈现（select 在场 + 载荷带草案）', () => {
  it('approve / always 直通；三选项值闭集正确', async () => {
    const p = primitives({ selectAnswer: 'approve' });
    expect(await answerApproval(draftReq, p.primitives)).toBe('approve');
    const a = primitives({ selectAnswer: 'always' });
    expect(await answerApproval(draftReq, a.primitives)).toBe('always');
    // 三选项 = approve / always / reject（无第四态）
    expect(p.selectCalls[0]!.choices.map((c) => c.value)).toEqual(['approve', 'always', 'reject']);
  });

  it('F10 文案纪律：always 选项明示条目内容（tool + pattern）与永久性', async () => {
    const p = primitives({ selectAnswer: 'always' });
    await answerApproval(draftReq, p.primitives);
    const always = p.selectCalls[0]!.choices.find((c) => c.value === 'always')!;
    expect(always.label).toContain('write');
    expect(always.label).toContain('/repo/.git/config');
    expect(always.label).toContain('永久');
  });

  it("''（通道无法表达三选/无效输入）降级 confirm 两态：approve/reject 决不因降级丢失", async () => {
    const ok = primitives({ selectAnswer: '', confirmAnswer: true });
    expect(await answerApproval(draftReq, ok.primitives)).toBe('approve');
    expect(ok.confirmCalls).toHaveLength(1); // 降级真的走到 confirm
    const deny = primitives({ selectAnswer: '', confirmAnswer: false });
    expect(await answerApproval(draftReq, deny.primitives)).toBe('reject');
    expect(deny.confirmCalls).toHaveLength(1);
  });
});

describe('answerApproval — 降级两态（select 不在场或无草案：呈现纪律）', () => {
  it('select 不在场：confirm 两态（「始终允许」不呈现）', async () => {
    const p = primitives({ confirmAnswer: true, withSelect: false });
    expect(await answerApproval(draftReq, p.primitives)).toBe('approve');
    expect(p.selectCalls).toHaveLength(0);
    expect(p.confirmCalls).toHaveLength(1);
  });

  it('select 在场但载荷无草案：同样降级两态', async () => {
    const p = primitives({ confirmAnswer: false });
    const req: ApprovalRequest = { summary: '沙箱升权 read-only → danger-full-access' };
    expect(await answerApproval(req, p.primitives)).toBe('reject');
    expect(p.selectCalls).toHaveLength(0); // 无草案不进三选
    expect(p.confirmCalls).toHaveLength(1);
  });
});

describe("answerApproval — interrupt 小刀 'cancel' 落账映射（保守收场 + signal.aborted 判据）", () => {
  it("select 保守收场 '' + 已 abort → 'cancel' 且不再降级发 confirm（时序洞锁）", async () => {
    const ac = new AbortController();
    ac.abort();
    // confirm 若被误发即返回 true → approve 假阳性——本断言必红防换皮
    const p = primitives({ selectAnswer: '', confirmAnswer: true });
    expect(await answerApproval(draftReq, p.primitives, { signal: ac.signal })).toBe('cancel');
    expect(p.confirmCalls).toHaveLength(0); // 降级面不复活（预置 aborted 的 confirm 同步收场 false，只会把 cancel 换皮成 reject）
  });

  it('confirm 保守收场 false + 已 abort → cancel（打断非拒绝）', async () => {
    const ac = new AbortController();
    ac.abort();
    const p = primitives({ confirmAnswer: false, withSelect: false });
    expect(await answerApproval(draftReq, p.primitives, { signal: ac.signal })).toBe('cancel');
  });

  it('signal 在场未 abort：正向答案先胜——与无 signal 行为逐位相同（回归）', async () => {
    const ac = new AbortController(); // 在场但未 abort
    const p = primitives({ selectAnswer: '', confirmAnswer: true });
    expect(await answerApproval(draftReq, p.primitives, { signal: ac.signal })).toBe('approve');
    expect(p.confirmCalls).toHaveLength(1); // 降级链照常
    // 未打断语境的保守值仍诚实记 reject（判据只认 signal.aborted）
    const d = primitives({ confirmAnswer: false, withSelect: false });
    expect(await answerApproval(draftReq, d.primitives, { signal: ac.signal })).toBe('reject');
  });
});
