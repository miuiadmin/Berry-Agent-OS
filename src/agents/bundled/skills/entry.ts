import { EvolutionWorkflow } from '../../../evolution/index.js';
import type { AgentTaskPayload } from '../../../contracts/tasks.js';
import { getDb, startModuleAgent } from '../../module-agent.js';

startModuleAgent(async (payload: AgentTaskPayload, context) => {
  const proposalId = String(payload.inputPayload.proposalId ?? '');
  if (!proposalId) throw new Error('skill_task 缺少 proposalId');
  const workflow = new EvolutionWorkflow(getDb());
  let llmNote: string | undefined;
  if (payload.inputPayload.useLlm === true) {
    const result = await context.llm.chat(
      [{ role: 'user', content: `请审查技能提案 ${proposalId} 的质量，输出简短中文建议。` }],
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
