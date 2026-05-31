import { homedir } from 'node:os';
import type { AgentTaskPayload } from '../../../contracts/tasks.js';
import { getDb, startModuleAgent } from '../../module-agent.js';
import { CodeRuntime } from '../../../code/index.js';
import { LockManager } from '../../../code/file-locks.js';
import { detectWorkspace } from '../../../code/workspace.js';
import { runTaskPhases } from '../../../code/task-phases.js';
import type { CodeAction } from '../../../contracts/code.js';

startModuleAgent(async (payload: AgentTaskPayload, context) => {
  const db = getDb();
  const runtime = new CodeRuntime(db);
  const lockManager = new LockManager(db);

  const input = payload.inputPayload;
  const workingDir = (input.workingDir as string) ?? homedir();
  const workspace = await detectWorkspace(workingDir);

  const result = await runTaskPhases({
    taskId: payload.taskId,
    sessionId: payload.sessionId,
    action: ((input.action as string) ?? 'full_task') as CodeAction,
    instruction: String(input.instruction ?? ''),
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
  };
});
