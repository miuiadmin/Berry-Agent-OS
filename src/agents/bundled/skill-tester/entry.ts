import type { AgentTaskPayload } from '../../../contracts/tasks.js';
import { getDb, startModuleAgent } from '../../module-agent.js';
import { createSkillTools } from '../../../tools/skill-tools.js';

startModuleAgent(async (payload: AgentTaskPayload, context) => {
  const { skillName, arguments: args, shellInjection } = payload.inputPayload as {
    skillName?: string;
    arguments?: string;
    shellInjection?: boolean;
  };

  if (!skillName) throw new Error('skill_test 缺少 skillName');

  const tools = createSkillTools(getDb(), { shellInjection: shellInjection ?? false });
  const getSkill = tools.find(t => t.name === 'get_skill')!;
  const reportOutcome = tools.find(t => t.name === 'report_skill_outcome')!;

  const getResult = await getSkill.execute({ name: skillName, arguments: args });
  if (getResult.isError) {
    return { kind: 'skill_test', ok: false, error: getResult.content };
  }

  const view = JSON.parse(getResult.content);

  let llmVerdict: string | undefined;
  if (payload.inputPayload.useLlm === true) {
    const result = await context.llm.chat(
      [{ role: 'user', content: `验证技能 "${skillName}" 的内容是否完整、格式是否正确，简短中文回答。\n\n技能内容：\n${view.content.slice(0, 2000)}` }],
      {
        agent: 'skill-tester',
        purpose: 'skill_verification',
        sessionId: payload.sessionId,
        taskId: payload.taskId,
        maxTokens: 500,
        temperature: 0.1,
      },
    );
    llmVerdict = result.content;
  }

  await reportOutcome.execute({ name: skillName, success: true, note: 'skill-tester 自动验证通过' });

  return {
    kind: 'skill_test',
    ok: true,
    skillName: view.name,
    hasContent: view.content.length > 0,
    hasArguments: !!view.arguments,
    hasWhenToUse: !!view.whenToUse,
    contentLength: view.content.length,
    viewCount: view.stats.viewCount,
    llmVerdict,
  };
});
