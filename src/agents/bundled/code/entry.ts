import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync, constants as fsConstants } from 'node:fs';
import type { AgentTaskPayload } from '../../../contracts/tasks.js';
import { getDb, startModuleAgent } from '../../module-agent.js';
import { CodeRuntime } from '../../../code/index.js';
import { LockManager } from '../../../code/file-locks.js';
import { detectWorkspace } from '../../../code/workspace.js';
import { runTaskPhases } from '../../../code/task-phases.js';
import type { CodeAction } from '../../../contracts/code.js';
import { registerTool } from '../../../tools/index.js';
import { hasFileBeenRead, markFileRead } from '../../../tools/read-tracker.js';
import { z } from 'zod';
import type { ToolResult } from '../../../tools/types.js';
// 13.0 AgentPort: Code Agent 可通过 AgentPort 向其他 Agent 提问
import { createAgentPort } from '../../agent-port.js';
// VF-4: Saga 补偿集成
import { SagaOrchestrator } from '../../../kernel/saga.js';
import { getLogger } from '../../../utils/logger.js';

const logger = getLogger('code-entry');

/**
 * 注册带文件锁保护的工具版本（覆盖 builtin）。
 *
 * VF-4 增强：所有文件写入操作通过 safeWriteFile 包装，
 * 自动在 Saga 中注册补偿动作（回滚到旧内容）。
 * 当任务被取消/中断时，onStop 回调触发 Saga 补偿。
 *
 * @param lockManager 文件锁管理器
 * @param workspaceDir 工作区目录
 * @param agentName 当前 Agent 名称
 * @param saga VF-4 Saga 编排器（可选；不传则跳过补偿注册）
 */
