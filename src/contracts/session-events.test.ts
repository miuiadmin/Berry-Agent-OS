/**
 * L0 contracts — 会话事件词汇注册表测试（会话篇 §2.1 落码注记双入口纪律；
 * 2026-08-25 Hermes 探针 #19 收口：注册表自 session 模块迁入，本文件为
 * 注册语义单一测试面——与 messages.test.ts 同构镜像）。
 *
 * 墙的形状（回归锁）：ctx.sessions.appendEvent 是应用落 durable 事件的唯一
 * 正门，但彼时词汇注册不在装载面——第三方写任何自有词汇必撞
 * SESSION_FORMAT_UNSUPPORTED（有门没钥匙）。本面闭合后：装载面注册 →
 * appendEvent 应可写（assembly 全栈腿在 app 层另有锁）。
 */

import { describe, expect, it } from 'vitest';
import { AppError, SESSION_CORE_TYPE_FORBIDDEN, SESSION_FORMAT_UNSUPPORTED } from './errors.js';
import {
  CORE_EVENT_TYPES,
  getSessionEventType,
  listSessionEventTypes,
  registerAppSessionEventType,
  registerSessionEventType,
} from './session-events.js';

describe('会话事件词汇注册表（双入口）', () => {
  it('装载面：注册 / 查询 / 注销（二次注销无害、注销后名称可复用）', () => {
    const unregister = registerAppSessionEventType({ type: 't-evt/note', tier: 'stable', category: 'surface' });
    expect(getSessionEventType('t-evt/note')?.category).toBe('surface');
    expect(listSessionEventTypes().map((d) => d.type)).toContain('t-evt/note');
    unregister();
    expect(getSessionEventType('t-evt/note')).toBeUndefined();
    unregister(); // 二次注销无害（防误注销后来者）
    const again = registerAppSessionEventType({ type: 't-evt/note', tier: 'stable', category: 'log-only' });
    expect(getSessionEventType('t-evt/note')?.category).toBe('log-only');
    again();
  });

  it('装载面：核心词拒注册（SESSION_CORE_TYPE_FORBIDDEN——注册侧先拦，与 appendEvent 写侧同罪）', () => {
    for (const type of ['user/message', 'llm/usage', 'turn/end', 'gate/decision']) {
      let error: unknown;
      try {
        registerAppSessionEventType({ type, category: 'surface', tier: 'stable' });
      } catch (reason) {
        error = reason;
      }
      expect(error, `核心词 ${type} 应拒注册`).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(SESSION_CORE_TYPE_FORBIDDEN);
    }
  });

  it('宿主面：模块级直调可注册（回注销器）；重复注册拒绝（SESSION_FORMAT_UNSUPPORTED）', () => {
    const unregister = registerSessionEventType({ type: 't-host/note', tier: 'stable', category: 'log-only' });
    expect(() => registerSessionEventType({ type: 't-host/note', tier: 'stable', category: 'log-only' })).toThrowError(
      AppError,
    );
    const unregisterDup = registerSessionEventType({ type: 't-host/dup', tier: 'stable', category: 'log-only' });
    unregister();
    unregisterDup();
  });

  it('格式非法拒绝：非小写斜线式词汇（两个入口同闸）', () => {
    for (const bad of ['Plain/Name', 'noslash', 'a//b', '/lead']) {
      expect(() => registerSessionEventType({ type: bad, tier: 'stable', category: 'log-only' })).toThrowError(
        AppError,
      );
      expect(() => registerAppSessionEventType({ type: bad, tier: 'stable', category: 'log-only' })).toThrowError(
        AppError,
      );
    }
  });

  it('核心 14 类随 contracts 模块加载即注册（旧消费面经 session 再导出零改动）', () => {
    for (const def of CORE_EVENT_TYPES) {
      expect(getSessionEventType(def.type)).toBeDefined();
    }
    // todo/write 是 reserved 词——在场但不许装载面重注册（核心族一体保护）
    let error: unknown;
    try {
      registerAppSessionEventType({ type: 'todo/write', tier: 'stable', category: 'surface' });
    } catch (reason) {
      error = reason;
    }
    expect((error as AppError).code).toBe(SESSION_CORE_TYPE_FORBIDDEN);
  });

  it('双入口同一注册表：定义互通（session 模块写侧/读侧消费不分入口）', () => {
    const unregister = registerAppSessionEventType({
      type: 't-shared/evt',
      category: 'surface',
      tier: 'stable',
      ignorable: true,
    });
    expect(getSessionEventType('t-shared/evt')?.ignorable).toBe(true);
    unregister();
    expect(getSessionEventType('t-shared/evt')).toBeUndefined();
  });
});

describe('错误码语义', () => {
  it('SESSION_FORMAT_UNSUPPORTED / SESSION_CORE_TYPE_FORBIDDEN 已注册且码值即词汇', () => {
    expect(SESSION_FORMAT_UNSUPPORTED).toBe('SESSION_FORMAT_UNSUPPORTED');
    expect(SESSION_CORE_TYPE_FORBIDDEN).toBe('SESSION_CORE_TYPE_FORBIDDEN');
  });
});
