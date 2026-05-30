import type { Command } from 'commander';
import type { Database } from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SkillsRegistry } from '../skills/index.js';
import { PluginRegistry, getPluginContract, getPluginManifestJsonSchema } from '../plugins/index.js';
import { EvolutionProposalStore, EvolutionWorkflow } from '../evolution/index.js';
import { withDb, writeOutput } from './shared.js';

export function registerCapabilityCommands(program: Command): void {
  registerSkillsCommands(program.command('skills').description('管理技能'));
  registerPluginsCommands(program.command('plugins').description('管理插件'));
}

export function registerSkillsCommands(skills: Command): void {
  skills
    .command('create <name>')
    .description('创建用户技能')
    .requiredOption('--description <text>', '技能描述')
    .option('--content <text>', '完整 SKILL.md 内容')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const skill = new SkillsRegistry(db).createUserSkill({
          name,
          description: opts.description,
          content: opts.content,
        });
        writeOutput(opts.json, skill, `技能已创建: ${skill.name}`);
      });
    });

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
    .command('get <name>')
    .alias('show')
    .description('查看技能内容')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const registry = new SkillsRegistry(db);
        const content = registry.load(name);
        writeOutput(opts.json, { name, content }, content);
      });
    });

  skills
    .command('path <name>')
    .description('输出技能文件路径')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const skill = new SkillsRegistry(db).get(name);
        if (!skill) throw new Error(`技能不存在: ${name}`);
        writeOutput(opts.json, { name, path: skill.filePath }, skill.filePath);
      });
    });

  skills
    .command('enable <name>')
    .description('启用技能')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const skill = new SkillsRegistry(db).setDisabled(name, false);
        writeOutput(opts.json, skill, `技能已启用: ${skill.name}`);
      });
    });

  skills
    .command('disable <name>')
    .description('禁用技能')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const skill = new SkillsRegistry(db).setDisabled(name, true);
        writeOutput(opts.json, skill, `技能已禁用: ${skill.name}`);
      });
    });

  skills
    .command('delete <name>')
    .description('删除技能索引，可选删除文件')
    .option('--remove-files', '同时删除技能目录')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const skill = new SkillsRegistry(db).delete(name, { removeFiles: opts.removeFiles ?? false });
        writeOutput(opts.json, skill, `技能已删除: ${skill.name}`);
      });
    });

  skills
    .command('reload')
    .description('重新扫描技能目录')
    .option('--json', '以 JSON 格式输出')
    .action((opts) => {
      withDb((db) => {
        const rows = new SkillsRegistry(db).reload();
        writeOutput(opts.json, rows, `技能已重新加载: ${rows.length} 个`);
      });
    });

  skills
    .command('stats')
    .description('输出技能统计')
    .option('--json', '以 JSON 格式输出')
    .action((opts) => {
      withDb((db) => {
        const stats = new SkillsRegistry(db).stats();
        writeOutput(opts.json, stats, JSON.stringify(stats, null, 2));
      });
    });
}

