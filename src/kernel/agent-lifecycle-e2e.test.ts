import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestHarness } from '../testing/harness.js';
import { getUserAgentsDir } from '../utils/paths.js';

const ECHO_MANIFEST = {
  apiVersion: 'berry.agent.v1',
  name: 'echo-test',
  version: '0.1.0',
  description: '端到端测试用 Echo Agent',
  level: 2,
  kind: 'on-demand',
  source: 'user',
  taskTypes: ['echo_e2e_task'],
  roles: [],
  entry: 'entry.ts',
  ipcProtocol: 'module-agent',
  requiresBrainReview: false,
};

const ECHO_ENTRY = `
import type { AgentTaskPayload } from '../../../contracts/tasks.js';
import { startModuleAgent } from '../../module-agent.js';

startModuleAgent(async (payload: AgentTaskPayload) => {
  const msg = String(payload.inputPayload.message ?? 'no message');
  return { kind: 'echo_e2e_task', echo: msg };
});
`;

describe('Agent Lifecycle E2E', () => {
  let harness: TestHarness;
  let agentDir: string;

  beforeAll(async () => {
    harness = new TestHarness({ timeoutMs: 30000, llmMode: 'mock' });
    await harness.start();

    agentDir = join(getUserAgentsDir(), 'echo-test');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(ECHO_MANIFEST, null, 2));
    writeFileSync(join(agentDir, 'entry.ts'), ECHO_ENTRY);
  }, 60000);

  afterAll(async () => {
    await harness.stop();
  }, 30000);

  it('agents.install 安装用户 Agent', async () => {
    const result = await socketRequest(harness, {
      type: 'agents.install',
      dir: agentDir,
    });
    expect(result.ok).toBe(true);
    expect(result.name).toBe('echo-test');
    expect(result.status).toBe('enabled');
  });

  it('agents.list 列出已安装的 Agent', async () => {
    const result = await socketRequest(harness, {
      type: 'agents.list',
      source: 'user',
    });
    expect(result.ok).toBe(true);
    const agents = result.agents as Array<{ name: string; source: string }>;
    const echo = agents.find(a => a.name === 'echo-test');
    expect(echo).toBeDefined();
    expect(echo!.source).toBe('user');
  });

  it('agents.inspect 查看 Agent 详情', async () => {
    const result = await socketRequest(harness, {
      type: 'agents.inspect',
      name: 'echo-test',
    });
    expect(result.ok).toBe(true);
    const agent = result.agent as Record<string, unknown>;
    expect(agent.name).toBe('echo-test');
    expect(agent.version).toBe('0.1.0');
    expect(agent.kind).toBe('on-demand');
    expect(agent.status).toBe('enabled');
    expect(agent.running).toBe(false);
  });

  it('agents.disable 禁用 Agent', async () => {
    const result = await socketRequest(harness, {
      type: 'agents.disable',
      name: 'echo-test',
      reason: 'E2E 测试禁用',
    });
    expect(result.ok).toBe(true);

    const inspect = await socketRequest(harness, {
      type: 'agents.inspect',
      name: 'echo-test',
    });
    expect((inspect.agent as any).status).toBe('disabled');
  });

  it('agents.enable 重新启用 Agent', async () => {
    const result = await socketRequest(harness, {
      type: 'agents.enable',
      name: 'echo-test',
    });
    expect(result.ok).toBe(true);

    const inspect = await socketRequest(harness, {
      type: 'agents.inspect',
      name: 'echo-test',
    });
    expect((inspect.agent as any).status).toBe('enabled');
  });

  it('agents.upgrade 升级 Agent 版本', async () => {
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({ ...ECHO_MANIFEST, version: '0.2.0' }, null, 2),
    );

    const result = await socketRequest(harness, {
      type: 'agents.upgrade',
      name: 'echo-test',
    });
    expect(result.ok).toBe(true);
    expect(result.fromVersion).toBe('0.1.0');
    expect(result.toVersion).toBe('0.2.0');

    const inspect = await socketRequest(harness, {
      type: 'agents.inspect',
      name: 'echo-test',
    });
    expect((inspect.agent as any).version).toBe('0.2.0');
  });

  it('agents.remove 移除 Agent', async () => {
    const result = await socketRequest(harness, {
      type: 'agents.remove',
      name: 'echo-test',
    });
    expect(result.ok).toBe(true);

    const inspect = await socketRequest(harness, {
      type: 'agents.inspect',
      name: 'echo-test',
    });
    expect(inspect.ok).toBe(true);
    expect((inspect.agent as any).status).toBe('removed');
    expect((inspect.agent as any).manifest).toBeNull();
  });

  it('agents.install 再次安装后 agents.reload 能发现', async () => {
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({ ...ECHO_MANIFEST, version: '0.3.0', name: 'echo-reload' }, null, 2),
    );

    const reloadResult = await socketRequest(harness, { type: 'agents.reload' });
    expect(reloadResult.ok).toBe(true);
    const discovered = reloadResult.discovered as string[];
    expect(discovered).toContain('echo-reload');

    const inspect = await socketRequest(harness, {
      type: 'agents.inspect',
      name: 'echo-reload',
    });
    expect(inspect.ok).toBe(true);
    expect((inspect.agent as any).version).toBe('0.3.0');
  });

  it('agents.remove 拒绝移除 bundled Agent', async () => {
    const result = await socketRequest(harness, {
      type: 'agents.remove',
      name: 'brain',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('内置智能体不可移除');
  });

  it('agents.disable 拒绝禁用 reviewer 角色 Agent', async () => {
    const result = await socketRequest(harness, {
      type: 'agents.disable',
      name: 'brain',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('系统关键角色');
  });

  it('DB 中存在完整生命周期事件', async () => {
    const db = harness.getDb();
    const events = db.prepare(
      `SELECT event_type FROM agent_lifecycle_events WHERE agent_name = 'echo-test' ORDER BY created_at`,
    ).all() as Array<{ event_type: string }>;

    const types = events.map(e => e.event_type);
    expect(types).toContain('installed');
    expect(types).toContain('disabled');
    expect(types).toContain('enabled');
    expect(types).toContain('upgraded');
    expect(types).toContain('removed');
  });
});

async function socketRequest(harness: TestHarness, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { createConnection } = await import('node:net');
  const { getSocketPath } = await import('../utils/paths.js');
  const socketPath = getSocketPath();

  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Socket request timeout'));
    }, 10000);

    socket.on('connect', () => {
      socket.write(JSON.stringify(data) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          clearTimeout(timer);
          socket.end();
          try {
            resolve(JSON.parse(line));
          } catch (e) {
            reject(e);
          }
          return;
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
