import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('time-intelligence');

export type PlanStatus = 'active' | 'completed' | 'cancelled' | 'expired';
export type TriggerType = 'scheduled' | 'conditional' | 'deadline';

export interface TimePlan {
  id: string;
  title: string;
  description: string;
  createdBy: 'brain' | 'user';
  status: PlanStatus;
  steps: PlanStep[];
  createdAt: number;
  completedAt: number | null;
}

export interface PlanStep {
  id: string;
  planId: string;
  order: number;
  description: string;
  triggerType: TriggerType;
  triggerAt: number | null;
  triggerCondition: string | null;
  capability: string | null;
  input: unknown;
  status: 'pending' | 'ready' | 'executing' | 'completed' | 'failed' | 'skipped';
  result: string | null;
  completedAt: number | null;
}

export interface ConditionalTrigger {
  planId: string;
  stepId: string;
  condition: string;
  checkIntervalMs: number;
  lastCheckedAt: number;
  deadlineAt: number | null;
}

export class TimeIntelligence {
  private conditionalTriggers: ConditionalTrigger[] = [];

  constructor(private readonly db: Database.Database) {
    this.ensureTables();
    this.loadConditionalTriggers();
  }

  createPlan(input: {
    title: string;
    description: string;
    createdBy: 'brain' | 'user';
    steps: Array<{
      description: string;
      triggerType: TriggerType;
      triggerAt?: number;
      triggerCondition?: string;
      capability?: string;
      input?: unknown;
    }>;
  }): TimePlan {
    const planId = genId('plan');
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO time_plans (id, title, description, created_by, status, created_at)
      VALUES (?, ?, ?, ?, 'active', ?)
    `).run(planId, input.title, input.description, input.createdBy, now);

    const steps: PlanStep[] = input.steps.map((s, i) => {
      const stepId = genId('step');
      this.db.prepare(`
        INSERT INTO time_plan_steps (id, plan_id, step_order, description, trigger_type, trigger_at, trigger_condition, capability, input_json, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(stepId, planId, i, s.description, s.triggerType, s.triggerAt ?? null, s.triggerCondition ?? null, s.capability ?? null, s.input ? JSON.stringify(s.input) : null);

      if (s.triggerType === 'conditional' && s.triggerCondition) {
        this.conditionalTriggers.push({
          planId,
          stepId,
          condition: s.triggerCondition,
          checkIntervalMs: 60_000,
          lastCheckedAt: 0,
          deadlineAt: s.triggerAt ?? null,
        });
      }

      return {
        id: stepId,
        planId,
        order: i,
        description: s.description,
        triggerType: s.triggerType,
        triggerAt: s.triggerAt ?? null,
        triggerCondition: s.triggerCondition ?? null,
        capability: s.capability ?? null,
        input: s.input ?? null,
        status: 'pending',
        result: null,
        completedAt: null,
      };
    });

    logger.info({ planId, title: input.title, stepCount: steps.length }, 'Time plan created');

