import type { CapabilityBus } from './capability-bus.js';
import type { CapabilityDescriptor, CapabilityExecutor, DangerLevel } from './contract.js';
import type { ToolDefinition } from '../tools/types.js';

export function registerToolsAsBusCapabilities(
  bus: CapabilityBus,
  tools: ToolDefinition[],
): void {
  for (const tool of tools) {
    if (bus.has(tool.name)) continue;

    const descriptor: CapabilityDescriptor = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      dangerLevel: tool.dangerLevel as DangerLevel,
      provider: { type: 'builtin', name: 'tool-registry' },
    };

    const executor: CapabilityExecutor = async (input) => {
      const result = await tool.execute(input);
      if (result.isError) throw new Error(result.content);
      return result.content;
    };

    bus.register(descriptor, executor);
  }
}

export function unregisterToolsFromBus(bus: CapabilityBus, toolNames: string[]): void {
  for (const name of toolNames) {
    bus.unregister(name);
  }
}
