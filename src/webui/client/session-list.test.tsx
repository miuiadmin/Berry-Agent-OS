/**
 * SessionList 组件测试（P1-3 SPA 测试轨——投影→组件数据流回归锁）。
 *
 * 锁四面：空态文案、行信息拼装（appId / cwd 尾段 / 相对时间）、审批角标
 * 出没（>0 才现）、活·闭态标记与选中回调上抛。数据形状锚 types.ts
 * SessionSummary。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionList } from './session-list';
import type { SessionSummary } from './types';

afterEach(cleanup);

/** 造一条会话清单条目（缺省活会话） */
function row(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return { appId: 'chat', active: true, ...overrides };
}

describe('SessionList（会话清单侧栏）', () => {
  it('空清单 = 「暂无会话」空态', () => {
    render(
      <SessionList
        sessions={[]}
        viewedId={undefined}
        approvalCounts={new Map()}
        onSelect={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('暂无会话')).toBeTruthy();
  });

  it('行信息拼装：appId / cwd 尾段 · 相对时间（updatedAt 缺席则时间省）', () => {
    const now = Date.now();
    const sessions = [
      row({ id: 's1', appId: 'berrycode', cwd: '/Users/x/Documents/code/berry', updatedAt: now }),
      row({ id: 's2', appId: 'chat' }), // cwd/updatedAt 双缺——尾段空 + 无时间后缀
    ];
    render(
      <SessionList
        sessions={sessions}
        viewedId={undefined}
        approvalCounts={new Map()}
        onSelect={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('berrycode')).toBeTruthy();
    expect(screen.getByText(/^berry · 刚刚$/)).toBeTruthy();
    expect(screen.getByText('chat')).toBeTruthy();
  });

  it('审批角标：pending > 0 现数点、0/缺席不现', () => {
    const sessions = [row({ id: 'a' }), row({ id: 'b' })];
    render(
      <SessionList
        sessions={sessions}
        viewedId={undefined}
        approvalCounts={
          new Map([
            ['a', 2],
            ['b', 0],
          ])
        }
        onSelect={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByTitle('2 项待审批')).toBeTruthy();
  });

  it('活·闭态：闭行现「闭」字（title 已闭只读），活行零文本标记', () => {
    const sessions = [row({ id: 'live', active: true }), row({ id: 'gone', active: false })];
    render(
      <SessionList
        sessions={sessions}
        viewedId={undefined}
        approvalCounts={new Map()}
        onSelect={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('闭')).toBeTruthy();
    expect(screen.getByTitle('已闭（只读）')).toBeTruthy();
    expect(screen.getByTitle('活会话')).toBeTruthy();
  });

  it('点击行上抛 onSelect(id)；「+ 开新」上抛 onOpen', () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const sessions = [row({ id: 'pick-me', cwd: '/w/proj' })];
    render(
      <SessionList
        sessions={sessions}
        viewedId={undefined}
        approvalCounts={new Map()}
        onSelect={onSelect}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByTitle('/w/proj'));
    expect(onSelect).toHaveBeenCalledWith('pick-me');
    fireEvent.click(screen.getByText('+ 开新'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
