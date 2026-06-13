import type Database from 'better-sqlite3';
import type { WorldModelSnapshot, UserState, ProjectState, EnvironmentState, TemporalState, WorldModelUpdate } from '../contracts/world-model.js';
import type { ToolBlock } from '../contracts/message-blocks.js';
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
    /** 工具调用轨迹（ToolBlock[]，来自 BlockCollector —— 审核链单一源）。本函数仅读 .name 推断意图。 */
    toolCalls?: ToolBlock[];
    sessionId: string;
  }): void {
    const now = Date.now();

    // 会话起始时间：首轮交互时锚定，后续轮保持不变（用于正确计算累计会话时长）
    if (this.snapshot.user.lastInteractionAt === null) {
      this.snapshot.temporal.sessionStartedAt = now;
    }
    this.snapshot.user.lastInteractionAt = now;
    this.snapshot.temporal.turnsInSession++;
    // 修正旧版 bug：旧版先设 lastInteractionAt=now 再用它算 duration，导致恒为 0
    this.snapshot.temporal.sessionDurationMs =
      now - (this.snapshot.temporal.sessionStartedAt ?? now);
    this.snapshot.updatedAt = now;

    // Detect frustration signals（挫败感信号累积）
    const frustrationPatterns = ['不对', '错了', '不是这个', '又', '为什么', '还是不行'];
    if (frustrationPatterns.some(p => input.userMessage.includes(p))) {
      this.snapshot.user.frustrationSignals++;
    }

    // Track recent topics（简单关键词提取）
    const topic = input.userMessage.slice(0, 50).replace(/[?？！!。.]/g, '').trim();
    if (topic.length > 3) {
      this.snapshot.user.recentTopics = [
        topic,
        ...this.snapshot.user.recentTopics.filter(t => t !== topic),
      ].slice(0, 10);
    }

    // 推断 energyLevel：基于挫败信号 + 近期交互密度（旧版恒为 unknown）
    // 挫败信号多 → frustrated；交互频繁（近 10 轮内） → focused；否则保持 unknown
    if (this.snapshot.user.frustrationSignals >= 3) {
      this.snapshot.user.energyLevel = 'frustrated';
    } else if (this.snapshot.temporal.turnsInSession > 0 && this.snapshot.user.frustrationSignals === 0) {
      this.snapshot.user.energyLevel = 'focused';
    }

    // 推断 currentActivity：取最近一个有意义的 topic 作为用户当前关注点
    if (this.snapshot.user.recentTopics.length > 0) {
      this.snapshot.user.currentActivity = this.snapshot.user.recentTopics[0];
    }

    // 从工具调用推断活跃目标（activeGoals）—— 代码/技能/记忆等高频工具揭示用户意图
    if (input.toolCalls && input.toolCalls.length > 0) {
      const goalMap: Record<string, string> = {
        edit_code: '代码修改', write_file: '文件创建', run_command: '命令执行',
        search_files: '代码搜索', grep_files: '内容检索', inspect_code: '代码分析',
        plan: '任务规划', squad: '团队协作', ask_user: '澄清需求',
      };
      for (const tc of input.toolCalls) {
        const goal = goalMap[tc.name];
        if (goal && !this.snapshot.user.activeGoals.includes(goal)) {
          this.snapshot.user.activeGoals = [...this.snapshot.user.activeGoals, goal].slice(-5);
        }
      }
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
    this.snapshot.temporal.sessionStartedAt = null;
    this.snapshot.user.frustrationSignals = 0;
    // session 重置时 energyLevel 回到 unknown，等待新一轮推断
    this.snapshot.user.energyLevel = 'unknown';
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
      sessionStartedAt: null,
      turnsInSession: 0,
      lastBreakAt: null,
      upcomingDeadlines: [],
    },
    updatedAt: Date.now(),
  };
}
