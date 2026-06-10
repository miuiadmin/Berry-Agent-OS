import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
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

/**
 * 注册带文件锁保护的工具版本（覆盖 builtin）。
 * 在 Code Agent 进程中，write_file / edit_code 会通过 LockManager 获取写锁，
 * 确保 dialogue 模式和 agent.task 模式的文件写入互斥。
 */
function registerLockedTools(lockManager: LockManager, workspaceDir: string, agentName: string): void {
  registerTool({
    name: 'write_file',
    description: '将内容写入指定文件（覆盖已有内容）。写入前自动获取文件锁。',
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
        await writeFile(resolved, content, 'utf-8');
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
    description: '对文件做精确字符串替换。写入前自动获取文件锁。',
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
        await writeFile(filePath, updated, 'utf-8');
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
function ensureLockedTools(): LockManager {
  const db = getDb();
  const lockManager = new LockManager(db);
  if (!lockedToolsRegistered) {
    lockedToolsRegistered = true;
    const workspaceDir = process.env.WORKSPACE_DIR ?? homedir();
    const agentName = process.env.AGENT_NAME ?? 'code';
    registerLockedTools(lockManager, workspaceDir, agentName);
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

  const input = payload.inputPayload;
  const workingDir = (input.workingDir as string) ?? homedir();
  const workspace = await detectWorkspace(workingDir);

  const result = await runTaskPhases({
    taskId: payload.taskId,
    sessionId: payload.sessionId,
    action: ((input.action as string) ?? 'full_task') as CodeAction,
    // instruction 来自 orchestrator 委派的 message 或 instruction 字段
    instruction: String(input.instruction ?? input.message ?? ''),
    workingDir: workspace?.gitRoot ?? workingDir,
    testCommand: input.testCommand as string | undefined,
    files: input.files as string[] | undefined,
    workspace,
    llm: context.llm,
    ipc: context.ipc,
    runtime,
    lockManager,
  });

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
