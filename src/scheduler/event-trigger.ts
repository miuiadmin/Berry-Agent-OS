import type Database from 'better-sqlite3';
import type { EventBus } from '../contracts/infrastructure.js';
import type { CronJobRow } from './contracts.js';
import type { TriggerDispatcher } from './trigger-dispatcher.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('event-trigger');

export class EventTrigger {
  private subscriptions: Array<() => void> = [];
  private jobsByEvent = new Map<string, CronJobRow[]>();

  constructor(
    private readonly db: Database.Database,
    private readonly eventBus: EventBus,
    private readonly dispatcher: TriggerDispatcher,
  ) {}

  start(): void {
    this.refresh();
    logger.info({ eventCount: this.jobsByEvent.size }, 'Event trigger subscriptions active');
  }

  stop(): void {
    for (const unsub of this.subscriptions) {
      unsub();
    }
    this.subscriptions = [];
    this.jobsByEvent.clear();
  }

  refresh(): void {
    this.stop();

    const jobs = this.db.prepare(
      "SELECT * FROM cron_jobs WHERE schedule_type = 'event' AND enabled = 1"
    ).all() as CronJobRow[];

    for (const job of jobs) {
      if (!job.event_filter) continue;

      let filter: { event?: string; events?: string[] };
      try {
        filter = JSON.parse(job.event_filter);
      } catch {
        logger.warn({ jobId: job.id }, 'Invalid event_filter JSON');
        continue;
      }

      const events = filter.events ?? (filter.event ? [filter.event] : []);
      for (const eventName of events) {
        if (!this.jobsByEvent.has(eventName)) {
          this.jobsByEvent.set(eventName, []);
        }
        this.jobsByEvent.get(eventName)!.push(job);
      }
    }

    for (const [eventName, matchingJobs] of this.jobsByEvent) {
      const unsub = this.eventBus.on(eventName as any, (payload: unknown) => {
        for (const job of matchingJobs) {
          if (!job.enabled) continue;
          if (this.matchesFilter(job, eventName, payload)) {
            this.dispatcher.trigger(job.id, { type: 'event', eventName }, payload);
          }
        }
      });
      if (unsub) this.subscriptions.push(unsub);
    }
  }

  private matchesFilter(job: CronJobRow, eventName: string, payload: unknown): boolean {
    if (!job.event_filter) return true;

    let filter: Record<string, unknown>;
    try {
      filter = JSON.parse(job.event_filter);
    } catch {
      return false;
    }

    const conditions = filter.conditions as Record<string, unknown> | undefined;
    if (!conditions) return true;

    if (typeof payload !== 'object' || payload === null) return false;
    const data = payload as Record<string, unknown>;

    for (const [key, expected] of Object.entries(conditions)) {
      if (data[key] !== expected) return false;
    }

    return true;
  }
}
