import { EvolutionWorkflow } from '../../../evolution/index.js';
import type { AgentTaskPayload } from '../../../contracts/tasks.js';
import { getDb, startModuleAgent } from '../../module-agent.js';

/**
 * 13.0 §12.3: 构建 mission 上下文前缀。
 * Skills Agent 在 mission 框架下工作时，注入目标到 LLM prompt。
 */
function buildMissionPrefix(missionPrompt?: string): string {
  if (!missionPrompt) return '';
  return `## 当前 Mission 上下文\n\n${missionPrompt}\n\n---\n\n`;
}

startModuleAgent(async (payload: AgentTaskPayload, context) => {
  const proposalId = String(payload.inputPayload.proposalId ?? '');
  if (!proposalId) throw new Error('skill_task 缺少 proposalId');
  const workflow = new EvolutionWorkflow(getDb());
  let llmNote: string | undefined;
  if (payload.inputPayload.useLlm === true) {
    // 13.0: 注入 mission 上下文到 skills LLM prompt
    const missionPrefix = buildMissionPrefix(context.missionPrompt);
    const result = await context.llm.chat(
      [{ role: 'user', content: missionPrefix + `请审查技能提案 ${proposalId} 的质量，输出简短中文建议。` }],
      {
        agent: 'skills',
        purpose: 'skill_generation',
        sessionId: payload.sessionId,
        taskId: payload.taskId,
        maxTokens: 800,
        temperature: 0.2,
      },
    );
    llmNote = result.content;
  }
  const proposal = workflow.validate(proposalId);
  const finalProposal = proposal.status === 'approved'
    ? workflow.approve(proposalId, { reviewer: 'skills-agent' })
    : proposal;
  return {
    kind: 'skill_task',
    proposalId,
    status: finalProposal.status,
    targetName: finalProposal.targetName,
    draftPath: finalProposal.draftPath,
    llmNote,
  };
});
