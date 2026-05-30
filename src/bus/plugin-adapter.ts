import type { CapabilityBus } from './capability-bus.js';
import type { CapabilityDescriptor, CapabilityExecutor, DangerLevel } from './contract.js';

export interface PluginToolInfo {
  pluginName: string;
  toolName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  dangerLevel?: DangerLevel;
}

export interface IPluginInvoker {
  invoke(pluginName: string, toolName: string, input: unknown): Promise<unknown>;
}

export function registerPluginToolsAsBusCapabilities(
  bus: CapabilityBus,
  tools: PluginToolInfo[],
  invoker: IPluginInvoker,
): void {
  for (const tool of tools) {
    const capabilityName = `plugin:${tool.pluginName}:${tool.toolName}`;
    if (bus.has(capabilityName)) continue;

    const descriptor: CapabilityDescriptor = {
      name: capabilityName,
      description: `[Plugin: ${tool.pluginName}] ${tool.description}`,
      dangerLevel: tool.dangerLevel ?? 'moderate',
      provider: { type: 'plugin', name: tool.pluginName },
      metadata: { toolName: tool.toolName },
    };

    const executor: CapabilityExecutor = async (input) => {
      return invoker.invoke(tool.pluginName, tool.toolName, input);
    };

    bus.register(descriptor, executor);
  }
}

export function unregisterPluginFromBus(bus: CapabilityBus, pluginName: string): void {
  const prefix = `plugin:${pluginName}:`;
  const toRemove = bus.discover({ providerType: 'plugin' })
    .filter((cap) => cap.name.startsWith(prefix))
    .map((cap) => cap.name);

  for (const name of toRemove) {
    bus.unregister(name);
  }
}
