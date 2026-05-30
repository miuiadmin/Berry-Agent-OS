import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { getSocketPath } from '../utils/paths.js';
import { getConsoleRenderer } from '../observability/console.js';
import { socketRequest } from './service-commands.js';

export function registerAgentCommands(program: Command): void {
  const agents = program.command('agents').description('管理 Agent 生命周期');

  agents
    .command('list')
    .description('列出所有 Agent')
    .option('--json', '以 JSON 格式输出')
    .option('--status <status>', '按状态过滤')
    .option('--source <source>', '按来源过滤')
    .action(async (opts) => {
      const renderer = getConsoleRenderer();
      const response = await sendAgentRequest('agents.list', {
        status: opts.status,
        source: opts.source,
      });
      if (!response.ok) {
        renderer.error(response.error as string);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        renderer.json(response);
        return;
      }
      const rows = response.agents as Array<{ name: string; version: string; status: string; source: string; kind: string }>;
      if (rows.length === 0) {
        renderer.info('暂无已注册的 Agent');
        return;
      }
      renderer.info(`共 ${rows.length} 个 Agent:\n`);
      for (const row of rows) {
        renderer.info(`  ${row.name}  v${row.version}  [${row.kind}]  ${row.status}  (${row.source})`);
      }
    });

  agents
    .command('inspect <name>')
    .description('查看 Agent 详情')
    .option('--json', '以 JSON 格式输出')
    .action(async (name: string, opts) => {
      const renderer = getConsoleRenderer();
      const response = await sendAgentRequest('agents.inspect', { name });
      if (!response.ok) {
        renderer.error(response.error as string);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        renderer.json(response);
        return;
      }
      const agent = response.agent as Record<string, unknown>;
      renderer.info(`名称: ${agent.name}`);
      renderer.info(`版本: ${agent.version}`);
      renderer.info(`类型: ${agent.kind}`);
      renderer.info(`状态: ${agent.status}`);
      renderer.info(`来源: ${agent.source}`);
      renderer.info(`运行中: ${agent.running ? '是' : '否'}`);
      renderer.info(`描述: ${agent.description}`);
    });

  agents
    .command('install <dir>')
    .description('安装 Agent（指定包含 agent.json 的目录）')
    .option('--json', '以 JSON 格式输出')
    .action(async (dir: string, opts) => {
      const renderer = getConsoleRenderer();
      const absDir = resolve(dir);
      if (!existsSync(absDir)) {
        renderer.error(`目录不存在: ${absDir}`);
        process.exitCode = 1;
        return;
      }
      const response = await sendAgentRequest('agents.install', { dir: absDir });
      if (!response.ok) {
        renderer.error(response.error as string);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        renderer.json(response);
        return;
      }
      renderer.info(`已安装 Agent: ${response.name}`);
    });

  agents
    .command('remove <name>')
    .description('移除 Agent')
    .option('--force', '强制移除（忽略进行中的任务）')
    .option('--json', '以 JSON 格式输出')
    .action(async (name: string, opts) => {
      const renderer = getConsoleRenderer();
      const response = await sendAgentRequest('agents.remove', { name, force: opts.force === true });
      if (!response.ok) {
        renderer.error(response.error as string);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        renderer.json(response);
        return;
      }
      renderer.info(`已移除 Agent: ${name}`);
    });

  agents
    .command('upgrade <name>')
    .description('升级 Agent（重新加载磁盘 manifest）')
    .option('--json', '以 JSON 格式输出')
    .action(async (name: string, opts) => {
      const renderer = getConsoleRenderer();
      const response = await sendAgentRequest('agents.upgrade', { name });
      if (!response.ok) {
        renderer.error(response.error as string);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        renderer.json(response);
        return;
      }
      renderer.info(`已升级 Agent: ${name} (${response.fromVersion} → ${response.toVersion})`);
    });

  agents
    .command('enable <name>')
    .description('启用 Agent')
    .option('--json', '以 JSON 格式输出')
    .action(async (name: string, opts) => {
      const renderer = getConsoleRenderer();
      const response = await sendAgentRequest('agents.enable', { name });
      if (!response.ok) {
        renderer.error(response.error as string);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        renderer.json(response);
        return;
      }
      renderer.info(`已启用 Agent: ${name}`);
    });

  agents
    .command('disable <name>')
    .description('禁用 Agent')
    .option('--reason <text>', '禁用原因')
    .option('--json', '以 JSON 格式输出')
    .action(async (name: string, opts) => {
      const renderer = getConsoleRenderer();
      const response = await sendAgentRequest('agents.disable', { name, reason: opts.reason });
      if (!response.ok) {
        renderer.error(response.error as string);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        renderer.json(response);
        return;
      }
      renderer.info(`已禁用 Agent: ${name}`);
    });

  agents
    .command('reload')
    .description('重新扫描用户 Agent 目录')
    .option('--json', '以 JSON 格式输出')
    .action(async (opts) => {
      const renderer = getConsoleRenderer();
      const response = await sendAgentRequest('agents.reload', {});
      if (!response.ok) {
        renderer.error(response.error as string);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        renderer.json(response);
        return;
      }
      const discovered = response.discovered as string[];
      const upgraded = response.upgraded as string[];
      if (discovered.length === 0 && upgraded.length === 0) {
        renderer.info('未发现新 Agent 或需要升级的 Agent');
      } else {
        if (discovered.length > 0) renderer.info(`新发现: ${discovered.join(', ')}`);
        if (upgraded.length > 0) renderer.info(`已升级: ${upgraded.join(', ')}`);
      }
    });
}

async function sendAgentRequest(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const socketPath = getSocketPath();
  if (!existsSync(socketPath)) {
    return { ok: false, error: 'Berry 服务未在运行' };
  }
  try {
    return await socketRequest(socketPath, { type, ...payload });
  } catch {
    return { ok: false, error: '无法连接 Berry 服务' };
  }
}
