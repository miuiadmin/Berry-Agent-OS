import type Database from 'better-sqlite3';
import type { Migration } from '../migration-runner.js';
import { runMemoryMigrations } from '../migrations.js';

const v0Baseline: Migration = {
  version: 0,
  name: 'legacy-baseline',
  up: (db: Database.Database) => {
    runMemoryMigrations(db);
  },
};

const v1ExtendScheduledTasks: Migration = {
  version: 1,
  name: 'extend-scheduled-tasks',
  up: (db: Database.Database) => {
    const cols = db.pragma('table_info(scheduled_tasks)') as Array<{ name: string }>;
    const existing = new Set(cols.map(c => c.name));
    if (!existing.has('script')) db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
    if (!existing.has('workdir')) db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN workdir TEXT`);
    if (!existing.has('delivery_channel')) db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN delivery_channel TEXT`);
    if (!existing.has('delivery_target')) db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN delivery_target TEXT`);
  },
};

const v2UnifiedPluginSystem: Migration = {
  version: 2,
  name: 'unified-plugin-system',
  up: (db: Database.Database) => {
    db.exec(`
      ALTER TABLE plugins_meta ADD COLUMN scope TEXT NOT NULL DEFAULT 'private';
      ALTER TABLE plugins_meta ADD COLUMN has_prompt INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE plugins_meta ADD COLUMN has_tools INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE plugins_meta ADD COLUMN has_code INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE plugins_meta ADD COLUMN has_hooks INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE plugins_meta ADD COLUMN has_service INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE plugins_meta ADD COLUMN prompt_content TEXT;
      ALTER TABLE plugins_meta ADD COLUMN prompt_priority REAL DEFAULT 0.5;
      ALTER TABLE plugins_meta ADD COLUMN prompt_activation_rules TEXT;
      ALTER TABLE plugins_meta ADD COLUMN manifest_json TEXT;
      ALTER TABLE plugins_meta ADD COLUMN evolution_json TEXT;
      ALTER TABLE plugins_meta ADD COLUMN importance REAL NOT NULL DEFAULT 0.6;
      ALTER TABLE plugins_meta ADD COLUMN previous_versions TEXT;
      ALTER TABLE plugins_meta ADD COLUMN promoted_from_id TEXT;
      ALTER TABLE plugins_meta ADD COLUMN promoted_at INTEGER;
      ALTER TABLE plugins_meta ADD COLUMN tags TEXT;
      ALTER TABLE plugins_meta ADD COLUMN owner_agent_id TEXT;
      ALTER TABLE plugins_meta ADD COLUMN workspace_id TEXT;
      ALTER TABLE plugins_meta ADD COLUMN user_id TEXT;
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_hooks (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        event TEXT NOT NULL,
        handler_path TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 50,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_hooks_unique ON plugin_hooks(plugin_id, event);
      CREATE INDEX IF NOT EXISTS idx_plugin_hooks_event ON plugin_hooks(event, priority);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_plugin_bindings (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'self',
        enabled INTEGER NOT NULL DEFAULT 1,
        pinned INTEGER NOT NULL DEFAULT 0,
        config_json TEXT,
        assigned_by TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_plugin_unique ON agent_plugin_bindings(agent_id, plugin_id);
      CREATE INDEX IF NOT EXISTS idx_agent_bindings_agent ON agent_plugin_bindings(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_bindings_plugin ON agent_plugin_bindings(plugin_id);
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_plugins_scope ON plugins_meta(scope, status);
      CREATE INDEX IF NOT EXISTS idx_plugins_workspace ON plugins_meta(workspace_id, scope);
      CREATE INDEX IF NOT EXISTS idx_plugins_user ON plugins_meta(user_id, scope);
    `);
  },
};

const v3WorkspaceDelegation: Migration = {
  version: 3,
  name: 'workspace-delegation',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE workspace_agents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE UNIQUE INDEX idx_workspace_agents_unique ON workspace_agents(workspace_id, agent_name);
      CREATE INDEX idx_workspace_agents_ws ON workspace_agents(workspace_id, role);
    `);

    db.exec(`
      CREATE TABLE delegation_history (
        id TEXT PRIMARY KEY,
        user_message_hash TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        intent TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX idx_delegation_history_hash ON delegation_history(user_message_hash, created_at);
    `);
  },
};

const v4OrgTreeHierarchy: Migration = {
  version: 4,
  name: 'org-tree-hierarchy',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE org_nodes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        parent_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        node_type TEXT NOT NULL DEFAULT 'group',
        path TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX idx_org_nodes_workspace ON org_nodes(workspace_id, path);
      CREATE INDEX idx_org_nodes_parent ON org_nodes(parent_id, position);
      CREATE UNIQUE INDEX idx_org_nodes_path ON org_nodes(path);
    `);

    db.exec(`
      ALTER TABLE workspace_agents ADD COLUMN org_node_id TEXT;
      ALTER TABLE workspace_agents ADD COLUMN superior_id TEXT;
      ALTER TABLE workspace_agents ADD COLUMN description TEXT;
      ALTER TABLE workspace_agents ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
    `);
  },
};

const v5TrustLevels: Migration = {
  version: 5,
  name: 'trust-levels',
  up: (db: Database.Database) => {
    db.exec(`
      ALTER TABLE workspace_agents ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'probation';
      ALTER TABLE workspace_agents ADD COLUMN consecutive_approvals INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workspace_agents ADD COLUMN total_rejections INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workspace_agents ADD COLUMN review_mode TEXT NOT NULL DEFAULT 'trust_based';
    `);
  },
};

const v6RuntimeProvider: Migration = {
  version: 6,
  name: 'runtime-provider',
  up: (db: Database.Database) => {
    db.exec(`
      ALTER TABLE workspace_agents ADD COLUMN provider TEXT;
      ALTER TABLE workspace_agents ADD COLUMN provider_config TEXT NOT NULL DEFAULT '{}';
    `);
  },
};

const v7CheckpointResume: Migration = {
  version: 7,
  name: 'checkpoint-resume',
  up: (db: Database.Database) => {
    const cols = db.pragma('table_info(agent_tasks)') as Array<{ name: string }>;
    const existing = new Set(cols.map(c => c.name));
    if (!existing.has('error_type')) db.exec(`ALTER TABLE agent_tasks ADD COLUMN error_type TEXT`);
    if (!existing.has('resume_count')) db.exec(`ALTER TABLE agent_tasks ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0`);
    if (!existing.has('resumed_from')) db.exec(`ALTER TABLE agent_tasks ADD COLUMN resumed_from TEXT`);
  },
};

const v8EngineEnhancements: Migration = {
  version: 8,
  name: 'engine-enhancements',
  up: (db: Database.Database) => {
    const agentCols = db.pragma('table_info(workspace_agents)') as Array<{ name: string }>;
    const agentExisting = new Set(agentCols.map(c => c.name));
    if (!agentExisting.has('prior_work_dir')) db.exec(`ALTER TABLE workspace_agents ADD COLUMN prior_work_dir TEXT`);
    if (!agentExisting.has('prior_session_id')) db.exec(`ALTER TABLE workspace_agents ADD COLUMN prior_session_id TEXT`);
    if (!agentExisting.has('thinking_level')) db.exec(`ALTER TABLE workspace_agents ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'default'`);

    const taskCols = db.pragma('table_info(agent_tasks)') as Array<{ name: string }>;
    const taskExisting = new Set(taskCols.map(c => c.name));
    if (!taskExisting.has('version')) db.exec(`ALTER TABLE agent_tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
  },
};

