import { genId } from '../../utils/id.js';
import type { AppEvents } from '../../lib/event-bus.js';
import { PluginRepository } from './plugin.repository.js';
import type { Plugin, PluginTool } from './plugin.repository.js';

export interface CreatePluginInput {
  name: string;
  description?: string;
  scope?: 'private' | 'workspace' | 'global';
  ownerAgentId?: string;
  workspaceId?: string;
  userId: string;
  source?: 'bundled' | 'evolved' | 'user' | 'installed' | 'mcp-bridge';
  riskLevel?: 'low' | 'medium' | 'high';
  promptContent?: string;
  manifestJson?: unknown;
  tags?: string[];
}

export interface AddToolInput {
  pluginId: string;
  toolName: string;
  title: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  permissionScope?: 'readonly' | 'workspace' | 'network' | 'dangerous';
}

export class PluginService {
  constructor(
    private repo: PluginRepository,
    private events: AppEvents,
  ) {}

  create(input: CreatePluginInput): Plugin {
    const id = genId();
    const now = new Date();
    const plugin = {
      id,
      name: input.name,
      version: 1,
      description: input.description ?? null,
      scope: input.scope ?? 'private',
      ownerAgentId: input.ownerAgentId ?? null,
      workspaceId: input.workspaceId ?? null,
      userId: input.userId,
      source: input.source ?? 'evolved',
      riskLevel: input.riskLevel ?? 'low',
      status: 'draft',
      hasPrompt: input.promptContent ? 1 : 0,
      hasTools: 0,
      hasCode: 0,
      hasHooks: 0,
      hasService: 0,
      promptContent: input.promptContent ?? null,
      promptPriority: 0.5,
      promptActivationRules: null,
      manifestJson: (input.manifestJson ?? null) as any,
      permissionsJson: null,
      evolutionJson: null,
      importance: 0.6,
      useCount: 0,
      successCount: 0,
      failureCount: 0,
      lastUsedAt: null,
      previousVersions: null,
      promotedFromId: null,
      promotedAt: null,
      tags: (input.tags ?? null) as any,
      createdAt: now,
      updatedAt: now,
    };
    this.repo.insert(plugin);
    this.events.emit('plugin.created', { pluginId: id });
    return plugin as Plugin;
  }

  getById(id: string): Plugin | undefined {
    return this.repo.findById(id);
  }

  listByWorkspace(workspaceId: string): Plugin[] {
    return this.repo.findByWorkspace(workspaceId);
  }

  enable(id: string): void {
    this.repo.update(id, { status: 'enabled' });
    this.events.emit('plugin.enabled', { pluginId: id });
  }

  disable(id: string): void {
    this.repo.update(id, { status: 'disabled' });
    this.events.emit('plugin.disabled', { pluginId: id });
  }

  addTool(input: AddToolInput): PluginTool {
    const id = genId();
    const tool = {
      id,
      pluginId: input.pluginId,
      toolName: input.toolName,
      title: input.title,
      description: input.description ?? null,
      inputSchema: input.inputSchema as any,
      outputSchema: (input.outputSchema ?? null) as any,
      permissionScope: input.permissionScope ?? 'readonly',
      createdAt: new Date(),
    };
    this.repo.insertTool(tool);
    this.repo.update(input.pluginId, { hasTools: 1 });
    return tool as PluginTool;
  }

  getTools(pluginId: string): PluginTool[] {
    return this.repo.findTools(pluginId);
  }

  bindToAgent(agentId: string, pluginId: string, source: string): void {
    this.repo.insertBinding({
      id: genId(),
      agentId,
      pluginId,
      source,
      enabled: 1,
      pinned: 0,
      configJson: null,
      assignedBy: null,
      createdAt: new Date(),
    });
  }

  unbindFromAgent(agentId: string, pluginId: string): void {
    this.repo.deleteBinding(agentId, pluginId);
  }

  recordUsage(pluginId: string, success: boolean): void {
    const plugin = this.repo.findById(pluginId);
    if (!plugin) return;
    const updates: Record<string, unknown> = {
      useCount: plugin.useCount + 1,
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    };
    if (success) updates.successCount = plugin.successCount + 1;
    else updates.failureCount = plugin.failureCount + 1;
    this.repo.update(pluginId, updates as any);
  }
}
