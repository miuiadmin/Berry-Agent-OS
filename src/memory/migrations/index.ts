import type Database from 'better-sqlite3';
import type { Migration } from '../migration-runner.js';
import { runMemoryMigrations } from '../migrations.js';
import { redactSecrets } from '../../observability/redaction.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('memory-migrations');

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

/**
 * v17: 15.0 存储层加固 — 历史数据 secret 清洗（一次性 backfill）。
 *
 * 增量落盘清洗（conversations.ts / dialogue-router.ts）只覆盖「清洗逻辑上线后」的
 * 新写入；本迁移负责把「上线前」已落库的明文 secret（API key / token / 私钥）
 * 一次性替换为 [REDACTED:name]。
 *
 * 幂等性：redactSecrets 对已清洗的内容（[REDACTED:xxx]）不会再匹配任何 secret 模式，
 * 因此重复执行零副作用（redacted === content 时跳过 UPDATE）。
 *
 * 边界：只清洗 content 字段，**不动** context_json / metadata_json —— 后者可能含
 * 结构化语义信息，且体积大、模式匹配误伤风险高。
 */
const v17RedactHistoryScan: Migration = {
  version: 17,
  name: 'redact-history-scan',
  up: (db: Database.Database) => {
    // 三张对话/审计表，统一用隐式 rowid 作主键定位行（FTS 触发器也是按 rowid 同步）
    const targets: Array<{ table: string; contentCol: string }> = [
      { table: 'conversations', contentCol: 'content' },
      { table: 'dialogue_messages', contentCol: 'content' },
      { table: 'agent_chat_messages', contentCol: 'content' },
    ];

    for (const { table, contentCol } of targets) {
      // 表可能不存在（极端旧库未跑过对应建表迁移）—— 用 sqlite_master 探测后跳过
      const exists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
        .get(table);
      if (!exists) continue;

      const rows = db
        .prepare(`SELECT rowid AS rid, ${contentCol} AS content FROM ${table} WHERE ${contentCol} IS NOT NULL`)
        .all() as Array<{ rid: number; content: string }>;

      const update = db.prepare(`UPDATE ${table} SET ${contentCol} = ? WHERE rowid = ?`);
      let cleaned = 0;
      for (const row of rows) {
        const redacted = redactSecrets(row.content);
        if (redacted !== row.content) {
          update.run(redacted, row.rid);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        logger.info({ table, cleaned }, '15.0 redact 历史扫描：清洗明文 secret');
      }
    }
  },
};

/**
 * v18: 15.0 存储层加固 — dialogue_messages / agent_chat_messages FTS5 全文索引，
 *      并补齐 conversations 缺失的 UPDATE 触发器。
 *
 * 设计沿用 v12 conversations_fts 已验证的模式：外部内容表（content=源表, content_rowid=rowid）
 * + 纯 trigram tokenizer。**不做 unicode61 双索引** —— BerryAgent 是中文优先产品，
 * trigram 对 CJK 子串已完全正确（unicode61 会把 CJK 拆成单字破坏短语匹配），双索引只会
 * 翻倍存储换边际的英文 ranking 收益。
 *
 * 触发器三件套（insert/delete/update）保证 FTS 与源表自动同步，应用层写入无需感知。
 * external content 表的 delete 用 `INSERT INTO fts(fts,rowid,col) VALUES('delete',...)` 语法；
 * update = delete 旧行 + insert 新行（FTS5 官方推荐模式）。
 *
 * conversations_fts 之前只有 insert/delete 触发器（v12），UPDATE content 时索引不同步——
 * 本迁移补上 update 触发器并 rebuild 三个索引，让历史数据与新触发器一致。
 */
const v18DialogueAndAgentChatFts: Migration = {
  version: 18,
  name: 'dialogue-agent-chat-fts',
  up: (db: Database.Database) => {
    db.exec(`
      -- ── dialogue_messages FTS5 ──
      CREATE VIRTUAL TABLE IF NOT EXISTS dialogue_messages_fts USING fts5(
        content,
        content='dialogue_messages',
        content_rowid='rowid',
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS dialogue_messages_fts_insert AFTER INSERT ON dialogue_messages BEGIN
        INSERT INTO dialogue_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS dialogue_messages_fts_delete AFTER DELETE ON dialogue_messages BEGIN
        INSERT INTO dialogue_messages_fts(dialogue_messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS dialogue_messages_fts_update AFTER UPDATE ON dialogue_messages BEGIN
        INSERT INTO dialogue_messages_fts(dialogue_messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO dialogue_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      -- ── agent_chat_messages FTS5 ──
      CREATE VIRTUAL TABLE IF NOT EXISTS agent_chat_messages_fts USING fts5(
        content,
        content='agent_chat_messages',
        content_rowid='rowid',
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS agent_chat_messages_fts_insert AFTER INSERT ON agent_chat_messages BEGIN
        INSERT INTO agent_chat_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS agent_chat_messages_fts_delete AFTER DELETE ON agent_chat_messages BEGIN
        INSERT INTO agent_chat_messages_fts(agent_chat_messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS agent_chat_messages_fts_update AFTER UPDATE ON agent_chat_messages BEGIN
        INSERT INTO agent_chat_messages_fts(agent_chat_messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO agent_chat_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      -- ── 补齐 conversations_fts 缺失的 UPDATE 触发器（v12 遗留） ──
      CREATE TRIGGER IF NOT EXISTS conversations_fts_update AFTER UPDATE ON conversations BEGIN
        INSERT INTO conversations_fts(conversations_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO conversations_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);

    // rebuild 三个索引：让触发器上线前的历史数据进入索引（external content 表从源表重建）
    // 失败不致命——索引为空只是搜不到，不影响主流程；用 try 包住避免迁移卡死。
    for (const fts of ['dialogue_messages_fts', 'agent_chat_messages_fts', 'conversations_fts']) {
      try {
        db.prepare(`INSERT INTO ${fts}(${fts}) VALUES ('rebuild')`).run();
      } catch (err) {
        logger.warn({ fts, err }, '15.0 FTS rebuild 跳过（源表可能不存在）');
      }
    }
  },
};

/**
 * v19: 15.0 redact 扩展 — 补扫 intent_anchors / brain_observations / agent_tool_calls
 * 三张表的历史明文 secret（v17 只覆盖了 conversations/dialogue_messages/agent_chat_messages）。
 *
 * 这三张表分别存：原始用户消息（intent_anchors.raw_message，最高风险——直接是用户输入）、
 * Brain 观察队列（brain_observations.content，镜像对话/工具调用）、工具调用摘要
 * （agent_tool_calls.input_summary，可能含传给工具的 key）。三者都可能内嵌用户误发的 secret。
 *
 * 幂等：与 v17 同理，已清洗内容（[REDACTED:xxx]）不再匹配 secret 模式，重复执行零副作用。
 */
const v19RedactExtraTablesScan: Migration = {
  version: 19,
  name: 'redact-extra-tables-scan',
  up: (db: Database.Database) => {
    const targets: Array<{ table: string; contentCol: string }> = [
      { table: 'intent_anchors', contentCol: 'raw_message' },
      { table: 'brain_observations', contentCol: 'content' },
      { table: 'agent_tool_calls', contentCol: 'input_summary' },
    ];

    for (const { table, contentCol } of targets) {
      const exists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
        .get(table);
      if (!exists) continue;

      const rows = db
        .prepare(`SELECT rowid AS rid, ${contentCol} AS content FROM ${table} WHERE ${contentCol} IS NOT NULL`)
        .all() as Array<{ rid: number; content: string }>;

      const update = db.prepare(`UPDATE ${table} SET ${contentCol} = ? WHERE rowid = ?`);
      let cleaned = 0;
      for (const row of rows) {
        const redacted = redactSecrets(row.content);
        if (redacted !== row.content) {
          update.run(redacted, row.rid);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        logger.info({ table, cleaned }, '15.0 redact 扩展扫描：清洗明文 secret');
      }
    }
  },
};

/**
 * v20: 15.0 §5.2 修复 — dialogue/agent_chat FTS 改为多列（from_agent, to_agent, content）。
 *
 * v18 的单列 content FTS 无法按 agent 名召回。曾尝试用拼接触发器 + rebuild，但 external-content
 * FTS 的 rebuild 只读映射的 content 列、不执行触发器拼接，历史行无法重索引（半成品）。
 * 正确做法：FTS 改为【多列】external-content（from_agent/to_agent/content 各为映射列）——
 * rebuild 读所有映射列，agent 名天然入索引，新行/历史行/自愈全部正确。searchDialogueMessages
 * 的 snippet 取 content 列（索引 2）。
 */
const v20FtsConcatAgentNames: Migration = {
  version: 20,
  name: 'fts-concat-agent-names',
  up: (db: Database.Database) => {
    // dialogue_messages_fts：DROP v18 单列表 + 触发器，重建为多列
    db.exec(`
      DROP TRIGGER IF EXISTS dialogue_messages_fts_insert;
      DROP TRIGGER IF EXISTS dialogue_messages_fts_delete;
      DROP TRIGGER IF EXISTS dialogue_messages_fts_update;
      DROP TABLE IF EXISTS dialogue_messages_fts;
      CREATE VIRTUAL TABLE dialogue_messages_fts USING fts5(
        from_agent, to_agent, content,
        content='dialogue_messages', content_rowid='rowid', tokenize='trigram'
      );
      CREATE TRIGGER dialogue_messages_fts_insert AFTER INSERT ON dialogue_messages BEGIN
        INSERT INTO dialogue_messages_fts(rowid, from_agent, to_agent, content)
        VALUES (new.rowid, new.from_agent, new.to_agent, new.content);
      END;
      CREATE TRIGGER dialogue_messages_fts_delete AFTER DELETE ON dialogue_messages BEGIN
        INSERT INTO dialogue_messages_fts(dialogue_messages_fts, rowid, from_agent, to_agent, content)
        VALUES('delete', old.rowid, old.from_agent, old.to_agent, old.content);
      END;
      CREATE TRIGGER dialogue_messages_fts_update AFTER UPDATE ON dialogue_messages BEGIN
        INSERT INTO dialogue_messages_fts(dialogue_messages_fts, rowid, from_agent, to_agent, content)
        VALUES('delete', old.rowid, old.from_agent, old.to_agent, old.content);
        INSERT INTO dialogue_messages_fts(rowid, from_agent, to_agent, content)
        VALUES (new.rowid, new.from_agent, new.to_agent, new.content);
      END;

      DROP TRIGGER IF EXISTS agent_chat_messages_fts_insert;
      DROP TRIGGER IF EXISTS agent_chat_messages_fts_delete;
      DROP TRIGGER IF EXISTS agent_chat_messages_fts_update;
      DROP TABLE IF EXISTS agent_chat_messages_fts;
      CREATE VIRTUAL TABLE agent_chat_messages_fts USING fts5(
        from_agent, to_agent, content,
        content='agent_chat_messages', content_rowid='rowid', tokenize='trigram'
      );
      CREATE TRIGGER agent_chat_messages_fts_insert AFTER INSERT ON agent_chat_messages BEGIN
        INSERT INTO agent_chat_messages_fts(rowid, from_agent, to_agent, content)
        VALUES (new.rowid, new.from_agent, new.to_agent, new.content);
      END;
      CREATE TRIGGER agent_chat_messages_fts_delete AFTER DELETE ON agent_chat_messages BEGIN
        INSERT INTO agent_chat_messages_fts(agent_chat_messages_fts, rowid, from_agent, to_agent, content)
        VALUES('delete', old.rowid, old.from_agent, old.to_agent, old.content);
      END;
      CREATE TRIGGER agent_chat_messages_fts_update AFTER UPDATE ON agent_chat_messages BEGIN
        INSERT INTO agent_chat_messages_fts(agent_chat_messages_fts, rowid, from_agent, to_agent, content)
        VALUES('delete', old.rowid, old.from_agent, old.to_agent, old.content);
        INSERT INTO agent_chat_messages_fts(rowid, from_agent, to_agent, content)
        VALUES (new.rowid, new.from_agent, new.to_agent, new.content);
      END;
    `);
    // rebuild：多列 external-content FTS 的 rebuild 读所有映射列（from/to/content），历史行正确入索引。
    for (const fts of ['dialogue_messages_fts', 'agent_chat_messages_fts']) {
      try {
        db.prepare(`INSERT INTO ${fts}(${fts}) VALUES ('rebuild')`).run();
      } catch (err) {
        logger.warn({ fts, err }, '15.0 v20 多列 FTS rebuild 跳过（源表可能不存在）');
      }
    }
  },
};

/**
 * v21: 15.0 D3-1 修复 — redact tool_calls 与 review_requests 的明文 secret。
 *
 * 这些表存工具入参/结果（input/result）与审核输入（review_input），常含密钥（凭证、token、
 * env 值）。v17-v19 redact 扫描覆盖了 conversations / intent_anchors / brain_observations /
 * agent_tool_calls，但漏了 tool_calls（主审计表）和 review_requests。本迁移补扫这两表，
 * 并与 audit-recorder.ts 写入时 redact（D3-1 正向修复）配合，确保历史 + 新增数据均无明文密钥。
 *
 * 幂等：与 v17-v19 同理，redactSecrets 对已清洗内容（[REDACTED:xxx]）不再匹配 secret 模式。
 */
const v21RedactToolCallsScan: Migration = {
  version: 21,
  name: 'redact-tool-calls-scan',
  up: (db: Database.Database) => {
    // tool_calls 两列（input/result）+ review_requests 一列（review_input）
    const targets: Array<{ table: string; contentCol: string }> = [
      { table: 'tool_calls', contentCol: 'input' },
      { table: 'tool_calls', contentCol: 'result' },
      { table: 'review_requests', contentCol: 'review_input' },
    ];

    for (const { table, contentCol } of targets) {
      const exists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
        .get(table);
      if (!exists) continue;

      const rows = db
        .prepare(`SELECT rowid AS rid, ${contentCol} AS content FROM ${table} WHERE ${contentCol} IS NOT NULL`)
        .all() as Array<{ rid: number; content: string }>;

      const update = db.prepare(`UPDATE ${table} SET ${contentCol} = ? WHERE rowid = ?`);
      let cleaned = 0;
      for (const row of rows) {
        const redacted = redactSecrets(row.content);
        if (redacted !== row.content) {
          update.run(redacted, row.rid);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        logger.info({ table, contentCol: contentCol, cleaned }, '15.0 D3-1 redact 扫描：清洗工具/审核明文 secret');
      }
    }
  },
};

/**
 * v22: 15.0 V-4 修复 — redact review_requests.draft_response/final_response 与 episodes.content。
 *
 * v21 扫描了 review_requests.review_input（user_message + tool_calls 的 input/result），
 * 但 review_requests 的 draft_response / final_response（Agent 生成的文本，会转述/回显密钥）
 * 与 episodes.content（会话事件流水）仍是明文落库——audit-recorder.recordReview 与
 * logEpisode 的写入时 redact（V-4 正向修复）只覆盖新增数据，本迁移补扫历史数据。
 *
 * 幂等：与 v17-v21 同理，redactSecrets 对已清洗内容（[REDACTED:xxx]）不再匹配 secret 模式。
 */
const v22RedactResponsesScan: Migration = {
  version: 22,
  name: 'redact-responses-scan',
  up: (db: Database.Database) => {
    // review_requests 两列（draft_response/final_response，Agent 文本）+ episodes 一列（content，事件流水）
    const targets: Array<{ table: string; contentCol: string }> = [
      { table: 'review_requests', contentCol: 'draft_response' },
      { table: 'review_requests', contentCol: 'final_response' },
      { table: 'episodes', contentCol: 'content' },
    ];

    for (const { table, contentCol } of targets) {
      const exists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
        .get(table);
      if (!exists) continue;

      const rows = db
        .prepare(`SELECT rowid AS rid, ${contentCol} AS content FROM ${table} WHERE ${contentCol} IS NOT NULL`)
        .all() as Array<{ rid: number; content: string }>;

      const update = db.prepare(`UPDATE ${table} SET ${contentCol} = ? WHERE rowid = ?`);
      let cleaned = 0;
      for (const row of rows) {
        const redacted = redactSecrets(row.content);
        if (redacted !== row.content) {
          update.run(redacted, row.rid);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        logger.info({ table, contentCol: contentCol, cleaned }, '15.0 V-4 redact 扫描：清洗回复/事件明文 secret');
      }
    }
  },
};

/**
 * v23: 15.0 V-6 修复 — redact agent_tasks.output_payload。
 *
 * output_payload 是 Agent 最终输出 / 流式累积文本的 JSON blob（streamingContent / response 等），
 * 与对话正文同等可能回显或转述密钥。task-manager.complete / flushStreamingContent 写入时 redact
 * （V-6 正向修复）只覆盖新增数据，本迁移补扫历史。整体 redactSecrets（对 JSON 字符串做子串匹配）——
 * 占位符 [REDACTED:xxx] 是普通字符，落进 JSON 字符串值内不破坏结构。
 *
 * 幂等：与 v17-v22 同理，redactSecrets 对已清洗内容不再匹配 secret 模式。
 */
const v23RedactOutputPayloadScan: Migration = {
  version: 23,
  name: 'redact-output-payload-scan',
  up: (db: Database.Database) => {
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get('agent_tasks');
    if (!exists) return;

    const rows = db
      .prepare(`SELECT rowid AS rid, output_payload AS content FROM agent_tasks WHERE output_payload IS NOT NULL`)
      .all() as Array<{ rid: number; content: string }>;

    const update = db.prepare(`UPDATE agent_tasks SET output_payload = ? WHERE rowid = ?`);
    let cleaned = 0;
    for (const row of rows) {
      const redacted = redactSecrets(row.content);
      if (redacted !== row.content) {
        update.run(redacted, row.rid);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info({ table: 'agent_tasks', contentCol: 'output_payload', cleaned }, '15.0 V-6 redact 扫描：清洗任务输出明文 secret');
    }
  },
};

/**
 * 15.0 V-7（sec-1 收尾）：回填扫描 agent_tasks.input_payload 列。
 *
 * input_payload 与 output_payload 对称——delegation-orchestrator 把 userMessage / assistantResponse /
 * 被拒指令直接嵌进 inputPayload（extract_feedback / detect_gap 等任务），其中可内嵌用户贴的密钥。
 * V-7 在 create() 写入时已加 redact（新数据），本迁移负责清洗存量库里的历史明文（与 v23 同构）。
 */
const v24RedactInputPayloadScan: Migration = {
  version: 24,
  name: 'redact-input-payload-scan',
  up: (db: Database.Database) => {
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get('agent_tasks');
    if (!exists) return;

    const rows = db
      .prepare(`SELECT rowid AS rid, input_payload AS content FROM agent_tasks WHERE input_payload IS NOT NULL`)
      .all() as Array<{ rid: number; content: string }>;

    const update = db.prepare(`UPDATE agent_tasks SET input_payload = ? WHERE rowid = ?`);
    let cleaned = 0;
    for (const row of rows) {
      const redacted = redactSecrets(row.content);
      if (redacted !== row.content) {
        update.run(redacted, row.rid);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info({ table: 'agent_tasks', contentCol: 'input_payload', cleaned }, '15.0 V-7 redact 扫描：清洗任务输入明文 secret');
    }
  },
};

/**
 * 对话内联统一（设计文档/22 期3b）：把旧 conversations 历史回填到新 messages + message_blocks。
 *
 * 回填范围：conversations 行 → messages（同 id）+ thinking block（reasoning）+ text block（content）。
 *   - 同 id 幂等（重跑安全）：已存在于 messages 的跳过。
 *   - redact：content/reasoning 落 message_blocks 前清洗（与 v17~v24 同法，覆盖 pre-15.0 残留明文）。
 *   - 不回填 tool_calls / dialogue_messages / agent_chat_messages：历史工具上下文留在旧表冷归档；
 *     新对话的工具调用由 BlockCollector 直接落 message_blocks（期3a/3b）。dialogue 折叠为 delegation block 属期4。
 *
 * FTS 重建不在此处：message_blocks_fts 在 db.ts 的 runMigrations 之后才创建，v25 执行时尚不存在；
 * 首启时由 db.ts 在建 FTS 表后做增量补齐 populate（见 db.ts populateMessageBlocksFts，幂等补缺失行）。
 */
const v25InlineBlocksBackfill: Migration = {
  version: 25,
  name: 'inline-blocks-backfill',
  up: (db: Database.Database) => {
    // 旧 conversations 表不存在（全新库）→ 无历史可回填
    const hasConversations = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'conversations'`)
      .get();
    if (!hasConversations) return;

    // reasoning / task_id 列由 v11 / 后续迁移添加；旧库可能缺列——按 table_info 容错取列
    const cols = new Set(
      (db.pragma('table_info(conversations)') as Array<{ name: string }>).map((c) => c.name),
    );
    const hasReasoning = cols.has('reasoning');
    const hasTaskId = cols.has('task_id');
    const hasClientMsgId = cols.has('client_msg_id');

    const selectSql = `SELECT id, session_id, role, content${
      hasReasoning ? ', reasoning' : ''
    }${hasClientMsgId ? ', client_msg_id' : ''}${hasTaskId ? ', task_id' : ''}, created_at
      FROM conversations ORDER BY created_at ASC`;
    const rows = db.prepare(selectSql).all() as Array<Record<string, unknown>>;

    const insertMessage = db.prepare(
      `INSERT OR IGNORE INTO messages (id, session_id, role, client_msg_id, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertBlock = db.prepare(
      `INSERT INTO message_blocks (id, message_id, seq, block_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const messageExists = db.prepare(`SELECT 1 FROM messages WHERE id = ?`);

    let migrated = 0;
    for (const r of rows) {
      // 幂等：已回填的消息跳过（重跑 / 部分失败恢复安全）
      if (messageExists.get(r.id as string)) continue;

      insertMessage.run(
        r.id,
        r.session_id,
        r.role,
        hasClientMsgId ? ((r.client_msg_id as string) ?? null) : null,
        hasTaskId ? ((r.task_id as string) ?? null) : null,
        r.created_at,
      );

      let seq = 0;
      const created = r.created_at as number;
      // thinking block（reasoning 非空时）
      if (hasReasoning && r.reasoning) {
        seq++;
        insertBlock.run(
          `${r.id}#b${seq}`,
          r.id,
          seq,
          'thinking',
          JSON.stringify({ type: 'thinking', text: redactSecrets(r.reasoning as string) }),
          created,
        );
      }
      // text block（content；空内容也建块以保留消息存在性）
      seq++;
      insertBlock.run(
        `${r.id}#b${seq}`,
        r.id,
        seq,
        'text',
        JSON.stringify({ type: 'text', text: redactSecrets((r.content as string) ?? '') }),
        created,
      );
      migrated++;
    }

    if (migrated > 0) {
      logger.info({ migrated }, '对话内联 v25 回填：conversations → messages + message_blocks');
    }
  },
};

/**
 * 对话内联统一收尾（设计文档/22 期2）：回填 v25 之后、消灭双轨制之前新增的 user 行到 messages + message_blocks。
 *
 * 为什么需要 v26（v25 已迁移 conversations 全表）：v25 在「迁移时刻」一次性回填了当时存在的所有 conversations
 * 行；但此后新增的 user 消息只落 conversations（旧 saveUserMessage 路径不写新表）。消灭双轨制后 user 活跃漏斗
 * 切到 persistUserMessage（SessionManager / MemoryRuntime 的 saveUserMessage 均走它，直写 messages），新 user 行
 * 不再有缺口。v26 即「闭合 v25→消灭双轨制 这段窗口」的一次性补漏——把期间只落 conversations 的 user 行补进新表。
 *
 * 范围限定 role='user'：assistant 行的 messages 落点用 BlockCollector.messageId（与 conversations.id 不同源），
 * 若按 conversations.id 回填 assistant 会与 collector 落库的行重复（双行）；user 行无此问题（user 不经 collector）。
 *
 * 幂等：messages.id = conversations.id（与 v25 同源），INSERT OR IGNORE 保证重跑安全；block 用派生稳定 id。
 * FTS：不在迁移内重建（message_blocks_fts 在 runMigrations 之后才创建，v26 执行时尚不存在，与 v25 同理）；
 * 首启由 db.ts populateMessageBlocksFts 增量补齐索引（v25→v26 升级时也会补，否则窗口期 user 行搜不到）；存量库由活跃漏斗 persistUserMessage 的增量 appendBlock 维护。
 */
const v26UserMessagesBackfill: Migration = {
  version: 26,
  name: 'user-messages-backfill',
  up: (db: Database.Database) => {
    // 旧 conversations 表不存在（全新库）→ 无历史可回填
    const hasConversations = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'conversations'`)
      .get();
    if (!hasConversations) return;

    // client_msg_id 列旧库可能缺——按 table_info 容错取列
    const cols = new Set(
      (db.pragma('table_info(conversations)') as Array<{ name: string }>).map((c) => c.name),
    );
    const hasClientMsgId = cols.has('client_msg_id');

    // 仅取「尚未回填到 messages」的 user 行（LEFT JOIN 找空），避免与 v25 已迁移行重复
    const rows = db
      .prepare(
        `SELECT c.id, c.session_id, c.content${
          hasClientMsgId ? ', c.client_msg_id' : ''
        }, c.created_at
         FROM conversations c
         LEFT JOIN messages m ON m.id = c.id
         WHERE c.role = 'user' AND m.id IS NULL
         ORDER BY c.created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;

    if (rows.length === 0) return;

    const insertMessage = db.prepare(
      `INSERT OR IGNORE INTO messages (id, session_id, role, client_msg_id, task_id, created_at)
       VALUES (?, ?, 'user', ?, NULL, ?)`,
    );
    // text block：派生稳定 id（blk-<conversations.id>），seq=1（user 行单 text block）；OR IGNORE 兜底任意约束冲突
    const insertBlock = db.prepare(
      `INSERT OR IGNORE INTO message_blocks (id, message_id, seq, block_type, payload_json, created_at)
       VALUES (?, ?, 1, 'text', ?, ?)`,
    );

    let migrated = 0;
    for (const r of rows) {
      const id = r.id as string;
      insertMessage.run(
        id,
        r.session_id,
        hasClientMsgId ? ((r.client_msg_id as string) ?? null) : null,
        r.created_at,
      );
      // content 落 message_blocks 前清洗（与 v25 同法，覆盖 pre-15.0 残留明文 secret）
      insertBlock.run(
        `blk-${id}`,
        id,
        JSON.stringify({ type: 'text', text: redactSecrets((r.content as string) ?? '') }),
        r.created_at,
      );
      migrated++;
    }

    logger.info({ migrated }, '对话内联 v26 回填：conversations user 行 → messages + message_blocks');
  },
};

/**
 * 15.0 redact 盲区存量清洗（P0-2）。
 *
 * v17~v24 覆盖了对话 / 任务 / 审核核心表，但漏了**记忆系统 + 若干旁路表**（这些不在 15.0 §9 的
 * 6 表承诺内，是全面核对时新发现的明文落库盲区）。P0-2 已在写入路径补 redact：
 *   - knowledge（knowledge.ts addKnowledge + evolution/engine + memory/entry 直接 INSERT）
 *   - 三层记忆（memory-layer-service create/update + FTS 同步 redacted）
 *   - brain_decisions（brain-decision-recorder.record + will-loop + unified-extractor 直接 INSERT）
 *   - drift_signals（drift-detector.recordSignal）
 *   - async_delegations（create/complete/fail）
 * 本迁移清洗这些表里 pre-fix 的历史明文（与 v17~v24 同法）。
 *
 * 配置驱动：一张 (表, 列) 清单统一扫，避免 14 段重复代码（v24 是单表单列写法，此处循环化是
 * 同构的自然延伸——不是新概念）。表 / 列不存在则跳过（全新库或旁路表未建），不阻塞启动。
 */
const V27_REDACT_TARGETS: ReadonlyArray<{ table: string; col: string }> = [
  { table: 'knowledge', col: 'summary' },
  { table: 'knowledge', col: 'detail' },
  { table: 'agent_memories_v2', col: 'content' },
  { table: 'workspace_memories', col: 'content' },
  { table: 'global_memories', col: 'content' },
  { table: 'brain_decisions', col: 'input_summary' },
  { table: 'brain_decisions', col: 'output_json' },
  { table: 'drift_signals', col: 'drift_description' },
  { table: 'drift_signals', col: 'suggested_action' },
  { table: 'drift_signals', col: 'actual_action' },
  { table: 'async_delegations', col: 'prompt' },
  { table: 'async_delegations', col: 'context_snapshot' },
  { table: 'async_delegations', col: 'result' },
  { table: 'async_delegations', col: 'error' },
];

const v27RedactBlindSpotScan: Migration = {
  version: 27,
  name: 'redact-blind-spot-scan',
  up: (db: Database.Database) => {
    let totalCleaned = 0;
    for (const { table, col } of V27_REDACT_TARGETS) {
      // 表不存在（全新库 / 旁路表未建）→ 跳过
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
        .get(table);
      if (!tableExists) continue;
      // 列不存在（旧库 schema 漂移）→ 跳过，不阻塞启动
      const cols = new Set(
        (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name),
      );
      if (!cols.has(col)) continue;

      // table / col 来自上方硬编码常量（非用户输入），无注入风险——与 v17~v24 同法
      const rows = db
        .prepare(`SELECT rowid AS rid, ${col} AS content FROM ${table} WHERE ${col} IS NOT NULL`)
        .all() as Array<{ rid: number; content: string }>;
      const update = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`);
      let cleaned = 0;
      for (const row of rows) {
        const redacted = redactSecrets(row.content);
        if (redacted !== row.content) {
          update.run(redacted, row.rid);
          cleaned++;
        }
      }
      totalCleaned += cleaned;
      if (cleaned > 0) {
        logger.info({ table, col, cleaned }, '15.0 P0-2 redact 盲区扫描：清洗历史明文 secret');
      }
    }
    if (totalCleaned === 0) {
      logger.debug({}, '15.0 P0-2 redact 盲区扫描：无历史明文需清洗');
    }
  },
};

/**
 * 对话内联统一收尾（设计文档/22）：回填 conversations 里仍残留、不在 messages 的孤行（user + assistant）。
 *
 * 根因：v25 一次性回填了它跑时刻的 conversations 全表，v26 只回填 user。但服务若仍跑老代码（期1 /
 * 消灭双轨制之前），会持续向 conversations 写新行制造孤子；这些孤子（含 v25 之后的 assistant 行，
 * v25/v26 都不会再跑）永远进不了 messages。本迁移收口：把所有 conversations ∉ messages 的行一次性
 * 补进新表，使 /state（读 messages）刷新不丢历史对话。消灭双轨制后新代码不再制造孤子，本迁移一次性善后。
 *
 * 与 v25 同构（reasoning→thinking block + content→text block），但用 LEFT JOIN 精确定位「不在 messages」
 * 的孤行；user + assistant 都回填（补 v26 只回填 user 的缺口）。幂等：LEFT JOIN m.id IS NULL + INSERT OR IGNORE。
 * FTS 不在此建（runMigrations 后才有 FTS 表，靠 db.ts populateMessageBlocksFts 增量补，与 v25/v26 同理）。
 */
const v28ConversationsOrphanBackfill: Migration = {
  version: 28,
  name: 'conversations-orphan-backfill',
  up: (db: Database.Database) => {
    const hasConversations = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'conversations'`)
      .get();
    if (!hasConversations) return;

    const cols = new Set(
      (db.pragma('table_info(conversations)') as Array<{ name: string }>).map((c) => c.name),
    );
    const hasReasoning = cols.has('reasoning');
    const hasClientMsgId = cols.has('client_msg_id');
    const hasTaskId = cols.has('task_id');

    // 仅取「尚未进 messages」的孤行（LEFT JOIN 找空）——user + assistant 都要，避免与 v25/v26 已回填行重复
    const rows = db
      .prepare(
        `SELECT c.id, c.session_id, c.role, c.content${
          hasReasoning ? ', c.reasoning' : ''
        }${hasClientMsgId ? ', c.client_msg_id' : ''}${hasTaskId ? ', c.task_id' : ''}, c.created_at
         FROM conversations c
         LEFT JOIN messages m ON m.id = c.id
         WHERE m.id IS NULL
         ORDER BY c.created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;

    if (rows.length === 0) return;

    const insertMessage = db.prepare(
      `INSERT OR IGNORE INTO messages (id, session_id, role, client_msg_id, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertBlock = db.prepare(
      `INSERT OR IGNORE INTO message_blocks (id, message_id, seq, block_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    let migrated = 0;
    for (const r of rows) {
      const id = r.id as string;
      insertMessage.run(
        id,
        r.session_id,
        r.role,
        hasClientMsgId ? ((r.client_msg_id as string) ?? null) : null,
        hasTaskId ? ((r.task_id as string) ?? null) : null,
        r.created_at,
      );
      // thinking block（assistant 的 reasoning 非空时）；content 落 text block 前清洗 secret（与 v25 同法）
      let seq = 0;
      if (hasReasoning && r.reasoning) {
        seq++;
        insertBlock.run(
          `${id}#b${seq}`,
          id,
          seq,
          'thinking',
          JSON.stringify({ type: 'thinking', text: redactSecrets(r.reasoning as string) }),
          r.created_at,
        );
      }
      seq++;
      insertBlock.run(
        `${id}#b${seq}`,
        id,
        seq,
        'text',
        JSON.stringify({ type: 'text', text: redactSecrets((r.content as string) ?? '') }),
        r.created_at,
      );
      migrated++;
    }

    logger.info({ migrated }, '对话内联 v28 回填：conversations 孤行（user+assistant）→ messages + message_blocks');
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
  v17RedactHistoryScan,
  v18DialogueAndAgentChatFts,
  v19RedactExtraTablesScan,
  v20FtsConcatAgentNames,
  v21RedactToolCallsScan,
  v22RedactResponsesScan,
  v23RedactOutputPayloadScan,
  v24RedactInputPayloadScan,
  v25InlineBlocksBackfill,
  v26UserMessagesBackfill,
  v27RedactBlindSpotScan,
  v28ConversationsOrphanBackfill,
];
