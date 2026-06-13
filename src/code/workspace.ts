import { execSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

export interface CodeWorkspace {
  gitRoot: string;
  allowedPaths: string[];
  readOnlyPaths: string[];
  excludedPaths: string[];
  isDirty: boolean;
  branch: string;
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
}

export interface DirtyCheckResult {
  dirty: boolean;
  untrackedCount: number;
  modifiedCount: number;
  stagedCount: number;
}

export interface WorkspaceOptions {
  allowedPaths?: string[];
  readOnlyPaths?: string[];
  excludedPaths?: string[];
}

const DEFAULT_EXCLUDED_PATHS = [
  '.git/objects',
  '.git/hooks',
  '.git/refs',
  '.env',
  '.env.local',
  '.env.production',
  'node_modules/',
  '*.key',
  '*.pem',
  '*.p12',
  '*.pfx',
];

/**
 * 检测工作区。优先 git 仓库（含 branch/dirty 状态），非 git 目录返回轻量工作区（路径验证仍生效，
 * git 功能降级为默认值）。这样 code agent 在普通目录也能创建文件——否则 detectWorkspace 返回 null
 * → task-phases synthesis 跳过 → implementation 永不执行 → 文件不创建（code agent 瘫痪）。
 */
export async function detectWorkspace(targetPath: string, options: WorkspaceOptions = {}): Promise<CodeWorkspace | null> {
  const absPath = resolve(targetPath);
  let gitRoot: string;
  try {
    gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: absPath,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // 非 git 目录：返回轻量工作区（路径验证仍用 absPath 作边界，git 功能降级为默认值）
    return {
      gitRoot: absPath,
      allowedPaths: options.allowedPaths ?? [],
      readOnlyPaths: options.readOnlyPaths ?? [],
      excludedPaths: options.excludedPaths ?? DEFAULT_EXCLUDED_PATHS,
      isDirty: false,
      branch: 'non-git',
    };
  }

  if (!gitRoot) return null;

  try {
    gitRoot = realpathSync(gitRoot);
  } catch {
    // keep as-is if realpath fails
  }

  let branch = 'HEAD';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: gitRoot,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // detached HEAD or other issue
  }

  const dirtyResult = await checkDirtyStateInternal(gitRoot);

  return {
    gitRoot,
    allowedPaths: options.allowedPaths ?? [],
    readOnlyPaths: options.readOnlyPaths ?? [],
    excludedPaths: options.excludedPaths ?? DEFAULT_EXCLUDED_PATHS,
    isDirty: dirtyResult.dirty,
    branch,
  };
}

export function validateFilePath(workspace: CodeWorkspace, filePath: string, mode: 'read' | 'write'): ValidationResult {
  const absPath = isAbsolute(filePath) ? resolve(filePath) : resolve(workspace.gitRoot, filePath);
  const normalizedRoot = resolve(workspace.gitRoot);

  if (!absPath.startsWith(normalizedRoot + '/') && absPath !== normalizedRoot) {
    return { allowed: false, reason: `路径越界: ${filePath} 不在仓库 ${normalizedRoot} 内` };
  }

  const relPath = relative(normalizedRoot, absPath);

  if (isExcluded(relPath, workspace.excludedPaths)) {
    return { allowed: false, reason: `路径被排除: ${relPath}` };
  }

  if (hasSymlinkInPath(normalizedRoot, absPath)) {
    return { allowed: false, reason: `路径包含符号链接: ${relPath}` };
  }

  if (mode === 'write') {
    if (workspace.readOnlyPaths.length > 0 && matchesAnyPrefix(relPath, workspace.readOnlyPaths)) {
      return { allowed: false, reason: `路径为只读: ${relPath}` };
    }

    if (workspace.allowedPaths.length > 0 && !matchesAnyPrefix(relPath, workspace.allowedPaths)) {
      return { allowed: false, reason: `路径不在允许写入范围内: ${relPath}` };
    }
  }

  return { allowed: true };
}

export async function checkDirtyState(workspace: CodeWorkspace): Promise<DirtyCheckResult> {
  return checkDirtyStateInternal(workspace.gitRoot);
}

export async function refreshWorkspace(workspace: CodeWorkspace): Promise<CodeWorkspace> {
  let branch = workspace.branch;
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workspace.gitRoot,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // keep existing
  }

  const dirtyResult = await checkDirtyStateInternal(workspace.gitRoot);

  return {
    ...workspace,
    branch,
    isDirty: dirtyResult.dirty,
  };
}

async function checkDirtyStateInternal(gitRoot: string): Promise<DirtyCheckResult> {
  let output = '';
  try {
    output = execSync('git status --porcelain', {
      cwd: gitRoot,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return { dirty: false, untrackedCount: 0, modifiedCount: 0, stagedCount: 0 };
  }

  const lines = output.split('\n').filter(l => l.length > 0);
  let untrackedCount = 0;
  let modifiedCount = 0;
  let stagedCount = 0;

  for (const line of lines) {
    const x = line[0];
    const y = line[1];
    if (x === '?' && y === '?') {
      untrackedCount++;
    } else {
      if (x !== ' ' && x !== '?') stagedCount++;
      if (y !== ' ' && y !== '?') modifiedCount++;
    }
  }

  return {
    dirty: lines.length > 0,
    untrackedCount,
    modifiedCount,
    stagedCount,
  };
}

function isExcluded(relPath: string, excludedPaths: string[]): boolean {
  for (const pattern of excludedPaths) {
    if (pattern.endsWith('/')) {
      if (relPath.startsWith(pattern) || relPath + '/' === pattern) return true;
    } else if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1);
      if (relPath.endsWith(ext)) return true;
    } else {
      if (relPath === pattern || relPath.startsWith(pattern + '/')) return true;
    }
  }
  return false;
}

function matchesAnyPrefix(relPath: string, prefixes: string[]): boolean {
  for (const prefix of prefixes) {
    if (relPath.startsWith(prefix) || relPath === prefix.replace(/\/$/, '')) return true;
  }
  return false;
}

function hasSymlinkInPath(root: string, target: string): boolean {
  const rel = relative(root, target);
  const parts = rel.split('/').filter(Boolean);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  return false;
}
