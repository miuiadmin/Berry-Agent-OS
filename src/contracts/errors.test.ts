/**
 * L0 contracts 单元测试——错误码族纪律（内核篇 §5.3）：
 * AppError 形状 / code 分派 / 注册表格式与去重护栏。
 */
import { describe, expect, it } from 'vitest';
import { AppError, CONTEXT_SERVICE_NOT_FOUND, listErrorCodes, registerErrorCode, TOOL_NOT_STARTED } from './errors.js';
import type { SessionEvent } from './events.js';

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
      'SESSION_EVENT_DATA_INVALID',
      'SESSION_EVENT_TOO_LARGE',
      'SESSION_SURFACE_OP_INVALID',
      'SESSION_FORK_BOUNDARY_INVALID',
    ]) {
      expect(codes).toContain(expected);
    }
  });
});

describe('SessionEvent 信封基型', () => {
  it('信封形状钉死：type/seq/time(毫秒)/data + 可选遮蔽三字段（会话篇 §1.1）', () => {
    // 类型层编译期约束，此处冒烟：毫秒 time、type 词汇、surfaceOp/sourceEventSeqs 遮蔽溯源
    const event: SessionEvent<{ text: string }> = {
      type: 'user/message',
      seq: 3,
      time: 1755900000000,
      data: { text: 'hi' },
    };
    const replace: SessionEvent<{ content: string }> = {
      type: 'tool/result',
      seq: 7,
      time: 1755900001000,
      data: { content: '重写后的结果' },
      surfaceOp: { op: 'replace', start: 4, end: 5 },
      sourceEventSeqs: [4, 5, 6],
    };
    expect(event.seq).toBe(3);
    expect(replace.surfaceOp?.op).toBe('replace');
  });
});
