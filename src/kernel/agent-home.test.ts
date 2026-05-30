import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAppHome, setAppHome } from '../utils/paths.js';
import type { AgentManifest } from '../agents/manifest.js';
import {
  assertAgentCanAccessPath,
  canAgentAccessPath,
  ensureAgentHome,
  getAgentHomePath,
} from './agent-home.js';

function makeManifest(name: string, overrides?: Partial<AgentManifest>): AgentManifest {
  const defaults: Record<string, AgentManifest> = {
    brain: { apiVersion: 'berry.agent.v1', name: 'brain', version: '0.1.0', description: '必经同步审核', level: 1, kind: 'resident', source: 'bundled', taskTypes: ['brain_review'], roles: ['reviewer'], entry: 'entry.ts', ipcProtocol: 'custom', requiresBrainReview: false, dependencies: [], capabilities: {} },
    conversation: { apiVersion: 'berry.agent.v1', name: 'conversation', version: '0.1.0', description: '直接与用户对话', level: 3, kind: 'resident', source: 'bundled', taskTypes: ['conversation_turn'], roles: ['primary', 'plugin-host'], entry: 'entry.ts', ipcProtocol: 'custom', requiresBrainReview: true, dependencies: [], capabilities: {} },
    learning: { apiVersion: 'berry.agent.v1', name: 'learning', version: '0.1.0', description: '发现应该学习的知识', level: 2, kind: 'on-demand', source: 'bundled', taskTypes: ['learning_review'], roles: [], entry: 'entry.ts', ipcProtocol: 'module-agent', requiresBrainReview: false, dependencies: [], capabilities: {} },
    skills: { apiVersion: 'berry.agent.v1', name: 'skills', version: '0.1.0', description: '创建和维护 SKILL.md', level: 2, kind: 'on-demand', source: 'bundled', taskTypes: ['skill_task'], roles: [], entry: 'entry.ts', ipcProtocol: 'module-agent', requiresBrainReview: false, dependencies: [], capabilities: {} },
    'plugin-builder': { apiVersion: 'berry.agent.v1', name: 'plugin-builder', version: '0.1.0', description: '生成和修改独立插件包', level: 2, kind: 'on-demand', source: 'bundled', taskTypes: ['plugin_task'], roles: [], entry: 'entry.ts', ipcProtocol: 'module-agent', requiresBrainReview: false, dependencies: [], capabilities: {} },
    code: { apiVersion: 'berry.agent.v1', name: 'code', version: '0.1.0', description: '代码库阅读、修改、测试、重构', level: 2, kind: 'on-demand', source: 'bundled', taskTypes: ['code_task'], roles: [], entry: 'entry.ts', ipcProtocol: 'module-agent', requiresBrainReview: false, dependencies: [], capabilities: {} },
  };
  return { ...defaults[name], ...overrides } as AgentManifest;
}

const ALL_AGENT_NAMES = ['brain', 'conversation', 'learning', 'skills', 'plugin-builder', 'code'];

describe('Agent Home', () => {
  let tempDir: string;
  let originalHome: string;

  beforeEach(() => {
    originalHome = getAppHome();
    tempDir = mkdtempSync(join(tmpdir(), 'berry-test-'));
    setAppHome(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    setAppHome(originalHome);
  });

  it('创建标准目录结构', () => {
    const paths = ensureAgentHome(makeManifest('conversation'));

    expect(existsSync(paths.home)).toBe(true);
    expect(existsSync(paths.runtime)).toBe(true);
    expect(existsSync(paths.tasks)).toBe(true);
    expect(existsSync(paths.cache)).toBe(true);
    expect(existsSync(paths.logs)).toBe(true);
    expect(existsSync(paths.agentYaml)).toBe(true);
    expect(existsSync(paths.agentMd)).toBe(true);
    expect(existsSync(paths.capabilities)).toBe(true);
  });

  it('agent.yaml 包含正确的元数据', () => {
    const paths = ensureAgentHome(makeManifest('brain'));
    const content = readFileSync(paths.agentYaml, 'utf-8');

    expect(content).toContain('name: brain');
    expect(content).toContain('level: 1');
    expect(content).toContain('brain_review');
  });

  it('capabilities.json 包含正确的 task types', () => {
    const paths = ensureAgentHome(makeManifest('code'));
    const caps = JSON.parse(readFileSync(paths.capabilities, 'utf-8'));

    expect(caps.name).toBe('code');
    expect(caps.level).toBe(2);
    expect(caps.taskTypes).toContain('code_task');
  });

  it('重复调用不覆盖已有文件', () => {
    const manifest = makeManifest('conversation');
    const paths = ensureAgentHome(manifest);

    writeFileSync(paths.agentMd, '# 自定义指令\n用户修改过');

    const paths2 = ensureAgentHome(manifest);
    const content = readFileSync(paths2.agentMd, 'utf-8');
    expect(content).toBe('# 自定义指令\n用户修改过');
  });

  it('getAgentHomePath 返回正确路径', () => {
    const path = getAgentHomePath('learning');
    expect(path).toBe(join(tempDir, 'agents', 'learning'));
  });

  it('所有 agent 都能创建 home', () => {
    const agents = ['brain', 'conversation', 'learning', 'skills', 'plugin-builder', 'code'] as const;
    for (const name of agents) {
      const paths = ensureAgentHome(makeManifest(name));
      expect(existsSync(paths.home)).toBe(true);
    }
  });

  it('允许 Agent 访问自己的工作目录', () => {
    const paths = ensureAgentHome(makeManifest('conversation'));

    expect(canAgentAccessPath('conversation', join(paths.tasks, 'tsk_1', 'task.json'), ALL_AGENT_NAMES)).toBe(true);
    expect(() => assertAgentCanAccessPath('conversation', paths.stateDb, ALL_AGENT_NAMES)).not.toThrow();
  });

  it('禁止 Agent 访问其他 Agent 的私有工作目录', () => {
    const brain = ensureAgentHome(makeManifest('brain'));

    expect(canAgentAccessPath('conversation', join(brain.tasks, 'tsk_1', 'task.json'), ALL_AGENT_NAMES)).toBe(false);
    expect(canAgentAccessPath('conversation', brain.stateDb, ALL_AGENT_NAMES)).toBe(false);
    expect(canAgentAccessPath('conversation', join(brain.cache, 'x'), ALL_AGENT_NAMES)).toBe(false);
    expect(() => assertAgentCanAccessPath('conversation', join(brain.logs, 'agent.log'), ALL_AGENT_NAMES))
      .toThrow('禁止访问其他 Agent 的私有工作目录');
  });

  it('允许访问 Agent Home 外部路径', () => {
    expect(canAgentAccessPath('conversation', join(tempDir, 'shared', 'file.txt'), ALL_AGENT_NAMES)).toBe(true);
  });
});
