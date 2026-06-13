import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { setupBusHandlers } from './proxy-handlers.js';
import type { ICapabilityBus, CapabilityDescriptor } from '../../bus/contract.js';
import type { IpcMessage } from '../types.js';

/**
 * 15.0 V-5：setupBusHandlers 的 bus.capabilities.request 路径 inputSchema 修复的表征测试。
 *
 * 修复前：required 分支是恒 {} 的死三元 `cap!.inputSchema ? {} : {}`，discover 分支也恒 {}——
 * 能力真实的 Zod schema 从未抵达 Agent，Agent 拿不到任何入参约束。
 * 修复后：经 descriptorToToolSpec 用 z.toJSONSchema() 转成标准 JSON Schema（与 src/tools/types.ts 同做法）。
 * 本组钉死「schema 真的被转换」「缺省回退」「discover 一致」「bus 缺省返空」四点，防死三元回归。
 */

/** 最小 mock IPC：记录 handler，捕获 send 的 payload。bus.capabilities.request 的 handler 是同步的。 */
function makeFakeIpc() {
  const handlers = new Map<string, (msg: IpcMessage) => void>();
  const sent: Array<{ type: string; payload: { tools?: Array<{ name: string; inputSchema: unknown }> } }> = [];
  const ipc = {
    onMessage: (type: string, handler: (msg: IpcMessage) => void) => {
      handlers.set(type, handler);
    },
    send: (type: string, _to: string, payload: unknown) => {
      sent.push({ type, payload: payload as { tools?: Array<{ name: string; inputSchema: unknown }> } });
      return true;
    },
  };
  return { ipc, handlers, sent };
}

/** 假 capability bus：按 name 取 descriptor，或 discover 全部。 */
function makeFakeBus(caps: CapabilityDescriptor[]): ICapabilityBus {
  const byName = new Map(caps.map((c) => [c.name, c]));
  return {
    getDescriptor: (name: string) => byName.get(name),
    discover: () => caps,
  } as unknown as ICapabilityBus;
}

/** 带真实 Zod schema 的能力（验证转换） */
const withSchema: CapabilityDescriptor = {
  name: 'with-schema',
  description: 'has a zod input schema',
  inputSchema: z.object({ path: z.string() }),
  dangerLevel: 'safe',
  provider: { type: 'builtin', name: 'test' },
};

/** 无 inputSchema 的能力（验证回退） */
const noSchema: CapabilityDescriptor = {
  name: 'no-schema',
  description: 'no input schema',
  dangerLevel: 'safe',
  provider: { type: 'builtin', name: 'test' },
};

type AnyIpcParam = Parameters<typeof setupBusHandlers>[0];

describe('setupBusHandlers bus.capabilities.request (15.0 V-5 inputSchema 修复)', () => {
  it('required 命中带 schema 的能力：inputSchema 转成 JSON Schema（不再是死三元 {}）', () => {
    const { ipc, handlers, sent } = makeFakeIpc();
    setupBusHandlers(ipc as unknown as AnyIpcParam, 'code', makeFakeBus([withSchema]));

    const handler = handlers.get('bus.capabilities.request')!;
    handler({ id: 'm1', payload: { agentName: 'code', required: ['with-schema'] } } as unknown as IpcMessage);

    const resp = sent.find((s) => s.type === 'bus.capabilities.response')!;
    const tool = resp.payload.tools![0];
    expect(tool.name).toBe('with-schema');
    // 修复前断言会失败（恒 {}）；修复后含 zod 转出的 properties.path.type=string
    expect(tool.inputSchema).not.toEqual({});
    expect(tool.inputSchema).toMatchObject({ type: 'object', properties: { path: { type: 'string' } } });
    // $schema 元键应被剔除（与 src/tools/types.ts zodToJsonSchema 一致）
    expect((tool.inputSchema as Record<string, unknown>).$schema).toBeUndefined();
  });

  it('required 命中无 schema 的能力：回退 { type: object }', () => {
    const { ipc, handlers, sent } = makeFakeIpc();
    setupBusHandlers(ipc as unknown as AnyIpcParam, 'code', makeFakeBus([noSchema]));

    const handler = handlers.get('bus.capabilities.request')!;
    handler({ id: 'm1', payload: { agentName: 'code', required: ['no-schema'] } } as unknown as IpcMessage);

    const tool = sent.find((s) => s.type === 'bus.capabilities.response')!.payload.tools![0];
    expect(tool.name).toBe('no-schema');
    expect(tool.inputSchema).toEqual({ type: 'object' });
  });

  it('required 为空 → discover 全部 safe 能力，带/不带 schema 一致处理', () => {
    const { ipc, handlers, sent } = makeFakeIpc();
    setupBusHandlers(ipc as unknown as AnyIpcParam, 'code', makeFakeBus([withSchema, noSchema]));

    const handler = handlers.get('bus.capabilities.request')!;
    handler({ id: 'm1', payload: { agentName: 'code', required: [] } } as unknown as IpcMessage);

    const tools = sent.find((s) => s.type === 'bus.capabilities.response')!.payload.tools!;
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(tools.length).toBe(2);
    // discover 路径同样做 JSON Schema 转换（修复前 discover 恒 {}）
    expect((byName.get('with-schema')!.inputSchema as Record<string, unknown>).properties).toBeDefined();
    expect(byName.get('no-schema')!.inputSchema).toEqual({ type: 'object' });
  });

  it('capabilityBus 为 null → 返回空 tools（fail-soft，不抛）', () => {
    const { ipc, handlers, sent } = makeFakeIpc();
    setupBusHandlers(ipc as unknown as AnyIpcParam, 'code', null);

    const handler = handlers.get('bus.capabilities.request')!;
    handler({ id: 'm1', payload: { agentName: 'code', required: ['with-schema'] } } as unknown as IpcMessage);

    const resp = sent.find((s) => s.type === 'bus.capabilities.response')!;
    expect(resp.payload.tools).toEqual([]);
  });
});
