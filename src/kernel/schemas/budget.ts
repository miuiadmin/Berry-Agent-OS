import { z } from 'zod';

export const BudgetConfigSchema = z.object({
  sessionLimit: z.number().default(500_000),
  agentLimit: z.number().default(200_000),
  taskLimit: z.number().default(100_000),
  dailyLimit: z.number().default(2_000_000),
  alertThresholds: z.object({
    info: z.number().default(0.5),
    warning: z.number().default(0.75),
    critical: z.number().default(0.9),
  }).default({ info: 0.5, warning: 0.75, critical: 0.9 }),
  costPerInputToken: z.number().default(0.000003),
  costPerOutputToken: z.number().default(0.000015),
  /** 每模型定价覆盖（可选） */
  modelCosts: z.record(z.string(), z.object({
    inputTokenCost: z.number(),
    outputTokenCost: z.number(),
  })).optional(),
  /** 告警消息语言 */
  locale: z.enum(['zh', 'en']).default('zh'),
});

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
