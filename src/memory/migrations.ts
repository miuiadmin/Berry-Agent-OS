import type Database from 'better-sqlite3';

export function runMemoryMigrations(conn: Database.Database): void {
  const previousLegacyAlter = conn.pragma('legacy_alter_table', { simple: true }) as number;
  conn.pragma('legacy_alter_table = ON');

  try {
    const knowledgeColumns = getColumns(conn, 'knowledge');
    addColumnIfMissing(conn, knowledgeColumns, 'knowledge', 'owner_key', "TEXT NOT NULL DEFAULT 'user:owner'");
    addColumnIfMissing(conn, knowledgeColumns, 'knowledge', 'source', "TEXT NOT NULL DEFAULT 'conversation'");
    addColumnIfMissing(conn, knowledgeColumns, 'knowledge', 'last_seen_at', 'INTEGER');
    addColumnIfMissing(conn, knowledgeColumns, 'knowledge', 'last_used_at', 'INTEGER');
    addColumnIfMissing(conn, knowledgeColumns, 'knowledge', 'last_used_query', 'TEXT');
    conn.prepare(
      `UPDATE knowledge SET last_seen_at = COALESCE(last_seen_at, updated_at, created_at, ?) WHERE last_seen_at IS NULL`,
    ).run(Date.now());
    rebuildKnowledgeIfNeeded(conn);

    const accessColumns = getColumns(conn, 'memory_access_log');
    addColumnIfMissing(conn, accessColumns, 'memory_access_log', 'recall_source', "TEXT NOT NULL DEFAULT 'auto_recall'");
    if (accessColumns.has('source')) {
      conn.prepare(
        `UPDATE memory_access_log SET recall_source = source WHERE source IS NOT NULL AND recall_source = 'auto_recall'`,
      ).run();
      rebuildMemoryAccessLog(conn);
    }

    rebuildConversationsIfNeeded(conn);
    migrateReviewsToReviewRequests(conn);
    rebuildRunArtifactsIfNeeded(conn);
    rebuildToolCallsIfNeeded(conn);
    addToolCallsAuditColumns(conn);
    rebuildTokenUsageIfNeeded(conn);
    addTokenUsageScopeColumns(conn);
    addTaskLifecycleColumns(conn);
    rebuildLogEventsIfNeeded(conn);
    rebuildConsoleFramesIfNeeded(conn);
    migrateCreateFileLocksTable(conn);
    relaxAgentTasksConstraint(conn);
    relaxModelRequestsPurpose(conn);
    addModelTierColumn(conn);
    addSkillsTelemetryColumns(conn);
    addSkillsVisibilityColumns(conn);
    migrateCreateAgentsMetaTables(conn);
    migrateCreateSignalHistoryTable(conn);
    migrateCreatePluginStorageTable(conn);
    migrateCreateCodeAuditTables(conn);
    migrateCreateSkillEventsTable(conn);
    addTaskTraceColumn(conn);
    addTaskRequeueColumn(conn);
    migrateCreateKnowledgeEmbeddings(conn);
    migrateCreateBrainDecisionsTable(conn);
    migrateCreateSystemInsightsTable(conn);
    migrateCreateWorldModelTable(conn);
    migrateCreateSelfModificationLog(conn);
    migrateBrainDecisionsAddColumns(conn);
    migrateBrainDecisionsExpandTypes(conn);
    migrateReviewRequestsExpandVerdicts(conn);
    addConversationsClientMsgIdColumn(conn);
    migrateCreateBrainObservationsTable(conn);
    migrateCreateAgentAuditTables(conn);
    migrateCreateBrainCorrectionsTable(conn);
    migrateBrainDecisionsAddTaskId(conn);
    migrateCreateUserPreferencesTable(conn);
  } finally {
    conn.pragma(`legacy_alter_table = ${previousLegacyAlter ? 'ON' : 'OFF'}`);
  }
}

