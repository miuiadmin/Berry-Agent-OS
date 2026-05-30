import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';

const logger = getLogger('cron-delivery');

export interface DeliveryBackend {
  name: string;
  deliver(target: string, output: string, metadata?: Record<string, unknown>): Promise<void>;
}

export class IpcDeliveryBackend implements DeliveryBackend {
  name = 'ipc';
  private sendFn: ((agentName: string, payload: Record<string, unknown>) => boolean) | null = null;

  setSendFn(fn: (agentName: string, payload: Record<string, unknown>) => boolean): void {
    this.sendFn = fn;
  }

  async deliver(target: string, output: string, metadata?: Record<string, unknown>): Promise<void> {
    if (!this.sendFn) {
      throw new Error('IPC delivery not configured');
    }
    const success = this.sendFn(target, { type: 'cron.result', output, ...metadata });
    if (!success) {
      throw new Error(`IPC delivery failed: agent ${target} unreachable`);
    }
  }
}

export class WebhookDeliveryBackend implements DeliveryBackend {
  name = 'webhook';

  async deliver(target: string, output: string, metadata?: Record<string, unknown>): Promise<void> {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ output, timestamp: Date.now(), ...metadata }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Webhook delivery failed: ${response.status} ${response.statusText}`);
    }
  }
}

export class DeliveryRouter {
  private backends = new Map<string, DeliveryBackend>();

  register(backend: DeliveryBackend): void {
    this.backends.set(backend.name, backend);
  }

  async deliver(channel: string, target: string, output: string, metadata?: Record<string, unknown>): Promise<void> {
    const backend = this.backends.get(channel);
    if (!backend) {
      logger.warn({ channel, target }, 'No delivery backend registered for channel');
      metrics.counter('cron_delivery_total').inc({ channel, status: 'no_backend' });
      return;
    }

    try {
      await backend.deliver(target, output, metadata);
      metrics.counter('cron_delivery_total').inc({ channel, status: 'success' });
      logger.debug({ channel, target }, 'Delivery successful');
    } catch (err) {
      metrics.counter('cron_delivery_total').inc({ channel, status: 'error' });
      logger.error({ channel, target, error: (err as Error).message }, 'Delivery failed');
      throw err;
    }
  }

  hasBackend(channel: string): boolean {
    return this.backends.has(channel);
  }
}
