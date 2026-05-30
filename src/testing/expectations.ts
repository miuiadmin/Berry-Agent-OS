import type { PendingModelRequest } from './model-takeover.js';
import type { FixtureExpectation, FixtureInteraction } from './fixtures.js';

export interface ExpectationResult {
  passed: boolean;
  failures: string[];
}

export function validateInteraction(
  request: PendingModelRequest,
  expected: FixtureInteraction,
  index: number,
): ExpectationResult {
  const failures: string[] = [];
  const prefix = `[${index}] ${expected.request.agent}/${expected.request.purpose}`;

  if (request.agent !== expected.request.agent) {
    failures.push(`${prefix}: agent 不匹配 — 期望 "${expected.request.agent}", 实际 "${request.agent}"`);
  }

  if (request.purpose !== expected.request.purpose) {
    failures.push(`${prefix}: purpose 不匹配 — 期望 "${expected.request.purpose}", 实际 "${request.purpose}"`);
  }

  if (expected.request.promptHash && expected.expect?.promptHashStable) {
    if (request.promptHash !== expected.request.promptHash) {
      failures.push(`${prefix}: promptHash 漂移 — 旧 "${expected.request.promptHash}", 新 "${request.promptHash}"`);
    }
  }

  if (expected.expect) {
    failures.push(...validateExpect(request, expected.expect, prefix));
  }

  return { passed: failures.length === 0, failures };
}

function validateExpect(
  request: PendingModelRequest,
  expect: FixtureExpectation,
  prefix: string,
): string[] {
  const failures: string[] = [];

  if (expect.toolNames) {
    const actualTools = extractToolNames(request.tools);
    for (const name of expect.toolNames) {
      if (!actualTools.includes(name)) {
        failures.push(`${prefix}: 缺少工具声明 "${name}"`);
      }
    }
  }

  if (expect.hasToolResultFor) {
    const messages = request.messages as Array<{ role?: string; content?: unknown }>;
    const toolResultNames = extractToolResultNames(messages);
    for (const name of expect.hasToolResultFor) {
      if (!toolResultNames.includes(name)) {
        failures.push(`${prefix}: 缺少工具结果 "${name}"`);
      }
    }
  }

  return failures;
}

function extractToolNames(tools: unknown[] | undefined): string[] {
  if (!tools) return [];
  return tools
    .map((t) => (t as { name?: string }).name)
    .filter((n): n is string => typeof n === 'string');
}

function extractToolResultNames(messages: Array<{ role?: string; content?: unknown }>): string[] {
  const names: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if ((block as { type?: string }).type === 'tool_result' && (block as { tool_name?: string }).tool_name) {
          names.push((block as { tool_name: string }).tool_name);
        }
      }
    }
  }
  return names;
}
