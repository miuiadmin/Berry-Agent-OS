import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestHarness } from '../testing/harness.js';
import type { TakeoverController } from '../testing/model-takeover.js';

describe('Code Agent E2E', () => {
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

  it('dispatches code_task and code-agent completes with summary', async () => {
    const dispatched = await harness.dispatchEvolutionTask({
      taskType: 'code_task',
      sessionId: 'code-test-1',
      inputPayload: {
        action: 'analyze',
        instruction: '分析 src/index.ts 的结构',
      },
    });

    expect(dispatched.ok).toBe(true);
    expect(dispatched.targetAgent).toBe('code');

    // Phase 1: Research — LLM reads code (ends without tool use)
    const researchReq = await controller.waitForRequest(10000);
    expect(researchReq.agent).toBe('code');
    expect(researchReq.purpose).toBe('code_task');
    controller.respond(researchReq.requestId, '已阅读 src/index.ts，这是入口文件。');

    // Phase 2: Synthesis — LLM produces analysis summary
    const synthesisReq = await controller.waitForRequest(10000);
    expect(synthesisReq.agent).toBe('code');
    controller.respond(synthesisReq.requestId, '这是一个 TypeScript 入口文件，导出了 CLI 和核心模块。');

    await harness.waitIdle(10000);

    const db = harness.getDb();
    const task = db.prepare(`SELECT status, output_payload FROM agent_tasks WHERE id = ?`)
      .get(dispatched.taskId) as { status: string; output_payload: string };

    expect(task.status).toBe('completed');
    const output = JSON.parse(task.output_payload);
    expect(output.kind).toBe('code_task');
    expect(output.action).toBe('analyze');
    expect(output.success).toBe(true);
    expect(output.summary).toContain('TypeScript');
  });

  it('code-agent records artifact after completion', async () => {
    const dispatched = await harness.dispatchEvolutionTask({
      taskType: 'code_task',
      sessionId: 'code-test-2',
      inputPayload: {
        action: 'analyze',
        instruction: '分析项目中的 hello 函数',
      },
    });

    // Phase 1: Research
    const researchReq = await controller.waitForRequest(10000);
    expect(researchReq.agent).toBe('code');
    controller.respond(researchReq.requestId, '已阅读代码，发现 hello 函数。');

    // Phase 2: Synthesis — return a plan JSON so patch_plan artifact is recorded
    const synthesisReq = await controller.waitForRequest(10000);
    controller.respond(synthesisReq.requestId, '```json\n{"description":"分析 hello","steps":[{"file":"src/utils.ts","action":"edit","description":"分析函数"}]}\n```');

    await harness.waitIdle(10000);

    const db = harness.getDb();
    const artifacts = db.prepare(`SELECT * FROM code_task_artifacts WHERE task_id = ?`)
      .all(dispatched.taskId) as Array<Record<string, unknown>>;

    expect(artifacts.length).toBeGreaterThan(0);
    const patchPlan = artifacts.find(a => a.artifact_type === 'patch_plan');
    expect(patchPlan).toBeDefined();
  });

  it('code-agent handles tool use via takeover', async () => {
    const dispatched = await harness.dispatchEvolutionTask({
      taskType: 'code_task',
      sessionId: 'code-test-3',
      inputPayload: {
        action: 'analyze',
        instruction: '读取 package.json 的内容',
      },
    });

    // Phase 1: Research — first call requests tool use
    const researchReq1 = await controller.waitForRequest(10000);
    expect(researchReq1.agent).toBe('code');

    controller.respond(researchReq1.requestId, '', {
      toolCalls: [{ id: 'toolu_code_1', name: 'inspect_code', input: { path: 'package.json' } }],
      stopReason: 'tool_use',
    });

    // Phase 1: Research — second call after tool result, ends research
    const researchReq2 = await controller.waitForRequest(15000);
    expect(researchReq2.agent).toBe('code');
    controller.respond(researchReq2.requestId, 'package.json 包含项目名称和依赖信息。');

    // Phase 2: Synthesis
    const synthesisReq = await controller.waitForRequest(10000);
    expect(synthesisReq.agent).toBe('code');
    controller.respond(synthesisReq.requestId, '项目配置分析完成。');

    await harness.waitIdle(15000);

    const db = harness.getDb();
    const task = db.prepare(`SELECT status, output_payload FROM agent_tasks WHERE id = ?`)
      .get(dispatched.taskId) as { status: string; output_payload: string };

    expect(task.status).toBe('completed');
    const output = JSON.parse(task.output_payload);
    expect(output.toolCallCount).toBeGreaterThanOrEqual(1);
  }, 30000);
});
