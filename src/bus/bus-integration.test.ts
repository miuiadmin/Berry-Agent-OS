import { describe, it, expect, beforeEach } from 'vitest';
import { CapabilityBus } from './capability-bus.js';
import { PermissionGate } from './permission-gate.js';
import { registerToolsAsBusCapabilities } from './tool-adapter.js';
import { registerPluginToolsAsBusCapabilities } from './plugin-adapter.js';
import type { ToolDefinition } from '../tools/types.js';
import type { InvokeContext } from './contract.js';
import { z } from 'zod';

function makeCtx(overrides?: Partial<InvokeContext>): InvokeContext {
  return {
    callChain: [],
    sessionId: 'test-session',
    correlationId: 'test-corr',
    ...overrides,
  };
}

describe('Bus Integration', () => {
  let bus: CapabilityBus;

  beforeEach(() => {
    bus = new CapabilityBus();
  });

  describe('Tool Adapter', () => {
    it('registers ToolDefinition[] as Bus capabilities', () => {
      const tools: ToolDefinition[] = [
        {
          name: 'test_echo',
          description: 'Echoes input',
          inputSchema: z.object({ text: z.string() }),
          dangerLevel: 'safe',
          execute: async (input: any) => ({ content: `echo: ${input.text}`, isError: false }),
        },
        {
          name: 'test_dangerous',
          description: 'A dangerous tool',
          inputSchema: z.object({}),
          dangerLevel: 'dangerous',
          execute: async () => ({ content: 'ran', isError: false }),
        },
      ];

      registerToolsAsBusCapabilities(bus, tools);

      expect(bus.has('test_echo')).toBe(true);
      expect(bus.has('test_dangerous')).toBe(true);

      const safe = bus.discover({ dangerLevel: 'safe' });
      expect(safe.some(c => c.name === 'test_echo')).toBe(true);

      const dangerous = bus.discover({ dangerLevel: 'dangerous' });
      expect(dangerous.some(c => c.name === 'test_dangerous')).toBe(true);
    });

    it('invokes tool via Bus and returns result', async () => {
      const tools: ToolDefinition[] = [{
        name: 'greet',
        description: 'Greets',
        inputSchema: z.object({ name: z.string() }),
        dangerLevel: 'safe',
        execute: async (input: any) => ({ content: `Hello, ${input.name}!`, isError: false }),
      }];

      registerToolsAsBusCapabilities(bus, tools);
      const result = await bus.invoke('greet', { name: 'World' }, makeCtx());

      expect(result.ok).toBe(true);
      expect(result.data).toBe('Hello, World!');
      expect(result.provider.type).toBe('builtin');
    });

    it('tool errors surface as invoke failures', async () => {
      const tools: ToolDefinition[] = [{
        name: 'fail_tool',
        description: 'Always fails',
        inputSchema: z.object({}),
        dangerLevel: 'safe',
        execute: async () => ({ content: 'Something went wrong', isError: true }),
      }];

      registerToolsAsBusCapabilities(bus, tools);
      const result = await bus.invoke('fail_tool', {}, makeCtx());

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Something went wrong');
    });
  });

  describe('Plugin Adapter', () => {
    it('registers plugin tools as Bus capabilities with namespaced names', () => {
      const pluginTools = [
        { pluginName: 'weather', toolName: 'get_forecast', description: 'Get weather', dangerLevel: 'safe' as const },
        { pluginName: 'weather', toolName: 'set_alert', description: 'Set alert', dangerLevel: 'moderate' as const },
      ];

      const invoker = { invoke: async () => ({ temp: 22 }) };
      registerPluginToolsAsBusCapabilities(bus, pluginTools, invoker);

      expect(bus.has('plugin:weather:get_forecast')).toBe(true);
      expect(bus.has('plugin:weather:set_alert')).toBe(true);

      const descriptor = bus.getDescriptor('plugin:weather:get_forecast');
      expect(descriptor?.provider.type).toBe('plugin');
      expect(descriptor?.provider.name).toBe('weather');
    });

    it('invokes plugin capability through Bus', async () => {
      const pluginTools = [
        { pluginName: 'calc', toolName: 'add', description: 'Add numbers' },
      ];
      const invoker = {
        invoke: async (_plugin: string, _tool: string, input: unknown) => {
          const { a, b } = input as { a: number; b: number };
          return { result: a + b };
        },
      };

      registerPluginToolsAsBusCapabilities(bus, pluginTools, invoker);
      const result = await bus.invoke('plugin:calc:add', { a: 3, b: 4 }, makeCtx());

      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ result: 7 });
    });
  });

  describe('Permission Gate Integration', () => {
    it('Brain judge blocks dangerous capabilities', async () => {
      const gate = new PermissionGate();
      gate.setBrainJudge({
        requestJudge: async (input) => {
          if (input.capabilityName === 'delete_all') {
            return { allowed: false, reason: 'Too dangerous' };
          }
          return { allowed: true, reason: 'OK' };
        },
      });
      bus.setPermissionGate(gate);

      bus.register(
        { name: 'delete_all', description: 'Deletes everything', dangerLevel: 'dangerous', provider: { type: 'builtin', name: 'test' } },
        async () => 'deleted',
      );
      bus.register(
        { name: 'read_config', description: 'Reads config', dangerLevel: 'moderate', provider: { type: 'builtin', name: 'test' } },
        async () => 'config data',
      );

      const blocked = await bus.invoke('delete_all', {}, makeCtx());
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toContain('Permission denied');

      const allowed = await bus.invoke('read_config', {}, makeCtx());
      expect(allowed.ok).toBe(true);
      expect(allowed.data).toBe('config data');
    });

    it('Permission Gate auto-allows when no Brain judge configured', async () => {
      const gate = new PermissionGate();
      bus.setPermissionGate(gate);

      bus.register(
        { name: 'moderate_op', description: 'Moderate operation', dangerLevel: 'moderate', provider: { type: 'builtin', name: 'test' } },
        async () => 'done',
      );

      const result = await bus.invoke('moderate_op', {}, makeCtx());
      expect(result.ok).toBe(true);
    });

    it('Permission Gate denies dangerous when no Brain judge configured', async () => {
      const gate = new PermissionGate();
      bus.setPermissionGate(gate);

      bus.register(
        { name: 'dangerous_op', description: 'Dangerous', dangerLevel: 'dangerous', provider: { type: 'builtin', name: 'test' } },
        async () => 'should not run',
      );

      const result = await bus.invoke('dangerous_op', {}, makeCtx());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('requires Brain judge');
    });
  });

  describe('Full Pipeline', () => {
    it('pipeline chains tools end-to-end', async () => {
      bus.register(
        { name: 'parse_input', description: 'Parse', dangerLevel: 'safe', provider: { type: 'builtin', name: 'test' } },
        async (input) => ({ parsed: true, value: input }),
      );
      bus.register(
        { name: 'transform', description: 'Transform', dangerLevel: 'safe', provider: { type: 'builtin', name: 'test' } },
        async (input: any) => ({ ...input, transformed: true }),
      );
      bus.register(
        { name: 'format_output', description: 'Format', dangerLevel: 'safe', provider: { type: 'builtin', name: 'test' } },
        async (input: any) => `Result: parsed=${input.parsed}, transformed=${input.transformed}`,
      );

      const result = await bus.pipeline('hello', ['parse_input', 'transform', 'format_output'], makeCtx());
      expect(result.ok).toBe(true);
      expect(result.data).toBe('Result: parsed=true, transformed=true');
    });

    it('invokeAll runs capabilities in parallel and returns all results', async () => {
      bus.register(
        { name: 'fast', description: 'Fast', dangerLevel: 'safe', provider: { type: 'builtin', name: 'test' } },
        async () => 'fast_result',
      );
      bus.register(
        { name: 'slow', description: 'Slow', dangerLevel: 'safe', provider: { type: 'builtin', name: 'test' } },
        async () => { await new Promise(r => setTimeout(r, 50)); return 'slow_result'; },
      );

      const results = await bus.invokeAll([
        { name: 'fast', input: {} },
        { name: 'slow', input: {} },
      ], makeCtx());

      expect(results).toHaveLength(2);
      expect(results[0].data).toBe('fast_result');
      expect(results[1].data).toBe('slow_result');
    });
  });
});
