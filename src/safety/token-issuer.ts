import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ITokenIssuer } from './contract.js';
import { genId } from '../utils/id.js';

export interface IssueTokenParams {
  approvalId?: string;
  runId?: string;
  sessionId: string;
  agentName: string;
  toolName: string;
  inputHash: string;
  cwd?: string;
  verdict?: 'allow_once' | 'allow_session';
  expiresMs?: number;
}

export interface PermissionToken {
  id: string;
  approvalId: string | null;
  runId: string | null;
  sessionId: string;
  agentName: string;
  toolName: string;
  inputHash: string;
  cwd: string | null;
  bindingHash: string;
  verdict: 'allow_once' | 'allow_session';
  oneTime: boolean;
  consumed: boolean;
  expiresAt: number;
  createdAt: number;
  consumedAt: number | null;
}

export interface TokenBinding {
  sessionId: string;
  agentName: string;
  toolName: string;
  inputHash: string;
  cwd?: string;
}

export type ValidationResult =
  | { valid: true; token: PermissionToken }
  | { valid: false; reason: string };

// TokenAuditEntry 已在 16.0 §17.8 随 getAuditLog 一并删除

export function computeBindingHash(binding: TokenBinding): string {
  const raw = `${binding.sessionId}|${binding.agentName}|${binding.toolName}|${binding.inputHash}|${binding.cwd ?? ''}`;
  return createHash('sha256').update(raw).digest('hex');
}

const DEFAULT_EXPIRES_MS = 60_000;

export class TokenIssuer implements ITokenIssuer {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  issue(params: IssueTokenParams): PermissionToken {
    const id = genId('ptk');
    const now = Date.now();
    const expiresAt = now + (params.expiresMs ?? DEFAULT_EXPIRES_MS);
    const verdict = params.verdict ?? 'allow_once';
    const oneTime = verdict === 'allow_once';

    const bindingHash = computeBindingHash({
      sessionId: params.sessionId,
      agentName: params.agentName,
      toolName: params.toolName,
      inputHash: params.inputHash,
      cwd: params.cwd,
    });

    this.db.prepare(`
      INSERT INTO permission_tokens (id, approval_id, run_id, session_id, agent_name, tool_name, input_hash, cwd, binding_hash, verdict, one_time, consumed, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      id,
      params.approvalId ?? null,
      params.runId ?? null,
      params.sessionId,
      params.agentName,
      params.toolName,
      params.inputHash,
      params.cwd ?? null,
      bindingHash,
      verdict,
      oneTime ? 1 : 0,
      expiresAt,
      now,
    );

    return {
      id,
      approvalId: params.approvalId ?? null,
      runId: params.runId ?? null,
      sessionId: params.sessionId,
      agentName: params.agentName,
      toolName: params.toolName,
      inputHash: params.inputHash,
      cwd: params.cwd ?? null,
      bindingHash,
      verdict,
      oneTime,
      consumed: false,
      expiresAt,
      createdAt: now,
      consumedAt: null,
    };
  }

  validate(tokenId: string, binding: TokenBinding): ValidationResult {
    const row = this.db.prepare(`
      SELECT * FROM permission_tokens WHERE id = ?
    `).get(tokenId) as Record<string, unknown> | undefined;

    if (!row) {
      return { valid: false, reason: '令牌不存在' };
    }

    const token = rowToToken(row);

    if (token.consumed) {
      return { valid: false, reason: '令牌已被消费' };
    }

    const now = Date.now();
    if (now > token.expiresAt) {
      return { valid: false, reason: '令牌已过期' };
    }

    const expectedHash = computeBindingHash(binding);
    if (token.bindingHash !== expectedHash) {
      return { valid: false, reason: '绑定上下文不匹配' };
    }

    return { valid: true, token };
  }

  consume(tokenId: string): boolean {
    const now = Date.now();

    const result = this.db.prepare(`
      UPDATE permission_tokens
      SET consumed = 1, consumed_at = ?
      WHERE id = ? AND consumed = 0 AND expires_at > ?
    `).run(now, tokenId, now);

    return result.changes > 0;
  }

  // findSessionToken / getAuditLog 已在 16.0 §17.8 删除（零调用方）
}

function rowToToken(row: Record<string, unknown>): PermissionToken {
  return {
    id: row.id as string,
    approvalId: row.approval_id as string | null,
    runId: row.run_id as string | null,
    sessionId: row.session_id as string,
    agentName: row.agent_name as string,
    toolName: row.tool_name as string,
    inputHash: row.input_hash as string,
    cwd: row.cwd as string | null,
    bindingHash: row.binding_hash as string,
    verdict: row.verdict as 'allow_once' | 'allow_session',
    oneTime: (row.one_time as number) === 1,
    consumed: (row.consumed as number) === 1,
    expiresAt: row.expires_at as number,
    createdAt: row.created_at as number,
    consumedAt: row.consumed_at as number | null,
  };
}
