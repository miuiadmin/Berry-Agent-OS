import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ToolAuditPayload } from '../contracts/audit.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('audit-recorder');

export class AuditRecorder {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  recordToolCall(audit: ToolAuditPayload & { agentName: string }): void {
    try {
      const finishedAt = Date.now();
      const startedAt = finishedAt - (audit.durationMs ?? 0);
      const inputHash = createHash('sha256').update(audit.toolInput).digest('hex').slice(0, 16);
      const permissionVerdict = audit.toolResult.startsWith('权限被拒绝:') ? 'deny' : 'allow';
      // 11.0: ephemeral taskId（dtask_xxx）是 dialogue 临时 ID，不存在于 agent_tasks 表，
      // 直接传入会触发 FK 约束失败，转为 null 避免写库报错
      const safeTaskId = audit.taskId?.startsWith('dtask_') ? null : (audit.taskId ?? null);
      this.db.prepare(`
        INSERT INTO tool_calls (id, session_id, task_id, correlation_id, agent_name, tool_name, input, input_hash,
          permission_token, permission_verdict, result, is_error, danger_level, started_at, finished_at, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        genId('tc'),
        audit.sessionId,
        safeTaskId,
        audit.correlationId ?? null,
        audit.agentName,
        audit.toolName,
        audit.toolInput,
        inputHash,
        audit.permissionToken ?? null,
        permissionVerdict,
        audit.toolResult,
        audit.isError ? 1 : 0,
        audit.dangerLevel,
        startedAt,
        finishedAt,
        audit.durationMs,
      );
    } catch (err) {
      logger.error({ err, agent: audit.agentName }, '工具审计记录失败');
    }
  }

  recordReview(params: {
    sessionId: string;
    level: string;
    draft: string;
    userMessage: string;
    toolCalls: Array<{ name: string; input: string; result: string }>;
    verdict: string;
    finalResponse: string;
    /** R14-4：可选 reason 字段，用于 auto-approve 等场景标注短路原因 */
    reason?: string;
  }): void {
    try {
      const reviewInput = JSON.stringify({
        user_message: params.userMessage,
        tool_calls: params.toolCalls.map((call) => ({
          name: call.name,
          input: call.input,
          result_preview: call.result.slice(0, 500),
        })),
      });
      this.db.prepare(`
        INSERT INTO review_requests (id, session_id, level, draft_response, review_input, verdict, final_response, reason, created_at, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        genId('rev'),
        params.sessionId,
        params.level,
        params.draft,
        reviewInput,
        params.verdict,
        params.finalResponse,
        params.reason ?? null,
        Date.now(),
        Date.now(),
      );
    } catch (err) {
      logger.error({ err }, '保存审核记录失败');
    }
  }
}
