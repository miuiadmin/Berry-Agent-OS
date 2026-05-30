import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ModuleContainer } from '../../modules/index.js';

const chatSchema = z.object({
  sessionId: z.string().optional(),
  agentId: z.string(),
  message: z.string().min(1),
});

export function createChatRoutes(modules: ModuleContainer) {
  const app = new Hono();

  app.post('/stream', zValidator('json', chatSchema), async (c) => {
    const { sessionId, agentId, message } = c.req.valid('json');

    const agent = modules.agent.getById(agentId);
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    let sid = sessionId;
    if (!sid) {
      const session = modules.execution.createSession({
        agentId,
        sessionType: 'user_chat',
        title: message.slice(0, 50),
      });
      sid = session.id;
    }

    modules.execution.addMessage(sid, 'user', message);

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'session', data: JSON.stringify({ sessionId: sid }) });

      await stream.writeSSE({
        event: 'progress',
        data: JSON.stringify({ status: 'thinking', summary: '思考中...' }),
      });

      await sleep(300);

      const response = generateMockResponse(message);
      const chunks = splitIntoChunks(response, 2);

      await stream.writeSSE({
        event: 'progress',
        data: JSON.stringify({ status: 'streaming', summary: '生成回复...' }),
      });

      for (const chunk of chunks) {
        await stream.writeSSE({
          event: 'text_delta',
          data: JSON.stringify({ text: chunk }),
        });
        await sleep(30 + Math.random() * 40);
      }

      modules.execution.addMessage(sid!, 'assistant', response);

      await stream.writeSSE({
        event: 'result',
        data: JSON.stringify({ response, sessionId: sid }),
      });
    });
  });

  return app;
}

function generateMockResponse(userMessage: string): string {
  const responses: Record<string, string> = {
    '你好': '你好！我是你的 AI 助手，有什么可以帮你的吗？',
    'hi': 'Hi! I\'m your AI assistant. How can I help you today?',
    'hello': 'Hello! What can I do for you?',
  };

  const lower = userMessage.toLowerCase().trim();
  if (responses[lower]) return responses[lower];

  return `收到你的消息：「${userMessage}」\n\n我目前是模拟响应模式（P3 阶段）。真实的 LLM 推理将在 P5 引擎阶段接入。\n\n作为演示，我可以：\n- 接收和回显你的消息\n- 展示流式输出效果\n- 持久化对话历史\n\n请继续向我发送消息来测试对话功能。`;
}

function splitIntoChunks(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
