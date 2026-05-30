import type { z } from 'zod';

export type DangerLevel = 'safe' | 'moderate' | 'dangerous';

export type CapabilityProviderType = 'builtin' | 'agent' | 'plugin' | 'runtime';

export interface CapabilityProvider {
  type: CapabilityProviderType;
  name: string;
}

export interface CapabilityDescriptor {
  name: string;
  description: string;
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  dangerLevel: DangerLevel;
  provider: CapabilityProvider;
  metadata?: Record<string, unknown>;
}

export interface InvokeContext {
  callChain: string[];
  callerAgent?: string;
  sessionId: string;
  correlationId: string;
  timeout?: number;
  traceId?: string;
}

export interface InvokeResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  auditId: string;
  durationMs: number;
  provider: CapabilityProvider;
}

export interface CapabilityQuery {
  providerType?: CapabilityProviderType;
  dangerLevel?: DangerLevel;
  namePattern?: string;
}

export interface ICapabilityBus {
  register(capability: CapabilityDescriptor, executor: CapabilityExecutor): void;
  unregister(name: string): void;
  has(name: string): boolean;
  discover(query?: CapabilityQuery): CapabilityDescriptor[];
  getDescriptor(name: string): CapabilityDescriptor | undefined;

  invoke(name: string, input: unknown, ctx: InvokeContext): Promise<InvokeResult>;
  invokeAll(calls: Array<{ name: string; input: unknown }>, ctx: InvokeContext): Promise<InvokeResult[]>;
  pipeline(input: unknown, steps: string[], ctx: InvokeContext): Promise<InvokeResult>;
  race(calls: Array<{ name: string; input: unknown }>, ctx: InvokeContext): Promise<InvokeResult>;
}

export type CapabilityExecutor = (input: unknown, ctx: InvokeContext) => Promise<unknown>;

export const MAX_CALL_DEPTH = 16;

export interface BusAuditEntry {
  id: string;
  capabilityName: string;
  provider: CapabilityProvider;
  callerAgent: string | null;
  sessionId: string;
  correlationId: string;
  callChain: string[];
  input: unknown;
  output: unknown;
  ok: boolean;
  error: string | null;
  durationMs: number;
  createdAt: number;
}

export interface PermissionGateDecision {
  allowed: boolean;
  reason: string;
  source: 'auto' | 'brain' | 'user';
}

export interface IPermissionGate {
  check(
    capability: CapabilityDescriptor,
    input: unknown,
    ctx: InvokeContext,
  ): Promise<PermissionGateDecision>;
}

export interface IBusAuditLogger {
  record(entry: BusAuditEntry): void;
  getBySession(sessionId: string, limit?: number): BusAuditEntry[];
  getByCorrelation(correlationId: string): BusAuditEntry[];
}
