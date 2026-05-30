import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PromptVersioning } from './prompt-versioning.js';

describe('PromptVersioning', () => {
  let db: Database.Database;
  let versioning: PromptVersioning;

  beforeEach(() => {
    db = new Database(':memory:');
    versioning = new PromptVersioning(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates first version for a prompt key', () => {
    const version = versioning.propose({
      promptKey: 'brain.routing',
      newContent: 'You are a router...',
      changeReason: 'Initial version',
      changeSource: 'manual',
    });

    expect(version.version).toBe(1);
    expect(version.status).toBe('active');
    expect(version.previousVersionId).toBeNull();
    expect(version.content).toBe('You are a router...');
  });

  it('creates sequential versions and supersedes previous', () => {
    versioning.propose({
      promptKey: 'brain.routing',
      newContent: 'Version 1',
      changeReason: 'v1',
      changeSource: 'manual',
    });

    const v2 = versioning.propose({
      promptKey: 'brain.routing',
      newContent: 'Version 2',
      changeReason: 'v2',
      changeSource: 'brain',
    });

    expect(v2.version).toBe(2);
    expect(v2.previousVersionId).not.toBeNull();

    const active = versioning.getActiveVersion('brain.routing');
    expect(active?.version).toBe(2);
    expect(active?.content).toBe('Version 2');

    const history = versioning.getVersionHistory('brain.routing');
    expect(history).toHaveLength(2);
    expect(history[0].status).toBe('active');
    expect(history[1].status).toBe('superseded');
  });

  it('rolls back to previous version', () => {
    versioning.propose({
      promptKey: 'brain.review',
      newContent: 'Good prompt',
      changeReason: 'initial',
      changeSource: 'manual',
    });
    versioning.propose({
      promptKey: 'brain.review',
      newContent: 'Bad prompt',
      changeReason: 'brain suggested change',
      changeSource: 'brain',
    });

    const rolled = versioning.rollback('brain.review', 'metrics worsened');
    expect(rolled?.content).toBe('Good prompt');
    expect(rolled?.version).toBe(1);
    expect(rolled?.status).toBe('active');

    const history = versioning.getVersionHistory('brain.review');
    const rolledBack = history.find(v => v.version === 2);
    expect(rolledBack?.status).toBe('rolled_back');
  });

  it('returns null when rolling back with no previous version', () => {
    versioning.propose({
      promptKey: 'single',
      newContent: 'only one',
      changeReason: 'first',
      changeSource: 'manual',
    });

    const result = versioning.rollback('single');
    expect(result).toBeNull();
  });

  it('records metrics after adoption', () => {
    const v = versioning.propose({
      promptKey: 'brain.routing',
      newContent: 'test',
      changeReason: 'test',
      changeSource: 'learning',
      currentMetrics: { fallbackRate: 0.3 },
    });

    versioning.recordMetricsAfterAdoption(v.id, { fallbackRate: 0.15 });

    const active = versioning.getActiveVersion('brain.routing');
    expect(active?.metricsAtCreation).toContain('0.3');
    expect(active?.metricsAfterAdoption).toContain('0.15');
  });

  it('handles multiple prompt keys independently', () => {
    versioning.propose({ promptKey: 'routing', newContent: 'R1', changeReason: '', changeSource: 'manual' });
    versioning.propose({ promptKey: 'review', newContent: 'V1', changeReason: '', changeSource: 'manual' });
    versioning.propose({ promptKey: 'routing', newContent: 'R2', changeReason: '', changeSource: 'brain' });

    expect(versioning.getActiveVersion('routing')?.content).toBe('R2');
    expect(versioning.getActiveVersion('review')?.content).toBe('V1');
  });
});
