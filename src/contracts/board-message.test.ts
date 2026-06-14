import { describe, it, expect } from 'vitest';
import { BoardMessageSchema, BOARD_STATUS_TRANSITIONS, nextBoardStatus, type BoardStatus, type BoardStatusEvent } from './board-message.js';

/**
 * BoardMessage 契约单测（16.0 P1）—— 钉死 7 种言语行为的 Zod 判别联合不变量。
 * 每 type 合法 payload 解析成功 + 非法/缺字段拒绝 + 板状态机流转合法。
 */
describe('BoardMessage 契约（16.0 P1 信封判别联合）', () => {
  // ─── 公共信封头字段（每条消息都需要）───
  const base = { id: 'm1', from: 'code', taskId: 't1', ts: 1000 };

  it('delegate：@指派，含子任务目标 + 可选 scope/childTaskId', () => {
    const msg = BoardMessageSchema.parse({
      ...base, type: 'delegate', to: 'research', subTaskGoal: '查旧调用点',
    });
    expect(msg.type).toBe('delegate');
    expect(msg).toMatchObject({ to: 'research', subTaskGoal: '查旧调用点' });

    // 带 childTaskId（拆子板）
    const withChild = BoardMessageSchema.parse({
      ...base, type: 'delegate', to: 'research', subTaskGoal: '深查',
      childTaskId: 't2', scope: { allowTools: ['inspect_code'] },
    });
    expect(withChild.type).toBe('delegate');
    expect((withChild as { childTaskId?: string }).childTaskId).toBe('t2');
  });

  it('delegate handoff：transferLeadership:true 表达整任务交接（§12 注）', () => {
    const handoff = BoardMessageSchema.parse({
      ...base, type: 'delegate', to: 'code2', subTaskGoal: '接手整块板',
      transferLeadership: true,
    });
    expect((handoff as { transferLeadership?: boolean }).transferLeadership).toBe(true);
  });

  it('delegate debate：mode=debate + debateConfig 表达辩论子区（§5.7）', () => {
    const debate = BoardMessageSchema.parse({
      ...base, type: 'delegate', to: 'research', subTaskGoal: '辩论方案 A vs B',
      mode: 'debate', debateConfig: { rounds: 3 },
    });
    expect((debate as { mode?: string }).mode).toBe('debate');
    expect((debate as { debateConfig?: { rounds?: number } }).debateConfig?.rounds).toBe(3);
  });

  it('report：附成果，必填 summary + status', () => {
    const msg = BoardMessageSchema.parse({
      ...base, type: 'report', to: 'brain', summary: '改完了', status: 'done',
    });
    expect(msg.type).toBe('report');

    // cant_split 降级上报（§10.3）
    const cantSplit = BoardMessageSchema.parse({
      ...base, type: 'report', to: 'leader-agent', summary: '拆不动', status: 'cant_split',
    });
    expect((cantSplit as { status: string }).status).toBe('cant_split');

    // 缺 status → 拒绝
    expect(() => BoardMessageSchema.parse({ ...base, type: 'report', to: 'brain', summary: 'x' })).toThrow();
  });

  it('tell：板上讨论，@all 或 @某成员', () => {
    const msg = BoardMessageSchema.parse({
      ...base, type: 'tell', to: 'all', text: '我查到 12 处引用',
    });
    expect(msg.type).toBe('tell');
  });

  it('ask：求助，@peer 不阻塞 / @brain 升级阻塞', () => {
    const peerAsk = BoardMessageSchema.parse({
      ...base, type: 'ask', to: 'research', question: 'X 的用法？',
    });
    expect(peerAsk.type).toBe('ask');

    const brainAsk = BoardMessageSchema.parse({
      ...base, type: 'ask', to: 'brain', question: '方向偏了', blocking: true,
    });
    expect((brainAsk as { blocking: boolean }).blocking).toBe(true);
  });

  it('tool_request：工具调用，to 固定 system', () => {
    const msg = BoardMessageSchema.parse({
      ...base, type: 'tool_request', to: 'system', toolName: 'write_file',
      input: { path: '/a/b.py', content: 'print(1)' },
    });
    expect(msg.type).toBe('tool_request');

    // to 非 system → 拒绝
    expect(() => BoardMessageSchema.parse({
      ...base, type: 'tool_request', to: 'brain', toolName: 'x', input: {},
    })).toThrow();
  });

  it('tool_result：工具结果，from 固定 system', () => {
    const msg = BoardMessageSchema.parse({
      ...base, type: 'tool_result', from: 'system', to: 'code', callId: 'c1', output: 'ok', ok: true,
    });
    expect(msg.type).toBe('tool_result');
  });

  it('command：brain 下令，4 种 intent', () => {
    for (const intent of ['redirect', 'stop', 'inspect', 'dispatch'] as const) {
      const msg = BoardMessageSchema.parse({
        ...base, type: 'command', from: 'brain', to: 'code', intent, instruction: '改方向',
      });
      expect(msg.type).toBe('command');
    }

    // dispatch 带 dispatchSpec
    const dispatch = BoardMessageSchema.parse({
      ...base, type: 'command', from: 'brain', to: 'leader', intent: 'dispatch',
      instruction: '补派 research', dispatchSpec: { agentRef: 'research', goal: '查兼容性' },
    });
    expect((dispatch as { dispatchSpec?: { agentRef: string } }).dispatchSpec?.agentRef).toBe('research');

    // 非 brain 发 command → schema 不强制 from（运行时路由层校验），但 type 正确
  });

  it('非法 type → 拒绝', () => {
    expect(() => BoardMessageSchema.parse({ ...base, type: 'whisper', to: 'x' })).toThrow();
  });

  it('缺必填字段 → 拒绝', () => {
    // delegate 缺 subTaskGoal
    expect(() => BoardMessageSchema.parse({ ...base, type: 'delegate', to: 'x' })).toThrow();
    // report 缺 summary
    expect(() => BoardMessageSchema.parse({ ...base, type: 'report', to: 'brain', status: 'done' })).toThrow();
  });
});

