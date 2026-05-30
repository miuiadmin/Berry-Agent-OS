import type Database from 'better-sqlite3';
import type { WorldModelSnapshot, UserState, ProjectState, EnvironmentState, TemporalState, WorldModelUpdate } from '../contracts/world-model.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('world-model');

export class WorldModelRuntime {
  private snapshot: WorldModelSnapshot;
  private updateLog: WorldModelUpdate[] = [];

  constructor(private readonly db: Database.Database) {
    this.snapshot = this.loadOrInitialize();
  }

  getSnapshot(): WorldModelSnapshot {
    return this.snapshot;
  }

  getSummary(): string {
    const s = this.snapshot;
    const parts: string[] = [];

    if (s.user.currentActivity) {
      parts.push(`用户当前: ${s.user.currentActivity}`);
    }
    if (s.user.energyLevel !== 'unknown') {
      parts.push(`精力: ${s.user.energyLevel}`);
    }
    if (s.user.frustrationSignals > 2) {
      parts.push(`注意: 用户可能有挫败感（${s.user.frustrationSignals} 个信号）`);
    }
    if (s.temporal.upcomingDeadlines.length > 0) {
      const nearest = s.temporal.upcomingDeadlines[0];
      const hoursLeft = Math.round((nearest.dueAt - Date.now()) / 3600_000);
      parts.push(`最近 deadline: ${nearest.description}（${hoursLeft}h 后）`);
    }

    const activeProjects = s.projects.filter(p => p.status === 'active' && p.urgency === 'high');
    if (activeProjects.length > 0) {
      parts.push(`高优项目: ${activeProjects.map(p => p.name).join(', ')}`);
    }

    return parts.length > 0 ? parts.join(' | ') : '';
  }

  updateFromConversation(input: {
    userMessage: string;
    assistantResponse: string;
    toolCalls?: Array<{ name: string }>;
    sessionId: string;
  }): void {
    const now = Date.now();

    this.snapshot.user.lastInteractionAt = now;
    this.snapshot.temporal.turnsInSession++;
    this.snapshot.temporal.sessionDurationMs = now - (this.snapshot.user.lastInteractionAt ?? now);
    this.snapshot.updatedAt = now;

    // Detect frustration signals
    const frustrationPatterns = ['不对', '错了', '不是这个', '又', '为什么', '还是不行'];
    if (frustrationPatterns.some(p => input.userMessage.includes(p))) {
      this.snapshot.user.frustrationSignals++;
    }

    // Track recent topics (simple keyword extraction)
    const topic = input.userMessage.slice(0, 50).replace(/[?？！!。.]/g, '').trim();
    if (topic.length > 3) {
      this.snapshot.user.recentTopics = [
        topic,
        ...this.snapshot.user.recentTopics.filter(t => t !== topic),
      ].slice(0, 10);
    }

    this.updateTemporal();
    this.persist();
  }

  updateFromEvent(event: { type: string; source: string; summary: string; severity: 'info' | 'warning' | 'critical' }): void {
    this.snapshot.environment.externalEvents.push({
      ...event,
      receivedAt: Date.now(),
      handled: false,
    });
    // Keep only recent events
    if (this.snapshot.environment.externalEvents.length > 50) {
      this.snapshot.environment.externalEvents = this.snapshot.environment.externalEvents.slice(-30);
    }
    this.snapshot.updatedAt = Date.now();
    this.persist();
  }

  resetSession(): void {
    this.snapshot.temporal.turnsInSession = 0;
    this.snapshot.temporal.sessionDurationMs = 0;
    this.snapshot.user.frustrationSignals = 0;
    this.snapshot.updatedAt = Date.now();
    this.persist();
  }

  private updateTemporal(): void {
    const now = new Date();
    const hour = now.getHours();
    if (hour >= 6 && hour < 12) this.snapshot.temporal.timeOfDay = 'morning';
    else if (hour >= 12 && hour < 18) this.snapshot.temporal.timeOfDay = 'afternoon';
    else if (hour >= 18 && hour < 22) this.snapshot.temporal.timeOfDay = 'evening';
    else this.snapshot.temporal.timeOfDay = 'night';
    this.snapshot.temporal.dayOfWeek = now.getDay();
  }

  private persist(): void {
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO world_model (id, snapshot_json, updated_at)
        VALUES ('current', ?, ?)
      `).run(JSON.stringify(this.snapshot), Date.now());
    } catch {
      // table may not exist yet
    }
  }

  private loadOrInitialize(): WorldModelSnapshot {
    try {
      const row = this.db.prepare(`SELECT snapshot_json FROM world_model WHERE id = 'current'`).get() as { snapshot_json: string } | undefined;
      if (row) {
        return JSON.parse(row.snapshot_json);
      }
    } catch {
      // table doesn't exist or parse error
    }
    return createDefaultSnapshot();
  }
}

function createDefaultSnapshot(): WorldModelSnapshot {
  return {
    user: {
      currentActivity: null,
      energyLevel: 'unknown',
      recentTopics: [],
      activeGoals: [],
      frustrationSignals: 0,
      lastInteractionAt: null,
    },
    projects: [],
    environment: {
      platform: process.platform,
      activeChannels: [],
      externalEvents: [],
      systemHealth: 'healthy',
    },
    temporal: {
      timeOfDay: 'morning',
      dayOfWeek: new Date().getDay(),
      sessionDurationMs: 0,
      turnsInSession: 0,
      lastBreakAt: null,
      upcomingDeadlines: [],
    },
    updatedAt: Date.now(),
  };
}
