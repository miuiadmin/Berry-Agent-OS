export { TestHarness, type HarnessOptions, type MessageResult, type LiveContextHook } from './harness.js';
export { LiveTestContext, buildSpanTree, formatDebugDump } from './live-test-context.js';
export { TakeoverController, type PendingModelRequest } from './model-takeover.js';
export { SessionRecorder, SessionReplayer, type SessionRecording, type RecordedExchange } from './session-recorder.js';
export { ParallelTestHarness, type ParallelResult, type TimelineEntry } from './parallel-harness.js';
export { IpcCapture } from './ipc-capture.js';
export { ConsoleCapture, type CapturedOutput } from './console-capture.js';
export { ConversationBuilder, type ConversationResult, type TurnResult } from './conversation-builder.js';
export * from './live-test-types.js';
export {
  createLiveContext,
  sendWithRetry,
  assertTokenBudget,
  assertLatencyBound,
  assertModelCallCount,
  assertNoErrors,
  assertNoLogErrors,
  assertEventOccurred,
  assertStreamingOrder,
  assertTimeToFirstChunk,
  assertStreamHasProgress,
  assertSpanExists,
  assertSpanAttribute,
  assertSpanStatus,
  assertNoErrorSpans,
  assertCounterValue,
  assertHistogramP95,
  assertTaskCompleted,
  assertNoFailedTasks,
  assertTaskDuration,
  assertToolWasCalled,
  assertToolSucceeded,
  assertNoToolErrors,
  assertApprovalGranted,
} from './live-test-helpers.js';
