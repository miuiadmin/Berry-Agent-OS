import { z } from 'zod';

/** Scalar config values that live at the top level of AppConfig */
export const KernelScalarsSchema = z.object({
  heartbeatIntervalMs: z.number().default(5000),
  heartbeatTimeoutMs: z.number().default(30000),
  requestTimeoutMs: z.number().default(30000),
  permissionMode: z.enum(['ask', 'allow-all', 'deny-all', 'yolo']).default('allow-all'),
});
