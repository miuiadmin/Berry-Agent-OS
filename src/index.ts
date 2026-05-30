#!/usr/bin/env node
import { Command } from 'commander';
import { registerServiceCommands, ensureServiceRunning } from './cli/service-commands.js';
import { registerRunCommand } from './cli/run-command.js';
import { startRepl } from './cli/repl.js';
import { registerTestCommands } from './cli/test-commands.js';
import { registerLogsCommands } from './cli/logs-commands.js';
import { registerDbCommands } from './cli/db-commands.js';
import { registerDoctorCommands } from './cli/doctor-commands.js';
import { registerPermissionCommands } from './cli/permissions.js';
import { registerEvolutionCommands } from './cli/evolution-commands.js';
import { registerCapabilityCommands } from './cli/capability-commands.js';
import { registerTaskCommands } from './cli/task-commands.js';
import { registerAgentCommands } from './cli/agent-commands.js';
import { getConsoleRenderer } from './observability/console.js';

const program = new Command();

program
  .name('berry')
  .description('BerryAgent - 双重自进化智能体')
  .version('0.2.0');

registerServiceCommands(program);
registerRunCommand(program);
registerTestCommands(program);
registerLogsCommands(program);
registerDbCommands(program);
registerDoctorCommands(program);
registerPermissionCommands(program);
registerEvolutionCommands(program);
registerCapabilityCommands(program);
registerTaskCommands(program);
registerAgentCommands(program);

program
  .command('chat')
  .description('交互式终端对话（自动启动服务）')
  .option('-s, --session <id>', '恢复指定会话')
  .action(async (opts) => {
    await ensureServiceRunning();
    await startRepl(opts);
  });

const args = process.argv.slice(2);
const hasSubcommand = args.length > 0 && !args[0].startsWith('-');

if (!hasSubcommand) {
  (async () => {
    process.env.BERRY_TERMINAL_MODE = 'human';
    const renderer = getConsoleRenderer();
    const { CoreService } = await import('./kernel/core-service.js');
    const coreService = new CoreService();

    process.on('SIGTERM', async () => { await coreService.stop(); process.exit(0); });
    process.on('SIGINT', async () => { await coreService.stop(); process.exit(0); });

    await coreService.start();
    renderer.info('Berry 服务已启动');
    renderer.info('终端对话: berry chat');
  })();
} else {
  program.parse();
}