function registerLockedTools(lockManager: LockManager, workspaceDir: string, agentName: string, saga?: SagaOrchestrator): void {
  /**
   * 安全写入文件：写入前保存旧内容，自动注册 Saga 补偿。
   *
   * 流程：
   * 1. 读取当前文件内容（如文件不存在则为 null）
   * 2. 写入新内容
   * 3. 在 Saga 中注册补偿（回滚到旧内容或删除新建文件）
   * 4. 13.0 §13.7: 同时生成 .bak 备份（用户手动回滚用）
   *
   * @returns 旧内容（供调用方记录）
   */
  async function safeWriteFile(filePath: string, content: string, sessionId: string): Promise<string | null> {
    const resolved = resolve(filePath);
    const oldContent = existsSync(resolved) ? await readFile(resolved, 'utf-8') : null;

    // 13.0 §13.7: 写 .bak 备份（用户手动回滚用，绕过 Saga 流程）
    if (oldContent !== null) {
      try {
        const bakPath = `${resolved}.bak`;
        await copyFile(resolved, bakPath, fsConstants.COPYFILE_FICLONE);
        logger.debug({ path: resolved, bakPath }, 'code-entry: .bak backup created');
      } catch (bakErr) {
        // .bak 失败不阻塞主写入 — Saga 补偿仍能回滚
        logger.warn({ err: bakErr, path: resolved }, 'code-entry: .bak backup failed (non-fatal)');
      }
    }

    // 写入新内容
    await writeFile(resolved, content, 'utf-8');

    // 注册 Saga 补偿（写入成功后才注册，写入失败则不需要回滚）
    if (saga && sessionId) {
      const sagaId = getOrCreateTaskSaga(sessionId);
      if (sagaId) {
        const stepName = oldContent !== null
          ? `restore_${resolved}`
          : `delete_new_${resolved}`;
        saga.addCompensation(sagaId, stepName, async () => {
          if (oldContent !== null) {
            await writeFile(resolved, oldContent, 'utf-8');
            logger.debug({ path: resolved }, 'saga:compensation restored file');
          } else {
            // 新建的文件 → 删除
            const { unlink } = await import('node:fs/promises');
            await unlink(resolved).catch(() => {});
            logger.debug({ path: resolved }, 'saga:compensation deleted new file');
          }
        });
      }
    }

    return oldContent;
  }

  registerTool({
    name: 'write_file',
    description: '将内容写入指定文件（覆盖已有内容）。写入前自动获取文件锁。支持 Saga 自动补偿。',
    inputSchema: z.object({
      path: z.string().describe('文件的绝对或相对路径'),
      content: z.string().describe('要写入的内容'),
    }),
    dangerLevel: 'safe',
    async execute(input: unknown): Promise<ToolResult> {
      const { path: filePath, content } = (input as { path: string; content: string });
      const resolved = resolve(filePath);
      const taskId = `lock-${Date.now()}`;
      let lockId: string | undefined;
      try {
        const lock = lockManager.acquire({ filePath: resolved, workspaceDir, taskId, agentName, lockType: 'write' });
        lockId = lock.id;
        await safeWriteFile(resolved, content, currentSessionId);
        return { content: `已写入文件: ${filePath}` };
      } catch (err) {
        return { content: `写入文件失败: ${(err as Error).message}`, isError: true };
      } finally {
        if (lockId) lockManager.release(lockId);
      }
    },
  });

  registerTool({
    name: 'edit_code',
    description: '对文件做精确字符串替换。写入前自动获取文件锁。支持 Saga 自动补偿。',
    inputSchema: z.object({
      path: z.string().describe('文件路径'),
      oldText: z.string().describe('要替换的原始文本（精确匹配）'),
      newText: z.string().describe('替换后的文本'),
      replaceAll: z.boolean().default(false).describe('true=替换所有匹配；false=要求唯一匹配'),
    }),
    dangerLevel: 'moderate',
    async execute(input: unknown): Promise<ToolResult> {
      const { path, oldText, newText, replaceAll } = (input as { path: string; oldText: string; newText: string; replaceAll: boolean });
      const filePath = resolve(path);
      const taskId = `lock-${Date.now()}`;
      let lockId: string | undefined;
      try {
        if (!hasFileBeenRead(filePath)) {
          return { content: `编辑被拒绝: 请先使用 read_file 或 inspect_code 读取该文件。`, isError: true };
        }
        const lock = lockManager.acquire({ filePath, workspaceDir, taskId, agentName, lockType: 'write' });
        lockId = lock.id;
        const content = await readFile(filePath, 'utf-8');
        if (!content.includes(oldText)) {
          return { content: `未找到匹配文本，文件未修改。`, isError: true };
        }
        if (!replaceAll) {
          let count = 0; let idx = -1;
          while ((idx = content.indexOf(oldText, idx + 1)) !== -1) count++;
          if (count > 1) {
            return { content: `找到 ${count} 处匹配，请提供更多上下文使 oldText 唯一，或设置 replaceAll=true。`, isError: true };
          }
        }
        const updated = replaceAll ? content.replaceAll(oldText, newText) : content.replace(oldText, newText);
        // edit_code 通过 safeWriteFile 写入，保留旧内容用于补偿
        await safeWriteFile(filePath, updated, currentSessionId);
        markFileRead(filePath);
        return { content: `已修改文件: ${path}` };
      } catch (err) {
        return { content: `编辑失败: ${(err as Error).message}`, isError: true };
      } finally {
        if (lockId) lockManager.release(lockId);
      }
    },
  });
}

/** 确保只注册一次 locked tools（首次 agent.task 或 dialogue.send 触发时） */
let lockedToolsRegistered = false;

/** VF-4: 当前任务的 sessionId（每次 agent.task 时更新） */
let currentSessionId = '';

/** VF-4: 当前任务的 saga ID（每次 agent.task 时创建/重置） */
let currentSagaId: string | null = null;

/** VF-4: Saga 编排器实例（进程级别，复用同一个 SQLite 连接） */
let sagaInstance: SagaOrchestrator | null = null;

/**
 * VF-4: 获取或创建当前任务的 saga。
 * 每次新任务开始时调用 resetTaskSaga() 重置。
 */
