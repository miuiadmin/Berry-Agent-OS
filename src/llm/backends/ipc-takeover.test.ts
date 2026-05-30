import { describe, it, expect, vi } from 'vitest';
import { IpcTakeoverBackend } from './ipc-takeover.js';
import type { IpcChildChannel } from '../../kernel/ipc.js';
import type { ModelRequest } from '../../contracts/model.js';

function createMockIpc(responsePayload: any): IpcChildChannel {
  return {
    send: vi.fn(),
    request: vi.fn().mockResolvedValue({ payload: responsePayload }),
    onMessage: vi.fn(),
    destroy: vi.fn(),
  } as unknown as IpcChildChannel;
}

function makeRequest(): ModelRequest {
  return {
    id: 'req_1',
    agent: 'code',
    purpose: 'edit',
    modelTier: 'default',
    mode: 'takeover',
    backend: 'ipc_takeover',
    apiKind: 'standard',
    sessionId: 'ses_1',
    correlationId: 'corr_1',
    stepIndex: 0,
    messages: [{ role: 'user', content: 'hi' }],
    options: {},
    promptHash: 'hash',
    system: 'you are helpful',
    tools: [{ name: 'read', description: 'Read file', inputSchema: { type: 'object' } }],
  } as ModelRequest;
}

describe('IpcTakeoverBackend', () => {
  it('sends correct payload to IPC and maps response', async () => {
    const ipc = createMockIpc({
      content: 'hello from takeover',
      stopReason: 'end_turn',
      toolCalls: [],
    });

    const backend = new IpcTakeoverBackend(ipc, 'takeover-model');
    const response = await backend.chat(makeRequest());

    expect(response.requestId).toBe('req_1');
    expect(response.content).toBe('hello from takeover');
    expect(response.stopReason).toBe('end_turn');
    expect(response.model).toBe('takeover-model');
    expect(response.contentBlocks).toEqual([{ type: 'text', text: 'hello from takeover' }]);

    expect(ipc.request).toHaveBeenCalledWith(
      'model.takeover.request',
      'core',
      expect.objectContaining({
        requestId: 'req_1',
        agent: 'code',
        purpose: 'edit',
      }),
      60000,
    );
  });

  it('maps tool calls in response', async () => {
    const ipc = createMockIpc({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'read', input: { path: '/tmp' } }],
    });

    const backend = new IpcTakeoverBackend(ipc);
    const response = await backend.chat(makeRequest());

    expect(response.toolCalls).toEqual([{ id: 'tc_1', name: 'read', input: { path: '/tmp' } }]);
    expect(response.contentBlocks).toEqual([
      { type: 'tool_use', id: 'tc_1', name: 'read', input: { path: '/tmp' } },
    ]);
  });

  it('throws when response contains error', async () => {
    const ipc = createMockIpc({
      error: 'Takeover session expired',
    });

    const backend = new IpcTakeoverBackend(ipc);
    await expect(backend.chat(makeRequest())).rejects.toThrow('Takeover session expired');
  });

  it('getModel returns configured model', () => {
    const ipc = createMockIpc({});
    const backend = new IpcTakeoverBackend(ipc, 'custom-model');
    expect(backend.getModel()).toBe('custom-model');
  });

  it('uses custom timeout', async () => {
    const ipc = createMockIpc({ content: 'ok' });
    const backend = new IpcTakeoverBackend(ipc, 'model', 30000);
    await backend.chat(makeRequest());

    expect(ipc.request).toHaveBeenCalledWith(
      'model.takeover.request',
      'core',
      expect.anything(),
      30000,
    );
  });
});
