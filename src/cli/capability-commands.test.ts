import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb, initDb } from '../memory/db.js';
import { setAppHome } from '../utils/paths.js';
import { registerCapabilityCommands } from './capability-commands.js';

const tempDirs: string[] = [];
let stdout = '';
let stderr = '';

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  stdout = '';
  stderr = '';
});

describe('capability CLI commands', () => {
  it('prints plugin schema and contract as JSON', async () => {
    initTempDb();
    await runCli(['plugins', 'schema', '--json']);
    expect(JSON.parse(stdout)).toHaveProperty('$schema');

    stdout = '';
    await runCli(['plugins', 'contract', '--json']);
    const contract = JSON.parse(stdout) as Record<string, unknown>;
    expect(contract.apiVersion).toBe('berry.plugin.v1');
  });

  it('supports top-level plugin scaffold, validate, dry-run, and test commands', async () => {
    initTempDb();

    await runCli(['plugins', 'scaffold', 'cli-report', '--description', '整理 CLI 报告', '--json']);
    const scaffold = JSON.parse(stdout) as Record<string, unknown>;
    expect((scaffold.manifest as Record<string, unknown>).name).toBe('cli-report');

    stdout = '';
    await runCli(['plugins', 'validate', 'cli-report', '--json']);
    expect((JSON.parse(stdout) as Record<string, unknown>).ok).toBe(true);

    stdout = '';
    await runCli(['plugins', 'dry-run', 'cli-report', 'cli_report_run', '--input-json', '{"input":"ok"}', '--json']);
    const dryRun = JSON.parse(stdout) as Record<string, unknown>;
    expect(dryRun.ok).toBe(true);
    expect((dryRun.output as Record<string, unknown>).message).toBe('ok');

    stdout = '';
    await runCli(['plugins', 'test', 'cli-report', '--json']);
    expect((JSON.parse(stdout) as Record<string, unknown>).ok).toBe(true);
  });

  it('supports top-level skills list command', async () => {
    initTempDb();

    await runCli(['skills', 'list', '--json']);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it('supports skill create, stats, reload, disable, enable, and delete commands', async () => {
    initTempDb();

    await runCli(['skills', 'create', 'cli-skill', '--description', 'CLI 技能', '--json']);
    expect((JSON.parse(stdout) as Record<string, unknown>).name).toBe('cli-skill');

    stdout = '';
    await runCli(['skills', 'stats', '--json']);
    expect((JSON.parse(stdout) as Record<string, unknown>).total).toBe(1);

    stdout = '';
    await runCli(['skills', 'disable', 'cli-skill', '--json']);
    expect((JSON.parse(stdout) as Record<string, unknown>).disabled).toBe(true);

    stdout = '';
    await runCli(['skills', 'enable', 'cli-skill', '--json']);
    expect((JSON.parse(stdout) as Record<string, unknown>).disabled).toBe(false);

    stdout = '';
    await runCli(['skills', 'reload', '--json']);
    expect(JSON.parse(stdout)).toHaveLength(1);

    stdout = '';
    await runCli(['skills', 'delete', 'cli-skill', '--json']);
    expect((JSON.parse(stdout) as Record<string, unknown>).name).toBe('cli-skill');
  });

  it('supports plugin propose, approve, stats, reload, and delete commands', async () => {
    initTempDb();

    await runCli(['plugins', 'scaffold', 'approval-report', '--description', '审批报告', '--json']);
    stdout = '';
    await runCli(['plugins', 'propose', 'approval-report', '--json']);
    const proposal = JSON.parse(stdout) as Record<string, unknown>;
    expect(proposal.type).toBe('plugin_create');
    expect(proposal.status).toBe('pending_review');

    stdout = '';
    await runCli(['plugins', 'approve', 'approval-report', '--enable', '--json']);
    const approved = JSON.parse(stdout) as Record<string, unknown>;
    expect(approved.status).toBe('applied');

    stdout = '';
    await runCli(['plugins', 'stats', '--json']);
    expect((JSON.parse(stdout) as Record<string, unknown>).total).toBe(1);

    stdout = '';
    await runCli(['plugins', 'reload', '--json']);
    expect(JSON.parse(stdout)).toHaveLength(1);

    stdout = '';
    await runCli(['plugins', 'delete', 'approval-report', '--json']);
    expect((JSON.parse(stdout) as Record<string, unknown>).name).toBe('approval-report');
  });
});

async function runCli(args: string[]): Promise<void> {
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  });
  const program = new Command();
  program.exitOverride();
  registerCapabilityCommands(program);
  await program.parseAsync(args, { from: 'user' });
}

function initTempDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'berryagent-capability-cli-test-'));
  tempDirs.push(dir);
  setAppHome(dir);
  initDb(join(dir, 'data', 'berry.db'));
  closeDb();
}