function getOrCreateTaskSaga(sessionId: string): string | null {
  if (!sagaInstance || !sessionId) return null;
  if (!currentSagaId) {
    currentSagaId = sagaInstance.createSaga(sessionId, 'code_write_compensation');
    sagaInstance.ensureCompensationList(currentSagaId);
  }
  return currentSagaId;
}

/** VF-4: 重置任务级 saga 状态（新任务开始时调用） */
function resetTaskSaga(): void {
  currentSagaId = null;
}

/** VF-4: 获取当前的 onStop 回调，供 runToolLoop 使用 */
function getOnStopCallback(): ((reason: 'aborted' | 'completed' | 'budget_exceeded' | 'error' | 'limit_reached') => Promise<void>) | undefined {
  if (!sagaInstance || !currentSagaId) return undefined;
  return async (reason) => {
    // 只有异常终止才触发补偿（正常完成不需要回滚）
    if (reason === 'aborted' || reason === 'error' || reason === 'budget_exceeded') {
      logger.info({ sagaId: currentSagaId, reason }, 'VF-4: triggering saga compensation');
      await sagaInstance!.compensateSaga(currentSagaId!);
    } else {
      // 正常完成 → 关闭 saga（不需要补偿）
      sagaInstance!.completeSaga(currentSagaId!);
    }
    currentSagaId = null;
  };
}

function ensureLockedTools(): LockManager {
  const db = getDb();
  const lockManager = new LockManager(db);
  if (!lockedToolsRegistered) {
    lockedToolsRegistered = true;
    const workspaceDir = process.env.WORKSPACE_DIR ?? homedir();
    const agentName = process.env.AGENT_NAME ?? 'code';
    // VF-4: 初始化 Saga 编排器
    sagaInstance = new SagaOrchestrator(db);
    registerLockedTools(lockManager, workspaceDir, agentName, sagaInstance);
  }
  return lockManager;
}

/**
 * 从 code agent 任务结果中构建用户友好的回复文本。
 * 优先使用 implementation phase 的 LLM 输出（自然语言描述），
 * 而非 lastPhase.summary（可能是 "测试失败: ..." 等 terse 文本）。
 *
 * @param result runTaskPhases 返回的完整结果
 * @returns 用户可见的自然语言回复
 */
function buildUserResponse(result: { phases: Array<{ phase: string; success: boolean; summary: string }>; success: boolean; summary: string; filesChanged?: string[]; testResult?: { passed: boolean } }): string {
  const parts: string[] = [];
  const filesChanged = result.filesChanged ?? [];

  // 优先找 implementation phase 的 summary（LLM 的完整自然语言输出）
  const implPhase = result.phases.find(p => p.phase === 'implementation');
  const mainText = implPhase?.summary || result.summary;
  if (mainText) parts.push(mainText);

  // 追加文件变更列表
  if (filesChanged.length > 0) {
    parts.push(`\n变更的文件：${filesChanged.join(', ')}`);
  }

  // 如果测试失败但文件已创建，标注测试状态（不覆盖正文）
  if (!result.success && result.testResult && !result.testResult.passed && filesChanged.length > 0) {
    parts.push('\n⚠️ 自动测试未通过，但文件已成功创建。');
  }

  return parts.join('\n');
}

/** 确保只注册一次 AgentPort 工具（首次 agent.task 或 dialogue.send 触发时） */
let agentPortRegistered = false;

/**
 * 注册 13.0 AgentPort 相关工具（ask_agent）。
 * AgentPort 允许 Code Agent 向其他 Agent（如 memory）提问获取信息。
 */
