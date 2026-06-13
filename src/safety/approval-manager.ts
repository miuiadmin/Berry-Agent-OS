import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import { TokenIssuer, type PermissionToken } from './token-issuer.js';
import type { PermissionMode } from './permissions.js';
import { metrics } from '../observability/metrics.js';

export type ApprovalKind = 'tool' | 'shell' | 'file' | 'plugin' | 'code' | 'brain' | 'user';
export type RiskLevel = 'low' | 'medium' | 'high';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
export type DecisionSource = 'rule' | 'brain' | 'user' | 'allowlist' | 'blocklist';

export interface CreateApprovalParams {
  runId?: string;
  sessionId: string;
  taskId?: string;
  correlationId: string;
  kind: ApprovalKind;
  requester: string;
  riskLevel: RiskLevel;
  requestPayload: Record<string, unknown>;
  bindingPayload: {
    agentName: string;
    toolName: string;
    inputHash: string;
    cwd?: string;
  };
  expiresMs?: number;
  toolUseId?: string;
  schema?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ApprovalRequest {
  id: string;
  runId: string | null;
  sessionId: string;
  taskId: string | null;
  correlationId: string;
  kind: ApprovalKind;
  requester: string;
  riskLevel: RiskLevel;
  requestPayload: Record<string, unknown>;
  bindingPayload: Record<string, unknown>;
  status: ApprovalStatus;
  decisionSource: DecisionSource | null;
  reason: string | null;
  expiresAt: number;
  createdAt: number;
  resolvedAt: number | null;
}

export interface ResolveDecision {
  verdict: 'approved' | 'denied';
  source: DecisionSource;
  reason?: string;
  tokenVerdict?: 'allow_once' | 'allow_session';
  tokenExpiresMs?: number;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: Record<string, unknown>;
}

const DEFAULT_EXPIRES_MS = 60_000;
const MAX_PENDING = 256;
const PLAN_APPROVAL_KINDS: ApprovalKind[] = ['code', 'plugin'];

export interface PendingApproval {
  requestId: string;
  schema?: Record<string, unknown>;
  toolUseId?: string;
  timeout?: ReturnType<typeof setTimeout>;
  responded: boolean;
}

export class ApprovalManager {
  private db: Database.Database;
  private tokenIssuer: TokenIssuer;
  private permissionMode: PermissionMode;
  private pending = new Map<string, PendingApproval>();

  constructor(db: Database.Database, tokenIssuer: TokenIssuer, permissionMode: PermissionMode) {
    this.db = db;
    this.tokenIssuer = tokenIssuer;
    this.permissionMode = permissionMode;
  }

  createRequest(params: CreateApprovalParams): ApprovalRequest {
    this.expireStale();
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value!;
      this.resolveTimeout(oldest);
    }

    const id = genId('apr');
    const now = Date.now();
    const expiresAt = now + (params.expiresMs ?? DEFAULT_EXPIRES_MS);

