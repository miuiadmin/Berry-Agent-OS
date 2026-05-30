import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestHarness } from '../testing/harness.js';
import type { TakeoverController } from '../testing/model-takeover.js';

describe('skill-tester agent 全链路', () => {
  let harness: TestHarness;
  let controller: TakeoverController;

  beforeAll(async () => {
    harness = new TestHarness({ timeoutMs: 30000, llmMode: 'takeover' });
    await harness.start();
    const tc = harness.getTakeoverController();
    if (!tc) throw new Error('TakeoverController not available');
    controller = tc;
  }, 60000);

  afterAll(async () => {
    await harness.stop();
  }, 30000);

  it('dispatches skill_test task to skill-tester agent and completes', async () => {
    const dispatched = await harness.dispatchEvolutionTask({
      taskType: 'skill_test',
      sessionId: 'skill-tester-basic',
      inputPayload: {
        skillName: 'code-review',
        arguments: 'src/main.ts security',
      },
    });

    expect(dispatched.ok).toBe(true);
    expect(dispatched.targetAgent).toBe('skill-tester');

    await harness.waitIdle(15000);
    const db = harness.getDb();
    const task = db.prepare(`SELECT status, output_payload FROM agent_tasks WHERE id = ?`)
      .get(dispatched.taskId) as { status: string; output_payload: string };
    expect(task.status).toBe('completed');

    const output = JSON.parse(task.output_payload);
    expect(output.kind).toBe('skill_test');
    expect(output.ok).toBe(true);
    expect(output.skillName).toBe('code-review');
    expect(output.hasContent).toBe(true);
    expect(output.hasArguments).toBe(true);
    expect(output.hasWhenToUse).toBe(true);
    expect(output.contentLength).toBeGreaterThan(100);
  });

  it('skill_test with useLlm triggers takeover for LLM verification', async () => {
    const dispatchPromise = harness.dispatchEvolutionTask({
      taskType: 'skill_test',
      sessionId: 'skill-tester-llm',
      inputPayload: {
        skillName: 'meeting-notes',
        useLlm: true,
      },
    });

    const request = await controller.waitForRequest(10000);
    expect(request.agent).toBe('skill-tester');
    expect(request.purpose).toBe('skill_verification');
    controller.respond(request.requestId, '技能格式正确，包含完整触发条件和执行规则。');

    const dispatched = await dispatchPromise;
    expect(dispatched.ok).toBe(true);
    await harness.waitIdle(15000);

    const db = harness.getDb();
    const task = db.prepare(`SELECT output_payload FROM agent_tasks WHERE id = ?`)
      .get(dispatched.taskId) as { output_payload: string };
    const output = JSON.parse(task.output_payload);
    expect(output.ok).toBe(true);
    expect(output.llmVerdict).toContain('技能格式正确');
  });

  it('skill_test fails gracefully for non-existent skill', async () => {
    const dispatched = await harness.dispatchEvolutionTask({
      taskType: 'skill_test',
      sessionId: 'skill-tester-fail',
      inputPayload: {
        skillName: 'non-existent-skill',
      },
    });

    expect(dispatched.ok).toBe(true);
    await harness.waitIdle(15000);

    const db = harness.getDb();
    const task = db.prepare(`SELECT status, output_payload FROM agent_tasks WHERE id = ?`)
      .get(dispatched.taskId) as { status: string; output_payload: string };
    expect(task.status).toBe('completed');
    const output = JSON.parse(task.output_payload);
    expect(output.ok).toBe(false);
    expect(output.error).toContain('不存在');
  });

  it('skill_test updates use_count via report_skill_outcome', async () => {
    const dispatched = await harness.dispatchEvolutionTask({
      taskType: 'skill_test',
      sessionId: 'skill-tester-stats',
      inputPayload: {
        skillName: 'git-commit-helper',
        arguments: 'feat core',
      },
    });

    expect(dispatched.ok).toBe(true);
    await harness.waitIdle(15000);

    const db = harness.getDb();
    const row = db.prepare(`SELECT use_count, success_count FROM skills_meta WHERE name = ?`)
      .get('git-commit-helper') as { use_count: number; success_count: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.use_count).toBeGreaterThanOrEqual(1);
    expect(row!.success_count).toBeGreaterThanOrEqual(1);
  });
});
