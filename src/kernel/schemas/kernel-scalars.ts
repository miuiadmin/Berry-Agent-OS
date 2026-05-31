import { z } from 'zod';

/** Scalar kernel config fields (not section objects) */
export const KernelScalarsSchema = z.object({
  heartbeatIntervalMs: z.number().default(5000),
  heartbeatTimeoutMs: z.number().default(30000),
  requestTimeoutMs: z.number().default(30000),
  permissionMode: z.enum(['ask', 'allow-all', 'deny-all']).default('allow-all'),
});
