import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CronJobRow, WebhookResult, IWebhookReceiver } from './contracts.js';
import type { TriggerDispatcher } from './trigger-dispatcher.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('webhook-receiver');

export class WebhookReceiver implements IWebhookReceiver {
  constructor(
    private readonly db: Database.Database,
    private readonly dispatcher: TriggerDispatcher,
  ) {}

  handleIncoming(token: string, payload: unknown, signature?: string, sourceIp?: string): WebhookResult {
    const job = this.db.prepare(
      "SELECT * FROM cron_jobs WHERE webhook_token = ? AND schedule_type = 'webhook' AND enabled = 1"
    ).get(token) as CronJobRow | undefined;

    if (!job) {
      logger.warn({ token: token.slice(0, 8) + '...' }, 'Webhook token not found');
      return { accepted: false, error: 'Invalid webhook token' };
    }

    const requestId = genId('whk');
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    let signatureValid: boolean | null = null;

    if (job.webhook_secret) {
      if (!signature) {
        this.recordAudit(job.id, requestId, sourceIp, payloadStr, false);
        return { accepted: false, error: 'Missing signature' };
      }
      signatureValid = this.verifySignature(job.webhook_secret, payloadStr, signature);
      if (!signatureValid) {
        this.recordAudit(job.id, requestId, sourceIp, payloadStr, false);
        logger.warn({ jobId: job.id, requestId }, 'Webhook signature verification failed');
        return { accepted: false, error: 'Invalid signature' };
      }
    }

    this.recordAudit(job.id, requestId, sourceIp, payloadStr, signatureValid ?? true);

    const result = this.dispatcher.trigger(job.id, { type: 'webhook', requestId }, payload);

    if (result.ok) {
      return { accepted: true, executionId: result.executionId };
    }
    return { accepted: false, error: result.reason };
  }

  private verifySignature(secret: string, body: string, receivedSig: string): boolean {
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected, 'utf8'),
        Buffer.from(receivedSig, 'utf8'),
      );
    } catch {
      return false;
    }
  }

  private recordAudit(jobId: string, requestId: string, sourceIp: string | undefined, payload: string, valid: boolean): void {
    const payloadHash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
    this.db.prepare(`
      INSERT INTO webhook_audit_log (id, job_id, request_id, source_ip, payload_hash, signature_valid, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(genId('wha'), jobId, requestId, sourceIp ?? null, payloadHash, valid ? 1 : 0, Date.now());
  }
}
