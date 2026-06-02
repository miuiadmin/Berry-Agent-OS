import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestHarness } from '../testing/harness.js';
import { getUserAgentsDir } from '../utils/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_AGENT_PATH = resolve(__dirname, '..', 'agents', 'module-agent.ts');

const FILE_EDITOR_MANIFEST = {
  apiVersion: 'berry.agent.v1',
  name: 'file-editor',
  version: '0.1.0',
  description: '文件编辑 Agent — 真实修改文件内容',
  level: 2,
  kind: 'on-demand',
  source: 'user',
  taskTypes: ['file_edit'],
  roles: [],
  entry: 'entry.ts',
  ipcProtocol: 'module-agent',
  requiresBrainReview: false,
};

// 这个 entry 直接用 node:fs 读写文件，不依赖 LLM
function makeFileEditorEntry(): string {
  return `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { startModuleAgent } from '${MODULE_AGENT_PATH}';

startModuleAgent(async (payload) => {
  const { filePath, action, content } = payload.inputPayload as {
    filePath: string;
    action: 'append' | 'prepend' | 'replace' | 'create';
    content: string;
  };

  if (!filePath || !action || content === undefined) {
    throw new Error('缺少必要参数: filePath, action, content');
  }

  let before = '';
  if (existsSync(filePath)) {
    before = readFileSync(filePath, 'utf-8');
  }

  let after = '';
  switch (action) {
    case 'append':
      after = before + content;
      break;
    case 'prepend':
      after = content + before;
      break;
    case 'replace':
      after = content;
      break;
    case 'create':
      if (existsSync(filePath)) {
        throw new Error('文件已存在: ' + filePath);
      }
      after = content;
      break;
    default:
      throw new Error('未知操作: ' + action);
  }

  writeFileSync(filePath, after, 'utf-8');

  return {
    kind: 'file_edit',
    filePath,
    action,
    beforeLength: before.length,
    afterLength: after.length,
    success: true,
  };
});
`;
}

