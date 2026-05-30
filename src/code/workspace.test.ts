import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectWorkspace, validateFilePath, checkDirtyState, refreshWorkspace } from './workspace.js';
import type { CodeWorkspace } from './workspace.js';

let tempDir: string;
let gitRepo: string;

beforeEach(() => {
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'berry-workspace-')));
  gitRepo = join(tempDir, 'repo');
  mkdirSync(gitRepo);
  execSync('git init', { cwd: gitRepo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: gitRepo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: gitRepo, stdio: 'pipe' });
  writeFileSync(join(gitRepo, 'README.md'), '# Test');
  execSync('git add . && git commit -m "init"', { cwd: gitRepo, stdio: 'pipe' });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('detectWorkspace', () => {
  it('在 git 仓库中返回正确的 gitRoot 和 branch', async () => {
    const ws = await detectWorkspace(gitRepo);
    expect(ws).not.toBeNull();
    expect(ws!.gitRoot).toBe(gitRepo);
    expect(ws!.branch).toMatch(/^(main|master)$/);
    expect(ws!.isDirty).toBe(false);
  });

  it('在子目录中也能正确探测', async () => {
    const subDir = join(gitRepo, 'src', 'lib');
    mkdirSync(subDir, { recursive: true });
    const ws = await detectWorkspace(subDir);
    expect(ws).not.toBeNull();
    expect(ws!.gitRoot).toBe(gitRepo);
  });

  it('在非 git 目录返回 null', async () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'berry-nongit-'));
    try {
      const ws = await detectWorkspace(nonGit);
      expect(ws).toBeNull();
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('接受自定义 excludedPaths', async () => {
    const ws = await detectWorkspace(gitRepo, { excludedPaths: ['custom/'] });
    expect(ws).not.toBeNull();
    expect(ws!.excludedPaths).toEqual(['custom/']);
  });
});

describe('validateFilePath', () => {
  let workspace: CodeWorkspace;

  beforeEach(async () => {
    workspace = (await detectWorkspace(gitRepo))!;
  });

  it('允许仓库内的合法路径', () => {
    const result = validateFilePath(workspace, 'src/index.ts', 'write');
    expect(result.allowed).toBe(true);
  });

  it('允许使用绝对路径', () => {
    const result = validateFilePath(workspace, join(gitRepo, 'src/index.ts'), 'write');
    expect(result.allowed).toBe(true);
  });

  it('拒绝路径穿越', () => {
    const result = validateFilePath(workspace, '../../etc/passwd', 'read');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('路径越界');
  });

  it('拒绝 excludedPaths 中的路径', () => {
    const result = validateFilePath(workspace, '.git/objects/abc', 'read');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('路径被排除');
  });

  it('拒绝 .env 文件', () => {
    const result = validateFilePath(workspace, '.env', 'write');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('路径被排除');
  });

  it('拒绝 .key 文件', () => {
    const result = validateFilePath(workspace, 'secrets/app.key', 'write');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('路径被排除');
  });

  it('拒绝 node_modules 下的文件', () => {
    const result = validateFilePath(workspace, 'node_modules/pkg/index.js', 'write');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('路径被排除');
  });

  it('包含符号链接时拒绝', () => {
    const realDir = join(gitRepo, 'real');
    const linkDir = join(gitRepo, 'linked');
    mkdirSync(realDir);
    writeFileSync(join(realDir, 'file.ts'), 'content');
    symlinkSync(realDir, linkDir);
    const result = validateFilePath(workspace, 'linked/file.ts', 'write');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('符号链接');
  });

  it('readOnlyPaths 阻止写入', () => {
    const ws: CodeWorkspace = { ...workspace, readOnlyPaths: ['vendor/'] };
    const result = validateFilePath(ws, 'vendor/lib.js', 'write');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('只读');
  });

  it('readOnlyPaths 不阻止读取', () => {
    const ws: CodeWorkspace = { ...workspace, readOnlyPaths: ['vendor/'] };
    const result = validateFilePath(ws, 'vendor/lib.js', 'read');
    expect(result.allowed).toBe(true);
  });

  it('allowedPaths 限制写入范围', () => {
    const ws: CodeWorkspace = { ...workspace, allowedPaths: ['src/'] };
    expect(validateFilePath(ws, 'src/index.ts', 'write').allowed).toBe(true);
    expect(validateFilePath(ws, 'docs/readme.md', 'write').allowed).toBe(false);
  });
});

describe('checkDirtyState', () => {
  it('干净仓库返回 dirty: false', async () => {
    const ws = (await detectWorkspace(gitRepo))!;
    const result = await checkDirtyState(ws);
    expect(result.dirty).toBe(false);
    expect(result.untrackedCount).toBe(0);
    expect(result.modifiedCount).toBe(0);
    expect(result.stagedCount).toBe(0);
  });

  it('正确计数修改和未跟踪文件', async () => {
    writeFileSync(join(gitRepo, 'README.md'), '# Modified');
    writeFileSync(join(gitRepo, 'new.txt'), 'new file');
    const ws = (await detectWorkspace(gitRepo))!;
    const result = await checkDirtyState(ws);
    expect(result.dirty).toBe(true);
    expect(result.modifiedCount).toBe(1);
    expect(result.untrackedCount).toBe(1);
  });

  it('正确计数 staged 文件', async () => {
    writeFileSync(join(gitRepo, 'README.md'), '# Staged');
    execSync('git add README.md', { cwd: gitRepo, stdio: 'pipe' });
    const ws = (await detectWorkspace(gitRepo))!;
    const result = await checkDirtyState(ws);
    expect(result.dirty).toBe(true);
    expect(result.stagedCount).toBe(1);
  });
});

describe('refreshWorkspace', () => {
  it('更新 dirty 状态', async () => {
    const ws = (await detectWorkspace(gitRepo))!;
    expect(ws.isDirty).toBe(false);

    writeFileSync(join(gitRepo, 'new.txt'), 'content');
    const refreshed = await refreshWorkspace(ws);
    expect(refreshed.isDirty).toBe(true);
  });
});
