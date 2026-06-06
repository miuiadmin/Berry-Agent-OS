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
        INSERT INTO review_requests (id, session_id, level, draft_response, review_input, verdict, final_response, created_at, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        genId('rev'),
        params.sessionId,
        params.level,
        params.draft,
        reviewInput,
        params.verdict,
        params.finalResponse,
        Date.now(),
        Date.now(),
      );
    } catch (err) {
      logger.error({ err }, '保存审核记录失败');
    }
  }

  /**
   * 记录一次「A 级 / 无 intent_anchor」的 auto-approve 审核结论。
   *
   * 业务背景：12.0 起，A 级简短回复（level='A'）与无 intent_anchor 的兜底分支
   * 会跳过 Brain LLM 同步审核，直接发 verdict='approve' 给 Conversation。
   * 这条短路路径此前完全不写 review_requests 表，导致审计数据 99% 缺失。
   *
   * 修复后：即使 auto-approve 也必须落库，verdict 用两个新枚举值
   * 'auto_approve_A_level' / 'auto_approve_no_intent' 区分于真实 Brain 'approve'，
   * 便于审计层按 verdict 区分「是否经过 LLM 审核」。
   *
   * 失败处理：fail-open — 写库失败只 log.error 不抛（来自 recordReview 内部 try/catch），
   * 调用方已发 approve verdict，不能因 audit 写失败阻塞对话流。
   * 审计缺失可在 reconciliation 任务中重放补齐。
   */
  recordAutoApprove(input: {
    sessionId: string;
    level: 'A' | 'no_intent_anchor';
    draft: string;
    userMessage: string;
    toolCalls?: Array<{ name: string; input: string; result: string }>;
    taskId?: string;
  }): void {
    // level='no_intent_anchor' 不是合法 ReviewLevel（仅 'A'/'B'/'C'），
    // 入库时归一为 'A'，verdict 字符串保留差异以保留审计语义
    const levelForDb = 'A';
    const verdict = input.level === 'no_intent_anchor' ? 'auto_approve_no_intent' : 'auto_approve_A_level';
    // 复用 recordReview 内部 INSERT，避免再写一遍 SQL：
    // finalResponse 在 auto-approve 场景与 draft 相同（没有改写）
    this.recordReview({
      sessionId: input.sessionId,
      level: levelForDb,
      draft: input.draft,
      userMessage: input.userMessage,
      toolCalls: input.toolCalls ?? [],
      verdict,
      finalResponse: input.draft,
    });
  }
}
