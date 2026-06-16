/**
 * 16.0 §17.4 delegation-orchestrator 巨石拆解——Brain 事件中继提取。
 * ①② 议会拆分后：brain(orchestrator) 与 ②reviewer 是两个独立子进程，各自经 IPC 边界中继事件到 core：
 *   - brain(orchestrator) 发的 observe/intervene/checker 事件 → attachOrchestratorEventRelay（brain.ipc）
 *   - ②reviewer 发的 cron review 标记 + 接收 cron.review 审核 → attachReviewerCronRelay（reviewer.ipc）
 *
 * 幂等性由调用方传入的 relayRegistry（WeakSet）保证——agent 崩溃重启后新 IPC 不在 registry → 重挂。
 */

import type { IpcChannel } from '../ipc.js';
import type { AgentRegistry } from '../agent-registry.js';
import type { EventPayload } from '../event-bus.js';
import { getEventBus } from '../event-bus.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('orchestrator');

/**
 * 挂载 brain(orchestrator) 子进程的事件中继（幂等）。
 * inbound：brain 的 observe/intervene/checker 事件 → core EventBus。
 *   - brain.signal_intervention：orchestrator 订阅后注入 turn.correction 软纠偏
 *   - brain.checker.dispatch：orchestrator 订阅后派发 checker 独立审核
 */
export function attachOrchestratorEventRelay(
  orchestratorIpc: IpcChannel,
  relayRegistry: WeakSet<object>,
): void {
  if (relayRegistry.has(orchestratorIpc)) return;
  relayRegistry.add(orchestratorIpc);
  const bus = getEventBus();

  // brain(orchestrator) → core：observe/intervene/checker 事件
  orchestratorIpc.onMessage('brain.signal_intervention', (msg) => {
    bus.emit('brain.signal_intervention', msg.payload as EventPayload<'brain.signal_intervention'>);
  });
  orchestratorIpc.onMessage('brain.checker.dispatch', (msg) => {
    bus.emit('brain.checker.dispatch', msg.payload as EventPayload<'brain.checker.dispatch'>);
  });
}

/**
 * 挂载 ②reviewer 子进程的 cron review 中继（幂等）。
 * inbound：②reviewer 的 cron_review_flagged → core EventBus（ws-event-bridge 转发前端）。
 * outbound：core 的 cron.review → 转发 IPC 给 ②reviewer 审核。
 */
export function attachReviewerCronRelay(
  reviewerIpc: IpcChannel,
  relayRegistry: WeakSet<object>,
  registry: AgentRegistry,
): void {
  if (relayRegistry.has(reviewerIpc)) return;
  relayRegistry.add(reviewerIpc);
  const bus = getEventBus();

  // ②reviewer → core：cron 审核标记
  reviewerIpc.onMessage('brain.cron_review_flagged', (msg) => {
    bus.emit('brain.cron_review_flagged', msg.payload as EventPayload<'brain.cron_review_flagged'>);
  });

  // core → ②reviewer：CronScheduler 在 core 发 cron.review，转发 IPC 给 ②reviewer 审核
  const reviewerName = registry.requireRole('reviewer').manifest.name;
  bus.on('cron.review', (payload) => {
    const sent = reviewerIpc.send('cron.review', reviewerName, payload);
    if (!sent) {
      logger.debug({ taskId: payload.taskId }, 'cron.review → reviewer IPC 发送失败（reviewer 可能未就绪），跳过审核');
    }
  });
}
