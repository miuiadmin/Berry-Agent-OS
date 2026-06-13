import { describe, it, expect } from 'vitest';
import { BlockSchema, isBlockTerminal } from './message-blocks.js';
import type { Block, ToolBlock, DelegationBlock, TextBlock } from './message-blocks.js';

/**
 * Block 契约单测 —— 钉死对话内联模型的判别联合 / schema 解析 / 终态判定。
 * 这些不变量是后续存储（message_blocks）、事件（stream.block）、渲染（blocks.map）的基础，
 * 防止未来重构破坏 Block 形状。
 */
describe('Block 契约（对话内联模型）', () => {
  describe('BlockSchema 解析', () => {
    it('解析 text block', () => {
      const block = { type: 'text', text: '你好' } satisfies TextBlock;
      expect(BlockSchema.parse(block)).toEqual(block);
    });

    it('解析 thinking block', () => {
      const parsed = BlockSchema.parse({ type: 'thinking', text: '让我想想' });
      expect(parsed.type).toBe('thinking');
    });

    it('解析 tool block 的 4 态机各态', () => {
      const states = ['pending', 'running', 'completed', 'failed'] as const;
      for (const state of states) {
        const block = { type: 'tool', id: 'c1', name: 'shell', input: { cmd: 'ls' }, state };
        const parsed = BlockSchema.parse(block) as ToolBlock;
        expect(parsed.state).toBe(state);
        expect(parsed.id).toBe('c1');
      }
    });

    it('解析 delegation block（含 childSessionId）', () => {
      const block = {
        type: 'delegation',
        id: 't1',
        targetAgent: 'code',
        state: 'completed',
        summary: '重构完成',
        childSessionId: 'sess-child',
      };
      const parsed = BlockSchema.parse(block) as DelegationBlock;
      expect(parsed.childSessionId).toBe('sess-child');
      expect(parsed.targetAgent).toBe('code');
    });

    it('解析 review block 的三种裁决', () => {
      for (const verdict of ['approve', 'modify', 'reject'] as const) {
        const parsed = BlockSchema.parse({ type: 'review', verdict });
        expect(parsed.type).toBe('review');
      }
    });

    it('拒绝未知 block type', () => {
      expect(() => BlockSchema.parse({ type: 'image', text: 'x' })).toThrow();
    });

    it('拒绝 tool block 的非法 state', () => {
      expect(() =>
        BlockSchema.parse({ type: 'tool', id: 'c1', name: 'shell', input: {}, state: 'done' }),
      ).toThrow();
    });

    it('拒绝 delegation block 的非法 state', () => {
      expect(() =>
        BlockSchema.parse({ type: 'delegation', id: 't1', targetAgent: 'code', state: 'ok' }),
      ).toThrow();
    });
  });

  describe('isBlockTerminal 终态判定', () => {
    it('tool block：completed/failed 为终态，pending/running 非终态', () => {
      const mk = (state: ToolBlock['state']): ToolBlock => ({
        type: 'tool',
        id: 'c1',
        name: 'shell',
        input: {},
        state,
      });
      expect(isBlockTerminal(mk('completed'))).toBe(true);
      expect(isBlockTerminal(mk('failed'))).toBe(true);
      expect(isBlockTerminal(mk('pending'))).toBe(false);
      expect(isBlockTerminal(mk('running'))).toBe(false);
    });

    it('delegation block：completed/failed/interrupted 为终态', () => {
      const mk = (state: DelegationBlock['state']): DelegationBlock => ({
        type: 'delegation',
        id: 't1',
        targetAgent: 'code',
        state,
      });
      expect(isBlockTerminal(mk('completed'))).toBe(true);
      expect(isBlockTerminal(mk('failed'))).toBe(true);
      expect(isBlockTerminal(mk('interrupted'))).toBe(true);
      expect(isBlockTerminal(mk('running'))).toBe(false);
    });

    it('text/thinking/review 无状态机，视为即终态', () => {
      const text: Block = { type: 'text', text: 'hi' };
      const thinking: Block = { type: 'thinking', text: 'hmm' };
      const review: Block = { type: 'review', verdict: 'approve' };
      expect(isBlockTerminal(text)).toBe(true);
      expect(isBlockTerminal(thinking)).toBe(true);
      expect(isBlockTerminal(review)).toBe(true);
    });
  });
});
