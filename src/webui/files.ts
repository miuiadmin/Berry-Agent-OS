/**
 * L3 webui — 工作区文件补全行走（契约篇 §6.8 刀三 @-mention 两段式第一段）。
 *
 * `@` 触发的文件路径补全数据源：从工作区根（deps.workspaceRoot 原始
 * workspace——与 fs 工具族/LSP resolvePath 同锚）有界异步行走。gitignore
 * 语义走 `ignore` 包（根 .gitignore 装载一次）+ 三硬跳名（.git/node_modules/
 * .DS_Store——无 .gitignore 的仓也保基本卫生）。双帽自守（spec：深度帽 +
 * 数量帽）：行走深度 ≤10、扫描条目 ≤5000（防巨仓拖死事件循环）、返回 ≤50
 * （补全面不是浏览面）。异步 readdir（不阻塞 TUI 主循环）。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import ignore from 'ignore';

/** 行走深度帽（目录层数——工作区补全面不需要更深） */
const MAX_DEPTH = 10;
/** 扫描条目帽（stat/readdir 计数——巨仓止损，超帽即停走） */
const MAX_SCAN = 5_000;
/** 返回条目帽（补全候选数——前缀序截断） */
const MAX_RESULTS = 50;

/** 无条件跳过的目录名（gitignore 之外的硬卫生——无 .gitignore 的仓同样生效） */
const HARD_SKIP_DIRS = new Set(['.git', 'node_modules']);

/**
 * 列工作区文件（前缀过滤 + gitignore 语义 + 双帽）。
 * @param root 工作区根（绝对路径——deps.workspaceRoot 产物）
 * @param prefix 前缀（用户 @ 后已输入的路径片段；空串 = 全部）
 * @returns 命中条目（root 相对 POSIX 风格路径，前缀序 ≤50 条）
 */
export async function listWorkspaceFiles(root: string, prefix: string): Promise<string[]> {
  // 根 .gitignore 装载（缺席 = 仅硬跳名生效；读失败容错——补全面不因权限面炸）
  let ig: ReturnType<typeof ignore> | undefined;
  try {
    const text = await readFile(join(root, '.gitignore'), 'utf8');
    ig = ignore().add(text);
  } catch {
    ig = undefined; // 无 .gitignore / 读失败——裸行走（硬跳名仍在）
  }

  /** 前缀命中收集（行走序即输出序——稳定可测） */
  const hits: string[] = [];
  /** 扫描计数（readdir 目录内条目累计——超帽止损） */
  let scanned = 0;

  /** 单目录行走（递归体——depth 帽内、扫描帽内） */
  async function walkDir(absDir: string, relDir: string, depth: number): Promise<void> {
    let names: readonly import('node:fs').Dirent[];
    try {
      names = await readdir(absDir, { withFileTypes: true });
    } catch {
      return; // 权限/消失等 IO 面——跳过该目录（补全不炸）
    }
    for (const ent of names) {
      if (scanned >= MAX_SCAN || hits.length >= MAX_RESULTS) return; // 双帽止损
      scanned += 1;
      if (ent.name === '.DS_Store' || ent.name.startsWith('.#')) continue; // 编辑器瞬态垃圾
      const rel = relDir === '' ? ent.name : `${relDir}/${ent.name}`;
      // gitignore 语义：ignore 包对目录式样式（`dist/` 尾斜杠）只在路径带尾斜杠
      // 时命中——目录条目双试探（`dist` 与 `dist/` 两形都问，任一命中即剪）
      const ignored = ig?.ignores(rel) === true || (ent.isDirectory() && ig?.ignores(`${rel}/`) === true);
      if (ignored) continue;
      if (ent.isDirectory()) {
        if (HARD_SKIP_DIRS.has(ent.name)) continue;
        if (rel.startsWith(prefix)) hits.push(rel); // 目录也可补全（@path 导航面）
        if (depth + 1 <= MAX_DEPTH) await walkDir(join(absDir, ent.name), rel, depth + 1);
      } else if (ent.isFile() && rel.startsWith(prefix)) {
        hits.push(rel);
        if (hits.length >= MAX_RESULTS) return;
      }
    }
  }

  await walkDir(root, '', 1);
  return hits.slice(0, MAX_RESULTS);
}

/** 相对路径工具（测试面导出——root 内绝对 → POSIX 相对） */
export function posixRelative(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}