function rebuildKnowledgeIfNeeded(conn: Database.Database): void {
  const schema = tableSql(conn, 'knowledge');
  const hasEvidenceSystem = schema.includes("evidence_kind IN ('direct','inferred','manual','system')");
  const hasSourceCheck = schema.includes("source IN ('conversation','manual','import','system','tool','plugin')");
  const hasRequiredLastSeen = schema.includes('last_seen_at INTEGER NOT NULL');
  if (hasEvidenceSystem && hasSourceCheck && hasRequiredLastSeen) return;

  const now = Date.now();
  conn.exec(`
    DROP TRIGGER IF EXISTS knowledge_ai;
    DROP TRIGGER IF EXISTS knowledge_ad;
    DROP TRIGGER IF EXISTS knowledge_au;
    DROP TABLE IF EXISTS knowledge_fts;
    ALTER TABLE knowledge RENAME TO knowledge_old_migration;

    CREATE TABLE knowledge (
      id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL DEFAULT 'user:owner',
      type TEXT NOT NULL CHECK(type IN (
        'identity','preference','goal','project','habit',
        'decision','constraint','relationship','fact','reflection'
      )),
      summary TEXT NOT NULL,
      detail TEXT,
      scope TEXT NOT NULL DEFAULT 'active' CHECK(scope IN ('active','durable')),
      evidence_kind TEXT NOT NULL DEFAULT 'inferred'
        CHECK(evidence_kind IN ('direct','inferred','manual','system')),
      source TEXT NOT NULL DEFAULT 'conversation'
        CHECK(source IN ('conversation','manual','import','system','tool','plugin')),
      confidence REAL NOT NULL DEFAULT 0.7,
      importance REAL NOT NULL DEFAULT 0.5,
      durability REAL NOT NULL DEFAULT 0.5,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      provenance TEXT,
      dismissed INTEGER NOT NULL DEFAULT 0,
      superseded_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_seen_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_used_at INTEGER,
      last_used_query TEXT
    );
  `);

  conn.prepare(`
    INSERT INTO knowledge (
      id, owner_key, type, summary, detail, scope, evidence_kind, source,
      confidence, importance, durability, evidence_count, provenance,
      dismissed, superseded_by, created_at, updated_at,
      last_seen_at, last_used_at, last_used_query
    )
    SELECT
      id,
      COALESCE(owner_key, 'user:owner'),
      type,
      summary,
      detail,
      scope,
      CASE
        WHEN evidence_kind IN ('direct','inferred','manual','system') THEN evidence_kind
        ELSE 'inferred'
      END,
      CASE
        WHEN source IN ('conversation','manual','import','system','tool','plugin') THEN source
        ELSE 'conversation'
      END,
      confidence,
      importance,
      durability,
      evidence_count,
      provenance,
      dismissed,
      superseded_by,
      created_at,
      updated_at,
      COALESCE(last_seen_at, updated_at, created_at, ?),
      last_used_at,
      last_used_query
    FROM knowledge_old_migration
  `).run(now);

  conn.exec(`DROP TABLE knowledge_old_migration;`);
}

function rebuildMemoryAccessLog(conn: Database.Database): void {
  conn.exec(`
    ALTER TABLE memory_access_log RENAME TO memory_access_log_old_migration;

    CREATE TABLE memory_access_log (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES run_artifacts(id),
      session_id TEXT NOT NULL,
      agent_name TEXT NOT NULL DEFAULT 'conversation',
      recall_source TEXT NOT NULL CHECK(recall_source IN ('auto_recall','tool_query','brain_requested')),
      query TEXT NOT NULL,
      result_ids TEXT NOT NULL,
      scores TEXT,
      context_chars INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    INSERT INTO memory_access_log (
      id, run_id, session_id, agent_name, recall_source, query,
      result_ids, scores, context_chars, truncated, created_at
    )
    SELECT
      id,
      run_id,
      session_id,
      agent_name,
      CASE
        WHEN recall_source IN ('auto_recall','tool_query','brain_requested') THEN recall_source
        WHEN source IN ('auto_recall','tool_query','brain_requested') THEN source
        ELSE 'auto_recall'
      END,
      query,
      result_ids,
      scores,
      context_chars,
      truncated,
      created_at
    FROM memory_access_log_old_migration;

    DROP TABLE memory_access_log_old_migration;
  `);
}

function rebuildConversationsIfNeeded(conn: Database.Database): void {
  const columns = getColumns(conn, 'conversations');
  const schema = tableSql(conn, 'conversations');
  if (
    columns.has('tool_name') &&
    columns.has('tool_input') &&
    columns.has('tool_result') &&
    columns.has('token_count') &&
    schema.includes("role IN ('user','assistant','system','tool')")
  ) {
    return;
  }

  conn.exec(`
    ALTER TABLE conversations RENAME TO conversations_old_migration;

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      content TEXT NOT NULL,
      tool_name TEXT,
      tool_input TEXT,
      tool_result TEXT,
      token_count INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    INSERT INTO conversations (
      id, session_id, role, content, tool_name, tool_input, tool_result, token_count, created_at
    )
    SELECT
      id,
      session_id,
      CASE WHEN role IN ('user','assistant','system','tool') THEN role ELSE 'system' END,
      content,
      NULL,
      NULL,
      NULL,
      NULL,
      created_at
    FROM conversations_old_migration;

    DROP TABLE conversations_old_migration;
  `);
}

