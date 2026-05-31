import type {
  AgentRuntime,
  AgentEvent,
  ExecutionTask,
  RuntimeCapabilities,
} from '../../../contracts/agent-runtime.js';
import type { LlmClient } from '../../../llm/index.js';
import { getLogger } from '../../../utils/logger.js';

const logger = getLogger('builtin-driver');

export class BuiltinDriver implements AgentRuntime {
  readonly name = 'Builtin';
  readonly provider = 'builtin' as const;

  constructor(private readonly llmClient: LlmClient) {}

  getCapabilities(): RuntimeCapabilities {
    return {
      toolInterception: true,
      streaming: true,
      fileAccess: true,
      multiTurn: true,
      resumable: false,
    };
  }

  async *execute(task: ExecutionTask): AsyncGenerator<AgentEvent> {
    const { executionId } = task;

    yield {
      kind: 'execution_started',
      executionId,
      timestamp: Date.now(),
      data: { provider: 'builtin' },
    };

    try {
      const result = await this.llmClient.chat(
        [{ role: 'user', content: task.prompt }],
        {
          system: task.systemPrompt,
          agent: 'builtin-runtime',
          purpose: 'runtime_execution',
          thinkingEnabled: task.thinkingLevel !== 'disabled',
          signal: undefined,
        },
      );

      if (result.content) {
        yield {
          kind: 'text_delta',
          executionId,
          timestamp: Date.now(),
          data: { text: result.content },
        };

        yield {
          kind: 'text_done',
          executionId,
          timestamp: Date.now(),
          data: { text: result.content },
        };
      }

      for (const toolCall of result.toolCalls) {
        yield {
          kind: 'tool_pending',
          executionId,
          timestamp: Date.now(),
          data: { name: toolCall.name, input: toolCall.input, callId: toolCall.id },
        };
      }

      yield {
        kind: 'execution_completed',
        executionId,
        timestamp: Date.now(),
        data: {
          content: result.content,
          toolCallCount: result.toolCalls.length,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          model: result.model,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ executionId, err }, 'Builtin execution failed');

      yield {
        kind: 'execution_failed',
        executionId,
        timestamp: Date.now(),
        data: { error: message },
      };
    }
  }

  async cancel(_executionId: string): Promise<void> {
    logger.warn('Cancel not yet supported for builtin driver');
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }
}
