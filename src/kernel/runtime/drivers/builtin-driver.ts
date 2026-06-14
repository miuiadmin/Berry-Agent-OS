import type {
  AgentRuntime,
  AgentEvent,
  ExecutionTask,
  RuntimeCapabilities,
} from '../../../contracts/agent-runtime.js';
import type { LlmClient } from '../../../llm/index.js';
import { getLogger } from '../../../utils/logger.js';

const logger = getLogger('builtin-driver');

/** 可变 LLM 客户端引用，支持热重载时替换 */
export interface LlmClientHolder {
  current: LlmClient;
}

export class BuiltinDriver implements AgentRuntime {
  readonly name = 'Builtin';
  readonly provider = 'builtin' as const;

  constructor(private readonly llmHolder: LlmClientHolder) {}

  /** 获取当前活跃的 LLM 客户端（热重载后自动指向新实例） */
  private get llmClient(): LlmClient { return this.llmHolder.current; }

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

      // 对话内联（doc 22）：非流式 chat() 拿到的 result.reasoning 投影为 thinking_delta AgentEvent——
      // delegation-orchestrator 的 case 'thinking_delta' 会调 blockCollector.onReasoningDelta → stream.block thinking。
      // 之前只 yield text_delta/tool_pending/execution_completed，builtin runtime 委派的思考过程永远到不了前端。
      // 与 external-driver.ts mapNormalizedEvent 的 thinking 分支对齐（统一投影范式）。
      if (result.reasoning) {
        yield {
          kind: 'thinking_delta',
          executionId,
          timestamp: Date.now(),
          data: { text: result.reasoning },
        };
      }

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
