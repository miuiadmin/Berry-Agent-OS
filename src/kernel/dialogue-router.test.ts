import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DialogueRouter } from './dialogue-router.js';
import { CORE_SCHEMA_SQL, CORE_INDEX_SQL } from '../memory/schema.js';
import type { DialogueMessagePayload } from '../contracts/dialogue.js';
import type { Socket } from 'node:net';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(CORE_SCHEMA_SQL);
  db.exec(CORE_INDEX_SQL);
  return db;
}

function mockSocket(): Socket {
  return { destroyed: false, write: vi.fn() } as unknown as Socket;
}

describe('DialogueRouter', () => {
  let db: Database.Database;
  let router: DialogueRouter;
  let targetSendCalls: Array<{ type: string; to: string; payload: unknown }>;
  let brainSendCalls: Array<{ type: string; to: string; payload: unknown }>;

  beforeEach(() => {
    db = createTestDb();
    targetSendCalls = [];
    brainSendCalls = [];

    router = new DialogueRouter({
      db,
      sessionManager: {
        // 12.0 notifyBrain 需要从 pending 读 intentAnchor；mock 给空函数即可
        getPending: vi.fn(() => undefined),
      } as any,
      getAgentIpc: () => ({
        send: (type: string, to: string, payload: unknown) => {
          targetSendCalls.push({ type, to, payload });
          return true;
        },
        onMessage: vi.fn(),
      }),
      getBrainIpc: () => ({
        send: (type: string, to: string, payload: unknown) => {
          brainSendCalls.push({ type, to, payload });
          return true;
        },
        onMessage: vi.fn(),
      }),
    });
  });

  afterEach(() => {
    router.dispose();
    db.close();
  });

  describe('registerDialogue', () => {
    it('创建对话并返回状态', () => {
      const state = router.registerDialogue('dlg-1', {
        sessionId: 'sess-1',
        correlationId: 'corr-1',
        initiator: 'conversation',
        target: 'code',
      });
      expect(state.dialogueId).toBe('dlg-1');
      expect(state.status).toBe('active');
      expect(state.currentRound).toBe(0);
    });

    it('getDialogue 能取回已注册的对话', () => {
      router.registerDialogue('dlg-2', {
        sessionId: 'sess-1',
        correlationId: 'corr-1',
        initiator: 'conversation',
        target: 'code',
      });
      expect(router.getDialogue('dlg-2')).toBeDefined();
      expect(router.getDialogue('nonexistent')).toBeUndefined();
    });
  });

  describe('sendMessage + handleReply', () => {
    it('完整的一轮对话：send → route → reply → resolve', async () => {
      router.registerDialogue('dlg-3', {
        sessionId: 'sess-1',
        correlationId: 'corr-1',
        initiator: 'conversation',
        target: 'code',
      });

      const msg: DialogueMessagePayload = {
        dialogueId: 'dlg-3',
        sequenceNumber: -1,
        from: 'conversation',
        to: 'code',
        content: '请分析 auth.ts',
      };

      const replyPromise = router.sendMessage(msg, mockSocket());

      // 验证消息已路由到目标 agent
      expect(targetSendCalls).toHaveLength(1);
      expect(targetSendCalls[0].type).toBe('dialogue.send');

      // 验证 Brain 收到 observe
      expect(brainSendCalls).toHaveLength(1);
      expect(brainSendCalls[0].type).toBe('dialogue.observe');

      // 模拟 Code Agent 回复
      router.handleReply({
        dialogueId: 'dlg-3',
        sequenceNumber: 1,
        from: 'code',
        to: 'conversation',
        content: 'auth.ts 有 3 个问题',
        metadata: { isFinal: false },
      });

      const reply = await replyPromise;
      expect(reply.content).toBe('auth.ts 有 3 个问题');
      expect(router.getDialogue('dlg-3')!.currentRound).toBe(1);
    });

    it('多轮对话递增 round', async () => {
      router.registerDialogue('dlg-4', {
        sessionId: 'sess-1',
        correlationId: 'corr-1',
        initiator: 'conversation',
        target: 'code',
      });

      // 第 1 轮
      const p1 = router.sendMessage({
        dialogueId: 'dlg-4', sequenceNumber: -1, from: 'conversation', to: 'code', content: 'round 1',
      }, mockSocket());
      router.handleReply({
        dialogueId: 'dlg-4', sequenceNumber: 1, from: 'code', to: 'conversation', content: 'reply 1',
      });
      await p1;

      // 第 2 轮
      const p2 = router.sendMessage({
        dialogueId: 'dlg-4', sequenceNumber: -1, from: 'conversation', to: 'code', content: 'round 2',
      }, mockSocket());
      router.handleReply({
        dialogueId: 'dlg-4', sequenceNumber: 3, from: 'code', to: 'conversation', content: 'reply 2',
      });
      await p2;

      expect(router.getDialogue('dlg-4')!.currentRound).toBe(2);
    });
  });

  describe('重入保护', () => {
    it('同一 dialogue 并发 send 抛错', async () => {
      router.registerDialogue('dlg-5', {
        sessionId: 'sess-1',
        correlationId: 'corr-1',
        initiator: 'conversation',
        target: 'code',
      });

      // 第一条 send（不 reply，pending 悬挂）
      router.sendMessage({
        dialogueId: 'dlg-5', sequenceNumber: -1, from: 'conversation', to: 'code', content: 'msg 1',
      }, mockSocket());

      // 第二条 send → 应该抛错
      await expect(router.sendMessage({
        dialogueId: 'dlg-5', sequenceNumber: -1, from: 'conversation', to: 'code', content: 'msg 2',
      }, mockSocket())).rejects.toThrow('concurrent send not allowed');
    });
  });

  describe('closeDialogue', () => {
    it('关闭对话 reject pending reply', async () => {
      router.registerDialogue('dlg-6', {
        sessionId: 'sess-1',
        correlationId: 'corr-1',
        initiator: 'conversation',
        target: 'code',
      });

      const promise = router.sendMessage({
        dialogueId: 'dlg-6', sequenceNumber: -1, from: 'conversation', to: 'code', content: 'test',
      }, mockSocket());

      router.closeDialogue('dlg-6', 'interrupted');

      await expect(promise).rejects.toThrow('dialogue closed: interrupted');
      expect(router.getDialogue('dlg-6')!.status).toBe('interrupted');
    });

    it('关闭时通知 Brain', () => {
      router.registerDialogue('dlg-7', {
        sessionId: 'sess-1',
        correlationId: 'corr-1',
        initiator: 'conversation',
        target: 'code',
      });
      router.closeDialogue('dlg-7', 'completed');
      const endMsg = brainSendCalls.find(c => c.type === 'dialogue.end');
      expect(endMsg).toBeDefined();
    });
  });

  describe('持久化', () => {
    it('send 和 reply 都写入 dialogue_messages 表', async () => {
      router.registerDialogue('dlg-8', {
        sessionId: 'sess-1',
        correlationId: 'corr-1',
        initiator: 'conversation',
        target: 'code',
      });

      const p = router.sendMessage({
        dialogueId: 'dlg-8', sequenceNumber: -1, from: 'conversation', to: 'code', content: 'hello',
      }, mockSocket());

      router.handleReply({
        dialogueId: 'dlg-8', sequenceNumber: 1, from: 'code', to: 'conversation', content: 'world',
      });
      await p;

      const rows = db.prepare('SELECT * FROM dialogue_messages WHERE dialogue_id = ?').all('dlg-8');
      expect(rows).toHaveLength(2);
    });

    it('getHistory 返回持久化的消息', async () => {
      router.registerDialogue('dlg-9', {
        sessionId: 'sess-1',
        correlationId: 'corr-1',
        initiator: 'conversation',
        target: 'code',
      });

      const p = router.sendMessage({
        dialogueId: 'dlg-9', sequenceNumber: -1, from: 'conversation', to: 'code', content: 'q',
      }, mockSocket());
      router.handleReply({
        dialogueId: 'dlg-9', sequenceNumber: 1, from: 'code', to: 'conversation', content: 'a',
      });
      await p;

      const history = router.getHistory('dlg-9');
      expect(history).toHaveLength(2);
      expect(history[0].content).toBe('q');
      expect(history[1].content).toBe('a');
    });
  });

  describe('轮次限制', () => {
    it('超过 maxRounds 自动关闭', async () => {
      router.registerDialogue('dlg-10', {
        sessionId: 'sess-1',
        correlationId: 'corr-1',
        initiator: 'conversation',
        target: 'code',
      });

      // 手动设置 currentRound 到极限
      const state = router.getDialogue('dlg-10')!;
      (state as any).currentRound = 10;

      await expect(router.sendMessage({
        dialogueId: 'dlg-10', sequenceNumber: -1, from: 'conversation', to: 'code', content: 'overflow',
      }, mockSocket())).rejects.toThrow('exceeded max rounds');

      expect(state.status).not.toBe('active');
    });
  });

  describe('预算守护: maxDialoguesPerRequest', () => {
    it('同一 correlationId 超过 maxDialoguesPerRequest 时抛错', () => {
      // DIALOGUE_DEFAULTS.maxDialoguesPerRequest = 3
      router.registerDialogue('dlg-a', { sessionId: 'sess-1', correlationId: 'corr-same', initiator: 'conversation', target: 'code' });
      router.registerDialogue('dlg-b', { sessionId: 'sess-1', correlationId: 'corr-same', initiator: 'conversation', target: 'learning' });
      router.registerDialogue('dlg-c', { sessionId: 'sess-1', correlationId: 'corr-same', initiator: 'conversation', target: 'code' });

      expect(() => router.registerDialogue('dlg-d', {
        sessionId: 'sess-1', correlationId: 'corr-same', initiator: 'conversation', target: 'code',
      })).toThrow('exceeded max dialogues per request');
    });

    it('不同 correlationId 的对话互不影响', () => {
      router.registerDialogue('dlg-x', { sessionId: 'sess-1', correlationId: 'corr-1', initiator: 'conversation', target: 'code' });
      router.registerDialogue('dlg-y', { sessionId: 'sess-1', correlationId: 'corr-2', initiator: 'conversation', target: 'code' });
      router.registerDialogue('dlg-z', { sessionId: 'sess-1', correlationId: 'corr-2', initiator: 'conversation', target: 'learning' });

      // corr-1 只有 1 个，corr-2 有 2 个，都没超限
      expect(router.getDialogue('dlg-x')!.status).toBe('active');
      expect(router.getDialogue('dlg-z')!.status).toBe('active');
    });
  });
});
