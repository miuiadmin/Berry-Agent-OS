import { z } from 'zod';
import { AGENT_ROLES, type AgentRole, type AgentLevel } from '../contracts/agents.js';

export const AGENT_KINDS = ['resident', 'on-demand'] as const;
export type AgentKind = typeof AGENT_KINDS[number];

export const AGENT_SOURCES = ['bundled', 'user', 'generated', 'installed'] as const;
export type AgentSource = typeof AGENT_SOURCES[number];

export const IPC_PROTOCOLS = ['module-agent', 'custom'] as const;
export type IpcProtocol = typeof IPC_PROTOCOLS[number];

export const agentManifestSchema = z.object({
  apiVersion: z.literal('berry.agent.v1'),
  name: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().default('0.1.0'),
  description: z.string().min(1),

  level: z.union([z.literal(1), z.literal(2), z.literal(3)]) as z.ZodType<AgentLevel>,
  kind: z.enum(AGENT_KINDS),
  source: z.enum(AGENT_SOURCES).default('bundled'),

  taskTypes: z.array(z.string().min(1)).min(1),
  roles: z.array(z.enum(AGENT_ROLES)).default([]),

  entry: z.string().default('entry.ts'),
  ipcProtocol: z.enum([...IPC_PROTOCOLS, 'generic-loop'] as const).default('module-agent'),

  requiresBrainReview: z.boolean().default(false),

  /**
   * 13.0 §5.2.4: 该 agent 允许直接对话的目标 agent 列表。
   * Kernel 启动时校验：不得包含 'brain'（Brain 是观察者，不直接对话）。
   * 运行时 gate 也会拦截 to==='brain'（纵深防御）。
   */
  canTalkTo: z.array(z.string().min(1)).default([]),

  dependencies: z.array(z.string()).default([]),
  capabilities: z.record(z.string(), z.unknown()).default({}),

  capabilitiesProvided: z.array(z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    dangerLevel: z.enum(['safe', 'moderate', 'dangerous']).default('safe'),
  })).default([]),

  capabilitiesRequired: z.array(z.string().min(1)).default([]),

  modelTier: z.enum(['fast', 'default', 'high']).optional(),
  maxTurns: z.number().int().positive().optional(),

  /**
   * L3: dialogue.observe 观察轮次上限（Brain 用，控制何时触发漂移/终止检测）。
   * 不同 Agent 可能需要不同的观察深度（code 需要 12 轮，memory 只需 6 轮）。
   * 默认 8 轮（与旧版硬编码行为一致）。
   */
  dialogueObserve: z.object({
    /** 单次观察对话的最大轮次，超出后 Brain 触发终止评估 */
    maxRounds: z.number().int().positive().default(8),
  }).default({ maxRounds: 8 }).optional(),
});

export type AgentManifest = z.infer<typeof agentManifestSchema>;

export interface RegisteredAgent {
  manifest: AgentManifest;
  manifestPath: string;
  entryPath: string;
  homeDir: string;
}
