import { z } from 'zod';

export const CronConfigSchema = z.object({
  enabled: z.boolean().default(false),
  checkIntervalMs: z.number().default(15_000),
  defaultTimeoutMs: z.number().default(60_000),
  scriptTimeoutMs: z.number().default(30_000),
  maxOutputChars: z.number().default(8_000),
  retryAttempts: z.number().default(3),
  retryDelaysMs: z.array(z.number()).default([5_000, 10_000, 30_000]),
});

export type CronConfig = z.infer<typeof CronConfigSchema>;

export interface ScheduledTaskRow {
  id: string;
  cron: string;
  description: string;
  prompt: string | null;
  skill_name: string | null;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  script: string | null;
  workdir: string | null;
  delivery_channel: string | null;
  delivery_target: string | null;
}

export interface ScriptResult {
  ok: boolean;
  output: string;
  wakeAgent: boolean;
}

export interface RunningJob {
  taskId: string;
  attempt: number;
  startedAt: number;
  abort: AbortController;
}
