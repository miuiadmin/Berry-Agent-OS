import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import type { IpcChildChannel } from '../contracts/infrastructure.js';
import { MODEL_TIERS } from '../contracts/model.js';

const SwitchModelSchema = z.object({
  tier: z.enum(MODEL_TIERS).describe('目标模型层级: fast(快速轻量) / default(默认平衡) / high(最强能力)'),
});

export function createModelTools(ipc: IpcChildChannel, sessionRef: { id: string }, requestTimeoutMs: number): ToolDefinition[] {
  const switchModelTool: ToolDefinition = {
    name: 'switch_model',
    description: '切换当前会话的模型层级。fast=快速轻量适合简单问题，default=默认平衡，high=最强能力适合复杂推理和代码。当用户要求使用更强/更快的模型时调用。',
    inputSchema: SwitchModelSchema,
    dangerLevel: 'safe',
    async execute(input: unknown): Promise<ToolResult> {
      const { tier } = input as z.infer<typeof SwitchModelSchema>;
      try {
        const response = await ipc.request('model.override', 'core', { sessionId: sessionRef.id, tier }, requestTimeoutMs);
        const payload = response.payload as { ok: boolean; error?: string };
        if (!payload.ok) {
          return { content: payload.error ?? '切换失败', isError: true };
        }
        const tierNames: Record<string, string> = { fast: '快速轻量', default: '默认平衡', high: '最强能力' };
        return { content: `已切换到 ${tier}（${tierNames[tier]}）模型层级，后续回复将使用该层级对应的模型。` };
      } catch (err) {
        return { content: `模型切换失败: ${(err as Error).message}`, isError: true };
      }
    },
  };

  return [switchModelTool];
}
