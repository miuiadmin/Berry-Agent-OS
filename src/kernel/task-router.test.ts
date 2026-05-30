import { describe, expect, it } from 'vitest';
import { TaskRouter } from './task-router.js';
import { AgentRegistry } from './agent-registry.js';
import type { AgentManifest } from '../agents/manifest.js';

function createTestRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  const manifests: AgentManifest[] = [
    { apiVersion: 'berry.agent.v1', name: 'brain', version: '0.1.0', description: '审核', level: 1, kind: 'resident', source: 'bundled', taskTypes: ['brain_review'], roles: ['reviewer'], entry: 'entry.ts', ipcProtocol: 'custom', requiresBrainReview: false, dependencies: [], capabilities: {} },
    { apiVersion: 'berry.agent.v1', name: 'conversation', version: '0.1.0', description: '对话', level: 3, kind: 'resident', source: 'bundled', taskTypes: ['conversation_turn'], roles: ['primary'], entry: 'entry.ts', ipcProtocol: 'custom', requiresBrainReview: true, dependencies: [], capabilities: {} },
    { apiVersion: 'berry.agent.v1', name: 'learning', version: '0.1.0', description: '学习', level: 2, kind: 'on-demand', source: 'bundled', taskTypes: ['learning_review'], roles: [], entry: 'entry.ts', ipcProtocol: 'module-agent', requiresBrainReview: false, dependencies: [], capabilities: {} },
    { apiVersion: 'berry.agent.v1', name: 'skills', version: '0.1.0', description: '技能', level: 2, kind: 'on-demand', source: 'bundled', taskTypes: ['skill_task'], roles: [], entry: 'entry.ts', ipcProtocol: 'module-agent', requiresBrainReview: false, dependencies: [], capabilities: {} },
    { apiVersion: 'berry.agent.v1', name: 'plugin-builder', version: '0.1.0', description: '插件', level: 2, kind: 'on-demand', source: 'bundled', taskTypes: ['plugin_task'], roles: [], entry: 'entry.ts', ipcProtocol: 'module-agent', requiresBrainReview: false, dependencies: [], capabilities: {} },
    { apiVersion: 'berry.agent.v1', name: 'code', version: '0.1.0', description: '代码', level: 2, kind: 'on-demand', source: 'bundled', taskTypes: ['code_task'], roles: [], entry: 'entry.ts', ipcProtocol: 'module-agent', requiresBrainReview: false, dependencies: [], capabilities: {} },
  ];
  for (const m of manifests) {
    registry.register(m, `/fake/${m.name}/agent.json`);
  }
  return registry;
}

describe('TaskRouter', () => {
  it('将核心任务类型路由到对应 Agent', () => {
    const registry = createTestRegistry();
    const router = new TaskRouter(registry);

    expect(router.route({ taskType: 'conversation_turn', requester: 'user' }).targetAgent).toBe('conversation');
    expect(router.route({ taskType: 'brain_review', requester: 'conversation' }).targetAgent).toBe('brain');
    expect(router.route({ taskType: 'skill_task', requester: 'learning' }).targetAgent).toBe('skills');
    expect(router.route({ taskType: 'plugin_task', requester: 'learning' }).targetAgent).toBe('plugin-builder');
    expect(router.route({ taskType: 'code_task', requester: 'conversation' }).targetAgent).toBe('code');
  });

  it('允许显式路由到已注册的 Agent', () => {
    const registry = createTestRegistry();
    const router = new TaskRouter(registry);

    const result = router.route({
      taskType: 'code_task',
      requester: 'conversation',
      targetAgent: 'code',
    });
    expect(result.targetAgent).toBe('code');
    expect(result.reason).toBe('显式路由');
  });

  it('拒绝路由到未注册的 Agent', () => {
    const registry = createTestRegistry();
    const router = new TaskRouter(registry);

    expect(() => router.route({
      taskType: 'code_task',
      requester: 'conversation',
      targetAgent: 'nonexistent',
    })).toThrow('目标智能体不存在');
  });

  it('拒绝未注册的任务类型', () => {
    const registry = createTestRegistry();
    const router = new TaskRouter(registry);

    expect(() => router.route({
      taskType: 'unknown_task',
      requester: 'user',
    })).toThrow('没有注册可处理 unknown_task 的智能体');
  });
});
