/**
 * L3 webui — 工作区文件补全行走单元测试（契约篇 §6.8 刀三 @-mention 第一段）。
 *
 * 真文件树（tmp dir 造树——gitignore 语义/硬跳名/前缀过滤/目录在场/双帽全
 * 真实 IO 面，不 mock fs）。posixRelative 辅助面一并锁。
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWorkspaceFiles, posixRelative } from './files.js';

/** 临时工作区（realpath 归一——macOS /var 与 /private/var 差异教训） */
function makeWorkspace(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'webui-files-')));
}

/** 造树助手：路径段数组 → 写文件（含父目录 mkdirp） */
function put(root: string, rel: string, content = 'x'): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

describe('工作区文件补全行走', () => {
  it('浅树全量：文件与目录都在候选（行走序输出）', async () => {
    const root = makeWorkspace();
    try {
      put(root, 'README.md');
      put(root, 'src/main.ts');
      put(root, 'src/util/helper.ts');
      const files = await listWorkspaceFiles(root, '');
      expect(files).toContain('README.md');
      expect(files).toContain('src/'); // 目录也可补全（@path 导航面）——携尾 '/'（TUI-7：接受侧不补尾空格以续走钻取）
      expect(files).toContain('src/main.ts');
      expect(files).toContain('src/util/helper.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('前缀过滤：src 只命中 src 族，不命中 README', async () => {
    const root = makeWorkspace();
    try {
      put(root, 'README.md');
      put(root, 'src/main.ts');
      const files = await listWorkspaceFiles(root, 'src');
      expect(files.every((f) => f.startsWith('src'))).toBe(true);
      expect(files).toContain('src/'); // 目录条目尾斜杠形
      expect(files).toContain('src/main.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('gitignore 语义：根 .gitignore 命中条目（文件与目录同判）不吐', async () => {
    const root = makeWorkspace();
    try {
      put(root, '.gitignore', 'dist/\nsecret.txt\n');
      put(root, 'src/main.ts');
      put(root, 'dist/bundle.js');
      put(root, 'secret.txt');
      const files = await listWorkspaceFiles(root, '');
      expect(files).toContain('src/main.ts');
      expect(files.some((f) => f.startsWith('dist'))).toBe(false); // 目录整棵剪
      expect(files).not.toContain('secret.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('硬跳名：无 .gitignore 的仓也保基本卫生（.git/node_modules 不入列）', async () => {
    const root = makeWorkspace();
    try {
      put(root, 'main.ts');
      put(root, '.git/objects/ab');
      put(root, 'node_modules/pkg/index.js');
      const files = await listWorkspaceFiles(root, '');
      expect(files).toEqual(['main.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('编辑器瞬态垃圾（.DS_Store / .# 开头）不入列', async () => {
    const root = makeWorkspace();
    try {
      put(root, 'a.ts');
      put(root, '.DS_Store');
      put(root, '.#b.ts');
      expect(await listWorkspaceFiles(root, '')).toEqual(['a.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('返回帽 50：宽前缀命中超 50 条截断（补全面不是浏览面）', async () => {
    const root = makeWorkspace();
    try {
      for (let i = 0; i < 60; i++) put(root, `f${String(i).padStart(2, '0')}.ts`);
      const files = await listWorkspaceFiles(root, 'f');
      expect(files).toHaveLength(50);
      expect(files[0]).toBe('f00.ts'); // 前缀序截断（行走序 = 名字序）
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('深度帽 10：10 段路径在册；11 段不再行走', async () => {
    const root = makeWorkspace();
    try {
      // depth 语义：第 k 层 walkDir 枚举 k 段相对路径——帽 10 = 10 段可见，
      // 10 段目录不再下钻（其内容 11 段不可见）
      const deep = Array.from({ length: 9 }, (_, i) => `d${i}`).join('/');
      put(root, `${deep}/inside.ts`); // 10 段 → 在册
      put(root, `${deep}/d9/outside.ts`); // 11 段 → 帽外
      const files = await listWorkspaceFiles(root, '');
      expect(files).toContain(`${deep}/inside.ts`);
      expect(files.some((f) => f.includes('outside.ts'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('空根与不存在根：空数组不炸（readdir 容错面）', async () => {
    expect(await listWorkspaceFiles(join(tmpdir(), 'webui-nonexistent-zzz'), '')).toEqual([]);
  });

  it('posixRelative：root 内绝对路径 → POSIX 相对（分隔符归一）', () => {
    expect(posixRelative('/a/b', '/a/b/c/d.ts')).toBe('c/d.ts');
    expect(posixRelative('/a/b', '/a/b')).toBe('');
  });
});
