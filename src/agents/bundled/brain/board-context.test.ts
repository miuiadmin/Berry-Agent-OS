/**
 * board-context 板上下文渲染测试（16.0 P4-B1）。
 * 钉死 renderBoardContext 的渲染不变量：元数据/花名册/近期发言三段齐全 + 各 type 摘要正确。
 */
import { describe, it, expect } from 'vitest';
import { renderBoardContext } from './board-context.js';
import { BoardMessageSchema, type BoardMessage } from '../../../contracts/board-message.js';
import type { BoardContext } from '../../../kernel/board-repo.js';

function mkMsg(partial: { type: BoardMessage['type'] } & Record<string, unknown>): BoardMessage {
  return BoardMessageSchema.parse({ id: 'm1', from: 'code', taskId: 't1', ts: 1000, ...partial }) as BoardMessage;
}

function mkCtx(overrides: Partial<BoardContext> = {}): BoardContext {
  return {
    meta: {
      taskId: 't1', goal: '重构模块 X', boardStatus: 'in_progress', leader: 'assistant',
      parentTaskId: null, spawnDepth: 0, turnCount: 5, maxTurns: 50, maxSpawnDepth: 3, activeScope: null,
    },
    members: [
      { agentId: 'assistant', role: 'leader' },
      { agentId: 'code', role: 'member' },
    ],
    recentMessages: [
      mkMsg({ type: 'delegate', to: 'code', subTaskGoal: '改模块 X' }),
      mkMsg({ type: 'report', to: 'leader', summary: '改完了', status: 'done' }),
    ],
    totalMessages: 5,
    ...overrides,
  };
}

describe('renderBoardContext 板上下文渲染（P4-B1）', () => {
  it('渲染三段齐全：目标/状态元数据 + 成员花名册 + 近期发言', () => {
    const out = renderBoardContext(mkCtx());
    expect(out).toContain('目标: 重构模块 X');
    expect(out).toContain('状态: in_progress');
    expect(out).toContain('leader: assistant');
    expect(out).toContain('深度: 0/3');
    expect(out).toContain('成员:');
    expect(out).toContain('assistant(leader)');
    expect(out).toContain('近期发言:');
  });

  it('近期发言：每 type 摘要正确（delegate→subTaskGoal / report→summary）', () => {
    const out = renderBoardContext(mkCtx());
    expect(out).toContain('[delegate] code'); // from
    expect(out).toContain('@指派');
    expect(out).toContain('改模块 X');
    expect(out).toContain('[report]');
    expect(out).toContain('@成果(done)');
    expect(out).toContain('改完了');
  });

  it('各 type 摘要分支覆盖（ask/tell/command/tool_request/tool_result）', () => {
    const ctx = mkCtx({
      recentMessages: [
        mkMsg({ type: 'ask', to: 'brain', question: '方向偏了？' }),
        mkMsg({ type: 'tell', to: 'all', text: '讨论中' }),
        mkMsg({ type: 'command', from: 'brain', to: 'code', intent: 'redirect', instruction: '改用 Y' }),
        mkMsg({ type: 'tool_request', to: 'system', toolName: 'write_file', input: {} }),
        mkMsg({ type: 'tool_result', from: 'system', to: 'code', callId: 'c1', output: 'ok', ok: true }),
      ],
    });
    const out = renderBoardContext(ctx);
    expect(out).toContain('@求助(brain)');
    expect(out).toContain('@发言');
    expect(out).toContain('@指令(redirect)');
    expect(out).toContain('@工具 write_file');
    expect(out).toContain('@工具结果 ok=true');
  });

  it('空花名册/空发言：不渲染对应段（无成员/近期发言行）', () => {
    const out = renderBoardContext(mkCtx({ members: [], recentMessages: [] }));
    expect(out).not.toContain('成员:');
    expect(out).not.toContain('近期发言:');
    // 元数据段仍在
    expect(out).toContain('目标:');
  });

  it('字符预算：goal/摘要超长被截断（防单条占满上下文）', () => {
    const longGoal = '目标'.repeat(200); // 400 字符
    const out = renderBoardContext(mkCtx({ meta: { ...mkCtx().meta, goal: longGoal } }));
    // goal 被截到预算内（不再含完整的 400 字符）
    expect(out).toContain('目标: 目标目标');
    expect(out.length).toBeLessThan(longGoal.length + 500);
  });
});