export function registerPluginsCommands(plugins: Command): void {
  plugins
    .command('contract')
    .description('输出 AI 可读插件契约')
    .option('--json', '以 JSON 格式输出')
    .action((opts) => writeOutput(opts.json ?? true, getPluginContract(), '已输出插件契约'));

  plugins
    .command('schema')
    .description('输出 plugin.json JSON Schema')
    .option('--json', '以 JSON 格式输出')
    .action((opts) => writeOutput(opts.json ?? true, getPluginManifestJsonSchema(), '已输出插件 Schema'));

  plugins
    .command('scaffold <name>')
    .description('生成插件草稿')
    .requiredOption('--description <text>', '插件描述')
    .option('--risk-level <level>', '风险等级: low, medium, high', 'low')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const registry = new PluginRegistry(db);
        const result = registry.createDraft({
          name,
          description: opts.description,
          riskLevel: opts.riskLevel,
          evidence: ['CLI scaffold'],
        });
        writeOutput(opts.json, result, `插件草稿已生成: ${result.manifest.name}`);
      });
    });

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
    .command('inspect <name>')
    .description('查看插件 manifest、权限、工具和状态')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const inspection = new PluginRegistry(db).inspect(name);
        writeOutput(opts.json, inspection, JSON.stringify(inspection, null, 2));
      });
    });

  plugins
    .command('get <name>')
    .description('输出插件 entry.ts 内容')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const plugin = new PluginRegistry(db).get(name);
        if (!plugin) throw new Error(`插件不存在: ${name}`);
        const content = readFileSync(plugin.entryPath, 'utf-8');
        writeOutput(opts.json, { name, content, path: plugin.entryPath }, content);
      });
    });

  plugins
    .command('path <name>')
    .description('输出插件目录路径')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const plugin = new PluginRegistry(db).get(name);
        if (!plugin) throw new Error(`插件不存在: ${name}`);
        writeOutput(opts.json, { name, path: plugin.pluginDir }, plugin.pluginDir);
      });
    });

  plugins
    .command('validate <name>')
    .description('验证插件')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const result = new PluginRegistry(db).validate(name);
        writeOutput(opts.json, result, result.ok ? '插件验证通过' : `插件验证失败: ${result.errors.join('; ')}`);
        if (!result.ok) process.exitCode = 1;
      });
    });

  plugins
    .command('test <name>')
    .description('执行插件 fixture 测试')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const result = new PluginRegistry(db).runFixtures(name);
        writeOutput(opts.json, result, result.ok ? `插件测试通过: ${result.passed}/${result.total}` : `插件测试失败: ${result.failed}/${result.total}`);
        if (!result.ok) process.exitCode = 1;
      });
    });

  plugins
    .command('dry-run <name> <tool>')
    .description('使用受控 fixture runtime 试运行插件工具')
    .option('--input-json <json>', 'JSON 输入', '{}')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, tool: string, opts) => {
      withDb((db) => {
        const input = parseJsonObject(opts.inputJson);
        const result = new PluginRegistry(db).dryRun(name, tool, input);
        writeOutput(opts.json, result, result.ok ? `插件试运行通过: ${tool}` : `插件试运行失败: ${result.error}`);
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

  plugins
    .command('propose <name>')
    .description('把已有插件草稿提交为自进化提案')
    .option('--source <source>', '提案来源', 'manual')
    .option('--reason <text>', '提案原因', '用户提交插件提案')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const registry = new PluginRegistry(db);
        const plugin = registry.get(name);
        if (!plugin) throw new Error(`插件不存在: ${name}`);
        const validation = registry.validate(name);
        const proposal = new EvolutionProposalStore(db).create({
          type: 'plugin_create',
          source: parseProposalSource(opts.source),
          targetName: plugin.name,
          draftPath: plugin.pluginDir,
          evidence: {
            observations: [opts.reason],
            confidence: validation.ok ? 0.8 : 0.4,
          },
          validatorResult: { ...validation },
          riskLevel: plugin.riskLevel,
          status: validation.ok ? 'pending_review' : 'failed',
          reason: validation.ok ? opts.reason : validation.errors.join('; '),
        });
        writeOutput(opts.json, proposal, `插件提案已创建: ${proposal.id}`);
      });
    });

  plugins
    .command('approve <name>')
    .description('批准插件提案，可选直接启用')
    .option('--enable', '批准后启用低/中风险插件')
    .option('--reviewer <name>', '审核来源', 'manual')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const proposal = findLatestPluginProposal(db, name);
        const approved = new EvolutionWorkflow(db).approve(proposal.id, {
          enable: opts.enable ?? false,
          reviewer: opts.reviewer,
        });
        writeOutput(opts.json, approved, `插件提案已批准: ${approved.status}`);
      });
    });

  plugins
    .command('delete <name>')
    .description('删除插件索引，可选删除文件')
    .option('--remove-files', '同时删除插件目录')
    .option('--json', '以 JSON 格式输出')
    .action((name: string, opts) => {
      withDb((db) => {
        const plugin = new PluginRegistry(db).delete(name, { removeFiles: opts.removeFiles ?? false });
        writeOutput(opts.json, plugin, `插件已删除: ${plugin.name}`);
      });
    });

  plugins
    .command('reload')
    .description('重新扫描插件目录')
    .option('--json', '以 JSON 格式输出')
    .action((opts) => {
      withDb((db) => {
        const rows = new PluginRegistry(db).reload();
        writeOutput(opts.json, rows, `插件已重新加载: ${rows.length} 个`);
      });
    });

  plugins
    .command('stats')
    .description('输出插件统计')
    .option('--json', '以 JSON 格式输出')
    .action((opts) => {
      withDb((db) => {
        const stats = new PluginRegistry(db).stats();
        writeOutput(opts.json, stats, JSON.stringify(stats, null, 2));
      });
    });
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // handled below
  }
  throw new Error('输入必须是 JSON 对象');
}

function parseProposalSource(value: string): 'conversation' | 'tool_failure' | 'user_correction' | 'reference_source' | 'manual' {
  return value === 'conversation' || value === 'tool_failure' || value === 'user_correction' || value === 'reference_source'
    ? value
    : 'manual';
}

function findLatestPluginProposal(db: Database, name: string) {
  const proposal = new EvolutionProposalStore(db).list()
    .find((item) => item.targetName === name && item.type.startsWith('plugin_') && !['rejected', 'failed', 'rolled_back'].includes(item.status));
  if (!proposal) throw new Error(`插件没有可批准的提案: ${name}`);
  return proposal;
}
