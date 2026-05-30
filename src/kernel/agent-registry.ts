import { resolve, dirname, join } from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { agentManifestSchema, type AgentManifest, type RegisteredAgent } from '../agents/manifest.js';
import type { AgentRole } from '../contracts/agents.js';
import { getAppHome } from '../utils/paths.js';
import { getLogger } from '../utils/logger.js';
import { parse as parseYaml } from 'yaml';

const logger = getLogger('agent-registry');

export class AgentRegistry {
  private agents = new Map<string, RegisteredAgent>();
  private taskTypeIndex = new Map<string, string>();
  private roleIndex = new Map<AgentRole, string>();
  private disabled = new Set<string>();

  async discover(dirs: { bundled: string; user: string }): Promise<void> {
    this.scanDir(dirs.bundled);
    if (existsSync(dirs.user)) {
      this.scanDir(dirs.user);
    }
  }

  register(manifest: AgentManifest, manifestPath: string): RegisteredAgent {
    if (this.agents.has(manifest.name)) {
      throw new Error(`智能体名称冲突: ${manifest.name} 已注册`);
    }

    const manifestDir = dirname(manifestPath);
    let entryPath: string;

    if (manifest.ipcProtocol === 'generic-loop') {
      // Dynamic agents use the generic-loop bootstrap entry
      entryPath = resolve(dirname(new URL(import.meta.url).pathname), '../agents/generic-loop-entry.ts');
      if (!existsSync(entryPath)) {
        entryPath = entryPath.replace(/\.ts$/, '.js');
      }
    } else {
      const rawEntry = resolve(manifestDir, manifest.entry);
      entryPath = rawEntry.endsWith('.ts') && !existsSync(rawEntry) && existsSync(rawEntry.replace(/\.ts$/, '.js'))
        ? rawEntry.replace(/\.ts$/, '.js')
        : rawEntry;
    }

    const homeDir = join(getAppHome(), 'agents', manifest.name);

    const registered: RegisteredAgent = { manifest, manifestPath, entryPath, homeDir };
    this.agents.set(manifest.name, registered);

    for (const taskType of manifest.taskTypes) {
      if (this.taskTypeIndex.has(taskType)) {
        const existing = this.taskTypeIndex.get(taskType)!;
        logger.warn({ taskType, existing, incoming: manifest.name }, `任务类型冲突: ${taskType} 已由 ${existing} 注册，${manifest.name} 被忽略`);
        continue;
      }
      this.taskTypeIndex.set(taskType, manifest.name);
    }

    for (const role of manifest.roles) {
      if (this.roleIndex.has(role)) {
        const existing = this.roleIndex.get(role)!;
        logger.warn({ role, existing, incoming: manifest.name }, `角色冲突: ${role} 已由 ${existing} 承担，${manifest.name} 被忽略`);
        continue;
      }
      this.roleIndex.set(role, manifest.name);
    }

    return registered;
  }

