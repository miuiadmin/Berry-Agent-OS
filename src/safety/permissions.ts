import type { DangerLevel } from '../utils/types.js';
import type { IPermissionEngine, PermissionCheckResult } from './contract.js';
import { checkBlocklist } from './blocklist.js';

export type PermissionMode = 'ask' | 'allow-all' | 'deny-all';

/**
 * 13.0 §5.3.6: 危险工具集合 — 使用这些工具必须先经用户确认（user_confirm）。
 *
 * fail-closed：列出在集合内的工具即使 dangerLevel='safe' 也走 user_confirm 流程。
 * AgentPort.useTool() 在执行前会通过 PermissionCoordinator 检查此集合。
 */
/**
 * 13.0 §5.3.6: 危险工具集合 — 使用这些工具必须先经用户确认（user_confirm）。
 *
 * fail-closed：列出在集合内的工具即使 dangerLevel='safe' 也走 user_confirm 流程。
 * AgentPort.useTool() 在执行前会通过 PermissionCoordinator 检查此集合。
 *
 * 集合构成：
 * 1. 已实现的实际工具名（run_command / write_file / edit_code / ...）
 * 2. §5.3.6 规范定义的抽象类别（http_request / send_email / send_message / db_migrate / db_write）
 *    —— 这些是 spec 规划中的工具类别，当前可能未实现，但加入集合可前向兼容：
 *    未来新增对应工具时自动获得危险分类，无需再改此处。
 */
export const DANGEROUS_TOOL_CATEGORIES = new Set<string>([
  // ─── 已实现的实际工具 ───
  'run_command',     // shell 执行（已有 blocklist，但 user_confirm 是另一道闸）
  'write_file',      // 文件覆盖（不可逆）
  'edit_code',       // 代码修改（不可逆）
  'delete_file',     // 文件删除（不可逆）
  'web_fetch',       // 外部网络访问（可能泄露数据）
  'http_fetch',      // 外部网络访问
  'send_notification', // 给用户发消息（可能被滥用）
  'cron_create',     // 创建定时任务（持久化副作用）
  'plugin_execute',  // 插件调用（沙箱外执行）
  // ─── §5.3.6 规范定义的抽象类别（前向兼容：未来工具自动归类） ───
  'http_request',    // 外部 API 调用（spec §5.3.6：白名单域名 + user.confirm）
  'send_email',      // 发送邮件（spec §5.3.6：必 user.confirm）
  'send_message',    // 发送消息到外部渠道（spec §5.3.6：必 user.confirm）
  'db_migrate',      // 数据库迁移（spec §5.3.6：必 user.confirm + 干跑模式）
  'db_write',        // 数据库写入（spec §5.3.6：必 user.confirm + 干跑模式）
]);

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

export class PermissionEngine implements IPermissionEngine {
  private mode: PermissionMode;
  /** 可选：覆盖默认的 DANGEROUS_TOOL_CATEGORIES */
  private dangerousTools: Set<string>;

  constructor(mode: PermissionMode, dangerousTools?: Set<string>) {
    this.mode = mode;
    this.dangerousTools = dangerousTools ?? DANGEROUS_TOOL_CATEGORIES;
  }

  /**
   * 13.0 §5.3.6: 判断工具是否属于危险类别。
   * @returns true 表示必须经 user_confirm 流程（即使 dangerLevel='safe'）
   */
  isDangerousTool(toolName: string): boolean {
    return this.dangerousTools.has(toolName);
  }

  /**
   * 列出当前所有危险工具（用于 UI 展示 / 测试）。
   */
  listDangerousTools(): string[] {
    return [...this.dangerousTools];
  }

  checkPermission(toolName: string, toolInput: string, dangerLevel: DangerLevel): PermissionCheckResult {
    // ① DANGEROUS_TOOL_CATEGORIES 命中：在 ask 模式下强制要求 user_confirm
    if (this.dangerousTools.has(toolName)) {
      if (this.mode === 'deny-all') {
        return { allowed: false, reason: `权限模式为 deny-all，危险工具 ${toolName} 被拒绝` };
      }
      // ask 模式 + dangerous → requiresReview（让上层走 user_confirm 流程）
      return {
        allowed: false,
        requiresReview: true,
        reason: `dangerous_tool:${toolName} 需要用户确认`,
      };
    }

    // ② run_command 的 blocklist 检查
    if (toolName === 'run_command') {
      const blockResult = checkBlocklist(toolInput);
      if (blockResult.blocked) {
        return { allowed: false, reason: blockResult.reason };
      }
    }

    switch (this.mode) {
      case 'deny-all':
        return { allowed: false, reason: '权限模式为 deny-all，所有工具调用被拒绝' };

      case 'allow-all':
        return { allowed: true };

      case 'ask':
        if (dangerLevel === 'safe') {
          return { allowed: true };
        }
        return { allowed: false, requiresReview: true, reason: 'ask 模式需要 Brain 审核' };
    }
  }

  getMode(): PermissionMode {
    return this.mode;
  }
}
