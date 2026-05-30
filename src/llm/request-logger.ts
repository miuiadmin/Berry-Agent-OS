import type Database from 'better-sqlite3';
import type { ModelRequest, ModelResponse } from '../contracts/model.js';

export class RequestLogger {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  logPending(request: ModelRequest): void {
    this.db.prepare(`
      INSERT INTO model_requests (
        id, session_id, task_id, correlation_id, agent_name, purpose, model_tier,
        mode, api_kind, backend, step_index, prompt_hash, tools_hash,
        request_payload, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      request.id,
      request.sessionId,
      request.taskId ?? null,
      request.correlationId,
      request.agent,
      request.purpose,
      request.modelTier ?? 'default',
      request.mode,
      request.apiKind,
      request.backend,
      request.stepIndex,
      request.promptHash,
      request.toolsHash ?? null,
      JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools, options: request.options }),
      Date.now(),
    );
  }

  logCompleted(requestId: string, response: ModelResponse): void {
    this.db.prepare(`
      UPDATE model_requests
      SET status = 'responded',
          model_name = ?,
          response_payload = ?,
          responded_at = ?
      WHERE id = ?
    `).run(
      response.model,
      JSON.stringify({
        content: response.content,
        contentBlocks: response.contentBlocks,
        toolCalls: response.toolCalls,
        stopReason: response.stopReason,
        usage: response.usage,
      }),
      Date.now(),
      requestId,
    );
  }

  logFailed(requestId: string, error: string): void {
    this.db.prepare(`
      UPDATE model_requests
      SET status = 'failed', error = ?, responded_at = ?
      WHERE id = ?
    `).run(error, Date.now(), requestId);
  }
}
