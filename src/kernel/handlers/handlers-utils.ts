/**
 * 16.0 重构——unified-handlers 通用 utility（从 unified-handlers.ts 提取）。
 *
 * 输入校验 + channel 回写 helpers，供 routeUserMessage / handleMessage / handler 定义共用。
 */
import type { MessageContext } from '../../contracts/messages.js';
import type { PermissionMode } from '../../safety/permissions.js';

/** 错误消息提取 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 必填字符串校验（空串/非 string → undefined） */
export function requireString(request: Record<string, unknown>, field: string): string | undefined {
  const val = request[field];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

/** 合法的权限模式集合 */
export const VALID_MODES: readonly PermissionMode[] = ['ask', 'allow-all', 'deny-all', 'yolo'];

/** 规范化 permissionMode（非法/缺省 → defaultMode） */
export function resolveEffectiveMode(raw: string | undefined, defaultMode: PermissionMode): PermissionMode {
  return raw && (VALID_MODES as readonly string[]).includes(raw) ? raw as PermissionMode : defaultMode;
}

/** 必填字段批量校验（缺任一 → 回写错误 + null） */
export function requireFields(ctx: MessageContext, request: Record<string, unknown>, fields: string[]): string[] | null {
  const values: string[] = [];
  for (const f of fields) {
    const v = requireString(request, f);
    if (!v) {
      ctx.channel!.write(JSON.stringify({ ok: false, error: `缺少 ${f} 参数` }) + '\n');
      return null;
    }
    values.push(v);
  }
  return values;
}

/** channel 成功回写 */
export function reply(ctx: MessageContext, data: Record<string, unknown>): void {
  ctx.channel!.write(JSON.stringify(data) + '\n');
}

/** channel 错误回写 */
export function replyError(ctx: MessageContext, error: string): void {
  ctx.channel!.write(JSON.stringify({ ok: false, error }) + '\n');
}
