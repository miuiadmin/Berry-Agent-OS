import type {
  RuntimeProvider,
  AgentRuntime,
  RuntimeCapabilities,
  ProviderConfig,
} from '../../contracts/agent-runtime.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('runtime-registry');

export class RuntimeRegistry {
  private drivers = new Map<RuntimeProvider, AgentRuntime>();
  private dynamicFactories = new Map<RuntimeProvider, (config: ProviderConfig) => AgentRuntime>();

  register(provider: RuntimeProvider, runtime: AgentRuntime): void {
    this.drivers.set(provider, runtime);
    logger.info({ provider, name: runtime.name }, 'Runtime registered');
  }

  registerFactory(provider: RuntimeProvider, factory: (config: ProviderConfig) => AgentRuntime): void {
    this.dynamicFactories.set(provider, factory);
    logger.info({ provider }, 'Runtime factory registered');
  }

  get(provider: RuntimeProvider): AgentRuntime | undefined {
    return this.drivers.get(provider);
  }

  getOrThrow(provider: RuntimeProvider): AgentRuntime {
    const runtime = this.drivers.get(provider);
    if (!runtime) {
      throw new Error(`No runtime registered for provider: ${provider}`);
    }
    return runtime;
  }

  has(provider: RuntimeProvider): boolean {
    return this.drivers.has(provider) || this.dynamicFactories.has(provider);
  }

  list(): Array<{ provider: RuntimeProvider; name: string; capabilities: RuntimeCapabilities }> {
    const result: Array<{ provider: RuntimeProvider; name: string; capabilities: RuntimeCapabilities }> = [];
    for (const [provider, runtime] of this.drivers) {
      result.push({ provider, name: runtime.name, capabilities: runtime.getCapabilities() });
    }
    return result;
  }

  resolveForAgent(row: { provider?: string | null; provider_config?: string }): AgentRuntime | null {
    if (!row.provider) return null;

    const provider = row.provider as RuntimeProvider;
    const existing = this.drivers.get(provider);
    if (existing) return existing;

    const factory = this.dynamicFactories.get(provider);
    if (factory && row.provider_config) {
      try {
        const config: ProviderConfig = JSON.parse(row.provider_config);
        return factory(config);
      } catch (err) {
        logger.warn({ provider, err }, 'Failed to create dynamic runtime from config');
        return null;
      }
    }

    return null;
  }
}
