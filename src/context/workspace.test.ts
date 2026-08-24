/**
 * L1 context 单元测试（canonical 工作区根推导——记忆篇 §3 project 键定义，
 * 第十四批 A 组；2026-08-25 检索族纵切批收编宿主 context + project-aliases
 * 重定向）：主仓库 / worktree（gitdir 指针 + commondir 归并）/ 子目录向上找 /
 * 非 git 回退 / 进程内缓存 / 别名重定向与缓存失效。真临时目录 fixture，无 mock。
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalWorkspaceRoot, setProjectAliases } from './workspace.js';

/** 测试根（整树 afterAll 清理） */
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'berry-ws-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('canonicalWorkspaceRoot（git commondir 归并——防 worktree/子目录裂库）', () => {
  it('主仓库：.git 目录 → 根 = 仓库目录；任意子目录向上归并同键', () => {
    const main = join(root, 'main');
    mkdirSync(join(main, '.git'), { recursive: true });
    const deep = join(main, 'packages', 'core', 'src');
    mkdirSync(deep, { recursive: true });
    expect(canonicalWorkspaceRoot(main)).toBe(main);
    // 子目录启动：向上找到最近 .git——同一 project 键
    expect(canonicalWorkspaceRoot(deep)).toBe(main);
  });

  it('worktree：.git 文件（gitdir 指针）→ commondir 归并到主仓库根', () => {
    const main = join(root, 'wtmain');
    const wtGitdir = join(main, '.git', 'worktrees', 'feature');
    mkdirSync(wtGitdir, { recursive: true });
    // worktree 的 gitdir 内 commondir 指回主仓库 .git（相对路径 ../..）
    writeFileSync(join(wtGitdir, 'commondir'), '../..');
    const worktree = join(root, 'feature-checkout');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${wtGitdir}\n`);
    expect(canonicalWorkspaceRoot(worktree)).toBe(main);
    // 主仓库自身与 worktree 同键——不裂库
    expect(canonicalWorkspaceRoot(main)).toBe(main);
  });

  it('submodule：modules gitdir 无 commondir → 独立成域（回退字面目录）', () => {
    const superRepo = join(root, 'super');
    const modGitdir = join(superRepo, '.git', 'modules', 'vendored');
    mkdirSync(modGitdir, { recursive: true });
    const subWork = join(superRepo, 'vendored');
    mkdirSync(subWork, { recursive: true });
    writeFileSync(join(subWork, '.git'), `gitdir: ${modGitdir}\n`);
    expect(canonicalWorkspaceRoot(subWork)).toBe(subWork);
  });

  it('非 git 目录：一路无 .git → 回退字面 cwd（含路径规范化）', () => {
    const plain = join(root, 'plain', 'nested');
    mkdirSync(plain, { recursive: true });
    expect(canonicalWorkspaceRoot(plain)).toBe(plain);
    // 相对路径入参同样规范化
    expect(canonicalWorkspaceRoot('.')).toBe(canonicalWorkspaceRoot(process.cwd()));
  });

  it('探测缓存：同路径重复调用幂等（结果一致——缓存不改变语义）', () => {
    const main = join(root, 'main');
    const again = join(root, 'main', 'packages');
    expect(canonicalWorkspaceRoot(again)).toBe(main);
    expect(canonicalWorkspaceRoot(again)).toBe(main); // 二次走缓存
  });
});

describe('project-aliases 重定向（检索族纵切批——解非 git 回退脆性）', () => {
  // 进程级表状态：每用例后还原空表，防污染同进程其他测试文件
  afterEach(() => setProjectAliases({}));

  it('现根命中别名 → 返回记账根（旧 project 键续用，零数据迁移）；未命中原样', () => {
    const moved = join(root, 'moved-project'); // 「现根」：目录改名后的新位置
    const ledger = join(root, 'old-path'); // 「记账根」：旧记忆键的哈希入参
    mkdirSync(moved, { recursive: true });
    setProjectAliases({ [moved]: ledger });
    expect(canonicalWorkspaceRoot(moved)).toBe(ledger); // 命中重定向
    const untouched = join(root, 'plain', 'nested'); // 既有用例目录（无别名）
    expect(canonicalWorkspaceRoot(untouched)).toBe(untouched); // 未命中不受影响
  });

  it('别名重设即清探测缓存（旧缓存不得盖过新表）', () => {
    const dir = join(root, 'alias-cache-probe');
    mkdirSync(dir, { recursive: true });
    expect(canonicalWorkspaceRoot(dir)).toBe(dir); // 表前求值——进缓存
    const ledger = join(root, 'ledger-2');
    setProjectAliases({ [dir]: ledger });
    expect(canonicalWorkspaceRoot(dir)).toBe(ledger); // 缓存已被清，走新表
  });
});
