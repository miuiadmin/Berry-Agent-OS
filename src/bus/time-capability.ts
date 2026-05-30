import type { CapabilityBus } from './capability-bus.js';
import type { CapabilityExecutor } from './contract.js';
import type { TimeIntelligence } from '../kernel/time-intelligence.js';

export function registerTimeIntelligenceCapabilities(bus: CapabilityBus, ti: TimeIntelligence): void {
  const createPlan: CapabilityExecutor = async (input) => {
    const { title, description, steps, createdBy } = input as {
      title: string;
      description?: string;
      createdBy?: 'brain' | 'user';
      steps: Array<{
        description: string;
        triggerType: 'scheduled' | 'conditional' | 'deadline';
        triggerAt?: number;
        triggerCondition?: string;
        capability?: string;
        input?: unknown;
      }>;
    };
    const plan = ti.createPlan({
      title,
      description: description ?? '',
      createdBy: createdBy ?? 'brain',
      steps,
    });
    return { planId: plan.id, stepCount: plan.steps.length };
  };

  bus.register({
    name: 'system:create_plan',
    description: 'Create a time-based plan with scheduled/conditional/deadline steps. Brain uses this to plan future work.',
    dangerLevel: 'safe',
    provider: { type: 'builtin', name: 'time-intelligence' },
  }, createPlan);

  const getPlans: CapabilityExecutor = async () => {
    const plans = ti.getActivePlans();
    return plans.map(p => ({
      id: p.id,
      title: p.title,
      status: p.status,
      stepCount: p.steps.length,
      completedSteps: p.steps.filter(s => s.status === 'completed').length,
      createdAt: p.createdAt,
    }));
  };

  bus.register({
    name: 'system:get_active_plans',
    description: 'List all active time plans with their progress.',
    dangerLevel: 'safe',
    provider: { type: 'builtin', name: 'time-intelligence' },
  }, getPlans);

  const cancelPlan: CapabilityExecutor = async (input) => {
    const { planId } = input as { planId: string };
    ti.cancelPlan(planId);
    return { cancelled: true, planId };
  };

  bus.register({
    name: 'system:cancel_plan',
    description: 'Cancel an active time plan and skip all pending steps.',
    dangerLevel: 'moderate',
    provider: { type: 'builtin', name: 'time-intelligence' },
  }, cancelPlan);
}
