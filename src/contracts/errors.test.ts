/**
 * L0 contracts 单元测试——错误码族纪律（内核篇 §5.3）：
 * AppError 形状 / code 分派 / 注册表格式与去重护栏。
 */
import { describe, expect, it } from 'vitest';
import { AppError, CONTEXT_SERVICE_NOT_FOUND, listErrorCodes, registerErrorCode, TOOL_NOT_STARTED } from './errors.js';
import type { SessionEventEnvelope } from './events.js';

describe('AppError 单基类', () => {
  it('code 为唯一判据：不派生子类，catch 按 code 分派', () => {
    const thrower = (): never => {
      throw new AppError(TOOL_NOT_STARTED, '工具未开始即被取消');
    };
    try {
      thrower();
    } catch (err) {
      // 统一 instanceof AppError + code 判等，永不 instanceof 具体场景类
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('TOOL_NOT_STARTED');
      expect((err as AppError).message).toContain('工具未开始');
    }
  });

  it('cause 透传（ES2022 Error cause 通道）', () => {
    const root = new Error('root cause');
    const err = new AppError(CONTEXT_SERVICE_NOT_FOUND, '外层', { cause: root });
    expect(err.cause).toBe(root);
  });
});

describe('错误码注册表', () => {
  it('格式护栏：非法格式注册直接抛错', () => {
    expect(() => registerErrorCode('lowercase_code')).toThrowError(AppError);
    expect(() => registerErrorCode('NOPREFIX')).toThrowError(AppError); // 缺模块前缀分隔
    expect(() => registerErrorCode('BAD-CODE')).toThrowError(AppError);
  });

  it('重复注册护栏：同一码二进注册表抛错', () => {
    // 取一个保证未注册过的码做重复实验
    registerErrorCode('TEST_DUP_PROBE');
    expect(() => registerErrorCode('TEST_DUP_PROBE')).toThrowError(/重复注册/);
  });

  it('listErrorCodes 含首批拍板码（CI 校验面）', () => {
    const codes = listErrorCodes();
    for (const expected of [
      'TOOL_NOT_STARTED',
      'TOOL_OUTCOME_UNKNOWN',
      'TOOL_TIMEOUT',
      'FS_NOT_OBSERVED',
      'FS_VERSION_CONFLICT',
      'SESSION_FORMAT_UNSUPPORTED',
      'SESSION_WRITE_CONFLICT',
    ]) {
      expect(codes).toContain(expected);
    }
  });
});

describe('SessionEventEnvelope 基型', () => {
  it('信封形状钉死：seq/sessionId/time/kind/data（类型层编译期约束，此处冒烟）', () => {
    const event: SessionEventEnvelope<{ text: string }> = {
      seq: 0,
      sessionId: 's-1',
      time: '2026-08-23T00:00:00.000Z',
      kind: 'user/message',
      data: { text: 'hi' },
    };
    expect(event.seq).toBe(0);
    expect(event.kind).toBe('user/message');
  });
});
