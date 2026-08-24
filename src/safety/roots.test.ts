/**
 * L3 safety 测试 — 可写根唯一推导 + carve-out 层叠例外（骨架篇 §7.3）。
 * 真文件系统（mkdtemp 工作区）验证 canonical 化、glob 展开、层叠判定。
 */

import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  absolutize,
  buildCarveOutTable,
  canonicalPath,
  createRootsProvider,
  deriveWritableRoots,
  expandCarveOutEntry,
  resolveWritability,
  type CarveOutEntry,
  type CarveOutNode,
} from './roots.js';
import type { SandboxMode, WritableRootsInput } from './types.js';

/** 造一个真临时工作区（直接 canonical 化——macOS mkdtemp 给的是 /var/... 非真实前缀） */
function makeWorkspace(): string {
  return canonicalPath(mkdtempSync(join(tmpdir(), 'safety-roots-')));
}

describe('canonicalPath', () => {
  it('存在路径解析符号链到真实位置', () => {
    const ws = makeWorkspace();
    const real = join(ws, 'real');
    mkdirSync(real);
    const link = join(ws, 'link');
    symlinkSync(real, link);
    expect(canonicalPath(link)).toBe(canonicalPath(real));
  });

  it('不存在路径原样返回（保守：缺失的根匹配不到任何东西）', () => {
    expect(canonicalPath('/definitely/not/exist/path')).toBe('/definitely/not/exist/path');
  });
});

describe('deriveWritableRoots（mode 一等输入——2026-08-25 修）', () => {
  it('workspace-write：workspace + /tmp + tmpdir（canonical 去重）', () => {
    const ws = makeWorkspace();
    const roots = deriveWritableRoots(ws, 'workspace-write');
    expect(roots).toContain(canonicalPath(ws));
    expect(roots).toContain(canonicalPath('/tmp')); // macOS 上真实位置是 /private/tmp
    expect(roots).toContain(canonicalPath(tmpdir()));
    // 去重：tmpdir 在多数 CI 环境就是 /tmp，集合不该有重复
    expect(new Set(roots).size).toBe(roots.length);
  });

  it('read-only：空根（fence 拦一切写——修前恒三根档位无效，回归锁）', () => {
    const ws = makeWorkspace();
    expect(deriveWritableRoots(ws, 'read-only')).toEqual([]);
  });

  it('danger-full-access：全盘单根 [sep]（isInsideRoot 分隔符特判的唯一全覆盖根）', () => {
    const ws = makeWorkspace();
    expect(deriveWritableRoots(ws, 'danger-full-access')).toEqual([sep]);
  });
});

describe('expandCarveOutEntry', () => {
  it('字面 pattern 转绝对路径（不检查存在性——init 前的 .git 就该挡）', () => {
    const ws = makeWorkspace();
    const out = expandCarveOutEntry(ws, { pattern: '.git', effect: 'deny' });
    expect(out).toEqual([canonicalPath(join(ws, '.git'))]);
  });

  it('顶层 glob 只展开实际存在的匹配（* 不跨目录分隔符）', () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, 'prod.env'), 'A=1');
    writeFileSync(join(ws, 'dev.env'), 'B=2');
    writeFileSync(join(ws, 'notenv.txt'), 'x');
    const out = expandCarveOutEntry(ws, { pattern: '*.env', effect: 'deny' });
    expect(out).toContain(canonicalPath(join(ws, 'prod.env')));
    expect(out).toContain(canonicalPath(join(ws, 'dev.env')));
    expect(out.some((p) => p.endsWith('notenv.txt'))).toBe(false);
  });

  it('目录不存在的 glob 展开为空集', () => {
    const ws = makeWorkspace();
    expect(expandCarveOutEntry(ws, { pattern: 'nodir/*.env', effect: 'deny' })).toEqual([]);
  });

  it('子目录层 glob 锚其所在目录', () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'local.env'), 'C=3');
    writeFileSync(join(ws, 'top.env'), 'D=4'); // 不在 src/ 层，不该被扫到
    const out = expandCarveOutEntry(ws, { pattern: 'src/*.env', effect: 'deny' });
    expect(out).toEqual([canonicalPath(join(ws, 'src', 'local.env'))]);
  });
});

