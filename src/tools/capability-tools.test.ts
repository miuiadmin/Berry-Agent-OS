import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initDb } from '../memory/db.js';
import { setAppHome } from '../utils/paths.js';
import { PluginRegistry } from '../plugins/index.js';
import { createCapabilityTools } from './capability-tools.js';
import type { IpcMessage } from '../kernel/types.js';

const tempDirs: string[] = [];

afterEach(() => {
  closeDb();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('capability tools', () => {
  it('routes plugin inspection and dry-run through IPC capability requests', async () => {
    const fakeIpc = {
      async request(type: string, to: string, payload: unknown): Promise<IpcMessage> {
        return {
          id: 'reply',
          correlationId: 'req',
          type: 'capability.response',
          from: to,
          to: 'conversation',
          payload: { ok: true, result: { type, payload } },
          timestamp: Date.now(),
        };
      },
    };
    const tools = createCapabilityTools(fakeIpc as never, 1000);
    const dryRun = await tools.find((tool) => tool.name === 'dry_run_plugin')!.execute({
      name: 'tool-report',
      tool: 'tool_report_run',
      input: { input: 'pong' },
    });

    expect(dryRun.isError).toBeFalsy();
    expect(dryRun.content).toContain('capability.plugins.dry_run');
    expect(dryRun.content).toContain('pong');
  });

  it('core-side registry can inspect generated plugin data used by capability responses', () => {
    initTempDb();
    const { manifest } = new PluginRegistry(getDb()).createDraft({
      name: 'tool-report',
      description: '工具层报告插件',
      evidence: ['工具测试'],
      riskLevel: 'low',
    });

    const inspection = new PluginRegistry(getDb()).inspect(manifest.name);
    expect(inspection.validation.ok).toBe(true);
    expect(inspection.tools[0].permissionScope).toBe('plugin.generated.readonly');
  });
});

function initTempDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'agent-test-capability-tools-test-'));
  tempDirs.push(dir);
  setAppHome(dir);
  initDb(join(dir, 'data', 'agent.db'));
}
