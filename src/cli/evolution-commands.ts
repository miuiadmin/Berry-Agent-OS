import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { getSocketPath } from '../utils/paths.js';
import { getConsoleRenderer } from '../observability/console.js';
import { EvolutionEngine, EvolutionWorkflow } from '../evolution/index.js';
import { SkillsRegistry } from '../skills/index.js';
import { PluginRegistry } from '../plugins/index.js';
import { socketRequest, withDb, writeOutput } from './shared.js';

export function registerEvolutionCommands(program: Command): void {
  const evolution = program.command('evolution').description('自进化系统');

  evolution
    .command('run <message>')
    .description('手动触发一次能力自进化检查')
    .option('-s, --session <id>', '会话 ID', 'manual')
    .option('--assistant-response <text>', '助手回复文本', '')
    .option('--json', '以 JSON 格式输出')
    .action((message: string, opts) => {
      withDb((db) => {
        const engine = new EvolutionEngine(db);
        const result = engine.runAfterConversation({
          sessionId: opts.session,
          userMessage: message,
          assistantResponse: opts.assistantResponse,
        });
        writeOutput(opts.json, result, `自进化检查完成: ${result.proposals.length} 个提案`);
      });
    });

  evolution
    .command('proposals')
    .description('列出自进化提案')
    .option('--json', '以 JSON 格式输出')
    .action((opts) => {
      withDb((db) => {
        const rows = new EvolutionEngine(db).listProposals();
        writeOutput(opts.json, rows, rows.length === 0 ? '暂无自进化提案' : `自进化提案数量: ${rows.length}`);
      });
    });

  evolution
    .command('validate <proposalId>')
    .description('验证自进化提案')
    .option('--json', '以 JSON 格式输出')
    .action((proposalId: string, opts) => {
      withDb((db) => {
        const proposal = new EvolutionWorkflow(db).validate(proposalId);
        writeOutput(opts.json, proposal, `提案验证完成: ${proposal.status}`);
        if (proposal.status === 'failed') process.exitCode = 1;
      });
    });

  evolution
    .command('approve <proposalId>')
    .description('批准自进化提案')
    .option('--enable', '批准后直接启用低/中风险插件')
    .option('--reviewer <name>', '审核来源', 'manual')
    .option('--json', '以 JSON 格式输出')
    .action((proposalId: string, opts) => {
      withDb((db) => {
        const proposal = new EvolutionWorkflow(db).approve(proposalId, {
          enable: opts.enable ?? false,
          reviewer: opts.reviewer,
        });
        writeOutput(opts.json, proposal, `提案已批准: ${proposal.status}`);
      });
    });

  evolution
    .command('reject <proposalId>')
    .description('拒绝自进化提案')
    .requiredOption('--reason <text>', '拒绝原因')
    .option('--json', '以 JSON 格式输出')
    .action((proposalId: string, opts) => {
      withDb((db) => {
        const proposal = new EvolutionWorkflow(db).reject(proposalId, opts.reason);
        writeOutput(opts.json, proposal, '提案已拒绝');
      });
    });

  evolution
    .command('rollback <proposalId>')
    .description('回滚自进化提案')
    .option('--reason <text>', '回滚原因', '用户请求回滚')
    .option('--json', '以 JSON 格式输出')
    .action((proposalId: string, opts) => {
      withDb((db) => {
        const proposal = new EvolutionWorkflow(db).rollback(proposalId, opts.reason);
        writeOutput(opts.json, proposal, '提案已回滚');
      });
    });

  evolution
    .command('dispatch <taskType>')
    .description('通过 Berry Service 派发自进化二级 Agent 任务')
    .option('-s, --session <id>', '会话 ID', 'manual')
    .option('--message <text>', 'learning_review 的用户消息')
    .option('--proposal-id <id>', 'skill_task/plugin_task 的提案 ID')
    .option('--enable', 'plugin_task 批准后启用')
    .option('--use-llm', '让二级 Agent 通过统一 LLM API 进行增强审查')
    .option('--json', '以 JSON 格式输出')
    .action(async (taskType: string, opts) => {
      const renderer = getConsoleRenderer();
      const socketPath = getSocketPath();
      if (!existsSync(socketPath)) {
        const payload = { ok: false, error: 'Berry 服务未在运行，请先执行 berry service start' };
        if (opts.json) renderer.json(payload);
        else renderer.error(payload.error);
        process.exitCode = 40;
        return;
      }
      const inputPayload: Record<string, unknown> = {};
      if (opts.message) inputPayload.message = opts.message;
      if (opts.proposalId) inputPayload.proposalId = opts.proposalId;
      if (opts.enable) inputPayload.enable = true;
      if (opts.useLlm) inputPayload.useLlm = true;
      const result = await socketRequest(socketPath, {
        type: 'evolution.dispatch',
        taskType,
        sessionId: opts.session,
        requester: 'cli',
        inputPayload,
      });
      if (opts.json) renderer.json(result);
      else if (result.ok) renderer.info(`任务已派发: ${result.taskId}`);
      else renderer.error(`派发失败: ${result.error}`);
      if (!result.ok) process.exitCode = 1;
    });

  const skills = evolution.command('skills').description('技能自进化');
  skills
    .command('list')
    .description('列出技能')
    .option('--json', '以 JSON 格式输出')
    .action((opts) => {
      withDb((db) => {
        const rows = new SkillsRegistry(db).list();
        writeOutput(opts.json, rows, rows.length === 0 ? '暂无技能' : `技能数量: ${rows.length}`);
      });
    });

  skills
    .command('show <name>')
    .description('查看技能内容')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const registry = new SkillsRegistry(db);
        const content = registry.load(name);
        writeOutput(opts.json, { name, content }, content);
      });
    });

  const plugins = evolution.command('plugins').description('插件自进化');
  plugins
    .command('list')
    .description('列出插件')
    .option('--json', '以 JSON 格式输出')
    .action((opts) => {
      withDb((db) => {
        const rows = new PluginRegistry(db).list();
        writeOutput(opts.json, rows, rows.length === 0 ? '暂无插件' : `插件数量: ${rows.length}`);
      });
    });

  plugins
    .command('validate <name>')
    .description('验证插件草稿')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const result = new PluginRegistry(db).validate(name);
        writeOutput(opts.json, result, result.ok ? '插件验证通过' : `插件验证失败: ${result.errors.join('; ')}`);
        if (!result.ok) process.exitCode = 1;
      });
    });

  plugins
    .command('enable <name>')
    .description('启用插件')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const plugin = new PluginRegistry(db).enable(name);
        writeOutput(opts.json, plugin, `插件已启用: ${plugin.name}`);
      });
    });

  plugins
    .command('disable <name>')
    .description('禁用插件')
    .option('--reason <text>', '禁用原因', '手动禁用')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const plugin = new PluginRegistry(db).disable(name, opts.reason);
        writeOutput(opts.json, plugin, `插件已禁用: ${plugin.name}`);
      });
    });

  plugins
    .command('rollback <name>')
    .description('回滚插件')
    .option('--reason <text>', '回滚原因', '手动回滚')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const plugin = new PluginRegistry(db).rollback(name, opts.reason);
        writeOutput(opts.json, plugin, `插件已回滚: ${plugin.name}`);
      });
    });
}