describe('buildCarveOutTable + resolveWritability 层叠判定', () => {
  /** 便捷：条目列表 → 判定表 */
  const table = (ws: string, entries: readonly CarveOutEntry[]): CarveOutNode[] => buildCarveOutTable(ws, entries);

  it('无条目：根内放行、根外 outside-roots', () => {
    const ws = makeWorkspace();
    const roots = deriveWritableRoots(ws, 'workspace-write');
    expect(resolveWritability(join(ws, 'a.txt'), roots, table(ws, []))).toEqual({ allowed: true });
    const verdict = resolveWritability('/etc/passwd', roots, table(ws, []));
    expect(verdict).toMatchObject({ allowed: false, kind: 'outside-roots' });
  });

  it('deny 条目遮罩根内子树：carve-out 拒绝并带命中条目', () => {
    const ws = makeWorkspace();
    const entries: CarveOutEntry[] = [{ pattern: '.git', effect: 'deny', note: '版本库' }];
    const verdict = resolveWritability(
      join(ws, '.git', 'config'),
      deriveWritableRoots(ws, 'workspace-write'),
      table(ws, entries),
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed && verdict.kind === 'carve-out') {
      expect(verdict.matched?.entry.pattern).toBe('.git');
      expect(verdict.matched?.effect).toBe('deny');
    } else {
      expect.unreachable('应为 carve-out 拒绝');
    }
  });

  it('嵌套层叠：父 deny / 子 allow（孙再可写，最深前缀胜出）', () => {
    const ws = makeWorkspace();
    const entries: CarveOutEntry[] = [
      { pattern: 'build', effect: 'deny' },
      { pattern: 'build/out', effect: 'allow' },
    ];
    const t = table(ws, entries);
    const roots = deriveWritableRoots(ws, 'workspace-write');
    // build/x → 父 deny 命中（子 allow 管不到更浅的路径）
    expect(resolveWritability(join(ws, 'build', 'x'), roots, t)).toMatchObject({ allowed: false, kind: 'carve-out' });
    // build/out/y → 子 allow 更深，赢回可写
    expect(resolveWritability(join(ws, 'build', 'out', 'y'), roots, t)).toEqual({ allowed: true });
    // 无关路径不受影响
    expect(resolveWritability(join(ws, 'src', 'a.ts'), roots, t)).toEqual({ allowed: true });
  });

  it('同深度同路径 deny 胜 allow（保守）', () => {
    const ws = makeWorkspace();
    const entries: CarveOutEntry[] = [
      { pattern: 'secret.env', effect: 'allow' },
      { pattern: 'secret.env', effect: 'deny' },
    ];
    const verdict = resolveWritability(
      join(ws, 'secret.env'),
      deriveWritableRoots(ws, 'workspace-write'),
      table(ws, entries),
    );
    expect(verdict).toMatchObject({ allowed: false, kind: 'carve-out' });
  });

  it('相邻前缀不误判（/ws-evil 不是 /ws 的子路径——分隔符守卫）', () => {
    // 用自定义根直接测分隔符判定（真实工作区的兄弟目录在 tmpdir 根内，本就合法可写）
    expect(resolveWritability('/definitely/ws-evil/x', ['/definitely/ws'], [])).toMatchObject({
      allowed: false,
      kind: 'outside-roots',
    });
    expect(resolveWritability('/definitely/ws/ok', ['/definitely/ws'], [])).toEqual({ allowed: true });
    expect(resolveWritability('/definitely/ws', ['/definitely/ws'], [])).toEqual({ allowed: true }); // 根本身可写
  });
});

describe('createRootsProvider / absolutize', () => {
  it('provider 返回 canonical 化可写根（与沙箱 profile 同源）', () => {
    const ws = makeWorkspace();
    const provider = createRootsProvider({ workspace: ws, mode: () => 'workspace-write' });
    expect(provider()).toEqual(deriveWritableRoots(ws, 'workspace-write'));
  });

  it('provider 随 mode getter 切档：降 read-only 即空根（fence 立即收紧——回归锁）', () => {
    const ws = makeWorkspace();
    let mode: SandboxMode = 'workspace-write';
    const provider = createRootsProvider({ workspace: ws, mode: () => mode });
    expect(provider().length).toBeGreaterThan(0);
    mode = 'read-only';
    expect(provider()).toEqual([]);
  });

  it('absolutize：相对路径锚 workspace、绝对路径原样（均 canonical 化）', () => {
    const ws = makeWorkspace();
    const input: WritableRootsInput = { workspace: ws, mode: () => 'workspace-write' };
    expect(absolutize(input, 'a/b.txt')).toBe(canonicalPath(join(ws, 'a', 'b.txt')));
    expect(absolutize(input, join(ws, 'c.txt'))).toBe(canonicalPath(join(ws, 'c.txt')));
  });
});
