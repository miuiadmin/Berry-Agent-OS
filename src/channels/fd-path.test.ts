/**
 * L4 channels 单元测试 — fd 可执行发现序（契约篇 §6.8 fd 接线小刀验收判据）。
 *
 * 全注入面（platform/env/exists）锁形状：两级发现序 / POSIX 双基名序
 * （fd → fdfind——Debian 实名变体）/ win32 fd.exe / 全序皆空诚实缺席
 * 返回 null（对照 bash-path 的 fail-loud 形状分野）/ 成功缓存零重探 /
 * 失败不缓存重探 / 消费点三态决策 fdPathFor。
 */

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fdPathFor, resetFdCacheForTest, resolveFdPath, type FdResolveDeps } from './fd-path.js';

/** 探测计数装置（缓存策略断言用——exists 每次调用计数） */
function countingExists(hits: readonly string[]): { exists: (path: string) => boolean; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    exists: (path: string) => {
      calls.push(path);
      return hits.includes(path);
    },
  };
}

/** POSIX 测试环境（PATH 两目录） */
const POSIX_ENV = { PATH: '/usr/bin:/opt/homebrew/bin' };

// 每用例复位进程级成功缓存（多用例隔离——bash-path 测试同款纪律）
beforeEach(() => resetFdCacheForTest());
afterEach(() => resetFdCacheForTest());

describe('resolveFdPath — 两级发现序', () => {
  it('⓪ APP_FD_PATH 显式覆盖：存在即用（操作员主权，不查 PATH）', () => {
    const probe = countingExists(['/custom/fd-bin']);
    const deps: FdResolveDeps = {
      platform: 'darwin',
      env: { ...POSIX_ENV, APP_FD_PATH: '/custom/fd-bin' },
      exists: probe.exists,
    };
    expect(resolveFdPath(deps)).toBe('/custom/fd-bin');
    expect(probe.calls).toEqual(['/custom/fd-bin']); // ⓪ 命中即止——PATH 未触
  });

  it('⓪ 指定但不存在：静默落 ①（已知静默角落——诚实缺席无出口反馈面）', () => {
    const probe = countingExists(['/opt/homebrew/bin/fd']);
    const deps: FdResolveDeps = {
      platform: 'darwin',
      env: { ...POSIX_ENV, APP_FD_PATH: '/typo/path' },
      exists: probe.exists,
    };
    expect(resolveFdPath(deps)).toBe('/opt/homebrew/bin/fd'); // PATH 命中
    expect(probe.calls[0]).toBe('/typo/path'); // ⓪ 先探（miss）
  });

  it('⓪ 空串视同未设：直接走 PATH 查找', () => {
    const probe = countingExists(['/usr/bin/fd']);
    const deps: FdResolveDeps = { platform: 'darwin', env: { ...POSIX_ENV, APP_FD_PATH: '' }, exists: probe.exists };
    expect(resolveFdPath(deps)).toBe('/usr/bin/fd');
    expect(probe.calls).not.toContain(''); // 空串不落探
  });

  it('① POSIX：PATH 目录序查找基名 fd（先目录先胜）', () => {
    const deps: FdResolveDeps = { platform: 'darwin', env: POSIX_ENV, exists: (p) => p === '/opt/homebrew/bin/fd' };
    expect(resolveFdPath(deps)).toBe('/opt/homebrew/bin/fd');
  });

  it('① POSIX 第二基名 fdfind：fd 全 miss 后落 Debian 实名变体（基名序不是目录序交错）', () => {
    const probe = countingExists(['/usr/bin/fdfind']);
    const deps: FdResolveDeps = { platform: 'linux', env: POSIX_ENV, exists: probe.exists };
    expect(resolveFdPath(deps)).toBe('/usr/bin/fdfind');
    // 探测序 = fd 两目录先扫完，才轮到 fdfind（基名外层循环——全部 fd miss 才探 fdfind）
    expect(probe.calls).toEqual(['/usr/bin/fd', '/opt/homebrew/bin/fd', '/usr/bin/fdfind']);
  });

  it('① win32：PATH 查找基名 fd.exe（分号切分；非 win32 宿主上 node:path 拼正斜杠——断言用 join 同源形态，bash-path 测试同款）', () => {
    const deps: FdResolveDeps = {
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\System32;C:\\tools' },
      exists: (p) => p === join('C:\\tools', 'fd.exe'),
    };
    expect(resolveFdPath(deps)).toBe(join('C:\\tools', 'fd.exe'));
  });

  it('全序皆空 → null（诚实缺席——对照 bash 的 fail-loud 形状，辅助面不抛）', () => {
    const deps: FdResolveDeps = { platform: 'darwin', env: { PATH: '/nowhere' }, exists: () => false };
    expect(resolveFdPath(deps)).toBe(null);
  });

  it('PATH 未设（GUI 最小环境）→ null 不抛', () => {
    const deps: FdResolveDeps = { platform: 'darwin', env: {}, exists: () => true };
    expect(resolveFdPath(deps)).toBe(null); // 空段过滤后无目录可探
  });
});

describe('resolveFdPath — 缓存策略（成功缓存失败重探）', () => {
  it('成功缓存：二次调用零重探（探测计数不变——进程级事实）', () => {
    const probe = countingExists(['/usr/bin/fd']);
    const deps: FdResolveDeps = { platform: 'darwin', env: POSIX_ENV, exists: probe.exists };
    resolveFdPath(deps);
    const callsAfterFirst = probe.calls.length;
    expect(resolveFdPath(deps)).toBe('/usr/bin/fd');
    expect(probe.calls).toHaveLength(callsAfterFirst); // 缓存命中——零探测
  });

  it('失败不缓存：二次调用重探（中途安装可发现性——探测计数翻倍）', () => {
    let installed = false; // 第一次探测后「装上」fd
    const probe = countingExists([]);
    const deps: FdResolveDeps = {
      platform: 'darwin',
      env: POSIX_ENV,
      exists: (p) => probe.exists(p) || (installed && p === '/usr/bin/fd'),
    };
    expect(resolveFdPath(deps)).toBe(null);
    installed = true;
    expect(resolveFdPath(deps)).toBe('/usr/bin/fd'); // 重探拿到
    // 计数全序形状：第一轮全 miss = fd×2 目录 + fdfind×2 目录 = 4 探；第二轮首探即命中 = 1
    expect(probe.calls).toEqual([
      '/usr/bin/fd',
      '/opt/homebrew/bin/fd',
      '/usr/bin/fdfind',
      '/opt/homebrew/bin/fdfind',
      '/usr/bin/fd',
    ]);
  });
});

describe('fdPathFor — 消费点三态决策（TuiChannelOptions.fdPath 注入键）', () => {
  it('undefined = 未注入：走真发现序（全空环境 = null 诚实缺席）', () => {
    expect(fdPathFor(undefined)).toBe(resolveFdPath({ platform: 'darwin', env: { PATH: '' }, exists: () => false }));
  });

  it('null = 显式禁用：直通 null（?? 合并会抹掉该语义——全等判断是关键）', () => {
    expect(fdPathFor(null)).toBe(null);
  });

  it('字符串 = 显式指定：直通（不探测、不校验——操作员主权）', () => {
    expect(fdPathFor('/explicit/fd')).toBe('/explicit/fd');
  });

  it('空串 = 与 null 同效禁用（pi-tui 真值判定 !fdPath 同款退化）', () => {
    expect(fdPathFor('')).toBe('');
  });
});
