import type { Database } from 'better-sqlite3';
import { SkillsRegistry } from '../skills/index.js';
import { PluginRegistry } from '../plugins/index.js';
import type { CapabilityRequestPayload } from '../contracts/capabilities.js';
import type { ICapabilityService } from './contract.js';

export class CapabilityService implements ICapabilityService {
  constructor(private readonly db: Database) {}

  handle(request: CapabilityRequestPayload): unknown {
    switch (request.action) {
      case 'capability.skills.list':
        return new SkillsRegistry(this.db).list();
      case 'capability.plugins.list':
        return new PluginRegistry(this.db).list();
      case 'capability.plugins.inspect':
        return new PluginRegistry(this.db).inspect(requiredName(request.payload));
      case 'capability.plugins.validate':
        return new PluginRegistry(this.db).validate(requiredName(request.payload));
      case 'capability.plugins.dry_run': {
        const payload = request.payload;
        const name = requiredName(payload);
        const tool = typeof payload.tool === 'string' ? payload.tool : '';
        if (!tool) throw new Error('缺少插件工具名称');
        const input = typeof payload.input === 'object' && payload.input !== null && !Array.isArray(payload.input)
          ? payload.input as Record<string, unknown>
          : {};
        return new PluginRegistry(this.db).dryRun(name, tool, input);
      }
      default:
        throw new Error(`未知能力请求: ${(request as { action?: string }).action}`);
    }
  }
}

function requiredName(payload: Record<string, unknown>): string {
  if (typeof payload.name !== 'string' || !payload.name) {
    throw new Error('缺少名称');
  }
  return payload.name;
}