function ensureAgentPortTools(
  ipc: import('../../../kernel/ipc.js').IpcChildChannel,
  askUser: (question: string, opts?: import('../../module-agent.js').AskUserOptions) => Promise<string>,
): void {
  if (agentPortRegistered) return;
  agentPortRegistered = true;

  const port = createAgentPort({ ipc, agentName: 'code', askUser });

  registerTool({
    name: 'ask_agent',
    description: '向另一个 Agent 提问获取信息。例如向 memory 查询用户偏好、向 learning 获取学习结果。适合需要跨 Agent 知识协作的场景。',
    dangerLevel: 'safe',
    inputSchema: z.object({
      target: z.string().describe('目标 Agent 名称，如 "memory"（查询用户知识库）、"learning"（查询学习结果）'),
      message: z.string().describe('要发送给目标 Agent 的消息，应包含足够的上下文'),
      context: z.record(z.string(), z.unknown()).optional().describe('可选：附加上下文信息'),
    }),
    async execute(input: unknown): Promise<ToolResult> {
      const { target, message, context: ctx } = input as { target: string; message: string; context?: Record<string, unknown> };
      try {
        const reply = await port.request({ to: target, content: message, context: ctx });
        return { content: `[${reply.from}] ${reply.content}` };
      } catch (err) {
        const errorMsg = (err as Error).message;
        // 超时或不可用时给出可操作建议，让 LLM 能自主决策
        const isTimeout = errorMsg.includes('timeout') || errorMsg.includes('不可用');
        const hint = isTimeout
          ? `${errorMsg}。建议：用现有信息继续完成任务，或使用其他工具自行获取信息。`
          : errorMsg;
        return { content: `ask_agent 失败: ${hint}`, isError: true };
      }
    },
  });
}

startModuleAgent(async (payload: AgentTaskPayload, context) => {
  const db = getDb();
  const runtime = new CodeRuntime(db);
  const lockManager = ensureLockedTools();
  // 13.0: 注册 AgentPort 工具，让 Code Agent 可通过 ask_agent 向其他 Agent 提问
  ensureAgentPortTools(context.ipc, context.askUser);

  // VF-4: 设置当前任务的 saga 上下文（sessionId 供 safeWriteFile 使用）
  currentSessionId = payload.sessionId;
  resetTaskSaga();

  const input = payload.inputPayload;
  const workingDir = (input.workingDir as string) ?? homedir();
  const workspace = await detectWorkspace(workingDir);

  // 13.0 §12.3: 将 mission 上下文注入 instruction
  // 当 Code Agent 执行 mission 任务时，LLM 能看到 plan 目标、当前 task、squad 角色等信息
  let instruction = String(input.instruction ?? input.message ?? '');
  if (context.missionPrompt) {
    instruction = `${instruction}\n\n## 当前 Mission 上下文\n\n${context.missionPrompt}`;
    logger.debug({ missionId: context.missionId, planTaskId: context.planTaskId }, 'code-entry: mission context injected into instruction');
  }

  const result = await runTaskPhases({
    taskId: payload.taskId,
    sessionId: payload.sessionId,
    action: ((input.action as string) ?? 'full_task') as CodeAction,
    // instruction 来自 orchestrator 委派的 message 或 instruction 字段
    instruction,
    workingDir: workspace?.gitRoot ?? workingDir,
    testCommand: input.testCommand as string | undefined,
    files: input.files as string[] | undefined,
    workspace,
    llm: context.llm,
    ipc: context.ipc,
    runtime,
    lockManager,
    // VF-4: 注入 onStop 回调，任务异常终止时触发 Saga 补偿
    onStop: getOnStopCallback() ?? undefined,
  });

  // VF-4: 正常完成后关闭 saga（不补偿）
  if (currentSagaId && sagaInstance) {
    sagaInstance.completeSaga(currentSagaId);
    currentSagaId = null;
  }

  return {
    kind: 'code_task',
    action: (input.action as string) ?? 'full_task',
    success: result.success,
    summary: result.summary,
    toolCallCount: result.totalToolCalls,
    filesChanged: result.filesChanged,
    testResult: result.testResult,
    // 用户友好的回复文本，formatAgentResult 会优先读取此字段
    response: buildUserResponse(result),
  };
});
