import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDialogueTools } from './dialogue-tools.js';
import type { IpcChildChannel } from '../kernel/ipc.js';
import type { IpcMessage } from '../kernel/types.js';

type MessageHandler = (msg: IpcMessage) => void;

function createMockIpc() {
  const handlers = new Map<string, MessageHandler[]>();
  const sent: Array<{ type: string; to: string; payload: unknown }> = [];

  const ipc = {
    send: (type: string, to: string, payload: unknown) => {
      sent.push({ type, to, payload });
      return true;
    },
    onMessage: (type: string, handler: MessageHandler) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(handler);
    },
    request: vi.fn(),
  } as unknown as IpcChildChannel;

  /** 模拟 Kernel 向 Conversation 发送 dialogue.reply */
  function simulateReply(dialogueId: string, content: string, metadata?: Record<string, unknown>) {
    const replyHandlers = handlers.get('dialogue.reply') ?? [];
    const msg = {
      id: 'msg-1',
      type: 'dialogue.reply' as const,
      from: 'core',
      to: 'conversation',
      payload: { dialogueId, sequenceNumber: 1, from: 'code', to: 'conversation', content, metadata },
      timestamp: Date.now(),
    };
    for (const h of replyHandlers) h(msg as unknown as IpcMessage);
  }

  return { ipc, sent, simulateReply };
}

describe('dialogue-tools', () => {
  let ipc: ReturnType<typeof createMockIpc>;
  let signal: AbortSignal | undefined;

  beforeEach(() => {
    ipc = createMockIpc();
    signal = undefined;
  });

  function createTool() {
    const tools = createDialogueTools(ipc.ipc, () => signal, () => 'corr-test');
    return tools.find(t => t.name === 'dialogue')!;
  }

  describe('正常流程', () => {
    it('发送消息并等待回复', async () => {
      const tool = createTool();

      const resultPromise = tool.execute({ target: 'code', message: '分析代码' });

      // 验证 dialogue.send 已发出
      expect(ipc.sent).toHaveLength(1);
      expect(ipc.sent[0].type).toBe('dialogue.send');
      const payload = ipc.sent[0].payload as any;
      expect(payload.to).toBe('code');
      expect(payload.content).toBe('分析代码');

      // 模拟回复
      ipc.simulateReply(payload.dialogueId, '分析完成，有 3 个问题');

      const result = await resultPromise;
      expect(result.content).toContain('分析完成，有 3 个问题');
      expect(result.content).toContain('[dialogue:code]');
      expect(result.isError).toBeUndefined();
    });

    it('续接已有对话（传 dialogueId）', async () => {
      const tool = createTool();

      const resultPromise = tool.execute({
        target: 'code',
        message: '继续修复',
        dialogueId: 'existing-dlg',
      });

      const payload = ipc.sent[0].payload as any;
      expect(payload.dialogueId).toBe('existing-dlg');

      ipc.simulateReply('existing-dlg', 'OK 已修复');
      const result = await resultPromise;
      expect(result.content).toContain('OK 已修复');
    });

    it('回复含 needsClarification 标记', async () => {
      const tool = createTool();
      const resultPromise = tool.execute({ target: 'code', message: 'test' });
      const payload = ipc.sent[0].payload as any;

      ipc.simulateReply(payload.dialogueId, '需要更多信息', { needsClarification: true });
      const result = await resultPromise;
      expect(result.content).toContain('需要澄清');
    });

    it('回复含 isFinal 标记', async () => {
      const tool = createTool();
      const resultPromise = tool.execute({ target: 'code', message: 'test' });
      const payload = ipc.sent[0].payload as any;

      ipc.simulateReply(payload.dialogueId, '完成', { isFinal: true });
      const result = await resultPromise;
      expect(result.content).toContain('对话完成');
    });
  });

  describe('取消', () => {
    it('AbortSignal 触发时返回中断错误', async () => {
      const controller = new AbortController();
      signal = controller.signal;

      const tool = createTool();
      const resultPromise = tool.execute({ target: 'code', message: 'long task' });

      // 立即 abort
      controller.abort();

      const result = await resultPromise;
      expect(result.content).toContain('对话被中断');
      expect(result.isError).toBe(true);
    });

    it('signal 已经 aborted 时立即返回', async () => {
      const controller = new AbortController();
      controller.abort();
      signal = controller.signal;

      const tool = createTool();
      const result = await tool.execute({ target: 'code', message: 'test' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('中断');
    });
  });

  describe('超时', () => {
    it('60s 无回复返回超时错误', async () => {
      vi.useFakeTimers();
      const tool = createTool();

      const resultPromise = tool.execute({ target: 'code', message: 'slow' });

      // 快进 61 秒
      await vi.advanceTimersByTimeAsync(61_000);

      const result = await resultPromise;
      expect(result.content).toContain('错误');
      // 超时提示包含可操作建议
      expect(result.content).toContain('响应超时');
      expect(result.content).toContain('建议');
      expect(result.isError).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('截断', () => {
    it('超长回复被截断', async () => {
      const tool = createTool();
      const resultPromise = tool.execute({ target: 'code', message: 'test' });
      const payload = ipc.sent[0].payload as any;

      const longContent = 'x'.repeat(25_000);
      ipc.simulateReply(payload.dialogueId, longContent);

      const result = await resultPromise;
      expect(result.content.length).toBeLessThan(25_000);
      expect(result.content).toContain('回复已截断');
    });
  });
});