function migrateReviewsToReviewRequests(conn: Database.Database): void {
  if (!tableExists(conn, 'reviews')) return;

  const rows = conn.prepare(`SELECT * FROM reviews`).all() as Record<string, unknown>[];
  const insert = conn.prepare(`
    INSERT OR IGNORE INTO review_requests (
      id, session_id, level, draft_response, review_input,
      verdict, final_response, reason, created_at, reviewed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const migrate = conn.transaction(() => {
    for (const row of rows) {
      const verdict = normalizeReviewVerdict(row.verdict);
      insert.run(
        row.id,
        row.session_id,
        normalizeReviewLevel(row.level),
        row.draft_response,
        JSON.stringify({ user_message: row.user_message ?? '' }),
        verdict,
        row.final_response ?? null,
        row.reason ?? null,
        row.created_at ?? Date.now(),
        verdict === 'pending' ? null : row.created_at ?? Date.now(),
      );
    }
    conn.exec(`DROP TABLE reviews;`);
  });
  migrate();
}

function rebuildToolCallsIfNeeded(conn: Database.Database): void {
  const columns = getColumns(conn, 'tool_calls');
  if (!columns.has('tool_input') && columns.has('input') && columns.has('input_hash')) return;

  conn.exec(`
    ALTER TABLE tool_calls RENAME TO tool_calls_old_migration;

    CREATE TABLE tool_calls (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES run_artifacts(id),
      session_id TEXT NOT NULL,
      task_id TEXT REFERENCES agent_tasks(id),
      correlation_id TEXT,
      agent_name TEXT NOT NULL DEFAULT 'conversation',
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      permission_token TEXT,
      permission_verdict TEXT CHECK(permission_verdict IN ('allow','deny','ask_user')),
      danger_level TEXT,
      result TEXT,
      is_error INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      finished_at INTEGER,
      duration_ms INTEGER
    );

    INSERT INTO tool_calls (
      id, run_id, session_id, task_id, correlation_id, agent_name, tool_name,
      input, input_hash, permission_token, permission_verdict, result,
      is_error, started_at, finished_at
    )
    SELECT
      id,
      NULL,
      session_id,
      NULL,
      NULL,
      'conversation',
      tool_name,
      tool_input,
      '',
      NULL,
      CASE
        WHEN permission_mode = 'deny-all' THEN 'deny'
        WHEN permission_mode IN ('ask','allow-all') THEN 'allow'
        ELSE NULL
      END,
      tool_result,
      COALESCE(is_error, 0),
      COALESCE(created_at, unixepoch() * 1000),
      CASE
        WHEN duration_ms IS NULL THEN created_at
        ELSE COALESCE(created_at, unixepoch() * 1000) + duration_ms
      END
    FROM tool_calls_old_migration;

    DROP TABLE tool_calls_old_migration;
  `);
}

function addToolCallsAuditColumns(conn: Database.Database): void {
  const columns = getColumns(conn, 'tool_calls');
  addColumnIfMissing(conn, columns, 'tool_calls', 'danger_level', 'TEXT');
  addColumnIfMissing(conn, columns, 'tool_calls', 'duration_ms', 'INTEGER');
}

function rebuildTokenUsageIfNeeded(conn: Database.Database): void {
  const columns = getColumns(conn, 'token_usage');
  if (!columns.has('agent') && columns.has('session_id') && columns.has('cache_read_tokens')) return;

  conn.exec(`
    ALTER TABLE token_usage RENAME TO token_usage_old_migration;

    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      model TEXT NOT NULL,
      cost_usd REAL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    INSERT INTO token_usage (
      session_id, input_tokens, output_tokens, cache_read_tokens,
      cache_creation_tokens, model, cost_usd, created_at
    )
    SELECT
      COALESCE(agent, 'legacy'),
      input_tokens,
      output_tokens,
      0,
      0,
      model,
      NULL,
      created_at
    FROM token_usage_old_migration;

    DROP TABLE token_usage_old_migration;
  `);
}

function addTokenUsageScopeColumns(conn: Database.Database): void {
  const columns = getColumns(conn, 'token_usage');
  addColumnIfMissing(conn, columns, 'token_usage', 'agent_name', 'TEXT');
  addColumnIfMissing(conn, columns, 'token_usage', 'task_id', 'TEXT');
}

function addTaskLifecycleColumns(conn: Database.Database): void {
  const columns = getColumns(conn, 'agent_tasks');
  addColumnIfMissing(conn, columns, 'agent_tasks', 'visibility', "TEXT NOT NULL DEFAULT 'foreground'");
  addColumnIfMissing(conn, columns, 'agent_tasks', 'notify_state', "TEXT NOT NULL DEFAULT 'none'");
  addColumnIfMissing(conn, columns, 'agent_tasks', 'backgrounded_at', 'INTEGER');
  addColumnIfMissing(conn, columns, 'agent_tasks', 'retrieved_at', 'INTEGER');
  addColumnIfMissing(conn, columns, 'agent_tasks', 'notified_at', 'INTEGER');
}

function rebuildRunArtifactsIfNeeded(conn: Database.Database): void {
  const columns = getColumns(conn, 'run_artifacts');
  if (columns.has('kind') && columns.has('log_level') && columns.has('status') && !columns.has('exit_code')) return;

  conn.exec(`
    ALTER TABLE run_artifacts RENAME TO run_artifacts_old_migration;

    CREATE TABLE run_artifacts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('cli','test','service','agent','plugin')),
      session_id TEXT,
      artifact_dir TEXT NOT NULL,
      log_level TEXT NOT NULL CHECK(log_level IN ('error','warn','info','debug')),
      command TEXT,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running','passed','failed','cancelled')),
      started_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      finished_at INTEGER
    );

    INSERT INTO run_artifacts (
      id, kind, session_id, artifact_dir, log_level, command, status, started_at, finished_at
    )
    SELECT
      id,
      'cli',
      NULL,
      artifact_dir,
      'info',
      command,
      CASE
        WHEN exit_code = 0 THEN 'passed'
        WHEN exit_code IS NULL THEN 'running'
        ELSE 'failed'
      END,
      started_at,
      finished_at
    FROM run_artifacts_old_migration;

    DROP TABLE run_artifacts_old_migration;
  `);
}

function rebuildLogEventsIfNeeded(conn: Database.Database): void {
  const columns = getColumns(conn, 'log_events');
  if (columns.has('message') && columns.has('payload') && columns.has('session_id') && !columns.has('msg')) return;

  conn.exec(`
    ALTER TABLE log_events RENAME TO log_events_old_migration;

    CREATE TABLE log_events (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES run_artifacts(id),
      session_id TEXT,
      level TEXT NOT NULL CHECK(level IN ('error','warn','info','debug')),
      module TEXT NOT NULL,
      message TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      correlation_id TEXT,
      span_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    INSERT INTO log_events (
      id, run_id, session_id, level, module, message, payload, correlation_id, span_id, created_at
    )
    SELECT
      CAST(id AS TEXT),
      run_id,
      NULL,
      CASE WHEN level IN ('error','warn','info','debug') THEN level ELSE 'info' END,
      module,
      msg,
      COALESCE(data, '{}'),
      NULL,
      NULL,
      created_at
    FROM log_events_old_migration;

    DROP TABLE log_events_old_migration;
  `);
}

function rebuildConsoleFramesIfNeeded(conn: Database.Database): void {
  const columns = getColumns(conn, 'console_frames');
  if (columns.has('seq') && columns.has('source') && columns.has('payload') && !tableSql(conn, 'console_frames').includes('id INTEGER')) {
    return;
  }

  conn.exec(`
    ALTER TABLE console_frames RENAME TO console_frames_old_migration;

    CREATE TABLE console_frames (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES run_artifacts(id),
      session_id TEXT,
      seq INTEGER NOT NULL,
      stream TEXT NOT NULL CHECK(stream IN ('stdin','stdout','stderr','system','jsonl')),
      source TEXT NOT NULL,
      level TEXT CHECK(level IN ('error','warn','info','debug')),
      is_json INTEGER NOT NULL DEFAULT 0,
      text TEXT,
      payload TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    INSERT INTO console_frames (
      id, run_id, session_id, seq, stream, source, level, is_json, text, payload, created_at
    )
    SELECT
      CAST(id AS TEXT),
      run_id,
      NULL,
      id,
      CASE WHEN stream IN ('stdin','stdout','stderr','system','jsonl') THEN stream ELSE 'system' END,
      'cli',
      NULL,
      0,
      text,
      NULL,
      created_at
    FROM console_frames_old_migration;

    DROP TABLE console_frames_old_migration;
  `);
}

function addColumnIfMissing(
  conn: Database.Database,
  columns: Set<string>,
  table: string,
  column: string,
  definition: string,
): void {
  if (columns.has(column)) return;
  conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  columns.add(column);
}

function tableExists(conn: Database.Database, table: string): boolean {
  const row = conn.prepare(
    `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table) as { found: number } | undefined;
  return Boolean(row);
}

