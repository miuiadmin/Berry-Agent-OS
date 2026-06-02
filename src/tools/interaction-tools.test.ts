import { describe, it, expect, vi } from 'vitest';
import { askUserTool, pushNotificationTool } from './interaction-tools.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

describe('ask_user', () => {
  it('formats question with options', async () => {
    const result = await askUserTool.execute({
      question: '用 tabs 还是 spaces?',
      options: [
        { label: 'Tabs', description: '用制表符缩进' },
        { label: 'Spaces', description: '用空格缩进' },
      ],
    });
    expect(result.content).toContain('tabs 还是 spaces');
    expect(result.content).toContain('1. Tabs');
    expect(result.content).toContain('2. Spaces');
    expect(result.content).toContain('用制表符缩进');
    expect(result.isError).toBeUndefined();
  });

  it('formats question without options', async () => {
    const result = await askUserTool.execute({ question: '你的项目名称是什么？' });
    expect(result.content).toContain('项目名称');
    expect(result.content).not.toContain('选项');
  });
});

describe('push_notification', () => {
  it('returns success message', async () => {
    const result = await pushNotificationTool.execute({ message: '构建完成' });
    expect(result.content).toContain('已通知');
    expect(result.content).toContain('构建完成');
    expect(result.isError).toBeUndefined();
  });

  it('accepts title parameter', async () => {
    const result = await pushNotificationTool.execute({ message: 'done', title: 'Build' });
    expect(result.content).toContain('已通知');
  });
});
