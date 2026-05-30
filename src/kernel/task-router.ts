import type { AgentRegistry } from './agent-registry.js';

export interface RouteTaskInput {
  taskType: string;
  requester: string;
  targetAgent?: string;
}

export interface RouteTaskResult {
  targetAgent: string;
  reason: string;
}

export class TaskRouter {
  constructor(private registry: AgentRegistry) {}

  route(input: RouteTaskInput): RouteTaskResult {
    if (input.targetAgent) {
      if (!this.registry.has(input.targetAgent)) {
        throw new Error(`目标智能体不存在: ${input.targetAgent}`);
      }
      return { targetAgent: input.targetAgent, reason: '显式路由' };
    }

    const agent = this.registry.getByTaskType(input.taskType);
    if (!agent) {
      throw new Error(`没有注册可处理 ${input.taskType} 的智能体`);
    }
    return {
      targetAgent: agent.manifest.name,
      reason: agent.manifest.description,
    };
  }
}