    return { id: planId, title: input.title, description: input.description, createdBy: input.createdBy, status: 'active', steps, createdAt: now, completedAt: null };
  }

  getReadySteps(): PlanStep[] {
    const now = Date.now();
    try {
      const rows = this.db.prepare(`
        SELECT s.* FROM time_plan_steps s
        JOIN time_plans p ON p.id = s.plan_id
        WHERE p.status = 'active'
          AND s.status = 'pending'
          AND s.trigger_type = 'scheduled'
          AND s.trigger_at <= ?
        ORDER BY s.trigger_at ASC
      `).all(now) as Array<Record<string, unknown>>;
      return rows.map(rowToStep);
    } catch {
      return [];
    }
  }

  getExpiredDeadlines(): PlanStep[] {
    const now = Date.now();
    try {
      const rows = this.db.prepare(`
        SELECT s.* FROM time_plan_steps s
        JOIN time_plans p ON p.id = s.plan_id
        WHERE p.status = 'active'
          AND s.status = 'pending'
          AND s.trigger_type = 'deadline'
          AND s.trigger_at <= ?
        ORDER BY s.trigger_at ASC
      `).all(now) as Array<Record<string, unknown>>;
      return rows.map(rowToStep);
    } catch {
      return [];
    }
  }

  completeStep(stepId: string, result: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE time_plan_steps SET status = 'completed', result = ?, completed_at = ? WHERE id = ?
    `).run(result, now, stepId);

    // Check if all steps in plan are done
    const step = this.db.prepare(`SELECT plan_id FROM time_plan_steps WHERE id = ?`).get(stepId) as { plan_id: string } | undefined;
    if (step) {
      const remaining = this.db.prepare(`
        SELECT COUNT(*) as c FROM time_plan_steps WHERE plan_id = ? AND status IN ('pending', 'ready', 'executing')
      `).get(step.plan_id) as { c: number };
      if (remaining.c === 0) {
        this.db.prepare(`UPDATE time_plans SET status = 'completed', completed_at = ? WHERE id = ?`).run(now, step.plan_id);
        logger.info({ planId: step.plan_id }, 'Time plan completed');
      }
    }
  }

  failStep(stepId: string, error: string): void {
    this.db.prepare(`
      UPDATE time_plan_steps SET status = 'failed', result = ? WHERE id = ?
    `).run(error, stepId);
  }

  cancelPlan(planId: string): void {
    this.db.prepare(`UPDATE time_plans SET status = 'cancelled' WHERE id = ?`).run(planId);
    this.db.prepare(`UPDATE time_plan_steps SET status = 'skipped' WHERE plan_id = ? AND status = 'pending'`).run(planId);
    this.conditionalTriggers = this.conditionalTriggers.filter(t => t.planId !== planId);
  }

  getActivePlans(): TimePlan[] {
    try {
      const plans = this.db.prepare(`SELECT * FROM time_plans WHERE status = 'active' ORDER BY created_at DESC`).all() as Array<Record<string, unknown>>;
      return plans.map(p => {
        const steps = this.db.prepare(`SELECT * FROM time_plan_steps WHERE plan_id = ? ORDER BY step_order`).all(p.id as string) as Array<Record<string, unknown>>;
        return {
          id: p.id as string,
          title: p.title as string,
          description: p.description as string,
          createdBy: p.created_by as 'brain' | 'user',
          status: p.status as PlanStatus,
          steps: steps.map(rowToStep),
          createdAt: p.created_at as number,
          completedAt: p.completed_at as number | null,
        };
      });
    } catch {
      return [];
    }
  }

  getConditionalTriggers(): ConditionalTrigger[] {
    return this.conditionalTriggers;
  }

  private loadConditionalTriggers(): void {
    try {
      const rows = this.db.prepare(`
        SELECT s.id as step_id, s.plan_id, s.trigger_condition, s.trigger_at
        FROM time_plan_steps s
        JOIN time_plans p ON p.id = s.plan_id
        WHERE p.status = 'active'
          AND s.status = 'pending'
          AND s.trigger_type = 'conditional'
      `).all() as Array<Record<string, unknown>>;

      this.conditionalTriggers = rows.map(r => ({
        planId: r.plan_id as string,
        stepId: r.step_id as string,
        condition: r.trigger_condition as string,
        checkIntervalMs: 60_000,
        lastCheckedAt: 0,
        deadlineAt: r.trigger_at as number | null,
      }));
    } catch {
      this.conditionalTriggers = [];
    }
  }

  private ensureTables(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS time_plans (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL CHECK(created_by IN ('brain','user')),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled','expired')),
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          completed_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS time_plan_steps (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES time_plans(id),
          step_order INTEGER NOT NULL,
          description TEXT NOT NULL,
          trigger_type TEXT NOT NULL CHECK(trigger_type IN ('scheduled','conditional','deadline')),
          trigger_at INTEGER,
          trigger_condition TEXT,
          capability TEXT,
          input_json TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','executing','completed','failed','skipped')),
          result TEXT,
          completed_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON time_plan_steps(plan_id, step_order);
        CREATE INDEX IF NOT EXISTS idx_plan_steps_trigger ON time_plan_steps(trigger_type, trigger_at) WHERE status = 'pending';
      `);
    } catch {
      // tables may already exist
    }
  }
}

function rowToStep(row: Record<string, unknown>): PlanStep {
  return {
    id: row.id as string,
    planId: row.plan_id as string,
    order: row.step_order as number,
    description: row.description as string,
    triggerType: row.trigger_type as TriggerType,
    triggerAt: row.trigger_at as number | null,
    triggerCondition: row.trigger_condition as string | null,
    capability: row.capability as string | null,
    input: row.input_json ? JSON.parse(row.input_json as string) : null,
    status: row.status as PlanStep['status'],
    result: row.result as string | null,
    completedAt: row.completed_at as number | null,
  };
}
