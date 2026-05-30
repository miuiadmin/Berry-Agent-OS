import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Command } from 'commander';
import { getDbPath, getSocketPath } from '../utils/paths.js';
import { socketRequest } from './shared.js';
import { getConsoleRenderer } from '../observability/console.js';
import { createCoreModuleRegistry } from '../kernel/module-system.js';

export function registerDoctorCommands(program: Command): void {
  const doctor = program.command('doctor').description('诊断运行环境');

  doctor
    .command('modules')
    .description('检查模块注册、依赖顺序和健康状态')
    .option('--json', '以 JSON 格式输出')
    .action((opts) => {
      const renderer = getConsoleRenderer();
      const dbPath = getDbPath();
      if (!existsSync(dbPath)) {
        const payload = { ok: false, error: '数据库文件不存在，请先启动服务或初始化数据库' };
        if (opts.json) renderer.json(payload);
        else renderer.error(payload.error);
        process.exitCode = 40;
        return;
      }

      const db = new Database(dbPath);
      try {
        const registry = createCoreModuleRegistry();
        const report = registry.doctor(db);

        if (opts.json) {
          renderer.json(report);
          return;
        }

        renderer.info(`模块诊断: ${report.ok ? '通过' : '失败'}`);
        renderer.info(`启动顺序: ${report.order.join(' -> ')}`);
        for (const mod of report.modules) {
          const missing = mod.missingDependencies.length > 0
            ? ` 缺失依赖: ${mod.missingDependencies.join(', ')}`
            : '';
          const error = mod.lastError ? ` 最近错误: ${mod.lastError}` : '';
          renderer.info(`  ${mod.name}: ${mod.status}${missing}${error}`);
        }

        if (!report.ok) {
          process.exitCode = 1;
        }
      } finally {
        db.close();
      }
    });

  doctor
    .command('metrics')
    .description('查看运行时指标（P50/P95 延迟、错误率、内存进化）')
    .option('--json', '以 JSON 格式输出')
    .action(async (opts) => {
      const renderer = getConsoleRenderer();
      const socketPath = getSocketPath();

      try {
        const health = await socketRequest(socketPath, { type: 'health' });

        if (opts.json) {
          renderer.json(health);
          return;
        }

        const uptimeMin = Math.round((health.uptimeMs as number) / 60000);
        renderer.info(`运行时间: ${uptimeMin} 分钟`);
        renderer.info(`记忆进化失败次数: ${health.evolutionFailures}`);

        const metricsData = health.metrics as {
          counters: Record<string, Array<{ labels: Record<string, string>; value: number }>>;
          histograms: Record<string, Array<{ labels: Record<string, string>; count: number; p50: number; p95: number; p99: number }>>;
        };

        if (metricsData.counters.llm_requests_total) {
          renderer.info('\nLLM 请求:');
          for (const entry of metricsData.counters.llm_requests_total) {
            renderer.info(`  ${entry.labels.agent ?? 'unknown'} [${entry.labels.status}]: ${entry.value}`);
          }
        }

        if (metricsData.histograms.llm_request_duration_ms) {
          renderer.info('\nLLM 延迟 (ms):');
          for (const entry of metricsData.histograms.llm_request_duration_ms) {
            renderer.info(`  ${entry.labels.agent ?? 'unknown'}: P50=${entry.p50} P95=${entry.p95} P99=${entry.p99} (n=${entry.count})`);
          }
        }

        if (metricsData.histograms.ipc_request_duration_ms) {
          renderer.info('\nIPC 延迟 (ms):');
          for (const entry of metricsData.histograms.ipc_request_duration_ms) {
            renderer.info(`  ${entry.labels.type}→${entry.labels.to}: P50=${entry.p50} P95=${entry.p95} (n=${entry.count})`);
          }
        }

        if (metricsData.counters.socket_requests_total) {
          renderer.info('\nSocket 请求:');
          for (const entry of metricsData.counters.socket_requests_total) {
            renderer.info(`  ${entry.labels.type}: ${entry.value}`);
          }
        }
      } catch (err) {
        renderer.error(`无法连接到 Berry Service: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
