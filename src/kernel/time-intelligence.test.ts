import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TimeIntelligence } from './time-intelligence.js';

describe('TimeIntelligence', () => {
  let db: Database.Database;
  let ti: TimeIntelligence;

  beforeEach(() => {
    db = new Database(':memory:');
    ti = new TimeIntelligence(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('createPlan', () => {
    it('creates a plan with scheduled steps', () => {
      const plan = ti.createPlan({
        title: 'Deploy feature X',
        description: 'Staged rollout',
        createdBy: 'brain',
        steps: [
          { description: 'Run tests', triggerType: 'scheduled', triggerAt: Date.now() + 3600_000 },
          { description: 'Deploy to staging', triggerType: 'scheduled', triggerAt: Date.now() + 7200_000 },
          { description: 'Monitor for 1h', triggerType: 'deadline', triggerAt: Date.now() + 10800_000 },
        ],
      });

      expect(plan.id).toBeTruthy();
      expect(plan.status).toBe('active');
      expect(plan.steps).toHaveLength(3);
      expect(plan.steps[0].status).toBe('pending');
      expect(plan.steps[0].triggerType).toBe('scheduled');
    });

    it('creates a plan with conditional triggers', () => {
      const plan = ti.createPlan({
        title: 'Wait for CI',
        description: '',
        createdBy: 'user',
        steps: [
          { description: 'Wait for CI green', triggerType: 'conditional', triggerCondition: 'ci_status == green' },
          { description: 'Merge PR', triggerType: 'scheduled', triggerAt: Date.now() + 60_000, capability: 'merge_pr' },
        ],
      });

      expect(plan.steps[0].triggerCondition).toBe('ci_status == green');
      expect(ti.getConditionalTriggers()).toHaveLength(1);
    });
  });

  describe('getReadySteps', () => {
    it('returns steps whose trigger time has passed', () => {
      ti.createPlan({
        title: 'Past plan',
        description: '',
        createdBy: 'brain',
        steps: [
          { description: 'Should fire', triggerType: 'scheduled', triggerAt: Date.now() - 1000 },
          { description: 'Not yet', triggerType: 'scheduled', triggerAt: Date.now() + 999999 },
        ],
      });

      const ready = ti.getReadySteps();
      expect(ready).toHaveLength(1);
      expect(ready[0].description).toBe('Should fire');
    });
  });

  describe('completeStep', () => {
    it('marks step as completed', () => {
      const plan = ti.createPlan({
        title: 'Simple',
        description: '',
        createdBy: 'brain',
        steps: [{ description: 'Do thing', triggerType: 'scheduled', triggerAt: Date.now() - 1 }],
      });

      ti.completeStep(plan.steps[0].id, 'Done successfully');

      const plans = ti.getActivePlans();
      expect(plans).toHaveLength(0); // plan completed since all steps done
    });

    it('plan stays active if steps remain', () => {
      const plan = ti.createPlan({
        title: 'Multi',
        description: '',
        createdBy: 'brain',
        steps: [
          { description: 'Step 1', triggerType: 'scheduled', triggerAt: Date.now() - 1 },
          { description: 'Step 2', triggerType: 'scheduled', triggerAt: Date.now() + 99999 },
        ],
      });

      ti.completeStep(plan.steps[0].id, 'ok');

      const active = ti.getActivePlans();
      expect(active).toHaveLength(1);
    });
  });

  describe('cancelPlan', () => {
    it('cancels plan and skips pending steps', () => {
      const plan = ti.createPlan({
        title: 'To cancel',
        description: '',
        createdBy: 'brain',
        steps: [
          { description: 'A', triggerType: 'scheduled', triggerAt: Date.now() + 9999 },
          { description: 'B', triggerType: 'conditional', triggerCondition: 'x' },
        ],
      });

      ti.cancelPlan(plan.id);

      const active = ti.getActivePlans();
      expect(active).toHaveLength(0);
      expect(ti.getConditionalTriggers()).toHaveLength(0);
    });
  });

  describe('getExpiredDeadlines', () => {
    it('returns deadline steps that have passed', () => {
      ti.createPlan({
        title: 'Deadline test',
        description: '',
        createdBy: 'brain',
        steps: [
          { description: 'Expired deadline', triggerType: 'deadline', triggerAt: Date.now() - 5000 },
        ],
      });

      const expired = ti.getExpiredDeadlines();
      expect(expired).toHaveLength(1);
      expect(expired[0].description).toBe('Expired deadline');
    });
  });
});
