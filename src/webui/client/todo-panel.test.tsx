/**
 * TodoPanel 组件测试（P1-3 SPA 测试轨——投影→组件数据流回归锁）。
 *
 * 锁三面：null/空表整体收起、状态图元三值映射、计数行（done/total + 进行 n）
 * 与 in_progress 行优先 activeForm 的呈现规则。数据形状锚 types.ts TodoItem。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TodoPanel } from './todo-panel';
import type { TodoItem } from './types';

// RTL 自动 cleanup 依赖 globals 配置——本轨不开 globals，显式收
afterEach(cleanup);

describe('TodoPanel（todo 常驻面板）', () => {
  it('todo = null（无表）整体收起——面板零渲染', () => {
    const { container } = render(<TodoPanel todo={null} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('任务清单')).toBeNull();
  });

  it('todo = []（已清空合法态）同收起', () => {
    const { container } = render(<TodoPanel todo={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('状态图元三值映射：pending ○ / in_progress ◐ / completed ●', () => {
    const todo: TodoItem[] = [
      { content: '写规范', status: 'pending' },
      { content: '落码', status: 'in_progress' },
      { content: '收口', status: 'completed' },
    ];
    render(<TodoPanel todo={todo} />);
    // 图元与内容分属两子节点——分别断言（图元唯一方可 getBy）
    expect(screen.getByText('○')).toBeTruthy();
    expect(screen.getByText('◐')).toBeTruthy();
    expect(screen.getByText('●')).toBeTruthy();
    expect(screen.getByText('写规范')).toBeTruthy();
    expect(screen.getByText('落码')).toBeTruthy();
    expect(screen.getByText('收口')).toBeTruthy();
  });

  it('计数行：done/total + 进行 n（inProgress > 0 才注记）', () => {
    const todo: TodoItem[] = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'in_progress' },
      { content: 'd', status: 'pending' },
    ];
    render(<TodoPanel todo={todo} />);
    expect(screen.getByText('2/4 · 进行 1')).toBeTruthy();
  });

  it('in_progress 行优先 activeForm（「正在做什么」贴当前态）', () => {
    const todo: TodoItem[] = [{ content: '修 bug', status: 'in_progress', activeForm: '正在修 bug' }];
    render(<TodoPanel todo={todo} />);
    expect(screen.getByText('正在修 bug')).toBeTruthy();
    // content 被优先替代而非并列——精确匹配无 '修 bug' 独立行
    expect(screen.queryByText('修 bug')).toBeNull();
  });

  it('未知状态值回落 ○ 图元（防御不改炸）', () => {
    const todo = [{ content: '怪态', status: 'weird' }] as unknown as TodoItem[];
    render(<TodoPanel todo={todo} />);
    expect(screen.getByText('○')).toBeTruthy();
    expect(screen.getByText('怪态')).toBeTruthy();
  });
});
