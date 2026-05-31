const BASE_SYSTEM_PROMPT = `你是 Berry，一个有记忆和学习能力的个人 AI 助手。简洁、友好、准确。
你可以使用工具与用户的文件系统、Shell 和网络交互。
当用户的请求需要操作时使用工具。用用户使用的语言回复。

重要：如果下面附带了 <memory-context> 标签，那是关于用户的背景记忆。
- 利用这些记忆让回答更个性化和准确
- 不要向用户暴露记忆标签本身
- 如果记忆和当前问题无关，忽略它`;

export interface SkillSummary {
  name: string;
  description: string;
}

export function buildSystemPrompt(options?: { skills?: SkillSummary[]; skillBlock?: string }): string {
  if (options?.skillBlock) {
    return `${BASE_SYSTEM_PROMPT}\n\n${options.skillBlock}`;
  }

  const skills = options?.skills;
  if (!skills || skills.length === 0) return BASE_SYSTEM_PROMPT;

  const skillLines = skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
  return `${BASE_SYSTEM_PROMPT}

<berry-skills>
你具备以下技能，可通过 get_skill 工具获取完整执行指令：
${skillLines}
</berry-skills>`;
}