function columnExists(conn: Database.Database, table: string, column: string): boolean {
  const rows = conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(r => r.name === column);
}

function tableSql(conn: Database.Database, table: string): string {
  const row = conn.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table) as { sql?: string } | undefined;
  return row?.sql ?? '';
}

function getColumns(conn: Database.Database, table: string): Set<string> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`Invalid table identifier: ${table}`);
  }
  return new Set(conn.prepare(`PRAGMA table_info('${table}')`).all().map((col) => (col as { name: string }).name));
}

function normalizeReviewLevel(value: unknown): string {
  return value === 'A' || value === 'B' || value === 'C' ? value : 'A';
}

function normalizeReviewVerdict(value: unknown): string {
  return value === 'pending' ||
    value === 'approve' ||
    value === 'modify' ||
    value === 'reject' ||
    value === 'require_user_confirm'
    ? value
    : 'pending';
}

function migrateCreateFileLocksTable(conn: Database.Database): void {
  if (tableExists(conn, 'file_locks')) return;

  conn.exec(`
    CREATE TABLE IF NOT EXISTS file_locks (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      workspace_dir TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES agent_tasks(id),
      agent_name TEXT NOT NULL,
      lock_type TEXT NOT NULL CHECK(lock_type IN ('read','write')),
      file_hash TEXT,
      acquired_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      expires_at INTEGER NOT NULL,
      released_at INTEGER,
      status TEXT NOT NULL DEFAULT 'held' CHECK(status IN ('held','released','expired'))
    );

    CREATE INDEX IF NOT EXISTS idx_file_locks_active
      ON file_locks(workspace_dir, file_path, status);
  `);
}

function relaxAgentTasksConstraint(conn: Database.Database): void {
  const schema = tableSql(conn, 'agent_tasks');
  if (!schema.includes("task_type IN (")) return;

  conn.exec(`
    ALTER TABLE agent_tasks RENAME TO agent_tasks_old_migration;

    CREATE TABLE agent_tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES run_artifacts(id),
      session_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      requester TEXT NOT NULL,
      target_agent TEXT NOT NULL,
      foreground INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'foreground'
        CHECK(visibility IN ('foreground','backgrounded','retrieved')),
      notify_state TEXT NOT NULL DEFAULT 'none'
        CHECK(notify_state IN ('none','pending','notified','dismissed')),
      priority INTEGER NOT NULL DEFAULT 0,
      input_payload TEXT NOT NULL,
      output_payload TEXT,
      status TEXT NOT NULL DEFAULT 'created'
        CHECK(status IN (
          'created','persisted','dispatched','acknowledged','running',
          'waiting_approval','completed','failed','timeout','cancelled'
        )),
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      dispatched_at INTEGER,
      acknowledged_at INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      backgrounded_at INTEGER,
      retrieved_at INTEGER,
      notified_at INTEGER
    );

    INSERT INTO agent_tasks SELECT * FROM agent_tasks_old_migration;
    DROP TABLE agent_tasks_old_migration;
  `);
}

