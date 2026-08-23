/**
 * L2 tools 单元测试——fs 观察态 CAS（骨架篇 §7.5；第七批安全四件之一）：
 * 写意图分派全分支 / edit 守卫 / 登记表生命周期。
 */

import { describe, expect, it } from 'vitest';
import { AppError, FS_NOT_OBSERVED, FS_VERSION_CONFLICT } from '../contracts/errors.js';
import { ObservedFiles, requireObservedForEdit, resolveWriteIntent, statVersion } from './observed.js';

/** 同步断言快捷：thunk 必抛 AppError 且 code 相符（resolve/require 系列都是同步函数） */
function expectThrow(fn: () => unknown, code: string): void {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

describe('resolveWriteIntent — 写意图分派（观察态 × 盘上状态）', () => {
  it('未读 + 不存在 → create-if-absent（全新创建合法）', () => {
    const intent = resolveWriteIntent(undefined, undefined);
    expect(intent).toEqual({ kind: 'create-if-absent' });
  });

  it('未读 + 已存在 → FS_NOT_OBSERVED（从未见过的内容不许覆盖）', () => {
    expectThrow(() => resolveWriteIntent(undefined, { version: '10:1' }), FS_NOT_OBSERVED);
  });

  it('absent 观察 + 仍不存在 → create-if-absent', () => {
    const intent = resolveWriteIntent({ state: 'absent' }, undefined);
    expect(intent).toEqual({ kind: 'create-if-absent' });
  });

  it('absent 观察 + 他方已创建 → FS_VERSION_CONFLICT（并发创建守卫）', () => {
    expectThrow(() => resolveWriteIntent({ state: 'absent' }, { version: '5:1' }), FS_VERSION_CONFLICT);
  });

  it('present 观察 + 指纹一致 → replace-if-version', () => {
    const intent = resolveWriteIntent({ state: 'present', version: '7:2' }, { version: '7:2' });
    expect(intent).toEqual({ kind: 'replace-if-version', expectedVersion: '7:2' });
  });

  it('present 观察 + 指纹漂移 → FS_VERSION_CONFLICT（丢失更新守卫）', () => {
    expectThrow(
      () => resolveWriteIntent({ state: 'present', version: '7:2' }, { version: '9:3' }),
      FS_VERSION_CONFLICT,
    );
  });

  it('present 观察 + 文件已被删除 → FS_VERSION_CONFLICT', () => {
    expectThrow(() => resolveWriteIntent({ state: 'present', version: '7:2' }, undefined), FS_VERSION_CONFLICT);
  });
});

describe('requireObservedForEdit — 补丁编辑守卫', () => {
  it('未读拒改：FS_NOT_OBSERVED', () => {
    expectThrow(() => requireObservedForEdit(undefined, { version: '1:1' }), FS_NOT_OBSERVED);
  });

  it('absent 观察（读时不在）同样拒绝——补丁编辑须有可锚定的旧内容', () => {
    expectThrow(() => requireObservedForEdit({ state: 'absent' }, undefined), FS_NOT_OBSERVED);
  });

  it('present 且指纹一致 → 放行为 replace-if-version', () => {
    const intent = requireObservedForEdit({ state: 'present', version: '3:3' }, { version: '3:3' });
    expect(intent).toEqual({ kind: 'replace-if-version', expectedVersion: '3:3' });
  });

  it('present 但指纹漂移 → FS_VERSION_CONFLICT（语义继续走 present 分支）', () => {
    expectThrow(
      () => requireObservedForEdit({ state: 'present', version: '3:3' }, { version: '4:4' }),
      FS_VERSION_CONFLICT,
    );
  });
});

describe('statVersion — 版本指纹', () => {
  it('size 与 mtimeMs 组合成指纹（任一变化即指纹变化）', () => {
    expect(statVersion(100, 1234.5)).toBe('100:1234.5');
    expect(statVersion(101, 1234.5)).not.toBe(statVersion(100, 1234.5));
    expect(statVersion(100, 1235)).not.toBe(statVersion(100, 1234.5));
  });
});

describe('ObservedFiles — 登记表', () => {
  it('present/absent 登记与读取', () => {
    const observed = new ObservedFiles();
    observed.observePresent('/a/b.txt', '1:1');
    observed.observeAbsent('/a/c.txt');
    expect(observed.get('/a/b.txt')).toEqual({ state: 'present', version: '1:1' });
    expect(observed.get('/a/c.txt')).toEqual({ state: 'absent' });
    expect(observed.get('/a/none')).toBeUndefined();
  });

  it('写后回填走 observePresent（写完即最新观察）', () => {
    const observed = new ObservedFiles();
    observed.observeAbsent('/new.txt');
    observed.observePresent('/new.txt', '42:9'); // 写成功回填
    expect(observed.get('/new.txt')).toEqual({ state: 'present', version: '42:9' });
  });

  it('clear 清空（测试/诊断辅助）', () => {
    const observed = new ObservedFiles();
    observed.observeAbsent('/x');
    observed.clear();
    expect(observed.get('/x')).toBeUndefined();
  });
});
