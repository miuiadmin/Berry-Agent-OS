import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getAppHome } from '../utils/paths.js';
import { getLogger } from '../utils/logger.js';
import type { AgentManifest } from '../agents/manifest.js';

const logger = getLogger('agent-home');

export interface AgentHomePaths {
  home: string;
  agentYaml: string;
  agentMd: string;
  capabilities: string;
  stateDb: string;
  runtime: string;
  tasks: string;
  cache: string;
  logs: string;
}

export function getAgentHomePath(name: string): string {
  return join(getAppHome(), 'agents', name);
}

export function canAgentAccessPath(agentName: string, targetPath: string, allAgentNames: string[]): boolean {
  const agentsRoot = resolve(getAppHome(), 'agents');
  const ownHome = resolve(getAgentHomePath(agentName));
  const target = resolve(targetPath);

  if (!target.startsWith(agentsRoot + '/')) {
    return true;
  }
  if (target === ownHome || target.startsWith(ownHome + '/')) {
    return true;
  }

  for (const other of allAgentNames) {
    if (other === agentName) continue;
    const otherHome = resolve(getAgentHomePath(other));
    const protectedPaths = [
      resolve(otherHome, 'state.db'),
      resolve(otherHome, 'tasks'),
      resolve(otherHome, 'cache'),
      resolve(otherHome, 'runtime'),
      resolve(otherHome, 'logs'),
    ];
    if (protectedPaths.some((protectedPath) => target === protectedPath || target.startsWith(protectedPath + '/'))) {
      return false;
    }
  }

  return true;
}

export function assertAgentCanAccessPath(agentName: string, targetPath: string, allAgentNames: string[]): void {
  if (!canAgentAccessPath(agentName, targetPath, allAgentNames)) {
    throw new Error(`Agent ${agentName} 禁止访问其他 Agent 的私有工作目录: ${targetPath}`);
  }
}

export function ensureAgentHome(manifest: AgentManifest): AgentHomePaths {
  const home = getAgentHomePath(manifest.name);

  const paths: AgentHomePaths = {
    home,
    agentYaml: join(home, 'agent.yaml'),
    agentMd: join(home, 'AGENT.md'),
    capabilities: join(home, 'capabilities.json'),
    stateDb: join(home, 'state.db'),
    runtime: join(home, 'runtime'),
    tasks: join(home, 'tasks'),
    cache: join(home, 'cache'),
    logs: join(home, 'logs'),
  };

  mkdirSync(paths.runtime, { recursive: true });
  mkdirSync(paths.tasks, { recursive: true });
  mkdirSync(paths.cache, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });

  if (!existsSync(paths.agentYaml)) {
    writeFileSync(paths.agentYaml, buildAgentYaml(manifest));
  }

  if (!existsSync(paths.agentMd)) {
    writeFileSync(paths.agentMd, buildAgentMd(manifest));
  }

  if (!existsSync(paths.capabilities)) {
    const capabilities = buildCapabilities(manifest);
    writeFileSync(paths.capabilities, JSON.stringify(capabilities, null, 2));
  }

  return paths;
}

export function getAgentHomeDbRow(manifest: AgentManifest) {
  const paths = ensureAgentHome(manifest);
  const configHash = computeFileHash(paths.agentYaml);
  const capabilitiesHash = computeFileHash(paths.capabilities);

  return {
    agentName: manifest.name,
    level: manifest.level,
    homeDir: paths.home,
    agentYamlPath: paths.agentYaml,
    agentMdPath: paths.agentMd,
    capabilitiesPath: paths.capabilities,
    stateDbPath: paths.stateDb,
    runtimeDir: paths.runtime,
    tasksDir: paths.tasks,
    cacheDir: paths.cache,
    logsDir: paths.logs,
    configHash,
    capabilitiesHash,
  };
}

function buildAgentYaml(manifest: AgentManifest): string {
  return `name: ${manifest.name}
level: ${manifest.level}
description: ${manifest.description}
task_types:
${manifest.taskTypes.map((t) => `  - ${t}`).join('\n')}
`;
}

function buildAgentMd(manifest: AgentManifest): string {
  return `# ${manifest.name} Agent

${manifest.description}

## 指令

> 此文件可人工编辑，修改后重启 Agent 生效。
`;
}

function buildCapabilities(manifest: AgentManifest) {
  return {
    name: manifest.name,
    level: manifest.level,
    taskTypes: manifest.taskTypes,
    tools: [] as string[],
    permissions: [] as string[],
  };
}

function computeFileHash(path: string): string {
  try {
    const content = readFileSync(path, 'utf-8');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch (err) {
    logger.debug({ err, path }, '文件哈希计算失败');
    return '';
  }
}
