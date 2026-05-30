import type { Database } from 'better-sqlite3';
import type { PluginRecord, ResolvedPluginSet } from '../contracts/plugins-v2.js';
import { PluginRegistryV2 } from './registry-v2.js';

export interface ScopeResolverDeps {
  db: Database;
  registry?: PluginRegistryV2;
}

export class ScopeResolver {
  private readonly registry: PluginRegistryV2;

  constructor(deps: ScopeResolverDeps) {
    this.registry = deps.registry ?? new PluginRegistryV2(deps.db);
  }

  resolve(agentId: string, workspaceId: string, userId: string): ResolvedPluginSet {
    return this.registry.getForAgent(agentId, workspaceId, userId);
  }

  resolveForFacet(
    agentId: string,
    workspaceId: string,
    userId: string,
    facet: keyof Omit<ResolvedPluginSet, 'all'>,
  ): PluginRecord[] {
    const set = this.resolve(agentId, workspaceId, userId);
    return set[facet];
  }
}
