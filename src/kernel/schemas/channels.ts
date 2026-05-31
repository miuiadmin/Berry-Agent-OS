import { z } from 'zod';

const TelegramChannelSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().default(''),
  pollingInterval: z.number().default(1000),
  allowedUserIds: z.array(z.string()).default([]),
});

export const ChannelsConfigSchema = z.object({
  telegram: z.prefault(TelegramChannelSchema, {}),
});

export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;
