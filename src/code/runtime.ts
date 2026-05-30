import type { Database } from 'better-sqlite3';
import { genId } from '../utils/id.js';
import type { ArtifactType } from './types.js';

export interface FileChangeRecord {
  id: string;
  taskId: string;
  filePath: string;
  action: 'create' | 'modify' | 'delete' | 'rename';
  before: string | null;
  after: string | null;
  createdAt: number;
}

export interface CommandRecord {
  id: string;
  taskId: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  createdAt: number;
}

export interface ChangeSummary {
  totalFiles: number;
  created: number;
  modified: number;
  deleted: number;
  renamed: number;
  files: Array<{ path: string; action: string }>;
}

export class CodeRuntime {
  constructor(private readonly db: Database) {}

  recordArtifact(taskId: string, type: ArtifactType, payload: Record<string, unknown>, opts?: { filePath?: string; command?: string }): string {
    const id = genId('cta');
    this.db.prepare(`
      INSERT INTO code_task_artifacts (id, task_id, artifact_type, file_path, command, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      taskId,
      type,
      opts?.filePath ?? null,
      opts?.command ?? null,
      JSON.stringify(payload),
      Date.now(),
    );
    return id;
  }

  getArtifacts(taskId: string): Array<{ id: string; type: ArtifactType; filePath: string | null; command: string | null; payload: Record<string, unknown>; createdAt: number }> {
    const rows = this.db.prepare(`
      SELECT id, artifact_type, file_path, command, payload, created_at
      FROM code_task_artifacts WHERE task_id = ? ORDER BY created_at
    `).all(taskId) as Array<{ id: string; artifact_type: string; file_path: string | null; command: string | null; payload: string; created_at: number }>;

    return rows.map(r => ({
      id: r.id,
      type: r.artifact_type as ArtifactType,
      filePath: r.file_path,
      command: r.command,
      payload: JSON.parse(r.payload),
      createdAt: r.created_at,
    }));
  }

  recordFileChange(taskId: string, filePath: string, action: FileChangeRecord['action'], before?: string, after?: string): string {
    const id = genId('cfc');
    this.db.prepare(`
      INSERT INTO code_file_changes (id, task_id, file_path, action, before_content, after_content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, taskId, filePath, action, before ?? null, after ?? null, Date.now());
    return id;
  }

  recordCommand(taskId: string, command: string, exitCode: number, stdout: string, stderr: string, durationMs: number): string {
    const id = genId('ccmd');
    this.db.prepare(`
      INSERT INTO code_commands (id, task_id, command, exit_code, stdout, stderr, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, taskId, command, exitCode, stdout, stderr, durationMs, Date.now());
    return id;
  }

  getChangeSummary(taskId: string): ChangeSummary {
    const rows = this.db.prepare(
      `SELECT file_path, action FROM code_file_changes WHERE task_id = ? ORDER BY created_at`,
    ).all(taskId) as Array<{ file_path: string; action: string }>;

    const summary: ChangeSummary = {
      totalFiles: rows.length,
      created: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      files: rows.map(r => ({ path: r.file_path, action: r.action })),
    };

    for (const row of rows) {
      if (row.action === 'create') summary.created++;
      else if (row.action === 'modify') summary.modified++;
      else if (row.action === 'delete') summary.deleted++;
      else if (row.action === 'rename') summary.renamed++;
    }

    return summary;
  }

  getCommandHistory(taskId: string): CommandRecord[] {
    const rows = this.db.prepare(
      `SELECT id, task_id, command, exit_code, stdout, stderr, duration_ms, created_at
       FROM code_commands WHERE task_id = ? ORDER BY created_at`,
    ).all(taskId) as Array<{
      id: string; task_id: string; command: string; exit_code: number;
      stdout: string; stderr: string; duration_ms: number; created_at: number;
    }>;

    return rows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      command: r.command,
      exitCode: r.exit_code,
      stdout: r.stdout,
      stderr: r.stderr,
      durationMs: r.duration_ms,
      createdAt: r.created_at,
    }));
  }
}
