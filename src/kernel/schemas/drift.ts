import { z } from 'zod';

/** 单个检测点的阈值 schema */
const ThresholdEntrySchema = z.object({
  warnBelow: z.number().min(0).max(1),
  blockBelow: z.number().min(0).max(1),
});

/** 12.0 漂移检测配置 schema */
export const DriftConfigSchema = z.object({
  /** 是否启用漂移检测（默认启用） */
  enabled: z.boolean().default(true),
  /** 各检测点的阈值配置 */
  thresholds: z.object({
    dialogue: ThresholdEntrySchema.default({ warnBelow: 0.5, blockBelow: 0.3 }),
    task_result: ThresholdEntrySchema.default({ warnBelow: 0.6, blockBelow: 0.4 }),
    final_response: ThresholdEntrySchema.default({ warnBelow: 0.7, blockBelow: 0.5 }),
  }).default({
    dialogue: { warnBelow: 0.5, blockBelow: 0.3 },
    task_result: { warnBelow: 0.6, blockBelow: 0.4 },
    final_response: { warnBelow: 0.7, blockBelow: 0.5 },
  }),
  /** 对话中每隔几轮触发语义检测 */
  dialogueCheckInterval: z.number().int().min(1).default(3),
  /** 是否启用 Verify Gate（高偏离时的同步阻断验证） */
  verifyGateEnabled: z.boolean().default(true),
  /** 哪些级别走同步 Brain 审核（D 级始终同步） */
  syncReviewLevels: z.array(z.enum(['B', 'C'])).default([]),
});
