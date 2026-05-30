import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setAppHome } from '../utils/paths.js';
import { closeDb, getDb, initDb } from '../memory/db.js';
import { EvolutionEngine } from './engine.js';
import { EvolutionWorkflow } from './workflow.js';
import { detectLearningSignals } from './detector.js';
import { SkillsRegistry } from '../skills/index.js';
import { PluginRegistry } from '../plugins/index.js';

let tempDirs: string[] = [];

afterEach(() => {
  closeDb();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('evolution engine', () => {
  it('detects reusable skill and plugin signals from user messages', () => {
    const signals = detectLearningSignals('以后每次报告都用中文标题；另外做一个插件自动化整理报告。', '好的');

    expect(signals.map((signal) => signal.kind)).toEqual(['skill', 'plugin']);
    expect(signals[0].riskLevel).toBe('low');
  });

  it('creates skill proposals and generated SKILL.md files', () => {
    initTempDb();
    const engine = new EvolutionEngine(getDb());

    const result = engine.runAfterConversation({
      sessionId: 's1',
      userMessage: '以后每次自进化测试报告都用中文标题、简洁列表，并标注证据来源。',
      assistantResponse: '已记住',
    });

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].type).toBe('skill_create');
    expect(result.proposals[0].status).toBe('applied');
    expect(result.applied[0].kind).toBe('skill');

    const skills = new SkillsRegistry(getDb()).list();
    expect(skills).toHaveLength(1);
    expect(new SkillsRegistry(getDb()).load(skills[0].name)).toContain('## 执行规则');
  });

  it('creates plugin draft proposals, files, validation records, and tool index', () => {
    initTempDb();
    const engine = new EvolutionEngine(getDb());

    const result = engine.runAfterConversation({
      sessionId: 's2',
      userMessage: '我需要一个插件，一键自动化整理自进化测试报告。',
      assistantResponse: '可以',
    });

    expect(result.proposals.some((proposal) => proposal.type === 'plugin_create')).toBe(true);
    const pluginApply = result.applied.find((item) => item.kind === 'plugin');
    expect(pluginApply).toBeDefined();

    const plugins = new PluginRegistry(getDb()).list();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].status).toBe('pending_review');

    const validation = new PluginRegistry(getDb()).validate(plugins[0].name);
    expect(validation.ok).toBe(true);
    expect(validation.tools.length).toBe(1);

    const toolCount = (getDb().prepare(`SELECT COUNT(*) AS count FROM plugin_tools`).get() as { count: number }).count;
    const eventCount = (getDb().prepare(`SELECT COUNT(*) AS count FROM plugin_events`).get() as { count: number }).count;
    expect(toolCount).toBe(1);
    expect(eventCount).toBeGreaterThan(0);
  });

  it('validates and approves plugin proposals through the workflow', () => {
    initTempDb();
    const engine = new EvolutionEngine(getDb());
    const result = engine.runAfterConversation({
      sessionId: 's-workflow',
      userMessage: '做一个插件自动化整理验证结果。',
      assistantResponse: '可以',
    });
    const proposal = result.proposals.find((item) => item.type === 'plugin_create')!;
    const workflow = new EvolutionWorkflow(getDb());

    const validated = workflow.validate(proposal.id);
    expect(validated.status).toBe('pending_review');

    const approved = workflow.approve(proposal.id, { enable: true, reviewer: 'test-brain' });
    expect(approved.status).toBe('applied');
    expect(approved.brainReviewId).toBe('test-brain');

    const plugin = new PluginRegistry(getDb()).list()[0];
    expect(plugin.status).toBe('enabled');

    const events = getDb().prepare(`SELECT event_type FROM plugin_events ORDER BY created_at`).all() as Array<{ event_type: string }>;
    expect(events.map((event) => event.event_type)).toContain('status_enabled');
  });

  it('keeps high-risk plugin proposals pending user confirmation when approved with enable', () => {
    initTempDb();
    const engine = new EvolutionEngine(getDb());
    const result = engine.runAfterConversation({
      sessionId: 's-high-risk',
      userMessage: '做一个插件自动化执行命令并整理验证结果。',
      assistantResponse: '可以',
    });
    const proposal = result.proposals.find((item) => item.type === 'plugin_create')!;

    const approved = new EvolutionWorkflow(getDb()).approve(proposal.id, { enable: true });
    expect(approved.status).toBe('pending_user_confirm');
    expect(new PluginRegistry(getDb()).list()[0].status).toBe('pending_user_confirm');
  });

  it('rejects and rolls back proposals with status reflected in assets', () => {
    initTempDb();
    const engine = new EvolutionEngine(getDb());
    const skillResult = engine.runAfterConversation({
      sessionId: 's-reject',
      userMessage: '以后每次报告都标注证据来源。',
      assistantResponse: '好的',
    });
    const workflow = new EvolutionWorkflow(getDb());
    const rejected = workflow.reject(skillResult.proposals[0].id, '质量不足');
    expect(rejected.status).toBe('rejected');
    expect(new SkillsRegistry(getDb()).list()[0].disabled).toBe(true);

    const pluginResult = engine.runAfterConversation({
      sessionId: 's-rollback',
      userMessage: '做一个插件自动化整理报告。',
      assistantResponse: '可以',
    });
    const pluginProposal = pluginResult.proposals.find((proposal) => proposal.type === 'plugin_create')!;
    workflow.approve(pluginProposal.id, { enable: true });
    const rolledBack = workflow.rollback(pluginProposal.id, '验证回滚');
    expect(rolledBack.status).toBe('rolled_back');
    expect(new PluginRegistry(getDb()).list()[0].status).toBe('rolled_back');
  });

  it('does not duplicate open proposals for the same target', () => {
    initTempDb();
    const engine = new EvolutionEngine(getDb());
    const input = {
      sessionId: 's3',
      userMessage: '以后每次报告都标注证据来源。',
      assistantResponse: '好的',
    };

    engine.runAfterConversation(input);
    engine.runAfterConversation(input);

    const count = (getDb().prepare(`SELECT COUNT(*) AS count FROM evolution_proposals`).get() as { count: number }).count;
    expect(count).toBe(1);
  });
});

function initTempDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'berryagent-evolution-test-'));
  tempDirs.push(dir);
  setAppHome(dir);
  initDb(join(dir, 'data', 'berry.db'));
}
