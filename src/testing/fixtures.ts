import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { TestHarness } from './harness.js';
import type { TakeoverController, PendingModelRequest } from './model-takeover.js';

export interface FixtureInteraction {
  request: {
    agent: string;
    purpose: string;
    modelTier?: string;
    promptHash?: string;
    toolsHash?: string;
  };
  response: {
    content: string;
    toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stopReason?: string;
  };
  expect?: FixtureExpectation;
}

export interface FixtureExpectation {
  agent?: string;
  purpose?: string;
  toolNames?: string[];
  hasToolResultFor?: string[];
  promptHashStable?: boolean;
}

export interface FixtureData {
  name: string;
  description?: string;
  userMessage: string;
  interactions: FixtureInteraction[];
  expectedResponse?: string;
}

export function loadFixture(filePath: string): FixtureData {
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as FixtureData;
}

export function saveFixture(filePath: string, fixture: FixtureData): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(fixture, null, 2) + '\n', 'utf-8');
}

export interface ReplayResult {
  response: string;
  sessionId: string;
  taskId: string;
  matchedAll: boolean;
  mismatches: string[];
}

export async function replayFixture(
  harness: TestHarness,
  fixture: FixtureData,
  options?: { timeoutMs?: number },
): Promise<ReplayResult> {
  const controller = harness.getTakeoverController();
  if (!controller) {
    throw new Error('Harness 未以 takeover 模式启动');
  }

  const timeoutMs = options?.timeoutMs ?? 10000;
  const mismatches: string[] = [];
  let interactionIdx = 0;

  const messagePromise = harness.sendMessage(fixture.userMessage);

  for (const interaction of fixture.interactions) {
    const req = await controller.waitForRequest(timeoutMs);

    if (interaction.expect) {
      const issues = validateExpectation(req, interaction.expect, interactionIdx);
      mismatches.push(...issues);
    }

    if (interaction.response.toolCalls) {
      controller.respond(req.requestId, interaction.response.content, {
        toolCalls: interaction.response.toolCalls,
        stopReason: interaction.response.stopReason,
      });
    } else {
      controller.respond(req.requestId, interaction.response.content, {
        stopReason: interaction.response.stopReason,
      });
    }

    interactionIdx++;
  }

  const result = await messagePromise;

  if (fixture.expectedResponse && result.response !== fixture.expectedResponse) {
    mismatches.push(
      `最终响应不匹配: 期望 "${fixture.expectedResponse}", 实际 "${result.response}"`,
    );
  }

  return {
    response: result.response,
    sessionId: result.sessionId,
    taskId: result.taskId,
    matchedAll: mismatches.length === 0,
    mismatches,
  };
}

export interface RecordedInteraction {
  request: PendingModelRequest;
  responseSent: {
    content: string;
    toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stopReason?: string;
  };
}

export function buildFixtureFromRecording(
  name: string,
  userMessage: string,
  interactions: RecordedInteraction[],
  finalResponse: string,
): FixtureData {
  return {
    name,
    userMessage,
    interactions: interactions.map((i) => ({
      request: {
        agent: i.request.agent,
        purpose: i.request.purpose,
        promptHash: i.request.promptHash,
      },
      response: {
        content: i.responseSent.content,
        toolCalls: i.responseSent.toolCalls,
        stopReason: i.responseSent.stopReason,
      },
      expect: {
        agent: i.request.agent,
        purpose: i.request.purpose,
      },
    })),
    expectedResponse: finalResponse,
  };
}

function validateExpectation(
  req: PendingModelRequest,
  expect: FixtureExpectation,
  idx: number,
): string[] {
  const issues: string[] = [];
  const prefix = `interaction[${idx}]`;

  if (expect.agent && req.agent !== expect.agent) {
    issues.push(`${prefix}: agent 期望 "${expect.agent}", 实际 "${req.agent}"`);
  }

  if (expect.purpose && req.purpose !== expect.purpose) {
    issues.push(`${prefix}: purpose 期望 "${expect.purpose}", 实际 "${req.purpose}"`);
  }

  if (expect.toolNames) {
    const actualTools = (req.tools as Array<{ name?: string }> | undefined)
      ?.map((t) => t.name)
      .filter(Boolean) ?? [];
    const missing = expect.toolNames.filter((n) => !actualTools.includes(n));
    if (missing.length > 0) {
      issues.push(`${prefix}: 缺少工具 ${missing.join(', ')}`);
    }
  }

  return issues;
}
