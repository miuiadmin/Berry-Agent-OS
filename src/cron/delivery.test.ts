import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeliveryRouter, IpcDeliveryBackend, WebhookDeliveryBackend } from './delivery.js';

describe('DeliveryRouter', () => {
  let router: DeliveryRouter;

  beforeEach(() => {
    router = new DeliveryRouter();
  });

  it('routes to registered backend', async () => {
    const ipc = new IpcDeliveryBackend();
    const sendFn = vi.fn().mockReturnValue(true);
    ipc.setSendFn(sendFn);
    router.register(ipc);

    await router.deliver('ipc', 'code-agent', 'task output');
    expect(sendFn).toHaveBeenCalledWith('code-agent', expect.objectContaining({ output: 'task output' }));
  });

  it('handles missing backend gracefully', async () => {
    await expect(router.deliver('unknown', 'target', 'output')).resolves.toBeUndefined();
  });

  it('throws on delivery failure', async () => {
    const ipc = new IpcDeliveryBackend();
    ipc.setSendFn(() => false);
    router.register(ipc);

    await expect(router.deliver('ipc', 'dead-agent', 'output')).rejects.toThrow('unreachable');
  });

  it('hasBackend returns correct state', () => {
    expect(router.hasBackend('ipc')).toBe(false);
    router.register(new IpcDeliveryBackend());
    expect(router.hasBackend('ipc')).toBe(true);
  });
});

describe('IpcDeliveryBackend', () => {
  it('throws when not configured', async () => {
    const backend = new IpcDeliveryBackend();
    await expect(backend.deliver('agent', 'output')).rejects.toThrow('not configured');
  });

  it('calls sendFn with correct params', async () => {
    const backend = new IpcDeliveryBackend();
    const sendFn = vi.fn().mockReturnValue(true);
    backend.setSendFn(sendFn);

    await backend.deliver('my-agent', 'hello', { taskId: 'cron-1' });
    expect(sendFn).toHaveBeenCalledWith('my-agent', {
      type: 'cron.result',
      output: 'hello',
      taskId: 'cron-1',
    });
  });
});

describe('WebhookDeliveryBackend', () => {
  it('sends POST request to target URL', async () => {
    const backend = new WebhookDeliveryBackend();
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    await backend.deliver('https://hooks.example.com/notify', 'cron output');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.example.com/notify',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    vi.unstubAllGlobals();
  });

  it('throws on non-OK response', async () => {
    const backend = new WebhookDeliveryBackend();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' }));

    await expect(backend.deliver('https://hooks.example.com', 'output')).rejects.toThrow('500');

    vi.unstubAllGlobals();
  });
});
