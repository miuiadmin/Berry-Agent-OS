import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, statSync, readdirSync, lstatSync, rmSync, type Dirent } from 'node:fs';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('task-workspace');
const MAX_WORKSPACE_BYTES = 100 * 1024 * 1024; // 100MB
const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface TaskWorkspacePaths {
  root: string;
  taskJson: string;
  contextJson: string;
  outputs: string;
  artifacts: string;
  tmp: string;
}

export function createTaskWorkspace(
  tasksDir: string,
  taskId: string,
  input: Record<string, unknown>,
): TaskWorkspacePaths {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`无效的 taskId: ${taskId}`);
  }
  const root = join(tasksDir, taskId);
  const resolved = resolve(root);
  if (!resolved.startsWith(resolve(tasksDir))) {
    throw new Error(`taskId 路径越界: ${taskId}`);
  }
  const paths: TaskWorkspacePaths = {
    root,
    taskJson: join(root, 'task.json'),
    contextJson: join(root, 'context.json'),
    outputs: join(root, 'outputs'),
    artifacts: join(root, 'artifacts'),
    tmp: join(root, 'tmp'),
  };

  mkdirSync(paths.outputs, { recursive: true });
  mkdirSync(paths.artifacts, { recursive: true });
  mkdirSync(paths.tmp, { recursive: true });

  writeFileSync(paths.taskJson, JSON.stringify(input, null, 2));
  writeFileSync(paths.contextJson, JSON.stringify({}));

  return paths;
}

export function closeTaskWorkspace(
  workspacePath: string,
  result: Record<string, unknown>,
): void {
  const resultPath = join(workspacePath, 'result.json');
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
}

export interface SafeWriteOptions {
  maxWorkspaceBytes?: number;
}

export function safeWriteWorkspaceFile(
  workspacePath: string,
  relativePath: string,
  content: string,
  options: SafeWriteOptions = {},
): string {
  const root = resolve(workspacePath);
  const target = resolve(root, relativePath);
  if (!target.startsWith(root + '/')) {
    throw new Error(`workspace 写入路径越界: ${relativePath}`);
  }

  assertNoSymlinkInPath(root, target);
  const maxBytes = options.maxWorkspaceBytes ?? MAX_WORKSPACE_BYTES;
  const current = checkWorkspaceSize(root).bytes;
  const nextBytes = Buffer.byteLength(content, 'utf-8');
  if (current + nextBytes > maxBytes) {
    throw new Error(`workspace 超出大小限制: ${current + nextBytes} > ${maxBytes}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { flag: 'wx' });
  return target;
}

export function cleanupStaleTaskWorkspaces(tasksDir: string, olderThanMs: number, now = Date.now()): string[] {
  const removed: string[] = [];
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(tasksDir, { withFileTypes: true });
  } catch (err) {
    logger.debug({ err, tasksDir }, '任务目录读取失败');
    return removed;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = join(tasksDir, entry.name);
    const stat = statSync(fullPath);
    if (now - stat.mtimeMs < olderThanMs) continue;
    rmSync(fullPath, { recursive: true, force: true });
    removed.push(fullPath);
  }
  return removed;
}

export function checkWorkspaceSize(workspacePath: string): { bytes: number; exceeded: boolean } {
  const bytes = getDirSize(workspacePath);
  return { bytes, exceeded: bytes > MAX_WORKSPACE_BYTES };
}

function getDirSize(dir: string): number {
  let total = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += getDirSize(fullPath);
      } else if (entry.isFile()) {
        total += statSync(fullPath).size;
      }
    }
  } catch {
    // directory may not exist yet — normal for new tasks
  }
  return total;
}

function assertNoSymlinkInPath(root: string, target: string): void {
  let current = root;
  const relative = target.slice(root.length + 1);
  const parts = relative.split('/').filter(Boolean);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`workspace 路径包含符号链接: ${current}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
}
