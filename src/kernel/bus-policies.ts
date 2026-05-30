import type { MessageType } from '../contracts/messages.js';

export interface MessagePolicy {
  timeoutMs?: number;
  retryCount?: number;
  retryBackoff?: 'exponential' | 'linear' | 'fixed';
  priority?: 'high' | 'normal' | 'low';
  maxPending?: number;
}

const policies = new Map<string, MessagePolicy>();

const DEFAULT_POLICY: MessagePolicy = {
  timeoutMs: 30_000,
  retryCount: 0,
  priority: 'normal',
};

export function setPolicy(type: MessageType | string, policy: MessagePolicy): void {
  policies.set(type, policy);
}

export function getPolicy(type: MessageType | string): MessagePolicy {
  return policies.get(type) ?? DEFAULT_POLICY;
}

export function clearPolicies(): void {
  policies.clear();
}

export function matchesPattern(type: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return type === pattern;
  const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^:]*') + '$');
  return regex.test(type);
}
