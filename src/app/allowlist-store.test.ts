/**
 * L5 app 测试 — allowlist 用户配置层存储（第二十四批题1a 接线批 Commit A）。
 * 真文件真原子写（tmpdir 落盘回读），无 mock：装载/活数组/去重/移除/损坏
 * 容错/写失败降级六面。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AllowlistEntry } from '../safety/index.js';
import { AllowlistStore } from './allowlist-store.js';

function freshDir(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'allowlist-store-'));
  return { dir, path: join(dir, 'allowlist.json') };
}

describe('AllowlistStore — 装载与活数组', () => {
  it('缺省文件 = 空表起步（零 warn 之外的副作用）；add 后落盘、重开读回', () => {
    const { path } = freshDir();
    const store = new AllowlistStore(path);
    expect(store.list()).toHaveLength(0);

    expect(store.add({ tool: 'write', pattern: 'docs' })).toBe(true);
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as { version: number; entries: unknown[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.entries).toEqual([{ tool: 'write', pattern: 'docs' }]);

    const reopened = new AllowlistStore(path);
    expect(reopened.list()).toEqual([{ tool: 'write', pattern: 'docs' }]);
  });

  it('活数组引用：entries 是同一引用，add/remove 原地改（守门行零重装即见最新表）', () => {
    const { path } = freshDir();
    const store = new AllowlistStore(path);
    const live = store.entries;
    store.add({ tool: 'bash', pattern: 'git status' });
    store.add({ tool: 'write', pattern: 'src' });
    expect(live).toHaveLength(2);
    store.remove(0);
    expect(live).toHaveLength(1);
    expect(live[0]).toEqual({ tool: 'write', pattern: 'src' });
    // list() 是拷贝视图——外部改 list 不影响活数组
    const snapshot = store.list() as AllowlistEntry[];
    snapshot.pop();
    expect(live).toHaveLength(1);
  });
});

describe('AllowlistStore — 容错面', () => {
  it('损坏文件 = 空表起步 + warn（原文件保留待人工处置）', () => {
    const { dir, path } = freshDir();
    writeFileSync(path, '{oops 不是 json', 'utf-8');
    const warnings: string[] = [];
    const store = new AllowlistStore(path, { warn: (m) => warnings.push(m) });
    expect(store.list()).toHaveLength(0);
    expect(warnings.join('\n')).toContain('损坏');
    expect(readFileSync(path, 'utf-8')).toContain('oops'); // 原文件未被动
    expect(dir).toContain('allowlist-store'); // lint 抚慰：dir 使用在场
  });

  it('版本/形状不合法条目拒载 + warn；合法条目照常载入', () => {
    const { path } = freshDir();
    const file = {
      version: 1,
      entries: [
        { tool: 'write', pattern: 'docs' },
        { tool: '', pattern: 'x' }, // tool 空——不合法
        { tool: 'bash', pattern: 42 }, // pattern 非串——不合法
        { tool: 'bash', pattern: 'ls', expiresAt: 'soon' }, // expiresAt 非数——不合法
      ],
    };
    writeFileSync(path, JSON.stringify(file), 'utf-8');
    const warnings: string[] = [];
    const store = new AllowlistStore(path, { warn: (m) => warnings.push(m) });
    expect(store.list()).toEqual([{ tool: 'write', pattern: 'docs' }]);
    expect(warnings.join('\n')).toContain('3 条形状不合法');
  });

  it('重复条目拒加（tool+pattern 全同幂等）；remove 越界 false', () => {
    const { path } = freshDir();
    const store = new AllowlistStore(path);
    expect(store.add({ tool: 'write', pattern: 'docs' })).toBe(true);
    expect(store.add({ tool: 'write', pattern: 'docs', expiresAt: 123 })).toBe(false); // 同键视重
    expect(store.list()).toHaveLength(1);
    expect(store.remove(5)).toBe(false);
    expect(store.remove(-1)).toBe(false);
  });

  it('落盘失败降级：warn 不抛，内存表仍生效', () => {
    // path 指向不存在目录 → writeAtomicFile 的 openSync 必抛 → 降级路
    const base = freshDir().dir;
    const badPath = join(base, 'no-such-dir', 'allowlist.json');
    const warnings: string[] = [];
    const store = new AllowlistStore(badPath, { warn: (m) => warnings.push(m) });
    expect(store.add({ tool: 'bash', pattern: 'ls' })).toBe(true); // 不抛
    expect(store.list()).toHaveLength(1); // 内存表仍生效
    expect(warnings.join('\n')).toContain('落盘失败');
  });
});