function relaxModelRequestsPurpose(conn: Database.Database): void {
  const schema = tableSql(conn, 'model_requests');
  if (!schema.includes("purpose IN (")) return;

  conn.exec(`
    ALTER TABLE model_requests RENAME TO model_requests_old_migration;

    CREATE TABLE model_requests (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES run_artifacts(id),
      session_id TEXT NOT NULL,
      task_id TEXT REFERENCES agent_tasks(id),
      correlation_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      purpose TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('live','mock','replay','takeover')),
      api_kind TEXT NOT NULL DEFAULT 'standard' CHECK(api_kind IN ('standard','claude_agent_sdk')),
      backend TEXT NOT NULL DEFAULT 'anthropic' CHECK(backend IN ('anthropic','ai_sdk','test','claude_agent_sdk')),
      model_name TEXT,
      protocol TEXT,
      sdk_run_id TEXT,
      step_index INTEGER NOT NULL DEFAULT 0,
      prompt_hash TEXT NOT NULL,
      tools_hash TEXT,
      expected_schema TEXT,
      request_payload TEXT NOT NULL,
      response_payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','responded','replayed','failed','timeout')),
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      responded_at INTEGER
    );

    INSERT INTO model_requests SELECT * FROM model_requests_old_migration;
    DROP TABLE model_requests_old_migration;
  `);
}

