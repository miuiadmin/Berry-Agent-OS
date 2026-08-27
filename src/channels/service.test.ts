/**
 * L4 channels 单元测试 — D1 app 行命令拒载（契约篇 §5.1 注册面路由，2026-08-27）。
 *
 * 命令单表无域层（全局命令面）：挂应用组合的行注册 TUI 命令 = 跨应用漏命令，
 * 装载期拒绝。渲染器 registerRenderer 不在拒载面（v1 全局——规范未裁，同族
 * 域层挂账随首个真实第三方需求）。
 */

import { describe, expect, it } from 'vitest';
import { AppError, COMPOSITION_ROW_INVALID } from '../contracts/errors.js';
import { runInCallerChain } from '../context/index.js';
import { createChannelsService } from './service.js';

/** 两行探针 fixture：row-app 挂应用 chat（在投影）、其余行挂系统（不在投影） */
const rowApp = {
  get: (rowId: string) => (rowId === 'row-app' ? 'chat' : undefined),
  size: () => 1,
};

/** 最小合法命令定义 */
const cmdOf = (name: string) => ({ name, description: `测试命令 ${name}`, handler: () => {} });

describe('createChannelsService — D1 app 行命令拒载', () => {
  it('app 行命令注册拒绝：COMPOSITION_ROW_INVALID（装载器 apply 帧 → 服务面执法）', () => {
    const channels = createChannelsService({ rowApp });
    try {
      runInCallerChain('row-app', () => channels.registerCommand(cmdOf('leak')));
      expect.unreachable('应抛 COMPOSITION_ROW_INVALID');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as InstanceType<typeof AppError>).code).toBe(COMPOSITION_ROW_INVALID);
      expect((e as InstanceType<typeof AppError>).message).toContain('app: chat');
    }
  });

  it('系统行与无帧注册照常（宿主/builtin 命令面不受执法影响）', () => {
    const channels = createChannelsService({ rowApp });
    runInCallerChain('row-sys', () => channels.registerCommand(cmdOf('sys-cmd')));
    channels.registerCommand(cmdOf('host-cmd')); // 无帧（装配段直注册）
    expect(
      channels
        .listCommands()
        .map((c) => c.name)
        .sort(),
    ).toEqual(['host-cmd', 'sys-cmd']);
  });

  it('渲染器注册不在拒载面（v1 全局——规范未裁，同族域层挂账）', () => {
    const channels = createChannelsService({ rowApp });
    expect(() =>
      runInCallerChain('row-app', () => channels.registerRenderer({ role: 'custom/x', render: () => [] })),
    ).not.toThrow();
  });

  it('缺省不接探针 = 不执法（纯测试/诊断面）', () => {
    const channels = createChannelsService();
    expect(() => runInCallerChain('row-app', () => channels.registerCommand(cmdOf('any')))).not.toThrow();
  });
});