describe('File Editor Agent E2E — 真实文件操作', { timeout: 120000 }, () => {
  let harness: TestHarness;
  let agentDir: string;
  let workDir: string;

  beforeAll(async () => {
    harness = new TestHarness({ timeoutMs: 60000, llmMode: 'mock' });
    await harness.start();

    // 在 hermetic SERVICE_HOME 下安装 file-editor agent
    agentDir = join(getUserAgentsDir(), 'file-editor');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(FILE_EDITOR_MANIFEST, null, 2));
    writeFileSync(join(agentDir, 'entry.ts'), makeFileEditorEntry());

    // 安装 agent（使用 harness.socketRequest 确保正确的 socket 路径和超时）
    const installResult = await harness.socketRequest({
      type: 'agents.install',
      dir: agentDir,
    });
    if (!installResult.ok) {
      throw new Error(`安装 file-editor 失败: ${installResult.error}`);
    }

    // 创建工作目录
    workDir = join(harness.getAppHome(), 'test-workspace');
    mkdirSync(workDir, { recursive: true });

    // 预热 agent: 触发一次 create 操作确保子进程已启动
    const warmupFile = join(workDir, '_warmup.txt');
    const warmup = await harness.dispatchEvolutionTask({
      taskType: 'file_edit',
      sessionId: 'warmup',
      inputPayload: { filePath: warmupFile, action: 'create', content: 'warmup' },
    });
    if (warmup.ok) await harness.waitIdle();
  }, 120000);

  afterAll(async () => {
    await harness.stop();
  }, 30000);

  it('create 操作 — 创建新文件', async () => {
    const targetFile = join(workDir, 'created.txt');

    const dispatched = await harness.dispatchEvolutionTask({
      taskType: 'file_edit',
      sessionId: 'fe-create',
      inputPayload: {
        filePath: targetFile,
        action: 'create',
        content: '这是 Agent 创建的文件\n第二行内容\n',
      },
    });

    expect(dispatched.ok, `dispatch 失败: ${JSON.stringify(dispatched)}`).toBe(true);
    expect(dispatched.targetAgent).toBe('file-editor');

    await harness.waitIdle();

    // 验证文件确实被创建
    expect(existsSync(targetFile)).toBe(true);
    const content = readFileSync(targetFile, 'utf-8');
    expect(content).toBe('这是 Agent 创建的文件\n第二行内容\n');

    // 验证任务状态
    const db = harness.getDb();
    const task = db.prepare(`SELECT status, output_payload FROM agent_tasks WHERE id = ?`)
      .get(dispatched.taskId) as { status: string; output_payload: string };
    expect(task.status).toBe('completed');
    const output = JSON.parse(task.output_payload);
    expect(output.success).toBe(true);
    expect(output.action).toBe('create');
    expect(output.afterLength).toBeGreaterThan(0);
  });

  it('append 操作 — 追加内容到已有文件', async () => {
    const targetFile = join(workDir, 'append-target.txt');
    writeFileSync(targetFile, '原始内容\n');

    const dispatched = await harness.dispatchEvolutionTask({
      taskType: 'file_edit',
      sessionId: 'fe-append',
      inputPayload: {
        filePath: targetFile,
        action: 'append',
        content: '追加的新行\n',
      },
    });

    expect(dispatched.ok).toBe(true);
    await harness.waitIdle();

    const content = readFileSync(targetFile, 'utf-8');
    expect(content).toBe('原始内容\n追加的新行\n');

    const db = harness.getDb();
    const task = db.prepare(`SELECT status, output_payload FROM agent_tasks WHERE id = ?`)
      .get(dispatched.taskId) as { status: string; output_payload: string };
    expect(task.status).toBe('completed');
    const output = JSON.parse(task.output_payload);
    expect(output.beforeLength).toBe('原始内容\n'.length);
    expect(output.afterLength).toBe('原始内容\n追加的新行\n'.length);
  });

  it('prepend 操作 — 在文件头部插入内容', async () => {
    const targetFile = join(workDir, 'prepend-target.txt');
    writeFileSync(targetFile, 'body content\n');

    const dispatched = await harness.dispatchEvolutionTask({
      taskType: 'file_edit',
      sessionId: 'fe-prepend',
      inputPayload: {
        filePath: targetFile,
        action: 'prepend',
        content: '# Header\n\n',
      },
    });

    expect(dispatched.ok).toBe(true);
    await harness.waitIdle();

    const content = readFileSync(targetFile, 'utf-8');
    expect(content).toBe('# Header\n\nbody content\n');
  });

  it('replace 操作 — 完全替换文件内容', async () => {
    const targetFile = join(workDir, 'replace-target.txt');
    writeFileSync(targetFile, '旧的内容，将被完全替换\n很长的旧内容\n');

    const dispatched = await harness.dispatchEvolutionTask({
      taskType: 'file_edit',
      sessionId: 'fe-replace',
      inputPayload: {
        filePath: targetFile,
        action: 'replace',
        content: '全新的内容\n',
      },
    });

    expect(dispatched.ok).toBe(true);
    await harness.waitIdle();

    const content = readFileSync(targetFile, 'utf-8');
    expect(content).toBe('全新的内容\n');

    const db = harness.getDb();
    const task = db.prepare(`SELECT output_payload FROM agent_tasks WHERE id = ?`)
      .get(dispatched.taskId) as { output_payload: string };
    const output = JSON.parse(task.output_payload);
    expect(output.beforeLength).toBeGreaterThan(output.afterLength);
  });

  it('错误处理 — create 已存在的文件应失败', async () => {
    const targetFile = join(workDir, 'existing.txt');
    writeFileSync(targetFile, '已存在');

    const dispatched = await harness.dispatchEvolutionTask({
      taskType: 'file_edit',
      sessionId: 'fe-error',
      inputPayload: {
        filePath: targetFile,
        action: 'create',
        content: '试图覆盖',
      },
    });

    expect(dispatched.ok).toBe(true);
    await harness.waitIdle();

    // 原文件内容不应被修改
    const content = readFileSync(targetFile, 'utf-8');
    expect(content).toBe('已存在');

    // 任务应标记为失败
    const db = harness.getDb();
    const task = db.prepare(`SELECT status FROM agent_tasks WHERE id = ?`)
      .get(dispatched.taskId) as { status: string };
    expect(task.status).toBe('failed');
  });

  it('连续多次操作同一文件 — 验证状态一致性', async () => {
    const targetFile = join(workDir, 'multi-ops.txt');

    // 第 1 步：创建
    const d1 = await harness.dispatchEvolutionTask({
      taskType: 'file_edit',
      sessionId: 'fe-multi-1',
      inputPayload: { filePath: targetFile, action: 'create', content: 'line1\n' },
    });
    await harness.waitIdle();

    // 第 2 步：追加
    const d2 = await harness.dispatchEvolutionTask({
      taskType: 'file_edit',
      sessionId: 'fe-multi-2',
      inputPayload: { filePath: targetFile, action: 'append', content: 'line2\n' },
    });
    await harness.waitIdle();

    // 第 3 步：再追加
    const d3 = await harness.dispatchEvolutionTask({
      taskType: 'file_edit',
      sessionId: 'fe-multi-3',
      inputPayload: { filePath: targetFile, action: 'append', content: 'line3\n' },
    });
    await harness.waitIdle();

    // 最终文件应包含三行
    const content = readFileSync(targetFile, 'utf-8');
    expect(content).toBe('line1\nline2\nline3\n');

    // 三个任务全部成功
    const db = harness.getDb();
    for (const d of [d1, d2, d3]) {
      const task = db.prepare(`SELECT status FROM agent_tasks WHERE id = ?`)
        .get(d.taskId) as { status: string };
      expect(task.status).toBe('completed');
    }
  });
});
