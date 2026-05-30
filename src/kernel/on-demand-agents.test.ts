import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestHarness } from '../testing/harness.js';
import type { TakeoverController } from '../testing/model-takeover.js';

describe('on-demand evolution agents', () => {
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

  it('starts learning-agent on demand and completes a learning_review task', async () => {
    const dispatched = await harness.dispatchEvolutionTask({
      taskType: 'learning_review',
      sessionId: 'agent-learning',
      inputPayload: {
        message: '以后每次自动化报告都用中文标题，并做一个插件整理结果。',
      },
    });

    expect(dispatched.ok).toBe(true);
    expect(dispatched.targetAgent).toBe('learning');

    await harness.waitIdle(10000);
    const db = harness.getDb();
    const task = db.prepare(`SELECT status, target_agent, output_payload FROM agent_tasks WHERE id = ?`)
      .get(dispatched.taskId) as { status: string; target_agent: string; output_payload: string };
    expect(task.status).toBe('completed');
    expect(task.target_agent).toBe('learning');
    expect(JSON.parse(task.output_payload).kind).toBe('learning_review');

    const proposalCount = (db.prepare(`SELECT COUNT(*) AS count FROM evolution_proposals`).get() as { count: number }).count;
    expect(proposalCount).toBeGreaterThan(0);
  });

  it('starts plugin-builder-agent on demand and approves a plugin proposal', async () => {
    const db = harness.getDb();
    const proposal = db.prepare(`
      SELECT id FROM evolution_proposals WHERE type = 'plugin_create' ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string };

    const dispatched = await harness.dispatchEvolutionTask({
      taskType: 'plugin_task',
      sessionId: 'agent-plugin',
      inputPayload: {
        proposalId: proposal.id,
        enable: true,
      },
    });

    expect(dispatched.ok).toBe(true);
    expect(dispatched.targetAgent).toBe('plugin-builder');

    await harness.waitIdle(10000);
    const task = db.prepare(`SELECT status, output_payload FROM agent_tasks WHERE id = ?`)
      .get(dispatched.taskId) as { status: string; output_payload: string };
    expect(task.status).toBe('completed');
    expect(JSON.parse(task.output_payload).kind).toBe('plugin_task');

    const plugin = db.prepare(`SELECT status FROM plugins_meta ORDER BY updated_at DESC LIMIT 1`)
      .get() as { status: string };
    expect(plugin.status).toBe('enabled');
  });

  it('starts skills-agent on demand and validates a skill proposal', async () => {
    const db = harness.getDb();
    const proposal = db.prepare(`
      SELECT id FROM evolution_proposals WHERE type = 'skill_create' ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string };

    const dispatched = await harness.dispatchEvolutionTask({
      taskType: 'skill_task',
      sessionId: 'agent-skill',
      inputPayload: { proposalId: proposal.id },
    });

    expect(dispatched.ok).toBe(true);
    expect(dispatched.targetAgent).toBe('skills');

    await harness.waitIdle(10000);
    const task = db.prepare(`SELECT status, output_payload FROM agent_tasks WHERE id = ?`)
      .get(dispatched.taskId) as { status: string; output_payload: string };
    expect(task.status).toBe('completed');
    expect(JSON.parse(task.output_payload).kind).toBe('skill_task');
  });

  it('supports takeover for learning-agent LLM enhanced review', async () => {
    const dispatchPromise = harness.dispatchEvolutionTask({
      taskType: 'learning_review',
      sessionId: 'agent-learning-llm',
      inputPayload: {
        message: '以后每次 LLM 增强报告都标注证据来源。',
        useLlm: true,
      },
    });

    const request = await controller.waitForRequest(10000);
    expect(request.agent).toBe('learning');
    expect(request.purpose).toBe('learning_review');
    controller.respond(request.requestId, JSON.stringify([
      {
        kind: 'skill',
        targetName: 'llm-evidence-report',
        description: 'LLM 增强报告需要标注证据来源',
        observations: ['用户明确要求长期输出偏好'],
        riskLevel: 'low',
      },
    ]));

    const dispatched = await dispatchPromise;
    expect(dispatched.ok).toBe(true);
    await harness.waitIdle(10000);

    const task = harness.getDb().prepare(`SELECT output_payload FROM agent_tasks WHERE id = ?`)
      .get(dispatched.taskId) as { output_payload: string };
    const output = JSON.parse(task.output_payload);
    expect(output.llmUsed).toBe(true);
    expect(output.proposals[0].targetName).toBe('llm-evidence-report-skill');
  });

  it('supports takeover for skills-agent and plugin-builder-agent LLM notes', async () => {
    const db = harness.getDb();
    const skillProposal = db.prepare(`
      SELECT id FROM evolution_proposals WHERE type = 'skill_create' ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string };

    const skillDispatchPromise = harness.dispatchEvolutionTask({
      taskType: 'skill_task',
      sessionId: 'agent-skill-llm',
      inputPayload: { proposalId: skillProposal.id, useLlm: true },
    });
    const skillReq = await controller.waitForRequest(10000);
    expect(skillReq.agent).toBe('skills');
    expect(skillReq.purpose).toBe('skill_generation');
    controller.respond(skillReq.requestId, '技能质量可以，建议保留证据章节。');
    const skillDispatch = await skillDispatchPromise;
    await harness.waitIdle(10000);
    const skillTask = db.prepare(`SELECT output_payload FROM agent_tasks WHERE id = ?`)
      .get(skillDispatch.taskId) as { output_payload: string };
    expect(JSON.parse(skillTask.output_payload).llmNote).toContain('技能质量');

    const pluginProposal = db.prepare(`
      SELECT id FROM evolution_proposals WHERE type = 'plugin_create' ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string };
    const pluginDispatchPromise = harness.dispatchEvolutionTask({
      taskType: 'plugin_task',
      sessionId: 'agent-plugin-llm',
      inputPayload: { proposalId: pluginProposal.id, useLlm: true },
    });
    const pluginReq = await controller.waitForRequest(10000);
    expect(pluginReq.agent).toBe('plugin-builder');
    expect(pluginReq.purpose).toBe('plugin_generation');
    controller.respond(pluginReq.requestId, '插件权限为只读，建议通过。');
    const pluginDispatch = await pluginDispatchPromise;
    await harness.waitIdle(10000);
    const pluginTask = db.prepare(`SELECT output_payload FROM agent_tasks WHERE id = ?`)
      .get(pluginDispatch.taskId) as { output_payload: string };
    expect(JSON.parse(pluginTask.output_payload).llmNote).toContain('插件权限');
  });
});