const v9SchedulerSubsystem: Migration = {
  version: 9,
  name: 'scheduler-subsystem',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        cron_expression TEXT,
        interval_minutes INTEGER,
        schedule_type TEXT NOT NULL CHECK(schedule_type IN ('cron','webhook','event')),
        webhook_secret TEXT,
        webhook_token TEXT,
        event_filter TEXT,
        concurrency_policy TEXT NOT NULL DEFAULT 'queue' CHECK(concurrency_policy IN ('queue','replace','forbid')),
        execution_mode TEXT NOT NULL DEFAULT 'run_only' CHECK(execution_mode IN ('create_task','run_only')),
        admission_gate INTEGER NOT NULL DEFAULT 1,
        prompt TEXT NOT NULL,
        chain_config TEXT,
        fan_out_config TEXT,
        session_mode TEXT NOT NULL DEFAULT 'new' CHECK(session_mode IN ('new','continue','pool')),
        enabled INTEGER NOT NULL DEFAULT 1,
        max_retries INTEGER NOT NULL DEFAULT 3,
        retry_delay_ms INTEGER NOT NULL DEFAULT 5000,
        last_triggered_at INTEGER,
        next_trigger_at INTEGER,
        pause_reason TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_workspace ON cron_jobs(workspace_id, enabled);
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_next ON cron_jobs(enabled, next_trigger_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_jobs_webhook_token ON cron_jobs(webhook_token);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_executions (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        round_id TEXT,
        trigger_source TEXT NOT NULL DEFAULT 'cron',
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed','skipped','timeout')),
        total_agents INTEGER,
        completed_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        trace_id TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        summary TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cron_executions_job ON cron_executions(job_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_cron_executions_status ON cron_executions(status, started_at);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS job_queue (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        source_id TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','running','completed','failed','skipped','timeout')),
        priority INTEGER NOT NULL DEFAULT 0,
        trace_id TEXT,
        claimed_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        output TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        timeout_ms INTEGER NOT NULL DEFAULT 300000,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_job_queue_pending ON job_queue(status, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_job_queue_agent ON job_queue(agent_id, status);
      CREATE INDEX IF NOT EXISTS idx_job_queue_source ON job_queue(source_id);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_reminders (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        name TEXT,
        prompt TEXT NOT NULL,
        trigger_at INTEGER NOT NULL,
        recurring_cron TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_fired_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON agent_reminders(enabled, trigger_at);
      CREATE INDEX IF NOT EXISTS idx_reminders_agent ON agent_reminders(agent_id);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_audit_log (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        request_id TEXT,
        source_ip TEXT,
        payload_hash TEXT,
        signature_valid INTEGER,
        received_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_audit_job ON webhook_audit_log(job_id, received_at);
    `);
  },
};

const v10IntelligenceLayer: Migration = {
  version: 10,
  name: 'intelligence-layer',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK(target_type IN ('user','agent')),
        target_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('task_assigned','execution_done','execution_failed','review_needed','mention','system','cron_exception','delegation_completed')),
        title TEXT NOT NULL,
        body TEXT,
        link TEXT,
        priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('urgent','normal','low')),
        read INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_target ON notifications(target_type, target_id, read, created_at);
      CREATE INDEX IF NOT EXISTS idx_notifications_workspace ON notifications(workspace_id, created_at);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        preferences_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        UNIQUE(workspace_id, user_id)
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS task_subscribers (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        subscriber_type TEXT NOT NULL CHECK(subscriber_type IN ('user','agent')),
        subscriber_id TEXT NOT NULL,
        reason TEXT NOT NULL CHECK(reason IN ('creator','assignee','commenter','mentioned','manual')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        UNIQUE(task_id, subscriber_type, subscriber_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_subscribers_task ON task_subscribers(task_id);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memories_v2 (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        workspace_id TEXT,
        type TEXT NOT NULL CHECK(type IN ('knowledge','preference','feedback','context')),
        content TEXT NOT NULL,
        source TEXT,
        importance REAL NOT NULL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_memories_agent ON agent_memories_v2(agent_id, archived, type);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_memories (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        owner_agent_id TEXT,
        type TEXT NOT NULL CHECK(type IN ('knowledge','preference','feedback','context')),
        content TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'evolved' CHECK(origin IN ('evolved','manual','imported','promoted')),
        visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','workspace')),
        importance REAL NOT NULL DEFAULT 0.5,
        tags TEXT,
        recall_count INTEGER NOT NULL DEFAULT 0,
        verified_at INTEGER,
        source_memory_id TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        last_recalled_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_memories_ws ON workspace_memories(workspace_id, archived, visibility);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS global_memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('knowledge','preference','feedback','context')),
        content TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'evolved' CHECK(origin IN ('evolved','manual','promoted')),
        source_workspace_id TEXT,
        source_memory_id TEXT,
        importance REAL NOT NULL DEFAULT 0.5,
        tags TEXT,
        recall_count INTEGER NOT NULL DEFAULT 0,
        verified_at INTEGER,
        archived INTEGER NOT NULL DEFAULT 0,
        last_recalled_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_global_memories_user ON global_memories(user_id, archived);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory_bindings_v2 (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        memory_layer TEXT NOT NULL CHECK(memory_layer IN ('agent','workspace','global')),
        source TEXT NOT NULL DEFAULT 'self',
        enabled INTEGER NOT NULL DEFAULT 1,
        pinned INTEGER NOT NULL DEFAULT 0,
        assigned_by TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        UNIQUE(agent_id, memory_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_bindings_agent ON agent_memory_bindings_v2(agent_id, enabled);
    `);

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_fts USING fts5(content, content='agent_memories_v2', content_rowid='rowid');
      CREATE VIRTUAL TABLE IF NOT EXISTS workspace_memories_fts USING fts5(content, content='workspace_memories', content_rowid='rowid');
      CREATE VIRTUAL TABLE IF NOT EXISTS global_memories_fts USING fts5(content, content='global_memories', content_rowid='rowid');
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_context_history (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        change_summary TEXT,
        changed_by TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_ws_context_history ON workspace_context_history(workspace_id, version);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS async_delegations (
        id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL,
        source_workspace_id TEXT,
        target_workspace_id TEXT NOT NULL,
        target_agent_id TEXT,
        prompt TEXT NOT NULL,
        context_snapshot TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','running','completed','failed','timeout','cancelled')),
        priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('urgent','normal','low')),
        timeout_ms INTEGER NOT NULL DEFAULT 7200000,
        result TEXT,
        error TEXT,
        parent_delegation_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        accepted_at INTEGER,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_delegations_session ON async_delegations(source_session_id, status);
      CREATE INDEX IF NOT EXISTS idx_delegations_target ON async_delegations(target_workspace_id, status);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS team_templates (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT NOT NULL DEFAULT 'custom' CHECK(category IN ('content','dev','research','support','custom')),
        org_structure TEXT NOT NULL,
        agent_configs TEXT NOT NULL,
        is_public INTEGER NOT NULL DEFAULT 0,
        use_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_templates_owner ON team_templates(owner_id);
      CREATE INDEX IF NOT EXISTS idx_templates_category ON team_templates(category, is_public);
    `);

    const wsCols = db.pragma('table_info(workspaces)') as Array<{ name: string }>;
    const wsExisting = new Set(wsCols.map(c => c.name));
    if (!wsExisting.has('context')) db.exec(`ALTER TABLE workspaces ADD COLUMN context TEXT`);
  },
};

const v11ConversationReasoning: Migration = {
  version: 11,
  name: 'conversation-reasoning',
  up: (db: Database.Database) => {
    const cols = db.pragma('table_info(conversations)') as Array<{ name: string }>;
    const existing = new Set(cols.map(c => c.name));
    if (!existing.has('reasoning')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN reasoning TEXT`);
    }
  },
};

const v12ConversationsFts: Migration = {
  version: 12,
  name: 'conversations-fts5',
  up: (db: Database.Database) => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='conversations_fts'`).get();
    if (!tables) {
      db.exec(`
        CREATE VIRTUAL TABLE conversations_fts USING fts5(
          content,
          content='conversations',
          content_rowid='rowid',
          tokenize='trigram'
        );

        CREATE TRIGGER IF NOT EXISTS conversations_fts_insert AFTER INSERT ON conversations BEGIN
          INSERT INTO conversations_fts(rowid, content) VALUES (new.rowid, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS conversations_fts_delete AFTER DELETE ON conversations BEGIN
          INSERT INTO conversations_fts(conversations_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        END;

        INSERT INTO conversations_fts(conversations_fts) VALUES('rebuild');
      `);
    }
  },
};

/** v13: pending_asks 表 — 持久化 agent ask_user 状态，进程崩溃后可恢复 */
const v13PendingAsks: Migration = {
  version: 13,
  name: 'pending-asks',
  up: (db: Database.Database) => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='pending_asks'`).get();
    if (!tables) {
      db.exec(`
        CREATE TABLE pending_asks (
          session_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          question TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );
        CREATE INDEX idx_pending_asks_corr ON pending_asks(correlation_id);
      `);
    }
  },
};

/**
 * v14: 13.0 灵魂版 Brain 观察队列表。
 * 持久化所有 Agent 间通信、工具调用、用户交互供 Brain OBSERVE 阶段使用。
 * 全新安装时 CORE_SCHEMA_SQL 已包含此表，此迁移确保已有数据库也能创建。
 * 设计：2D 隔离 (session_id, task_id)、优先级 (0=critical 1=normal 2=verbose)、滚动窗口 500 条
 */
const v14BrainObservations: Migration = {
  version: 14,
  name: 'brain-observations',
  up: (db: Database.Database) => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='brain_observations'`).get();
    if (!tables) {
      db.exec(`
        CREATE TABLE brain_observations (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          observation_type TEXT NOT NULL CHECK(observation_type IN (
            'dialogue_send', 'dialogue_reply', 'tool_call', 'tool_result',
            'agent_event', 'drift_signal', 'user_interaction', 'permission_judgment'
          )),
          from_agent TEXT NOT NULL,
          to_agent TEXT,
          content TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 1,
          metadata_json TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          UNIQUE(session_id, task_id, seq)
        );
        CREATE INDEX idx_brain_obs_session ON brain_observations(session_id, created_at DESC);
        CREATE INDEX idx_brain_obs_type ON brain_observations(observation_type, created_at DESC);
        CREATE INDEX idx_brain_obs_priority ON brain_observations(priority, created_at DESC);
      `);
    }
  },
};

/** v15: 给 brain_decisions 补 task_id 列（v0 baseline 的 runMemoryMigrations 已有此逻辑，但已跑过 v0 的老库跳过不会再执行） */
const v15BrainDecisionsTaskId: Migration = {
  version: 15,
  name: 'brain-decisions-task-id',
  up: (db: Database.Database) => {
    const cols = db.pragma('table_info(brain_decisions)') as Array<{ name: string }>;
    const existing = new Set(cols.map(c => c.name));
    if (!existing.has('task_id')) {
      db.exec(`ALTER TABLE brain_decisions ADD COLUMN task_id TEXT`);
    }
  },
};

/** v16: pending_request_state 表 — SessionManager 持久化 PendingRequest 关键字段，进程重启后可恢复 metadata。
 *  schema 与 session-manager.ts 的 persistRequestState/recoverRequestStates 读写列保持一致。 */
const v16PendingRequestState: Migration = {
  version: 16,
  name: 'pending-request-state',
  up: (db: Database.Database) => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='pending_request_state'`).get();
    if (!tables) {
      db.exec(`
        CREATE TABLE pending_request_state (
          msg_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          task_id TEXT,
          intent_anchor_json TEXT,
          level TEXT,
          reasoning TEXT,
          draft_preview TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );
        CREATE INDEX IF NOT EXISTS idx_pending_request_state_session ON pending_request_state(session_id, created_at);
      `);
    }
  },
};

export const ALL_MIGRATIONS: Migration[] = [
  v0Baseline,
  v1ExtendScheduledTasks,
  v2UnifiedPluginSystem,
  v3WorkspaceDelegation,
  v4OrgTreeHierarchy,
  v5TrustLevels,
  v6RuntimeProvider,
  v7CheckpointResume,
  v8EngineEnhancements,
  v9SchedulerSubsystem,
  v10IntelligenceLayer,
  v11ConversationReasoning,
  v12ConversationsFts,
  v13PendingAsks,
  v14BrainObservations,
  v15BrainDecisionsTaskId,
  v16PendingRequestState,
];