describe('Board 状态机（§6.5.1）', () => {
  it('终态无后续流转', () => {
    const terminals: BoardStatus[] = ['completed', 'failed', 'interrupted'];
    for (const t of terminals) {
      expect(BOARD_STATUS_TRANSITIONS[t]).toHaveLength(0);
    }
  });

  it('created 可进入 in_progress / interrupted', () => {
    expect(BOARD_STATUS_TRANSITIONS.created).toContain('in_progress');
    expect(BOARD_STATUS_TRANSITIONS.created).toContain('interrupted');
  });

  it('in_progress 可进入 5 种状态（含终态）', () => {
    const next = BOARD_STATUS_TRANSITIONS.in_progress;
    expect(next).toContain('awaiting_review');
    expect(next).toContain('awaiting_user');
    expect(next).toContain('completed');
    expect(next).toContain('failed');
    expect(next).toContain('interrupted');
  });

  it('awaiting_review 可打回 in_progress 或终结', () => {
    const next = BOARD_STATUS_TRANSITIONS.awaiting_review;
    expect(next).toContain('in_progress'); // 打回重做
    expect(next).toContain('completed');   // approve
    expect(next).toContain('failed');      // reject
  });
});

describe('nextBoardStatus 推导（§6.5.1 单一事实源）', () => {
  it('report：done→completed / blocked→failed / partial+cant_split→in_progress', () => {
    expect(nextBoardStatus('in_progress', { kind: 'report', status: 'done' })).toBe('completed');
    expect(nextBoardStatus('in_progress', { kind: 'report', status: 'blocked' })).toBe('failed');
    // partial/cant_split 推到 in_progress，与当前态相同 → null（无变化）
    expect(nextBoardStatus('in_progress', { kind: 'report', status: 'partial' })).toBeNull();
    expect(nextBoardStatus('in_progress', { kind: 'report', status: 'cant_split' })).toBeNull();
    // partial 从 awaiting_review（打回重做）→ in_progress（合法流转）
    expect(nextBoardStatus('awaiting_review', { kind: 'report', status: 'partial' })).toBe('in_progress');
  });

  it('delegate→in_progress（首次指派 / 再次派工）', () => {
    expect(nextBoardStatus('created', { kind: 'delegate' })).toBe('in_progress');
  });

  it('enter_review / await_user：进审核闸 / 等用户', () => {
    expect(nextBoardStatus('in_progress', { kind: 'enter_review' })).toBe('awaiting_review');
    expect(nextBoardStatus('in_progress', { kind: 'await_user' })).toBe('awaiting_user');
  });

  it('user_resumed / user_rejected / interrupt：用户侧流转', () => {
    expect(nextBoardStatus('awaiting_user', { kind: 'user_resumed' })).toBe('in_progress');
    expect(nextBoardStatus('awaiting_user', { kind: 'user_rejected' })).toBe('failed');
    expect(nextBoardStatus('in_progress', { kind: 'interrupt' })).toBe('interrupted');
  });

  it('终态 no-op：已完成/已失败/已中断板不被迟到信封打回', () => {
    for (const terminal of ['completed', 'failed', 'interrupted'] as BoardStatus[]) {
      expect(nextBoardStatus(terminal, { kind: 'report', status: 'done' })).toBeNull();
      expect(nextBoardStatus(terminal, { kind: 'delegate' })).toBeNull();
    }
  });

  it('非法流转抛错（防状态机被绕过）', () => {
    // created 不能直接 enter_review（必须先 in_progress）
    expect(() => nextBoardStatus('created', { kind: 'enter_review' })).toThrow();
    // completed 是终态 → null（不抛，因为终态短路在合法性校验前）
    expect(nextBoardStatus('completed', { kind: 'interrupt' })).toBeNull();
  });
});
