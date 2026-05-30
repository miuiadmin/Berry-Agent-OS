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
