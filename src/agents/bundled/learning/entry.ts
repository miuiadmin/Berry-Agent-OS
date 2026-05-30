import { EvolutionEngine } from '../../../evolution/index.js';
import type { AgentTaskPayload } from '../../../contracts/tasks.js';
import { getDb, startModuleAgent } from '../../module-agent.js';
import { detectLearningSignals, parseLearningSignalsFromText } from '../../../evolution/detector.js';

startModuleAgent(async (payload: AgentTaskPayload, context) => {
  const input = payload.inputPayload;
  const message = String(input.message ?? input.userMessage ?? '');
  const assistantResponse = String(input.assistantResponse ?? '');
  const engine = new EvolutionEngine(getDb());
  const turn = {
    sessionId: payload.sessionId,
    userMessage: message,
    assistantResponse,
  };
  const useLlm = input.useLlm === true;
  let signals = detectLearningSignals(message, assistantResponse);
  let llmUsed = false;
  if (useLlm) {
    const llmResult = await context.llm.chat(
      [{ role: 'user', content: buildLearningPrompt(message, assistantResponse) }],
      {
        agent: 'learning',
        purpose: 'learning_review',
        sessionId: payload.sessionId,
        taskId: payload.taskId,
        maxTokens: 1200,
        temperature: 0.2,
      },
    );
    const llmSignals = parseLearningSignalsFromText(llmResult.content);
    if (llmSignals.length > 0) {
      signals = llmSignals;
      llmUsed = true;
    }
  }

  const result = engine.runSignals(turn, signals);
  return {
    kind: 'learning_review',
    llmUsed,
    proposals: result.proposals.map((proposal) => ({
      id: proposal.id,
      type: proposal.type,
      targetName: proposal.targetName,
      status: proposal.status,
    })),
    applied: result.applied,
    skippedReason: result.skippedReason,
  };
});

function buildLearningPrompt(userMessage: string, assistantResponse: string): string {
  return `你是 系统的 Learning Agent。请判断这轮对话是否值得沉淀为 Skill 或 Plugin。

规则：
- Skill 适合长期偏好、输出格式、工作方式、提示词策略。
- Plugin 适合可执行工具、自动化、一键处理、集成外部系统。
- 只输出 JSON 数组，不要输出其他文字。
- 每个对象字段：kind(skill|plugin), targetName, description, observations(string[]), riskLevel(low|medium|high)。
- 没有值得沉淀的内容时输出 []。

用户消息：
${userMessage}

助手回复：
${assistantResponse}
`;
}