  get(name: string): RegisteredAgent | undefined {
    return this.agents.get(name);
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  getByTaskType(taskType: string): RegisteredAgent | undefined {
    const name = this.taskTypeIndex.get(taskType);
    if (!name || this.disabled.has(name)) return undefined;
    return this.agents.get(name);
  }

  getByRole(role: AgentRole): RegisteredAgent | undefined {
    const name = this.roleIndex.get(role);
    if (!name || this.disabled.has(name)) return undefined;
    return this.agents.get(name);
  }

  requireRole(role: AgentRole): RegisteredAgent {
    const agent = this.getByRole(role);
    if (!agent) {
      throw new Error(`系统缺少必要角色 ${role}，没有 Agent 声明承担此角色`);
    }
    return agent;
  }

  unregister(name: string): void {
    const agent = this.agents.get(name);
    if (!agent) return;

    for (const taskType of agent.manifest.taskTypes) {
      if (this.taskTypeIndex.get(taskType) === name) {
        this.taskTypeIndex.delete(taskType);
      }
    }
    for (const role of agent.manifest.roles) {
      if (this.roleIndex.get(role) === name) {
        this.roleIndex.delete(role);
      }
    }
    this.agents.delete(name);
    this.disabled.delete(name);
  }

  canUnregister(name: string): { ok: boolean; reason?: string } {
    const agent = this.agents.get(name);
    if (!agent) return { ok: false, reason: `智能体不存在: ${name}` };
    if (agent.manifest.source === 'bundled') {
      return { ok: false, reason: `内置智能体不可移除: ${name}` };
    }
    for (const role of agent.manifest.roles) {
      if (role === 'reviewer' || role === 'primary') {
        return { ok: false, reason: `智能体承担系统关键角色 ${role}，不可移除` };
      }
    }
    return { ok: true };
  }

  disable(name: string): void {
    if (!this.agents.has(name)) throw new Error(`智能体不存在: ${name}`);
    this.disabled.add(name);
  }

  enable(name: string): void {
    if (!this.agents.has(name)) throw new Error(`智能体不存在: ${name}`);
    this.disabled.delete(name);
  }

  isDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  listAll(): RegisteredAgent[] {
    return [...this.agents.values()];
  }

  listResident(): RegisteredAgent[] {
    return this.listAll().filter(a => a.manifest.kind === 'resident');
  }

  listOnDemand(): RegisteredAgent[] {
    return this.listAll().filter(a => a.manifest.kind === 'on-demand');
  }

  getAgentNames(): string[] {
    return [...this.agents.keys()];
  }

  getTaskTypes(): string[] {
    return [...this.taskTypeIndex.keys()];
  }

  validateSystemRoles(): void {
    const requiredRoles: AgentRole[] = ['reviewer', 'primary', 'orchestrator'];
    for (const role of requiredRoles) {
      const agent = this.getByRole(role);
      if (!agent) {
        throw new Error(`系统无法启动: 缺少必要角色 "${role}"，请确保至少一个 Agent 在 manifest 中声明该角色`);
      }
      if (agent.manifest.kind !== 'resident') {
        throw new Error(`系统无法启动: 角色 "${role}" 必须由 resident Agent 承担，但 ${agent.manifest.name} 是 on-demand`);
      }
    }
  }

  async refresh(userDir: string): Promise<RegisteredAgent[]> {
    const newAgents: RegisteredAgent[] = [];
    if (!existsSync(userDir)) return newAgents;

    for (const entry of readdirSync(userDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (this.agents.has(entry.name)) continue;

      const manifestPath = join(userDir, entry.name, 'agent.json');
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest = this.loadManifest(manifestPath);
        const registered = this.register(manifest, manifestPath);
        newAgents.push(registered);
        logger.info({ name: manifest.name }, `发现新 Agent: ${manifest.name}`);
      } catch (err) {
        logger.warn({ err, path: manifestPath }, `刷新时跳过无效 manifest`);
      }
    }

    return newAgents;
  }

  private scanDir(dir: string): void {
    if (!existsSync(dir)) return;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const agentDir = join(dir, entry.name);

      // Try agent.json first, then agent.yaml
      const jsonPath = join(agentDir, 'agent.json');
      const yamlPath = join(agentDir, 'agent.yaml');
      const manifestPath = existsSync(jsonPath) ? jsonPath : existsSync(yamlPath) ? yamlPath : null;
      if (!manifestPath) continue;

      try {
        const manifest = this.loadManifest(manifestPath);
        this.register(manifest, manifestPath);
      } catch (err) {
        logger.error({ err, path: manifestPath }, `加载 Agent manifest 失败: ${manifestPath}`);
      }
    }
  }

  private loadManifest(path: string): AgentManifest {
    const content = readFileSync(path, 'utf-8');
    const raw = path.endsWith('.yaml') || path.endsWith('.yml')
      ? parseYaml(content)
      : JSON.parse(content);
    return agentManifestSchema.parse(raw);
  }
}

export interface AvailableAgent {
  name: string;
  taskTypes: string[];
  description: string;
}

export function buildAvailableAgentsList(registry: AgentRegistry): AvailableAgent[] {
  return registry.listAll()
    .filter(a => !registry.isDisabled(a.manifest.name))
    .map(a => ({
      name: a.manifest.name,
      taskTypes: a.manifest.taskTypes,
      description: a.manifest.description,
    }));
}
