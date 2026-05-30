import type { AgentRuntime, AgentEvent, ExecutionTask } from '../../contracts/agent-runtime.js';
import type { ExecutionCheckpoint } from '../../contracts/checkpoint.js';
import type { CheckpointService } from '../checkpoint-service.js';
import type { ErrorClassifier } from '../error-classifier.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('runtime-executor');

export class RuntimeExecutor {
  constructor(
    private checkpointService: CheckpointService,
    private errorClassifier: ErrorClassifier,
  ) {}

  async *executeWithCheckpoint(
    runtime: AgentRuntime,
    task: ExecutionTask,
    existingCheckpoint?: ExecutionCheckpoint,
  ): AsyncGenerator<AgentEvent> {
    const effectiveTask = existingCheckpoint
      ? this.buildResumeTask(task, existingCheckpoint)
      : task;

    let stepIndex = existingCheckpoint?.stepIndex ?? 0;
    const messages: Array<{ role: string; content: string }> = [...(existingCheckpoint?.messages ?? [])];
    const toolState: ExecutionCheckpoint['toolState'] = [...(existingCheckpoint?.toolState ?? [])];
    let lastOutput = existingCheckpoint?.lastOutput ?? '';
    let inputTokens = existingCheckpoint?.metrics.tokenUsed.input ?? 0;
    let outputTokens = existingCheckpoint?.metrics.tokenUsed.output ?? 0;
    let toolCallCount = existingCheckpoint?.metrics.toolCallCount ?? 0;
    const startTime = Date.now() - (existingCheckpoint?.metrics.durationMs ?? 0);

    try {
      for await (const event of runtime.execute(effectiveTask)) {
        yield event;

        switch (event.kind) {
          case 'text_delta':
            lastOutput += (event.data.text as string) ?? '';
            break;

          case 'text_done':
            messages.push({ role: 'assistant', content: lastOutput });
            break;

          case 'tool_completed': {
            stepIndex++;
            toolCallCount++;
            toolState.push({
              name: (event.data.name as string) ?? 'unknown',
              callId: (event.data.callId as string) ?? `step-${stepIndex}`,
              status: 'completed',
              output: event.data.output as string | undefined,
            });

            this.checkpointService.saveCheckpoint({
              taskId: task.executionId,
              executionId: task.executionId,
              stepIndex,
              messages,
              toolState,
              lastOutput,
              metrics: {
                tokenUsed: { input: inputTokens, output: outputTokens },
                toolCallCount,
                durationMs: Date.now() - startTime,
              },
              savedAt: Date.now(),
            });

            yield {
              kind: 'checkpoint_saved',
              executionId: task.executionId,
              timestamp: Date.now(),
              data: { stepIndex },
            };
            break;
          }

          case 'tool_failed': {
            stepIndex++;
            toolCallCount++;
            toolState.push({
              name: (event.data.name as string) ?? 'unknown',
              callId: (event.data.callId as string) ?? `step-${stepIndex}`,
              status: 'pending',
              output: event.data.error as string | undefined,
            });

            this.checkpointService.saveCheckpoint({
              taskId: task.executionId,
              executionId: task.executionId,
              stepIndex,
              messages,
              toolState,
              lastOutput,
              metrics: {
                tokenUsed: { input: inputTokens, output: outputTokens },
                toolCallCount,
                durationMs: Date.now() - startTime,
              },
              savedAt: Date.now(),
            });

            yield {
              kind: 'checkpoint_saved',
              executionId: task.executionId,
              timestamp: Date.now(),
              data: { stepIndex },
            };
            break;
          }

          case 'progress': {
            if (event.data.inputTokens) inputTokens = event.data.inputTokens as number;
            if (event.data.outputTokens) outputTokens = event.data.outputTokens as number;
            break;
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorType = this.errorClassifier.classify(errorMsg);

      if (errorType !== 'permanent' && stepIndex > 0) {
        this.checkpointService.markResumable(task.executionId, errorType, errorMsg);
        yield {
          kind: 'execution_failed',
          executionId: task.executionId,
          timestamp: Date.now(),
          data: { error: errorMsg, resumable: true, errorType },
        };
      } else {
        yield {
          kind: 'execution_failed',
          executionId: task.executionId,
          timestamp: Date.now(),
          data: { error: errorMsg, resumable: false, errorType },
        };
      }

      logger.warn({ taskId: task.executionId, errorType, stepIndex }, 'Execution failed');
    }
  }

  private buildResumeTask(task: ExecutionTask, checkpoint: ExecutionCheckpoint): ExecutionTask {
    const contextParts: string[] = [];

    if (task.context) {
      contextParts.push(task.context);
    }

    if (checkpoint.messages.length > 0) {
      contextParts.push('\n--- Previous conversation (resuming from checkpoint) ---');
      for (const msg of checkpoint.messages) {
        contextParts.push(`[${msg.role}]: ${msg.content}`);
      }
      contextParts.push('--- End of previous context ---\n');
    }

    if (checkpoint.lastOutput) {
      contextParts.push(`[Last output before interruption]: ${checkpoint.lastOutput}`);
    }

    return {
      ...task,
      context: contextParts.join('\n'),
    };
  }
}