    this.db.prepare(`
      INSERT INTO approval_requests (id, run_id, session_id, task_id, correlation_id, kind, requester, risk_level, request_payload, binding_payload, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      id,
      params.runId ?? null,
      params.sessionId,
      params.taskId ?? null,
      params.correlationId,
      params.kind,
      params.requester,
      params.riskLevel,
      JSON.stringify({
        ...params.requestPayload,
        ...(params.schema ? { schema: params.schema } : {}),
        ...(params.toolUseId ? { tool_use_id: params.toolUseId } : {}),
      }),
      JSON.stringify(params.bindingPayload),
      expiresAt,
      now,
    );

    const timeout = setTimeout(() => {
      this.resolveTimeout(id);
    }, params.timeoutMs ?? params.expiresMs ?? DEFAULT_EXPIRES_MS);
    this.pending.set(id, {
      requestId: id,
      schema: params.schema,
      toolUseId: params.toolUseId,
      timeout,
      responded: false,
    });

    metrics.counter('approval_requests_total').inc({ kind: params.kind, risk_level: params.riskLevel });

    return {
      id,
      runId: params.runId ?? null,
      sessionId: params.sessionId,
      taskId: params.taskId ?? null,
      correlationId: params.correlationId,
      kind: params.kind,
      requester: params.requester,
      riskLevel: params.riskLevel,
      requestPayload: {
        ...params.requestPayload,
        ...(params.schema ? { schema: params.schema } : {}),
        ...(params.toolUseId ? { tool_use_id: params.toolUseId } : {}),
      },
      bindingPayload: params.bindingPayload,
      status: 'pending',
      decisionSource: null,
      reason: null,
      expiresAt,
      createdAt: now,
      resolvedAt: null,
    };
  }

  resolve(requestId: string, decision: ResolveDecision): PermissionToken | null {
    const row = this.db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(requestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (row.status !== 'pending') return null;
    if (!this.markResponded(requestId)) return null;

    const now = Date.now();
    const newStatus = decision.verdict;

    this.db.prepare(`
      UPDATE approval_requests SET status = ?, decision_source = ?, reason = ?, resolved_at = ? WHERE id = ?
    `).run(newStatus, decision.source, buildDecisionReason(decision), now, requestId);

    metrics.counter('approval_decisions_total').inc({
      kind: row.kind as string,
      decision: decision.verdict,
      source: decision.source,
    });

    if (decision.verdict === 'denied') return null;
    if (PLAN_APPROVAL_KINDS.includes(row.kind as ApprovalKind)) return null;

    const binding = JSON.parse(row.binding_payload as string) as {
      agentName: string;
      toolName: string;
      inputHash: string;
      cwd?: string;
    };

    return this.tokenIssuer.issue({
      approvalId: requestId,
      runId: row.run_id as string | undefined,
      sessionId: row.session_id as string,
      agentName: binding.agentName,
      toolName: binding.toolName,
      inputHash: binding.inputHash,
      cwd: binding.cwd,
      verdict: decision.tokenVerdict ?? 'allow_once',
      expiresMs: decision.tokenExpiresMs,
    });
  }

  /**
   * 15.0 R2-4：autoDecide 接受可选 mode 参数（per-session 模式由 coordinator 传入，
   * 避免进程级单例 approvalManager.permissionMode 并发污染）。不传则回退 this.permissionMode。
   */
  autoDecide(request: ApprovalRequest, mode?: PermissionMode): PermissionToken | null {
    const decisionMode = mode ?? this.permissionMode;
    switch (decisionMode) {
      case 'allow-all':
        return this.resolve(request.id, {
          verdict: 'approved',
          source: 'rule',
          reason: '权限模式为 allow-all',
        });

      case 'deny-all':
        this.resolve(request.id, {
          verdict: 'denied',
          source: 'rule',
          reason: '权限模式为 deny-all',
        });
        return null;

      case 'ask':
      case 'yolo':
        // 15.0 机制 A：ask / yolo 仅 L1（low）规则自动批准；L2（medium）/ L3（high）返回 null，
        // 由上层 handler 路由——ask：L2→Brain、L3→用户确认；yolo：L2/L3 全→Brain。
        // （engine 已在 checkAndIssue 前把非 safe 标为 requiresReview，故此处实际只收到 low；
        //  保留 medium/high → null 是为了防御 engine 行为变化时仍 fail-closed。）
        if (request.riskLevel === 'low') {
          // 工具执行层强制要求 tokenId，必须走 resolve() 让 tokenIssuer 签发，
          // 而非在外面 hack 一个无 token 的 allowed:true（会导致"缺少 permission token"）。
          return this.resolve(request.id, {
            verdict: 'approved',
            source: 'rule',
            reason: 'L1 低风险自动批准',
          });
        }
        // L2/L3 → return null，交由上层 handler 路由到 Brain permission judge / 用户确认
        return null;
    }
  }

  expire(): number {
    return this.expireStale();
  }

  cancel(requestId: string): boolean {
    const now = Date.now();
    if (!this.markResponded(requestId)) return false;
    const result = this.db.prepare(`
      UPDATE approval_requests SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status = 'pending'
    `).run(now, requestId);
    return result.changes > 0;
  }

  getPending(sessionId?: string): ApprovalRequest[] {
    this.expireStale();
    let rows: Array<Record<string, unknown>>;
    if (sessionId) {
      rows = this.db.prepare(`
        SELECT * FROM approval_requests WHERE status = 'pending' AND session_id = ? ORDER BY created_at ASC
      `).all(sessionId) as Array<Record<string, unknown>>;
    } else {
      rows = this.db.prepare(`
        SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY created_at ASC
      `).all() as Array<Record<string, unknown>>;
    }
    return rows.map(rowToApproval);
  }

  getRequest(requestId: string): ApprovalRequest | null {
    const row = this.db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(requestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToApproval(row);
  }

  private expireStale(): number {
    const now = Date.now();
    for (const pending of this.pending.values()) {
      const req = this.getRequest(pending.requestId);
      if (req?.status !== 'pending' || req.expiresAt > now) continue;
      this.markResponded(pending.requestId);
    }
    const result = this.db.prepare(`
      UPDATE approval_requests SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND expires_at <= ?
    `).run(now, now);
    return result.changes;
  }

  private resolveTimeout(requestId: string): void {
    this.markResponded(requestId);
    const now = Date.now();
    this.db.prepare(`
      UPDATE approval_requests SET status = 'expired', reason = COALESCE(reason, '审批等待超时'), resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(now, requestId);
  }

  private markResponded(requestId: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return true;
    if (pending.responded) return false;
    pending.responded = true;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    return true;
  }
}

function buildDecisionReason(decision: ResolveDecision): string | null {
  const extras: Record<string, unknown> = {};
  if (decision.updatedInput) extras.updatedInput = decision.updatedInput;
  if (decision.updatedPermissions) extras.updatedPermissions = decision.updatedPermissions;
  if (Object.keys(extras).length === 0) return decision.reason ?? null;
  return JSON.stringify({ reason: decision.reason ?? null, ...extras });
}

function rowToApproval(row: Record<string, unknown>): ApprovalRequest {
  return {
    id: row.id as string,
    runId: row.run_id as string | null,
    sessionId: row.session_id as string,
    taskId: row.task_id as string | null,
    correlationId: row.correlation_id as string,
    kind: row.kind as ApprovalKind,
    requester: row.requester as string,
    riskLevel: row.risk_level as RiskLevel,
    requestPayload: JSON.parse(row.request_payload as string),
    bindingPayload: JSON.parse(row.binding_payload as string),
    status: row.status as ApprovalStatus,
    decisionSource: row.decision_source as DecisionSource | null,
    reason: row.reason as string | null,
    expiresAt: row.expires_at as number,
    createdAt: row.created_at as number,
    resolvedAt: row.resolved_at as number | null,
  };
}
