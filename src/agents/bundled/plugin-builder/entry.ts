import { EvolutionWorkflow } from '../../../evolution/index.js';
import type { AgentTaskPayload } from '../../../contracts/tasks.js';
import { getDb, startModuleAgent } from '../../module-agent.js';

/**
 * 13.0 §12.3: 构建 mission 上下文前缀。
 * Plugin Builder 在 mission 框架下工作时，注入目标到 LLM prompt。
 */
function buildMissionPrefix(missionPrompt?: string): string {
  if (!missionPrompt) return '';
  return `## 当前 Mission 上下文\n\n${missionPrompt}\n\n---\n\n`;
}

startModuleAgent(async (payload: AgentTaskPayload, context) => {
  const proposalId = String(payload.inputPayload.proposalId ?? '');
  if (!proposalId) throw new Error('plugin_task 缺少 proposalId');
  const enable = payload.inputPayload.enable === true;
  let llmNote: string | undefined;
  if (payload.inputPayload.useLlm === true) {
    // 13.0: 注入 mission 上下文到 plugin builder LLM prompt
    const missionPrefix = buildMissionPrefix(context.missionPrompt);
    const result = await context.llm.chat(
      [{ role: 'user', content: missionPrefix + `请审查插件提案 ${proposalId} 的 manifest、工具 schema、权限风险和测试建议。只输出简短中文建议。` }],
      {
        agent: 'plugin-builder',
        purpose: 'plugin_generation',
        sessionId: payload.sessionId,
        taskId: payload.taskId,
        maxTokens: 1000,
        temperature: 0.2,
      },
    );
    llmNote = result.content;
  }
  const workflow = new EvolutionWorkflow(getDb());
  const validated = workflow.validate(proposalId);
  if (validated.status === 'failed') {
    return {
      kind: 'plugin_task',
      proposalId,
      status: validated.status,
      targetName: validated.targetName,
      validatorResult: validated.validatorResult,
      llmNote,
    };
  }
  const approved = workflow.approve(proposalId, { enable, reviewer: 'plugin-builder-agent' });
  return {
    kind: 'plugin_task',
    proposalId,
    status: approved.status,
    targetName: approved.targetName,
    draftPath: approved.draftPath,
    validatorResult: approved.validatorResult,
    llmNote,
  };
});
