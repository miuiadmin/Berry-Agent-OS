import { eq, and } from 'drizzle-orm';
import type { AppDb } from '../../db/client.js';
import { plugins, pluginTools, pluginHooks, agentPluginBindings } from '../../db/schema/plugins.js';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

export type Plugin = InferSelectModel<typeof plugins>;
export type NewPlugin = InferInsertModel<typeof plugins>;
export type PluginTool = InferSelectModel<typeof pluginTools>;
export type PluginHook = InferSelectModel<typeof pluginHooks>;
export type PluginBinding = InferSelectModel<typeof agentPluginBindings>;

export class PluginRepository {
  constructor(private db: AppDb) {}

  findById(id: string): Plugin | undefined {
    return this.db.select().from(plugins).where(eq(plugins.id, id)).get();
  }

  findByWorkspace(workspaceId: string): Plugin[] {
    return this.db.select().from(plugins).where(eq(plugins.workspaceId, workspaceId)).all();
  }

  findByUser(userId: string): Plugin[] {
    return this.db.select().from(plugins).where(eq(plugins.userId, userId)).all();
  }

  insert(plugin: NewPlugin): void {
    this.db.insert(plugins).values(plugin).run();
  }

  update(id: string, data: Partial<Omit<NewPlugin, 'id'>>): void {
    this.db.update(plugins).set(data).where(eq(plugins.id, id)).run();
  }

  delete(id: string): void {
    this.db.delete(plugins).where(eq(plugins.id, id)).run();
  }

  // Tools
  findTools(pluginId: string): PluginTool[] {
    return this.db.select().from(pluginTools).where(eq(pluginTools.pluginId, pluginId)).all();
  }

  insertTool(tool: InferInsertModel<typeof pluginTools>): void {
    this.db.insert(pluginTools).values(tool).run();
  }

  // Hooks
  findHooks(pluginId: string): PluginHook[] {
    return this.db.select().from(pluginHooks).where(eq(pluginHooks.pluginId, pluginId)).all();
  }

  insertHook(hook: InferInsertModel<typeof pluginHooks>): void {
    this.db.insert(pluginHooks).values(hook).run();
  }

  // Bindings
  findBindings(agentId: string): PluginBinding[] {
    return this.db.select().from(agentPluginBindings).where(eq(agentPluginBindings.agentId, agentId)).all();
  }

  insertBinding(binding: InferInsertModel<typeof agentPluginBindings>): void {
    this.db.insert(agentPluginBindings).values(binding).run();
  }

  deleteBinding(agentId: string, pluginId: string): void {
    this.db.delete(agentPluginBindings)
      .where(and(eq(agentPluginBindings.agentId, agentId), eq(agentPluginBindings.pluginId, pluginId)))
      .run();
  }
}
