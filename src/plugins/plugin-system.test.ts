import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initDb } from '../memory/db.js';
import { setAppHome } from '../utils/paths.js';
import { getPluginContract, getPluginManifestJsonSchema, PluginRegistry } from './index.js';

const tempDirs: string[] = [];

afterEach(() => {
  closeDb();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('plugin system', () => {
  it('exposes AI-readable contract and manifest schema', () => {
    const contract = getPluginContract();
    const schema = getPluginManifestJsonSchema();

    expect(contract.apiVersion).toBe('berry.plugin.v1');
    expect(JSON.stringify(contract)).toContain('berry plugins validate <name> --json');
    expect(schema).toHaveProperty('$schema');
  });

  it('scaffolds, inspects, dry-runs, and fixture-tests a generated plugin', () => {
    initTempDb();
    const registry = new PluginRegistry(getDb());
    const { manifest, validation } = registry.createDraft({
      name: 'report helper',
      description: '整理自进化测试报告',
      evidence: ['用户需要自动整理测试报告'],
      riskLevel: 'low',
    });

    expect(validation.ok).toBe(true);
    expect(manifest.name).toBe('report-helper');

    const inspection = registry.inspect(manifest.name);
    expect(inspection.validation.ok).toBe(true);
    expect(inspection.tools[0].permissionScope).toBe('plugin.generated.readonly');

    const dryRun = registry.dryRun(manifest.name, 'report_helper_run', { input: 'ping' });
    expect(dryRun.ok).toBe(true);
    expect(dryRun.output?.message).toBe('ping');

    const fixtures = registry.runFixtures(manifest.name);
    expect(fixtures.ok).toBe(true);
    expect(fixtures.passed).toBe(1);
  });

  it('rejects plugins that try to read env or import model SDKs directly', () => {
    initTempDb();
    const registry = new PluginRegistry(getDb());
    const { manifest } = registry.createDraft({
      name: 'unsafe plugin',
      description: '不安全插件',
      evidence: ['安全测试'],
      riskLevel: 'high',
    });

    appendFileSync(manifest.entryPath, '\nconsole.log(process.env.API_KEY);\nimport OpenAI from "openai";\n');

    const validation = registry.validate(manifest.name);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join('\n')).toContain('插件不得直接读取真实环境变量');
    expect(validation.errors.join('\n')).toContain('插件不得直接调用模型 SDK');
  });
});

function initTempDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'agent-test-plugin-test-'));
  tempDirs.push(dir);
  setAppHome(dir);
  initDb(join(dir, 'data', 'agent.db'));
}
