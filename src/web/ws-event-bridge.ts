import type { WebSocketServer, WebSocket } from 'ws';
import type { EventBus, EventName } from '../contracts/infrastructure.js';

const BRIDGED_EVENTS: EventName[] = [
  'task.created',
  'task.started',
  'task.completed',
  'task.failed',
  'task.timeout',
  'task.cancelled',
  'task.progress',
  'agent.enabled',
  'agent.disabled',
  'agent.crashed',
  'config.reloaded',
  'daemon.connected',
  'daemon.disconnected',
  'daemon.task.progress',
  'daemon.task.completed',
  'daemon.task.failed',
  // Notification events
  'notification.created',
  'notification.read',
  // Scheduler events
  'scheduler.job_enqueued',
  'scheduler.job_claimed',
  'scheduler.job_completed',
  'scheduler.job_failed',
  'scheduler.chain_step_completed',
  'scheduler.chain_approval_pending',
  'scheduler.reminder_fired',
  'scheduler.webhook_received',
  // MCP events
  'mcp.connected',
  'mcp.disconnected',
  'mcp.failed',
  'mcp.tools_changed',
  // Cron events
  'cron.fired',
  'cron.completed',
  'cron.failed',
];

export class WsEventBridge {
  private unsubscribes: Array<() => void> = [];

  constructor(private wss: WebSocketServer, eventBus: EventBus) {
    for (const event of BRIDGED_EVENTS) {
      const unsub = eventBus.on(event, (payload) => {
        const msg = JSON.stringify({ type: 'event', event, payload, ts: Date.now() });
        for (const client of this.wss.clients) {
          if ((client as unknown as { readyState: number }).readyState === 1) {
            (client as WebSocket).send(msg);
          }
        }
      });
      this.unsubscribes.push(unsub);
    }
  }

  dispose(): void {
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes = [];
  }
}
