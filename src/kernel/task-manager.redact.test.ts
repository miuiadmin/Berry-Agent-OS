import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb } from '../memory/db.js';
import { TaskManager } from './task-manager.js';
import { EventBus } from './event-bus.js';

/**
 * 15.0 V-7 写入边界 redact 钉死测试。
 *
 * redaction.test.ts 只覆盖 redactSecrets 函数本身；db.test.ts 只覆盖 v23/v24 回填迁移会跑。
 * 但「create() / complete() 真的在落库前调了 redactSecrets」这一环此前无人钉——一旦有人手滑
 * 删掉 redactSecrets 包裹，新写入的明文 secret 会绕过回填迁移（迁移只清洗历史存量）。
 *
 * 本测试用真实 initDb + TaskManager 跑完整生命周期，读回 agent_tasks 两个 JSON blob 列断言占位符存在，
 * 防止 V-7（input_payload）/ V-6（output_payload）的写入边界被无声回退。
 */
describe('TaskManager 写入边界 redact（V-6/V-7）', () => {
  let dir: string;
  let tm: TaskManager;

  afterEach(() => {
    // dispose 清掉 dispatch() 启动的超时定时器，避免 timer 泄漏到下一个用例
    tm?.dispose();
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('create() 落库前 redact input_payload（V-7）', () => {
    dir = mkdtempSync(join(tmpdir(), 'berry-tm-redact-'));
    initDb(join(dir, 'test.db'));
    tm = new TaskManager(getDb(), new EventBus());

    // 模拟 delegation-orchestrator 把用户消息（内嵌 anthropic key）塞进 inputPayload 的真实场景
    const anthropicKey = 'sk-ant-api03-abc123def456ghi789jkl012mno345pqr678';
    const taskId = tm.create({
      sessionId: 's1',
      correlationId: 'c1',
      taskType: 'delegation',
      requester: 'brain',
      targetAgent: 'code',
      inputPayload: { taskType: 'extract_feedback', userMessage: `我的 key 是 ${anthropicKey}` },
    });

    const row = tm.getTask(taskId);
    expect(row).toBeDefined();
    // 明文密钥不得落库
    expect(row!.input_payload).not.toContain(anthropicKey);
    // 被替换为占位符（证明走的是 redactSecrets，而非凭空清空）
    expect(row!.input_payload).toContain('[REDACTED:anthropic_key]');
  });

  it('complete() 落库前 redact output_payload（V-6）', () => {
    dir = mkdtempSync(join(tmpdir(), 'berry-tm-redact-'));
    initDb(join(dir, 'test.db'));
    tm = new TaskManager(getDb(), new EventBus());

    const taskId = tm.create({
      sessionId: 's1',
      correlationId: 'c1',
      taskType: 'delegation',
      requester: 'brain',
      targetAgent: 'code',
      inputPayload: {},
    });

    // 跑完整状态机到 running，再 complete —— 与真实派发链路一致
    tm.dispatch(taskId);
    tm.acknowledge(taskId);
    tm.start(taskId);

    // Agent 输出回显了工具结果里的 GitHub PAT（真实泄密场景）
    const githubPat = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AB';
    tm.complete(taskId, { result: `echo ${githubPat} >> ~/.netrc` });

    const row = tm.getTask(taskId);
    expect(row).toBeDefined();
    expect(row!.output_payload).not.toContain(githubPat);
    expect(row!.output_payload).toContain('[REDACTED:github_pat]');
  });
});