function addSkillsTelemetryColumns(conn: Database.Database): void {
  if (!tableExists(conn, 'skills_meta')) return;
  const columns = getColumns(conn, 'skills_meta');
  addColumnIfMissing(conn, columns, 'skills_meta', 'view_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(conn, columns, 'skills_meta', 'patch_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(conn, columns, 'skills_meta', 'last_viewed_at', 'INTEGER');
  addColumnIfMissing(conn, columns, 'skills_meta', 'last_patched_at', 'INTEGER');
  addColumnIfMissing(conn, columns, 'skills_meta', 'created_by', "TEXT NOT NULL DEFAULT 'system'");
  addColumnIfMissing(conn, columns, 'skills_meta', 'state', "TEXT NOT NULL DEFAULT 'active'");
}

function addModelTierColumn(conn: Database.Database): void {
  const columns = getColumns(conn, 'model_requests');
  if (columns.has('model_tier')) return;
  conn.exec(`ALTER TABLE model_requests ADD COLUMN model_tier TEXT NOT NULL DEFAULT 'default' CHECK(model_tier IN ('fast','default','high'))`);
}

function addSkillsVisibilityColumns(conn: Database.Database): void {
  if (!tableExists(conn, 'skills_meta')) return;
  const columns = getColumns(conn, 'skills_meta');
  addColumnIfMissing(conn, columns, 'skills_meta', 'arguments_json', 'TEXT');
  addColumnIfMissing(conn, columns, 'skills_meta', 'when_to_use', 'TEXT');
  addColumnIfMissing(conn, columns, 'skills_meta', 'allowed_tools_json', 'TEXT');
  addColumnIfMissing(conn, columns, 'skills_meta', 'model_invocable', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(conn, columns, 'skills_meta', 'description_hidden', 'INTEGER NOT NULL DEFAULT 0');
}

function migrateCreateAgentsMetaTables(conn: Database.Database): void {
  if (tableExists(conn, 'agents_meta')) return;

  conn.exec(`
    CREATE TABLE IF NOT EXISTS agents_meta (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      version TEXT NOT NULL DEFAULT '0.1.0',
      description TEXT NOT NULL,
      agent_dir TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user'
        CHECK(source IN ('bundled','user','generated','installed')),
      kind TEXT NOT NULL CHECK(kind IN ('resident','on-demand')),
      level INTEGER NOT NULL CHECK(level IN (1,2,3)),
      status TEXT NOT NULL DEFAULT 'enabled'
        CHECK(status IN ('pending_review','enabled','disabled','removed','failed','quarantined')),
      roles_json TEXT NOT NULL DEFAULT '[]',
      task_types_json TEXT NOT NULL DEFAULT '[]',
      task_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      installed_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      upgraded_at INTEGER,
      removed_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS agent_lifecycle_events (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'installed','removed','upgraded','enabled','disabled',
        'started','stopped','crashed','review_requested','review_completed'
      )),
      from_version TEXT,
      to_version TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_agents_meta_status ON agents_meta(status);
    CREATE INDEX IF NOT EXISTS idx_agents_meta_source ON agents_meta(source, status);
    CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_name ON agent_lifecycle_events(agent_name, created_at);
  `);
}

function migrateCreateSignalHistoryTable(conn: Database.Database): void {
  if (tableExists(conn, 'signal_history')) return;

  conn.exec(`
    CREATE TABLE IF NOT EXISTS signal_history (
      id TEXT PRIMARY KEY,
      signal_type TEXT NOT NULL,
      target TEXT NOT NULL,
      confidence REAL NOT NULL,
      source_turn_id TEXT,
      outcome TEXT NOT NULL DEFAULT 'pending'
        CHECK(outcome IN ('pending','accepted','rejected','deduped')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_signal_history_target ON signal_history(target);
    CREATE INDEX IF NOT EXISTS idx_signal_history_outcome ON signal_history(outcome, created_at);
  `);
}

function migrateCreatePluginStorageTable(conn: Database.Database): void {
  if (tableExists(conn, 'plugin_storage')) return;

  conn.exec(`
    CREATE TABLE IF NOT EXISTS plugin_storage (
      plugin_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (plugin_name, key)
    );

    CREATE INDEX IF NOT EXISTS idx_plugin_storage_plugin ON plugin_storage(plugin_name);
  `);
}

function migrateCreateSkillEventsTable(conn: Database.Database): void {
  if (!tableExists(conn, 'skill_events')) {
    conn.exec(`
      CREATE TABLE skill_events (
        id TEXT PRIMARY KEY,
        skill_name TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_skill_events_name ON skill_events(skill_name);
      CREATE INDEX idx_skill_events_type ON skill_events(event_type);
    `);
  }
}

function migrateCreateCodeAuditTables(conn: Database.Database): void {
  if (!tableExists(conn, 'code_file_changes')) {
    conn.exec(`
      CREATE TABLE code_file_changes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('create','modify','delete','rename')),
        before_content TEXT,
        after_content TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE INDEX idx_code_file_changes_task ON code_file_changes(task_id);
    `);
  }

  if (!tableExists(conn, 'code_commands')) {
    conn.exec(`
      CREATE TABLE code_commands (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        command TEXT NOT NULL,
        exit_code INTEGER NOT NULL,
        stdout TEXT NOT NULL DEFAULT '',
        stderr TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE INDEX idx_code_commands_task ON code_commands(task_id);
    `);
  }
}

function addTaskTraceColumn(conn: Database.Database): void {
  const cols = getColumns(conn, 'agent_tasks');
  addColumnIfMissing(conn, cols, 'agent_tasks', 'trace_id', 'TEXT');
}

function addTaskRequeueColumn(conn: Database.Database): void {
  const cols = getColumns(conn, 'agent_tasks');
  addColumnIfMissing(conn, cols, 'agent_tasks', 'requeue_count', 'INTEGER NOT NULL DEFAULT 0');
}

/**
 * 给 conversations 表加 client_msg_id 列 + UNIQUE 索引。
 * 12.0 起 user 消息改用 clientMsgId 精确去重（同 session 内同 clientMsgId 只入库一次），
 * 替换旧的 5s 窗口 + content 匹配（边界 bug：用户连续相同消息 > 5s 会被重复入库）。
 */
function addConversationsClientMsgIdColumn(conn: Database.Database): void {
  const cols = getColumns(conn, 'conversations');
  addColumnIfMissing(conn, cols, 'conversations', 'client_msg_id', 'TEXT');
  // UNIQUE 索引（条件索引：仅对 client_msg_id 非空行生效，允许老数据无 clientMsgId 仍可入）
  conn.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_client_msg_id
     ON conversations(session_id, client_msg_id)
     WHERE client_msg_id IS NOT NULL`,
  );
}

function migrateCreateKnowledgeEmbeddings(conn: Database.Database): void {
  if (tableExists(conn, 'knowledge_embeddings')) return;
  conn.exec(`
    CREATE TABLE knowledge_embeddings (
      knowledge_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
}

function migrateCreateBrainDecisionsTable(conn: Database.Database): void {
  if (tableExists(conn, 'brain_decisions')) return;
  conn.exec(`
    CREATE TABLE brain_decisions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      decision_type TEXT NOT NULL
        CHECK(decision_type IN ('route','review','permission','correction','aggregated_insight','will_action','cron_review')),
      input_summary TEXT NOT NULL,
      output_json TEXT NOT NULL,
      confidence REAL,
      outcome TEXT CHECK(outcome IN ('good','bad','neutral')),
      feedback_source TEXT
        CHECK(feedback_source IS NULL OR feedback_source IN ('user_correction','metric_signal','evolution_engine')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX idx_brain_decisions_type_session
      ON brain_decisions(decision_type, session_id);
    CREATE INDEX idx_brain_decisions_outcome
      ON brain_decisions(outcome) WHERE outcome IS NOT NULL;
    CREATE INDEX idx_brain_decisions_created
      ON brain_decisions(created_at);
  `);
}

/**
 * 13.0 灵魂版：Brain 观察队列表。
 * - 持久化所有 Agent 间通信 + 工具调用 + 用户交互
 * - Brain 重启可从 SQLite 恢复完整上下文
 * - 按 (session_id, task_id) 二维隔离，按 seq 单调递增
 * - 滚动窗口 500 条，超出后按 (priority DESC, timestamp ASC) 裁剪
 */
function migrateCreateBrainObservationsTable(conn: Database.Database): void {
  if (tableExists(conn, 'brain_observations')) return;
  conn.exec(`
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

    CREATE INDEX idx_brain_obs_session
      ON brain_observations(session_id, created_at DESC);
    CREATE INDEX idx_brain_obs_type
      ON brain_observations(observation_type, created_at DESC);
    CREATE INDEX idx_brain_obs_priority
      ON brain_observations(priority, created_at DESC);
  `);
}

/**
 * 13.0 Agent 间对话审计表 + Agent 工具调用审计表。
 * - agent_chat_messages：记录所有 Agent 间 request/response 对话，前端 agent-chat 面板读取
 * - agent_tool_calls：记录每个 Agent 的工具调用详情，Brain 审核读取工具上下文
 * - 与 tool_calls 表互补：tool_calls 记录 LLM 层工具调用，agent_tool_calls 按 agent 维度索引
 */
function migrateCreateAgentAuditTables(conn: Database.Database): void {
  if (!tableExists(conn, 'agent_chat_messages')) {
    conn.exec(`
      CREATE TABLE agent_chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('request', 'response', 'notify')),
        message_type TEXT NOT NULL DEFAULT 'agent.question',
        content TEXT NOT NULL,
        correlation_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE INDEX idx_agent_chat_session
        ON agent_chat_messages(session_id, created_at DESC);
      CREATE INDEX idx_agent_chat_task
        ON agent_chat_messages(task_id, created_at DESC);
      CREATE INDEX idx_agent_chat_agents
        ON agent_chat_messages(from_agent, to_agent, created_at DESC);
      CREATE INDEX idx_agent_chat_correlation
        ON agent_chat_messages(correlation_id);
    `);
  }

  if (!tableExists(conn, 'agent_tool_calls')) {
    conn.exec(`
      CREATE TABLE agent_tool_calls (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_summary TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        duration_ms INTEGER,
        approved_by TEXT CHECK(approved_by IN ('auto', 'scope', 'brain', 'user')),
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE INDEX idx_agent_tool_session
        ON agent_tool_calls(session_id, created_at DESC);
      CREATE INDEX idx_agent_tool_task
        ON agent_tool_calls(task_id, created_at DESC);
      CREATE INDEX idx_agent_tool_agent
        ON agent_tool_calls(agent_name, created_at DESC);
      CREATE INDEX idx_agent_tool_name
        ON agent_tool_calls(tool_name, success, created_at DESC);
    `);
  }
}

/**
 * 13.0 §13.20: brain_corrections 表 — 追踪 Brain 纠偏频次，Evolution 引擎据此触发学习闭环。
 *
 * 触发规则（§3.7 升级式纠偏）：
 * - 同 agent 30 分钟内 high 严重度纠偏 >= 3 次 → capability.evolution.request
 * - 同 agent 60 分钟内所有纠偏 >= 8 次 → capability.evolution.request
 *
 * 与 brain_decisions 表的区别：
 * - brain_decisions 是完整决策历史（route/review/permission/correction/...）
 * - brain_corrections 仅追踪纠偏，专门用于频次检测
 */
function migrateCreateBrainCorrectionsTable(conn: Database.Database): void {
  if (tableExists(conn, 'brain_corrections')) return;
  conn.exec(`
    CREATE TABLE brain_corrections (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT,
      agent_name TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high')),
      action TEXT NOT NULL CHECK(action IN ('continue', 'adjust', 'stop', 'restart')),
      instruction TEXT NOT NULL,
      block_tools_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX idx_brain_corrections_agent_time
      ON brain_corrections(agent_name, created_at DESC);
    CREATE INDEX idx_brain_corrections_severity_time
      ON brain_corrections(severity, created_at DESC);
    CREATE INDEX idx_brain_corrections_session
      ON brain_corrections(session_id, created_at DESC);
  `);
}

/**
 * 13.0 §5.3.7 + §8.8: user_preferences 表 — 跨 session 持久化的用户偏好。
 *
 * 触发来源：
 * - BrainDecisionRecorder 的 behavior_note 升级（severity=high → 永久化）
 * - Evolution Engine 从 user.feedback / restore-original / brain_modify_wrong 中提取偏好
 * - 用户手动编辑（未来 UI）
 *
 * 字段：
 * - key: 偏好 key（点号分隔，如 'response.style.concise'）
 * - value: JSON 值
 * - source: 'evolution_engine' | 'brain_decision' | 'user_explicit'
 * - confidence: 0-1（evolution 推导的可信度）
 * - expires_at: 90 天后自动清理（高频更新型偏好；常驻型设 NULL）
 */
function migrateCreateUserPreferencesTable(conn: Database.Database): void {
  if (tableExists(conn, 'user_preferences')) return;
  conn.exec(`
    CREATE TABLE user_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      pref_key TEXT NOT NULL,
      pref_value TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('evolution_engine', 'brain_decision', 'user_explicit', 'restore_original')),
      confidence REAL DEFAULT 1.0,
      expires_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      UNIQUE(user_id, pref_key)
    );
    CREATE INDEX idx_user_preferences_user_key
      ON user_preferences(user_id, pref_key);
    CREATE INDEX idx_user_preferences_expires
      ON user_preferences(expires_at) WHERE expires_at IS NOT NULL;
  `);
}

/**
 * 13.0 §12.6 + §3.7: 给 brain_decisions 加 task_id 列（让 decision 能按 task 聚合查询）。
 * 用于：
 *   - C.13 升级式纠偏：同 (agent, task) 的纠偏 severity 升级追踪
 *   - 用户点击 restore-original 时反查该 task 的所有 Brain 决策
 *   - Plan auto-mark-done 后回写所有相关 decision 的 task_id 关联
 */
function migrateBrainDecisionsAddTaskId(conn: Database.Database): void {
  if (columnExists(conn, 'brain_decisions', 'task_id')) return;
  conn.exec(`
    ALTER TABLE brain_decisions ADD COLUMN task_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_brain_decisions_task
      ON brain_decisions(task_id, created_at DESC) WHERE task_id IS NOT NULL;
  `);
}

function migrateCreateSystemInsightsTable(conn: Database.Database): void {
  if (tableExists(conn, 'system_insights')) return;
  conn.exec(`
    CREATE TABLE system_insights (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL
        CHECK(category IN ('routing','review','permission','evolution','performance')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'tentative'
        CHECK(status IN ('tentative','validated','expired')),
      source_decisions TEXT,
      adopted_count INTEGER NOT NULL DEFAULT 0,
      last_adopted_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      expired_at INTEGER
    );

    CREATE INDEX idx_system_insights_status_category
      ON system_insights(status, category);
    CREATE INDEX idx_system_insights_active
      ON system_insights(status) WHERE status != 'expired';
  `);
}

function migrateCreateWorldModelTable(conn: Database.Database): void {
  if (tableExists(conn, 'world_model')) return;
  conn.exec(`
    CREATE TABLE world_model (
      id TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS world_model_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      source TEXT NOT NULL,
      summary TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info'
        CHECK(severity IN ('info','warning','critical')),
      handled INTEGER NOT NULL DEFAULT 0,
      received_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX idx_world_model_events_unhandled
      ON world_model_events(handled, received_at) WHERE handled = 0;
  `);
}

function migrateCreateSelfModificationLog(conn: Database.Database): void {
  if (tableExists(conn, 'self_modification_log')) return;
  conn.exec(`
    CREATE TABLE self_modification_log (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('system','brain_self','user','learning_agent')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','superseded','rolled_back')),
      evidence_ids TEXT,
      expected_improvement TEXT,
      performance_score REAL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX idx_self_mod_target_active
      ON self_modification_log(target, status) WHERE status = 'active';
    CREATE INDEX idx_self_mod_target_version
      ON self_modification_log(target, version DESC);
  `);
}

function migrateBrainDecisionsAddColumns(conn: Database.Database): void {
  if (!tableExists(conn, 'brain_decisions')) return;
  const cols = getColumns(conn, 'brain_decisions');
  addColumnIfMissing(conn, cols, 'brain_decisions', 'lesson', 'TEXT');
  addColumnIfMissing(conn, cols, 'brain_decisions', 'resolved_at', 'INTEGER');
}

function migrateBrainDecisionsExpandTypes(conn: Database.Database): void {
  if (!tableExists(conn, 'brain_decisions')) return;
  const sql = tableSql(conn, 'brain_decisions');
  if (!sql || sql.includes('aggregated_insight')) return;
  conn.exec(`
    CREATE TABLE brain_decisions_new (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      decision_type TEXT NOT NULL
        CHECK(decision_type IN ('route','review','permission','correction','aggregated_insight','will_action','cron_review')),
      input_summary TEXT NOT NULL,
      output_json TEXT NOT NULL,
      confidence REAL,
      outcome TEXT CHECK(outcome IN ('good','bad','neutral')),
      feedback_source TEXT
        CHECK(feedback_source IS NULL OR feedback_source IN ('user_correction','metric_signal','evolution_engine')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      lesson TEXT,
      resolved_at INTEGER
    );
    INSERT INTO brain_decisions_new SELECT id, session_id, decision_type, input_summary, output_json, confidence, outcome, feedback_source, created_at, lesson, resolved_at FROM brain_decisions;
    DROP TABLE brain_decisions;
    ALTER TABLE brain_decisions_new RENAME TO brain_decisions;
    CREATE INDEX idx_brain_decisions_type_session ON brain_decisions(decision_type, session_id);
    CREATE INDEX idx_brain_decisions_outcome ON brain_decisions(outcome) WHERE outcome IS NOT NULL;
    CREATE INDEX idx_brain_decisions_created ON brain_decisions(created_at);
  `);
}

/**
 * R14-4 撤销：原 12.0 加的 migrateReviewRequestsExpandVerdicts 因生产代码中
 * 无任何调用方（recordAutoApprove 是死代码），撤回以保持 verdict 字段语义单一。
 * schema.ts 已把 verdict CHECK 约束恢复为原始 5 个枚举值。
 * 本函数保留空壳以兼容 migrate() 调用链（不再做任何操作）。
 */
function migrateReviewRequestsExpandVerdicts(conn: Database.Database): void {
  // R14-4：no-op（schema 已撤销扩展）。保留函数签名避免调用链破坏。
  // 旧库已存在 'auto_approve_*' 行的：下次落库遇到 CHECK 约束冲突会写入失败，
  // 但 recordAutoApprove 在生产代码无调用方，理论上不会有新行写入。
  void conn;
}
