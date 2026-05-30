import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './prompt-builder.js';

describe('buildSystemPrompt', () => {
  it('无技能时返回基础 prompt', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Berry');
    expect(prompt).not.toContain('berry-skills');
  });

  it('空技能数组不注入技能块', () => {
    const prompt = buildSystemPrompt({ skills: [] });
    expect(prompt).not.toContain('berry-skills');
  });

  it('有技能时注入技能摘要', () => {
    const prompt = buildSystemPrompt({
      skills: [
        { name: 'json-formatter', description: '格式化 JSON' },
        { name: 'text-summarizer', description: '文本摘要' },
      ],
    });
    expect(prompt).toContain('<berry-skills>');
    expect(prompt).toContain('json-formatter: 格式化 JSON');
    expect(prompt).toContain('text-summarizer: 文本摘要');
    expect(prompt).toContain('get_skill');
  });

  it('skillBlock 参数直接拼接到 prompt', () => {
    const block = '<berry-skills>\n自定义技能块\n</berry-skills>';
    const prompt = buildSystemPrompt({ skillBlock: block });
    expect(prompt).toContain('Berry');
    expect(prompt).toContain('自定义技能块');
  });

  it('skillBlock 优先于 skills', () => {
    const prompt = buildSystemPrompt({
      skills: [{ name: 'ignored', description: '不应出现' }],
      skillBlock: '<berry-skills>优先块</berry-skills>',
    });
    expect(prompt).toContain('优先块');
    expect(prompt).not.toContain('ignored');
  });

  it('skillBlock 为空字符串时不注入', () => {
    const prompt = buildSystemPrompt({ skillBlock: '' });
    expect(prompt).not.toContain('berry-skills');
  });
});
