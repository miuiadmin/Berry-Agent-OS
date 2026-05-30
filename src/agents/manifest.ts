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
  ipcProtocol: z.enum(IPC_PROTOCOLS).default('module-agent'),

  requiresBrainReview: z.boolean().default(false),

  dependencies: z.array(z.string()).default([]),
  capabilities: z.record(z.string(), z.unknown()).default({}),
});

export type AgentManifest = z.infer<typeof agentManifestSchema>;

export interface RegisteredAgent {
  manifest: AgentManifest;
  manifestPath: string;
  entryPath: string;
  homeDir: string;
}
