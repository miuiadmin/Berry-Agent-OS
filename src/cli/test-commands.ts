import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { getSocketPath } from '../utils/paths.js';
import { getConsoleRenderer } from '../observability/console.js';
import { createHermeticEnv } from '../testing/hermetic-env.js';
import { startRun, endRun, resolveLogLevel } from '../observability/index.js';
import { EXIT_CODES } from '../kernel/errors.js';
import { socketRequest } from './service-commands.js';
import { applyRealTestEnv, resolveRealTestConfig, summarizeRealTestConfig } from './real-test-profile.js';

export function registerTestCommands(program: Command): void {
  const test = program.command('test').description('测试工具（开发/CI 用）');

  const real = test.command('real').description('真实模型测试（live-builtin/live-override）');

  real
    .command('run <message>')
    .description('使用真实模型执行一次测试对话')
    .option('--profile <profile>', '真实测试 profile: builtin, override', 'builtin')
    .option('--base-url <url>', 'override profile 的模型 base URL')
    .option('--api-key <key>', 'override profile 的模型 API key')
    .option('--model <model>', 'override profile 的模型名称')
    .option('-s, --session <id>', '会话 ID，用于连续对话/跨会话测试')
    .option('--data-dir <path>', '测试数据目录；默认使用临时目录')
    .option('-p, --permission-mode <mode>', '权限模式: ask, allow-all, deny-all', 'allow-all')
    .option('--non-interactive', '非交互模式；ask 会按 deny-all 处理')
    .option('--json', '以 JSON 格式输出')
    .option('--timeout <ms>', '超时时间（毫秒）', '120000')
    .action(async (message: string, opts) => {
      const renderer = getConsoleRenderer();
      const isJson = opts.json ?? false;
      const timeoutMs = parseInt(opts.timeout, 10);
      const config = resolveRealTestConfig({
        profile: opts.profile,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        dataDir: opts.dataDir,
      });
      const env = applyRealTestEnv(config);
      let service: { start: () => Promise<void>; stop: () => Promise<void> } | null = null;

      try {
        const { CoreService } = await import('../kernel/core-service.js');
        service = new CoreService();
        await service.start();

        const socketPath = getSocketPath();
        const response = await socketRequest(socketPath, {
          type: 'message',
          message,
          streaming: false,
          sessionId: opts.session,
          permissionMode: opts.nonInteractive && opts.permissionMode === 'ask' ? 'deny-all' : opts.permissionMode,
          nonInteractive: opts.nonInteractive ?? false,
        });

        await service.stop();
        service = null;

        const responseText = String(response.response ?? '');
        const ok = !response.error && !responseText.startsWith('抱歉，处理过程中发生错误:');
        const output = {
          ok,
          profile: config.profile,
          response: response.response,
          error: response.error,
          sessionId: response.sessionId,
          taskId: response.taskId,
          timeoutMs,
          config: summarizeRealTestConfig(config),
        };

        if (isJson) {
          renderer.json(output);
        } else if (response.error) {
          renderer.error(`真实测试失败: ${response.error}`);
        } else {
          renderer.info(String(response.response ?? ''));
        }
      } catch (err) {
        if (isJson) {
          renderer.json({
            ok: false,
            error: (err as Error).message,
            profile: config.profile,
            config: summarizeRealTestConfig(config),
          });
        } else {
          renderer.error(`真实测试执行失败: ${(err as Error).message}`);
        }
        process.exitCode = EXIT_CODES.LLM_ERROR;
      } finally {
        if (service) {
          try { await service.stop(); } catch {}
        }
        env.cleanup();
      }
    });

  test
    .command('run <message>')
    .description('在测试环境中执行一次对话')
    .option('--llm-mode <mode>', 'LLM 模式: mock, takeover', 'mock')
    .option('-p, --permission-mode <mode>', '权限模式: ask, allow-all, deny-all', 'allow-all')
    .option('--non-interactive', '非交互模式；ask 会按 deny-all 处理')
    .option('--json', '以 JSON 格式输出')
    .option('--timeout <ms>', '超时时间（毫秒）', '30000')
    .action(async (message: string, opts) => {
      const renderer = getConsoleRenderer();
      const isJson = opts.json ?? false;
      const timeoutMs = parseInt(opts.timeout, 10);

      const env = createHermeticEnv({ llmMode: opts.llmMode as 'mock' | 'takeover' });

      try {
        const { CoreService } = await import('../kernel/core-service.js');
        const service = new CoreService();
        await service.start();

        const socketPath = getSocketPath();
        const response = await socketRequest(socketPath, {
          type: 'message',
          message,
          permissionMode: opts.nonInteractive && opts.permissionMode === 'ask' ? 'deny-all' : opts.permissionMode,
          nonInteractive: opts.nonInteractive ?? false,
        });

        await service.stop();

        if (isJson) {
          renderer.json({
            ok: !response.error,
            response: response.response,
            sessionId: response.sessionId,
            taskId: response.taskId,
            llmMode: opts.llmMode,
            appHome: env.appHome,
          });
        } else {
          if (response.error) {
            renderer.error(`错误: ${response.error}`);
          } else {
            renderer.info(String(response.response ?? ''));
          }
        }
      } catch (err) {
        if (isJson) {
          renderer.json({
            ok: false,
            error: (err as Error).message,
            llmMode: opts.llmMode,
            appHome: env.appHome,
          });
        } else {
          renderer.error(`测试执行失败: ${(err as Error).message}`);
        }
      } finally {
        env.cleanup();
      }
    });

  test
    .command('env')
    .description('输出 hermetic 测试环境信息')
    .option('--json', '以 JSON 格式输出')
    .action((opts) => {
      const renderer = getConsoleRenderer();
      const env = createHermeticEnv();
      const info = {
        appHome: env.appHome,
        llmMode: process.env.APP_LLM_MODE,
        tz: process.env.TZ,
        lang: process.env.LANG,
      };
      env.cleanup();

      if (opts.json) {
        renderer.json(info);
      } else {
        renderer.info(`SERVICE_HOME=${info.appHome}`);
        renderer.info(`APP_LLM_MODE=${info.llmMode}`);
        renderer.info(`TZ=${info.tz}`);
        renderer.info(`LANG=${info.lang}`);
      }
    });

  test
    .command('wait-idle')
    .description('等待所有任务完成')
    .option('--timeout <ms>', '超时时间（毫秒）', '30000')
    .option('--json', '以 JSON 格式输出')
    .action(async (opts) => {
      const renderer = getConsoleRenderer();
      const socketPath = getSocketPath();
      const isJson = opts.json ?? false;

      if (!existsSync(socketPath)) {
        if (isJson) {
          renderer.json({ ok: false, error: 'Berry 服务未在运行' });
        } else {
          renderer.error('Berry 服务未在运行');
        }
        process.exit(EXIT_CODES.SERVICE_NOT_RUNNING);
      }

      const timeoutMs = parseInt(opts.timeout, 10);
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        try {
          const status = await socketRequest(socketPath, { type: 'status' });
          if (status.status) {
            const agents = status.status as Record<string, { status: string }>;
            const allReady = Object.values(agents).every((a) => a.status === 'ready');
            if (allReady) {
              if (isJson) {
                renderer.json({ ok: true, idle: true });
              } else {
                renderer.info('所有任务已完成');
              }
              return;
            }
          }
        } catch {
          // retry
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      if (isJson) {
        renderer.json({ ok: false, error: '等待超时' });
      } else {
        renderer.error('等待超时: 仍有任务未完成');
      }
      process.exit(1);
    });

  test
    .command('requests')
    .description('列出 pending 的 takeover 请求')
    .option('--json', '以 JSON 格式输出')
    .action(async (opts) => {
      const renderer = getConsoleRenderer();
      const isJson = opts.json ?? false;

      renderer.error('此命令需要在 takeover 模式下通过 TestHarness 使用');
      renderer.error('参考: src/testing/harness.ts → getTakeoverController()');
      if (isJson) {
        renderer.json({ ok: false, error: 'takeover 模式仅支持进程内使用' });
      }
    });

  test
    .command('respond <requestId>')
    .description('回应 takeover 请求')
    .option('--content <text>', '响应内容')
    .option('--json', '以 JSON 格式输出')
    .action(async (requestId: string, opts) => {
      const renderer = getConsoleRenderer();
      const isJson = opts.json ?? false;

      renderer.error('此命令需要在 takeover 模式下通过 TestHarness 使用');
      renderer.error('参考: src/testing/harness.ts → getTakeoverController()');
      if (isJson) {
        renderer.json({ ok: false, error: 'takeover 模式仅支持进程内使用' });
      }
    });
}
