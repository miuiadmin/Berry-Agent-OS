/**
 * L0 contracts — 自定义消息角色注册表测试（骨架篇 §2.3 落码注记双入口纪律；
 * 2026-08-25 #16 收口：注册表自 agent 模块迁入，本文件为注册语义单一测试面）。
 */

import { describe, expect, it } from 'vitest';
import { AGENT_ROLE_EXISTS, AGENT_ROLE_INVALID, AppError } from './errors.js';
import {
  getMessageRoleDefinition,
  isStandardMessage,
  isStandardRole,
  listMessageRoles,
  registerHostMessageRole,
  registerPluginMessageRole,
} from './messages.js';

describe('消息角色注册表（双入口）', () => {
  it('插件面：注册 / 枚举 / 注销后可复用名称（二次注销无害）', () => {
    const unregister = registerPluginMessageRole('t-role/x-note', { render: { intent: 'status', label: '注' } });
    expect(listMessageRoles()).toContain('t-role/x-note');
    unregister();
    expect(listMessageRoles()).not.toContain('t-role/x-note');
    unregister(); // 二次注销无害（防误注销后来者）
    const unregisterAgain = registerPluginMessageRole('t-role/x-note', {});
    unregisterAgain();
  });

  it('插件面：无 / 单段名拒绝（AGENT_ROLE_INVALID——宿主自留地不可占）', () => {
    let error: unknown;
    try {
      registerPluginMessageRole('plain-name', {});
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('AGENT_ROLE_INVALID');
  });

  it('宿主面：无 / 单段名可注册；含 / 域名拒绝（AGENT_ROLE_INVALID——域名走插件面）', () => {
    const unregister = registerHostMessageRole('t-host-note', {});
    expect(listMessageRoles()).toContain('t-host-note');
    expect(() => registerHostMessageRole('domain/name', {})).toThrowError(AppError);
    unregister();
  });

  it('宿主面与标准角色同名：拒绝（AGENT_ROLE_EXISTS）；插件面结构上不可精确撞（必含 /）', () => {
    let error: unknown;
    try {
      registerHostMessageRole('user', {});
    } catch (reason) {
      error = reason;
    }
    expect((error as AppError).code).toBe('AGENT_ROLE_EXISTS');
    // 插件面 'user/x' 域前缀恰为标准角色名：全名键控不互蔽——合法注册且不遮蔽 user
    const unregister = registerPluginMessageRole('user/x', {});
    expect(isStandardRole('user/x')).toBe(false);
    expect(isStandardRole('user')).toBe(true); // 标准角色未被遮蔽
    unregister();
  });

  it('重复注册同名自定义角色：拒绝（跨入口撞名同样拒绝——注册表唯一）', () => {
    const unregister = registerHostMessageRole('t-dup-name', {});
    // 插件面用同名（带 / 不可能撞——换宿主面撞同一注册表）
    expect(() => registerHostMessageRole('t-dup-name', {})).toThrowError(AppError);
    unregister();
  });

  it('插件面与宿主面同一注册表：定义互通（convert/renderer 消费不分入口）', () => {
    const unregister = registerPluginMessageRole('t-shared/role', { render: { intent: 'hidden' } });
    expect(getMessageRoleDefinition('t-shared/role')?.render?.intent).toBe('hidden');
    unregister();
    expect(getMessageRoleDefinition('t-shared/role')).toBeUndefined();
  });
});

describe('标准角色判据', () => {
  it('isStandardRole / isStandardMessage 窄化守卫', () => {
    expect(isStandardRole('user')).toBe(true);
    expect(isStandardRole('assistant')).toBe(true);
    expect(isStandardRole('toolResult')).toBe(true);
    expect(isStandardRole('memory/recall')).toBe(false);
    const standard = { role: 'user', content: 'hi', timestamp: 1 };
    const custom = { role: 'memory/recall', content: 'x', timestamp: 1 };
    expect(isStandardMessage(standard)).toBe(true);
    expect(isStandardMessage(custom)).toBe(false);
  });
});
