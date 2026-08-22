/**
 * governance-switch 治理路由单测（设计文档/废弃/23 §4 + §9 P3）。
 *
 * 钉死「单一 switch 收敛」契约：每个 BoardMessage.type 路由到正确的治理机制（§4.1 四姿态）。
 * behaviour-parity：同 type → 同 route kind。这是 P3 把 15.0 A/B/C/D 四套 IPC flow
 * 收敛到一处 switch 的不变量基础。
 */
import { describe, it, expect } from 'vitest';
import { routeGovernance } from './governance-switch.js';
import { BoardMessageSchema, type BoardMessage } from '../../contracts/board-message.js';

/** 用 BoardMessageSchema 构造合法信封（确保 type 判别联合字段齐全） */
function msg(partial: { type: BoardMessage['type'] } & Record<string, unknown>): BoardMessage {
  return BoardMessageSchema.parse({
    id: 'm1', from: 'code', taskId: 't1', ts: 1000, ...partial,
  }) as BoardMessage;
}

describe('governance-switch 治理路由（§4.1 四姿态收敛）', () => {
  it('tool_request → gate（①权限专员，撞闸同步阻塞）', () => {
    const route = routeGovernance(msg({ type: 'tool_request', to: 'system', toolName: 'write_file', input: { path: '/a' } }));
    expect(route.kind).toBe('gate');
    expect((route as { toolName: string }).toolName).toBe('write_file');
  });

  it('report → review（②产出审核专员，必经审核）', () => {
    for (const status of ['done', 'partial', 'blocked', 'cant_split'] as const) {
      const route = routeGovernance(msg({ type: 'report', to: 'brain', summary: 'x', status }));
      expect(route.kind).toBe('review');
      expect((route as { status: string }).status).toBe(status);
    }
  });

  it('ask(@brain) → escalate（③brain Escalate 升级求助）', () => {
    const route = routeGovernance(msg({ type: 'ask', to: 'brain', question: '方向偏了' }));
    expect(route.kind).toBe('escalate');
    expect((route as { question: string }).question).toBe('方向偏了');
  });

  it('ask(@peer) → peer_help（板内求助，不惊动治理硬闸）', () => {
    const route = routeGovernance(msg({ type: 'ask', to: 'research', question: '这个用法?' }));
    expect(route.kind).toBe('peer_help');
  });

  it('command → command（③brain Command 纠偏，4 intent）', () => {
    for (const intent of ['redirect', 'stop', 'inspect', 'dispatch'] as const) {
      const route = routeGovernance(msg({ type: 'command', from: 'brain', to: 'code', intent, instruction: '改' }));
      expect(route.kind).toBe('command');
      expect((route as { intent: string }).intent).toBe(intent);
    }
  });

  it('tell / delegate / tool_result → none（无治理硬动作，brain 异步看板）', () => {
    expect(routeGovernance(msg({ type: 'tell', to: 'all', text: '讨论' })).kind).toBe('none');
    expect(routeGovernance(msg({ type: 'delegate', to: 'code', subTaskGoal: '拆活' })).kind).toBe('none');
    expect(routeGovernance(msg({ type: 'tool_result', from: 'system', to: 'code', callId: 'c1', output: 'ok', ok: true })).kind).toBe('none');
  });

  it('behaviour-parity：同 type 同 route kind（收敛契约稳定）', () => {
    // 每种 type 多次路由结果一致（switch 确定性）
    const types: Array<{ type: BoardMessage['type']; expected: string }> = [
      { type: 'tool_request', expected: 'gate' },
      { type: 'report', expected: 'review' },
      { type: 'command', expected: 'command' },
      { type: 'tell', expected: 'none' },
      { type: 'delegate', expected: 'none' },
      { type: 'tool_result', expected: 'none' },
    ];
    for (const { type, expected } of types) {
      const r1 = routeGovernance(msg({ type, to: type === 'tool_request' ? 'system' : 'x', ...(type === 'tool_request' ? { toolName: 't', input: {} } : {}), ...(type === 'report' ? { summary: 's', status: 'done' } : {}), ...(type === 'command' ? { from: 'brain', intent: 'stop', instruction: 'i' } : {}), ...(type === 'tool_result' ? { from: 'system', callId: 'c', output: 'o', ok: true } : {}), ...(type === 'tell' ? { text: 't' } : {}), ...(type === 'delegate' ? { subTaskGoal: 'g' } : {}) }));
      const r2 = routeGovernance(msg({ type, to: type === 'tool_request' ? 'system' : 'x', ...(type === 'tool_request' ? { toolName: 't', input: {} } : {}), ...(type === 'report' ? { summary: 's', status: 'done' } : {}), ...(type === 'command' ? { from: 'brain', intent: 'stop', instruction: 'i' } : {}), ...(type === 'tool_result' ? { from: 'system', callId: 'c', output: 'o', ok: true } : {}), ...(type === 'tell' ? { text: 't' } : {}), ...(type === 'delegate' ? { subTaskGoal: 'g' } : {}) }));
      expect(r1.kind).toBe(expected);
      expect(r1.kind).toBe(r2.kind);
    }
  });
});
