/**
 * L4 exec 单元测试 — bash 可执行发现序（骨架篇 §7.6「平台形态与 bash
 * 发现序」，2026-08-27 P1-3 挖矿 B11 缺口③）。
 *
 * 覆盖：⓪ APP_BASH_PATH 覆盖（命中/缺失列诊断）/ ① POSIX PATH 查找（真
 * env 真解析）/ ② win32 知名位序 / ③ win32 PATH 带 WSL 启动器排除 /
 * 成功缓存（探测计数一次）/ 全空 fail-loud 列已探测位。
 * deps 注入缝锁平台形状——win32 腿在 POSIX CI 上照测。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { join } from 'node:path';
import { resolveBash, resetBashCacheForTest, type BashResolveDeps } from './bash-path.js';
import { AppError, EXEC_SPAWN_FAILED } from '../contracts/errors.js';

/** 断言 EXEC_SPAWN_FAILED（消息含已探测位清单） */
function expectSpawnFailed(deps: BashResolveDeps): AppError {
  try {
    resolveBash(deps);
    expect.unreachable('应当抛错');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(EXEC_SPAWN_FAILED);
    return err as AppError;
  }
}

beforeEach(() => resetBashCacheForTest());

describe('⓪ APP_BASH_PATH 显式覆盖（操作员主权）', () => {
  it('存在即用——不做 WSL 排除检查（可为 WSL bash）', () => {
    const path = resolveBash({
      platform: 'win32',
      env: { APP_BASH_PATH: 'C:\\special\\bash.exe', PATH: '' },
      exists: (p) => p === 'C:\\special\\bash.exe',
    });
    expect(path).toBe('C:\\special\\bash.exe');
  });

  it('指定但不存在 → 记入已探测清单继续发现序', () => {
    const err = expectSpawnFailed({
      platform: 'win32',
      env: { APP_BASH_PATH: 'C:\\gone\\bash.exe', PATH: '' },
      exists: () => false,
    });
    expect(err.message).toContain('C:\\gone\\bash.exe');
  });
});

describe('① POSIX：PATH 查找', () => {
  it('真 env 真解析（darwin/linux CI 上 /bin 或 /usr/bin 必有 bash）', () => {
    const path = resolveBash({ env: { ...process.env } });
    expect(path).toMatch(/bash$/);
    expect(path).toContain('/');
  });

  it('PATH 全空 = EXEC_SPAWN_FAILED（不降级 cmd.exe）', () => {
    const err = expectSpawnFailed({ platform: 'darwin', env: { PATH: '/nonexistent-dir-a:/nonexistent-dir-b' } });
    expect(err.message).toContain('不降级');
  });

  it('探测序按 PATH 目录顺序（前位命中优先）', () => {
    const probed: string[] = [];
    const path = resolveBash({
      platform: 'linux',
      env: { PATH: '/x:/y' },
      exists: (p) => {
        probed.push(p);
        return p === '/y/bash';
      },
    });
    expect(path).toBe('/y/bash');
    expect(probed).toEqual(['/x/bash', '/y/bash']);
  });
});

describe('② win32：知名位序探（git-bash 家族）', () => {
  it('ProgramFiles\\Git\\bin\\bash.exe 命中（首位优先）', () => {
    const target = join('C:\\Program Files', 'Git', 'bin', 'bash.exe');
    const path = resolveBash({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files', PATH: '' },
      exists: (p) => p === target,
    });
    expect(path).toBe(target);
  });

  it('bin 缺则 usr/bin 次位（git-bash 家族序）', () => {
    const target = join('C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe');
    const path = resolveBash({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files', PATH: '' },
      exists: (p) => p === target,
    });
    expect(path).toBe(target);
  });
});

describe('③ win32：PATH 查找带 WSL 启动器排除', () => {
  it('System32\\bash.exe = WSL 启动器——跳过继续找', () => {
    const wsl = join('C:\\Windows\\System32', 'bash.exe');
    const target = join('D:\\tools', 'bash.exe');
    const path = resolveBash({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\System32;D:\\tools' },
      exists: (p) => p === wsl || p === target,
    });
    expect(path).toBe(target);
  });

  it('非 System32 的 bash.exe 照常命中', () => {
    const target = join('D:\\msys64\\usr\\bin', 'bash.exe');
    const path = resolveBash({
      platform: 'win32',
      env: { PATH: 'D:\\msys64\\usr\\bin' },
      exists: (p) => p === target,
    });
    expect(path).toBe(target);
  });
});

describe('成功缓存 / 失败不缓存', () => {
  it('命中后二次 resolve 零探测（首次全序 3 位 = 知名位 2 + PATH 1，二次零增量）', () => {
    const target = join('D:\\tools', 'bash.exe');
    let count = 0;
    const deps: BashResolveDeps = {
      platform: 'win32',
      env: { PATH: 'D:\\tools' },
      exists: (p) => {
        count++;
        return p === target;
      },
    };
    expect(resolveBash(deps)).toBe(target);
    expect(count).toBe(3);
    expect(resolveBash(deps)).toBe(target);
    expect(count).toBe(3); // 二次走缓存——探针零增量
  });

  it('全序皆空 = EXEC_SPAWN_FAILED 列已探测位（含排除注记）', () => {
    const wsl = join('C:\\Windows\\System32', 'bash.exe');
    const err = expectSpawnFailed({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Windows\\System32' },
      exists: (p) => p === wsl,
    });
    expect(err.message).toContain('WSL 启动器，已排除');
    // 知名位清单在消息里（分隔符随宿主 join——断言子串不含分隔符的段名）
    expect(err.message).toContain('Git');
  });
});
