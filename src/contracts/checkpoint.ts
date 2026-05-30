export type ErrorType = 'transient' | 'permanent' | 'resource' | 'timeout';

export type ResumeStrategy = 'continue' | 'retry_last' | 'restart';

export interface ExecutionCheckpoint {
  taskId: string;
  executionId: string;
  stepIndex: number;
  messages: Array<{ role: string; content: string }>;
  toolState: Array<{
    name: string;
    callId: string;
    status: 'completed' | 'pending';
    output?: string;
  }>;
  lastOutput: string;
  metrics: {
    tokenUsed: { input: number; output: number };
    toolCallCount: number;
    durationMs: number;
  };
  savedAt: number;
}

export interface ResumeDecision {
  strategy: ResumeStrategy;
  reason: string;
  checkpoint?: ExecutionCheckpoint;
}

export interface ResumeRequest {
  taskId: string;
  strategy?: ResumeStrategy;
  guidance?: string;
}

export interface ResumeResult {
  success: boolean;
  newTaskId?: string;
  error?: string;
}

export const MAX_RESUME_COUNT = 3;
export const CHECKPOINT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
