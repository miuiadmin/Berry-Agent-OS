/**
 * brain.observe + brain.command.result handler（§17.4 巨石拆解——从 brain/entry.ts 整组提取）。
 *
 * brain.command.result：消费 brain.command 的执行结果 → 记录为观察。
 * brain.observe：记录观察 + 定期 plan 进度检查（调 checkPlanProgress）。
 * observationCounter + PLAN_CHECK_INTERVAL 完全自包含于本模块。
 */

import type { IpcMessage } from '../../../kernel/types.js';
import type { RecordObservationInput, ObservationType } from '../../../kernel/observation-recorder.js';
import { safeSlice } from '../../../utils/safe-slice.js';
import { getLogger } from '../../../utils/logger.js';

/** brain.observe 的 payload 类型（与 entry.ts 内联定义镜像） */
interface BrainObservePayload {
  sessionId: string;
  taskId: string;
  observationType: ObservationType;
  fromAgent: string;
  toAgent?: string;
  content: string;
  priority?: 0 | 1 | 2;
  metadata?: Record<string, unknown>;
}

/** 每 N 次观察触发一次 plan 进度检查 */
const PLAN_CHECK_INTERVAL = 10;

/** deps 注入 */
export interface ObserveHandlerDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  observationRecorder: any;
  /** checkPlanProgress 函数（来自 createPlanMonitor） */
  checkPlanProgress: (sessionId: string, taskId: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipc: any;
}

/**
 * 注册 brain.observe + brain.command.result handler（§17.4 整组提取）。
 * observationCounter Map 完全自包含——entry.ts 不再持有。
 */
export function setupObserveHandler(deps: ObserveHandlerDeps): void {
  const { observationRecorder, checkPlanProgress, ipc } = deps;
  const logger = getLogger('brain-observe');
  const observationCounter = new Map<string, number>();

  // 15.0 机制 D：消费 brain.command 的执行结果 → 记录为观察
  ipc.onMessage('brain.command.result', (msg: IpcMessage) => {
    const result = msg.payload as { success?: boolean; data?: unknown; error?: string };
    try {
      observationRecorder.record({
        sessionId: 'brain-command',
        taskId: msg.correlationId ?? msg.id ?? 'unknown',
        observationType: 'agent_event',
        fromAgent: 'core', toAgent: 'brain',
        content: safeSlice(JSON.stringify(result), 2000),
        priority: 1,
      });
    } catch (err) {
      logger.warn({ err }, 'brain.command.result:record failed');
    }
  });

  // brain.observe：记录观察 + 定期 plan 进度检查
  ipc.onMessage('brain.observe', (msg: IpcMessage) => {
    const payload = msg.payload as BrainObservePayload;
    try {
      const recordInput: RecordObservationInput = {
        sessionId: payload.sessionId, taskId: payload.taskId,
        observationType: payload.observationType,
        fromAgent: payload.fromAgent, toAgent: payload.toAgent,
        content: safeSlice(payload.content, 2000),
        priority: payload.priority ?? 1, metadata: payload.metadata,
      };
      observationRecorder.record(recordInput);
    } catch (err) {
      logger.warn({ err, sessionId: payload.sessionId, taskId: payload.taskId }, 'brain.observe:record failed');
    }

    // §12.5 定期 plan 进度检查（零 LLM，规则化）
    try {
      const count = (observationCounter.get(payload.sessionId) ?? 0) + 1;
      observationCounter.set(payload.sessionId, count);
      if (count >= PLAN_CHECK_INTERVAL) {
        observationCounter.set(payload.sessionId, 0);
        checkPlanProgress(payload.sessionId, payload.taskId);
      }
    } catch (err) {
      logger.warn({ err, sessionId: payload.sessionId }, 'brain.observe:plan-check failed');
    }
  });
}
