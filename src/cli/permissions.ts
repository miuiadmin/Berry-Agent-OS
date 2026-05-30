import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { getSocketPath } from '../utils/paths.js';
import { getConsoleRenderer } from '../observability/console.js';
import { socketRequest } from './service-commands.js';

export function registerPermissionCommands(program: Command): void {
  const permissions = program.command('permissions').description('管理待处理权限审批');

  permissions
    .command('list')
    .description('列出 pending 权限审批')
    .option('-s, --session <id>', '按会话过滤')
    .option('--json', '以 JSON 格式输出')
    .action(async (opts) => {
      const renderer = getConsoleRenderer();
      const socketPath = getSocketPath();
      if (!existsSync(socketPath)) {
        renderer.error('Berry 服务未在运行');
        process.exitCode = 10;
        return;
      }

      const response = await socketRequest(socketPath, {
        type: 'permissions.list',
        sessionId: opts.session,
      });

      if (opts.json) {
        renderer.json(response);
        return;
      }

      const pending = response.pending as Array<Record<string, unknown>> | undefined;
      if (!pending || pending.length === 0) {
        renderer.info('当前没有待处理权限审批');
        return;
      }
      for (const req of pending) {
        renderer.info(`${req.id} ${req.kind} ${req.riskLevel} ${req.requester}`);
      }
    });

  permissions
    .command('approve <requestId>')
    .description('批准权限审批')
    .option('--session-token', '批准为会话级令牌')
    .option('--reason <text>', '审批理由')
    .option('--json', '以 JSON 格式输出')
    .action((requestId: string, opts) => resolvePermission('permissions.approve', requestId, opts));

  permissions
    .command('deny <requestId>')
    .description('拒绝权限审批')
    .option('--reason <text>', '审批理由')
    .option('--json', '以 JSON 格式输出')
    .action((requestId: string, opts) => resolvePermission('permissions.deny', requestId, opts));

  permissions
    .command('cancel <requestId>')
    .description('取消权限审批')
    .option('--reason <text>', '取消理由')
    .option('--json', '以 JSON 格式输出')
    .action((requestId: string, opts) => resolvePermission('permissions.cancel', requestId, opts));
}

async function resolvePermission(
  type: 'permissions.approve' | 'permissions.deny' | 'permissions.cancel',
  requestId: string,
  opts: { sessionToken?: boolean; reason?: string; json?: boolean },
): Promise<void> {
  const renderer = getConsoleRenderer();
  const socketPath = getSocketPath();
  if (!existsSync(socketPath)) {
    renderer.error('Berry 服务未在运行');
    process.exitCode = 10;
    return;
  }

  const response = await socketRequest(socketPath, {
    type,
    requestId,
    reason: opts.reason,
    allowSession: opts.sessionToken ?? false,
  });

  if (opts.json) {
    renderer.json(response);
    return;
  }

  renderer.info(response.ok ? '权限审批已处理' : '权限审批处理失败');
}
