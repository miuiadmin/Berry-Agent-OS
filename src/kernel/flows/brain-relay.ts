/**
 * 16.0 §17.4 delegation-orchestrator 巨石拆解——Brain 事件中继提取。
 *
 * 从 delegation-orchestrator.ts 的 reattachBrainRelay 闭包整组搬出（行为保持，
 * 仅把 this.* 依赖改成显式参数）。Brain 是独立子进程，进程内 EventBus 发不到 core；
 * 这些事件必须经 IPC 边界中继：
 *   - inbound（brain → core）：brain 用 ipc.send 发来 → core re-emit 到 EventBus
 *   - outbound（core → brain）：core 发 cron.review → 转发 IPC 给 Brain 审核
 *
 * 幂等性由调用方传入的 relayRegistry（WeakSet）保证——Brain 崩溃重启后新 IPC 引用
 * 不在 registry 中，会重新挂载（见 orchestrator.onBrainRegistered）。
 */

import type { IpcChannel } from '../ipc.js';
import type { AgentRegistry } from '../agent-registry.js';
import type { EventPayload } from '../event-bus.js';
import { getEventBus } from '../event-bus.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('orchestrator');

/**
 * 挂载 Brain 子进程 ↔ core EventBus 的双向事件中继（幂等：同一 ipc 不重复挂载）。
 *
 * @param brainIpc      Brain（reviewer）进程的 IPC 通道
 * @param relayRegistry 已挂载中继的 IPC 去重集合（WeakSet，brain 重启后新引用不在其中→重挂）
 * @param registry      AgentRegistry——用于按 role('reviewer') 解析 Brain agent 名（outbound 发送目标）
 */
export function attachBrainEventRelay(
  brainIpc: IpcChannel,
  relayRegistry: WeakSet<object>,
  registry: AgentRegistry,
): void {
  // 幂等：同一 IPC 已挂载则跳过
  if (relayRegistry.has(brainIpc)) return;
  relayRegistry.add(brainIpc);
  const bus = getEventBus();

  // ── inbound：Brain → core（brain 用 ipc.send 发来，core re-emit 到 EventBus） ──
  // brain.signal_intervention：delegation-orchestrator 订阅后注入 turn.correction 软纠偏
  brainIpc.onMessage('brain.signal_intervention', (msg) => {
    bus.emit('brain.signal_intervention', msg.payload as EventPayload<'brain.signal_intervention'>);
  });
  // brain.checker.dispatch：delegation-orchestrator 订阅后派发 checker 独立审核
  brainIpc.onMessage('brain.checker.dispatch', (msg) => {
    bus.emit('brain.checker.dispatch', msg.payload as EventPayload<'brain.checker.dispatch'>);
  });
  // brain.cron_review_flagged：ws-event-bridge 订阅后转发前端展示警告
  brainIpc.onMessage('brain.cron_review_flagged', (msg) => {
    bus.emit('brain.cron_review_flagged', msg.payload as EventPayload<'brain.cron_review_flagged'>);
  });

  // ── outbound：core → Brain（CronScheduler 在 core 发 cron.review，转发 IPC 给 Brain 审核） ──
  const brainName = registry.requireRole('reviewer').manifest.name;
  bus.on('cron.review', (payload) => {
    // 发送失败（Brain 未就绪/已退出）静默跳过——cron 审核是 best-effort，不阻塞 cron 流程
    const sent = brainIpc.send('cron.review', brainName, payload);
    if (!sent) {
      logger.debug({ taskId: payload.taskId }, 'cron.review → brain IPC 发送失败（brain 可能未就绪），跳过审核');
    }
  });
}
