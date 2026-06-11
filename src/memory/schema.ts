export const CORE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS modules_meta (
    name TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('kernel','agent','module','channel','plugin','testing')),
    status TEXT NOT NULL DEFAULT 'stopped'
      CHECK(status IN ('registered','starting','running','stopped','failed','disabled')),
    contract_version TEXT,
    depends_on TEXT NOT NULL DEFAULT '[]',
    last_started_at INTEGER,
    last_stopped_at INTEGER,
    last_error TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS agent_homes (
    agent_name TEXT PRIMARY KEY,
    level INTEGER NOT NULL CHECK(level IN (1,2,3)),
    home_dir TEXT NOT NULL,
    agent_yaml_path TEXT NOT NULL,
    agent_md_path TEXT NOT NULL,
    capabilities_path TEXT NOT NULL,
    state_db_path TEXT NOT NULL,
    runtime_dir TEXT NOT NULL,
    tasks_dir TEXT NOT NULL,
    cache_dir TEXT NOT NULL,
    logs_dir TEXT NOT NULL,
    config_hash TEXT,
    instruction_hash TEXT,
    capabilities_hash TEXT,
    status TEXT NOT NULL DEFAULT 'registered'
      CHECK(status IN ('registered','starting','running','stopped','failed','disabled')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
    content TEXT NOT NULL,
    -- 以下 4 列为历史遗留，从不写入。工具调用数据已迁移到 tool_calls 表。保留以兼容已有数据库。
    tool_name TEXT,
    tool_input TEXT,
    tool_result TEXT,
    token_count INTEGER,
    -- 客户端消息 ID（per-message 唯一），用作 user 消息精确幂等键
    client_msg_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  -- client_msg_id UNIQUE 索引由 addConversationsClientMsgIdColumn migration 创建（避免 legacy schema 与新列冲突）

  CREATE TABLE IF NOT EXISTS agent_tasks (
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
        'waiting_approval','completed','failed','timeout','cancelled','resumable'
      )),
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    dispatched_at INTEGER,
    acknowledged_at INTEGER,
    started_at INTEGER,
    finished_at INTEGER,
    backgrounded_at INTEGER,
    retrieved_at INTEGER,
    notified_at INTEGER,
    trace_id TEXT,
    requeue_count INTEGER NOT NULL DEFAULT 0,
    error_type TEXT,
    resume_count INTEGER NOT NULL DEFAULT 0,
    resumed_from TEXT,
    version INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS agent_task_workspaces (
    task_id TEXT PRIMARY KEY REFERENCES agent_tasks(id),
    agent_name TEXT NOT NULL REFERENCES agent_homes(agent_name),
    workspace_dir TEXT NOT NULL,
    task_json_path TEXT NOT NULL,
    context_json_path TEXT,
    plan_path TEXT,
    transcript_path TEXT,
    decisions_path TEXT,
    outputs_dir TEXT NOT NULL,
    artifacts_dir TEXT NOT NULL,
    tmp_dir TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created'
      CHECK(status IN ('created','ready','archived','cleaned','failed')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    archived_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES agent_tasks(id),
    run_id TEXT REFERENCES run_artifacts(id),
    session_id TEXT,
    correlation_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created'
      CHECK(status IN (
        'created','persisted','dispatched','acknowledged',
        'running','completed','failed','timeout','cancelled'
      )),
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    persisted_at INTEGER,
    dispatched_at INTEGER,
    acknowledged_at INTEGER,
    delivered_at INTEGER,
    processed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS task_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES agent_tasks(id),
    run_id TEXT REFERENCES run_artifacts(id),
    session_id TEXT,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    level TEXT CHECK(level IN ('error','warn','info','debug')),
    message TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS review_requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    level TEXT NOT NULL CHECK(level IN ('A','B','C')),
    draft_response TEXT NOT NULL,
    review_input TEXT NOT NULL,
    -- R14-4：12.0 加的 'auto_approve_A_level' / 'auto_approve_no_intent' 两个 verdict
    -- 在生产代码中无任何调用方（audit-recorder.recordAutoApprove 是死代码），
    -- 撤回以保持字段语义单一：verdict 字段只表达"审核结论"，不混"业务短路标记"。
    -- 真实 A 级 / no_intent_anchor 兜底如果需要审计，level='A' 字段已能区分。
    verdict TEXT NOT NULL CHECK(verdict IN (
      'pending','approve','modify','reject','require_user_confirm'
    )),
    final_response TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    reviewed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS model_requests (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES run_artifacts(id),
    session_id TEXT NOT NULL,
    task_id TEXT REFERENCES agent_tasks(id),
    correlation_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    purpose TEXT NOT NULL,
    model_tier TEXT NOT NULL DEFAULT 'default' CHECK(model_tier IN ('fast','default','high')),
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

  CREATE TABLE IF NOT EXISTS tool_calls (
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

  CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES run_artifacts(id),
    session_id TEXT NOT NULL,
    task_id TEXT REFERENCES agent_tasks(id),
    correlation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('tool','shell','file','plugin','code','brain','user')),
    requester TEXT NOT NULL,
    risk_level TEXT NOT NULL CHECK(risk_level IN ('low','medium','high')),
    request_payload TEXT NOT NULL,
    binding_payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','approved','denied','expired','cancelled')),
    decision_source TEXT CHECK(decision_source IN ('rule','brain','user','allowlist','blocklist')),
    reason TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    resolved_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS permission_tokens (
    id TEXT PRIMARY KEY,
    approval_id TEXT REFERENCES approval_requests(id),
    run_id TEXT REFERENCES run_artifacts(id),
    session_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    cwd TEXT,
    binding_hash TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK(verdict IN ('allow_once','allow_session')),
    one_time INTEGER NOT NULL DEFAULT 1,
    consumed INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    consumed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS code_task_artifacts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES agent_tasks(id),
    run_id TEXT REFERENCES run_artifacts(id),
    artifact_type TEXT NOT NULL CHECK(artifact_type IN (
      'patch_plan','file_change','test_run','diagnostic','summary'
    )),
    file_path TEXT,
    command TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

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

  CREATE TABLE IF NOT EXISTS run_artifacts (
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

  CREATE TABLE IF NOT EXISTS console_frames (
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

  CREATE TABLE IF NOT EXISTS log_events (
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

  CREATE TABLE IF NOT EXISTS sdk_event_index (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES run_artifacts(id),
    session_id TEXT,
    task_id TEXT REFERENCES agent_tasks(id),
    model_request_id TEXT REFERENCES model_requests(id),
    agent_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    subtype TEXT,
    raw_artifact_path TEXT NOT NULL,
    summary TEXT,
    token_count INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    workspace_dir TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK(status IN ('active','archived','disabled')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS workspace_capabilities (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    capability_type TEXT NOT NULL CHECK(capability_type IN ('skill','plugin','mcp','file')),
    capability_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config_path TEXT,
    config_hash TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    UNIQUE(workspace_id, capability_type, capability_id)
  );

  CREATE TABLE IF NOT EXISTS knowledge (
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

  CREATE TABLE IF NOT EXISTS memory_access_log (
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

  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS skills_meta (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    version TEXT NOT NULL DEFAULT '0.1.0',
    description TEXT NOT NULL,
    file_path TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'bundled'
      CHECK(origin IN ('bundled','generated','user')),
    created_by TEXT NOT NULL DEFAULT 'system'
      CHECK(created_by IN ('system','agent','user')),
    state TEXT NOT NULL DEFAULT 'active'
      CHECK(state IN ('active','stale','archived')),
    use_count INTEGER NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    patch_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    last_viewed_at INTEGER,
    last_patched_at INTEGER,
    disabled INTEGER NOT NULL DEFAULT 0,
    arguments_json TEXT,
    when_to_use TEXT,
    allowed_tools_json TEXT,
    model_invocable INTEGER NOT NULL DEFAULT 1,
    description_hidden INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS plugins_meta (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    version TEXT NOT NULL DEFAULT '0.1.0',
    description TEXT NOT NULL,
    plugin_dir TEXT NOT NULL,
    manifest_path TEXT NOT NULL,
    entry_path TEXT NOT NULL,
    api_version TEXT NOT NULL DEFAULT 'berry.plugin.v1',
    source TEXT NOT NULL DEFAULT 'generated'
      CHECK(source IN ('bundled','generated','user','installed')),
    status TEXT NOT NULL DEFAULT 'disabled'
      CHECK(status IN (
        'draft','validating','pending_review','pending_user_confirm',
        'enabled','disabled','failed','quarantined','rolled_back'
      )),
    risk_level TEXT NOT NULL DEFAULT 'medium'
      CHECK(risk_level IN ('low','medium','high')),
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    permissions_json TEXT NOT NULL DEFAULT '{}',
    manifest_hash TEXT,
    code_hash TEXT,
    review_id TEXT,
    use_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    quarantine_reason TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS plugin_tools (
    id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL REFERENCES plugins_meta(id),
    tool_name TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    input_schema TEXT NOT NULL,
    output_schema TEXT,
    permission_scope TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS plugin_events (
    id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL REFERENCES plugins_meta(id),
    session_id TEXT,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS evolution_proposals (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN (
      'skill_create','skill_patch','plugin_create','plugin_patch'
    )),
    source TEXT NOT NULL CHECK(source IN (
      'conversation','tool_failure','user_correction','reference_source','manual'
    )),
    target_name TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    draft_path TEXT,
    diff_json TEXT,
    validator_result TEXT,
    risk_level TEXT NOT NULL DEFAULT 'medium'
      CHECK(risk_level IN ('low','medium','high')),
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK(status IN (
        'draft','validating','pending_review','pending_user_confirm',
        'approved','applied','rejected','failed','quarantined','rolled_back'
      )),
    brain_review_id TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    cron TEXT NOT NULL,
    description TEXT NOT NULL,
    prompt TEXT,
    skill_name TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    script TEXT,
    workdir TEXT,
    delivery_channel TEXT,
    delivery_target TEXT
  );

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

  CREATE TABLE IF NOT EXISTS webhook_audit_log (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    request_id TEXT,
    source_ip TEXT,
    payload_hash TEXT,
    signature_valid INTEGER,
    received_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_name TEXT,
    task_id TEXT,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    model TEXT NOT NULL,
    cost_usd REAL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

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

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

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

  CREATE TABLE IF NOT EXISTS notification_preferences (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    preferences_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    UNIQUE(workspace_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS task_subscribers (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    subscriber_type TEXT NOT NULL CHECK(subscriber_type IN ('user','agent')),
    subscriber_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN ('creator','assignee','commenter','mentioned','manual')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    UNIQUE(task_id, subscriber_type, subscriber_id)
  );

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

  CREATE TABLE IF NOT EXISTS workspace_context_history (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    change_summary TEXT,
    changed_by TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

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
`;

export const CORE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_tasks_run ON agent_tasks(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_tasks_corr ON agent_tasks(correlation_id);
  CREATE INDEX IF NOT EXISTS idx_agent_task_workspaces_agent ON agent_task_workspaces(agent_name, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_msg_to_status ON agent_messages(to_agent, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_msg_corr ON agent_messages(correlation_id);
  CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_task_events_run ON task_events(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_review_session ON review_requests(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_model_req_status ON model_requests(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_model_req_session ON model_requests(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_model_req_task ON model_requests(task_id, step_index);
  CREATE INDEX IF NOT EXISTS idx_tool_session ON tool_calls(session_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_approval_pending ON approval_requests(status, expires_at);
  CREATE INDEX IF NOT EXISTS idx_approval_run ON approval_requests(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_permission_token_binding ON permission_tokens(binding_hash, consumed, expires_at);
  CREATE INDEX IF NOT EXISTS idx_code_artifacts_task ON code_task_artifacts(task_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_run_artifacts_session ON run_artifacts(session_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_console_frames_run ON console_frames(run_id, seq);
  CREATE INDEX IF NOT EXISTS idx_log_events_level ON log_events(level, created_at);
  CREATE INDEX IF NOT EXISTS idx_log_events_run ON log_events(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sdk_event_run ON sdk_event_index(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sdk_event_request ON sdk_event_index(model_request_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_workspace_capabilities ON workspace_capabilities(workspace_id, capability_type, enabled);
  CREATE INDEX IF NOT EXISTS idx_know_owner_type ON knowledge(owner_key, type, dismissed);
  CREATE INDEX IF NOT EXISTS idx_know_owner_scope ON knowledge(owner_key, scope, updated_at);
  CREATE INDEX IF NOT EXISTS idx_know_owner_used ON knowledge(owner_key, last_used_at);
  CREATE INDEX IF NOT EXISTS idx_memory_access_session ON memory_access_log(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_memory_access_run ON memory_access_log(run_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ep_session ON episodes(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ep_type ON episodes(event_type, created_at);
  CREATE INDEX IF NOT EXISTS idx_plugin_tools_plugin ON plugin_tools(plugin_id);
  CREATE INDEX IF NOT EXISTS idx_plugin_events_plugin ON plugin_events(plugin_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_evolution_status ON evolution_proposals(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_token_session ON token_usage(session_id);
  CREATE INDEX IF NOT EXISTS idx_token_date ON token_usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_agents_meta_status ON agents_meta(status);
  CREATE INDEX IF NOT EXISTS idx_agents_meta_source ON agents_meta(source, status);
  CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_name ON agent_lifecycle_events(agent_name, created_at);
  CREATE INDEX IF NOT EXISTS idx_cron_jobs_workspace ON cron_jobs(workspace_id, enabled);
  CREATE INDEX IF NOT EXISTS idx_cron_jobs_next ON cron_jobs(enabled, next_trigger_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_jobs_webhook_token ON cron_jobs(webhook_token);
  CREATE INDEX IF NOT EXISTS idx_cron_executions_job ON cron_executions(job_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_cron_executions_status ON cron_executions(status, started_at);
  CREATE INDEX IF NOT EXISTS idx_job_queue_pending ON job_queue(status, priority, created_at);
  CREATE INDEX IF NOT EXISTS idx_job_queue_agent ON job_queue(agent_id, status);
  CREATE INDEX IF NOT EXISTS idx_job_queue_source ON job_queue(source_id);
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON agent_reminders(enabled, trigger_at);
  CREATE INDEX IF NOT EXISTS idx_reminders_agent ON agent_reminders(agent_id);
  CREATE INDEX IF NOT EXISTS idx_webhook_audit_job ON webhook_audit_log(job_id, received_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_target ON notifications(target_type, target_id, read, created_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_workspace ON notifications(workspace_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_task_subscribers_task ON task_subscribers(task_id);
  CREATE INDEX IF NOT EXISTS idx_agent_memories_agent ON agent_memories_v2(agent_id, archived, type);
  CREATE INDEX IF NOT EXISTS idx_workspace_memories_ws ON workspace_memories(workspace_id, archived, visibility);
  CREATE INDEX IF NOT EXISTS idx_global_memories_user ON global_memories(user_id, archived);
  CREATE INDEX IF NOT EXISTS idx_memory_bindings_agent ON agent_memory_bindings_v2(agent_id, enabled);
  CREATE INDEX IF NOT EXISTS idx_ws_context_history ON workspace_context_history(workspace_id, version);
  CREATE INDEX IF NOT EXISTS idx_delegations_session ON async_delegations(source_session_id, status);
  CREATE INDEX IF NOT EXISTS idx_delegations_target ON async_delegations(target_workspace_id, status);
  CREATE INDEX IF NOT EXISTS idx_templates_owner ON team_templates(owner_id);
  CREATE INDEX IF NOT EXISTS idx_templates_category ON team_templates(category, is_public);

  CREATE TABLE IF NOT EXISTS conversation_meta (
    session_id TEXT PRIMARY KEY,
    title TEXT,
    pinned INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_conversation_meta_pinned ON conversation_meta(pinned, updated_at DESC);

  -- 11.0 智能体间对话消息镜像（DialogueRouter 持久化层）
  CREATE TABLE IF NOT EXISTS dialogue_messages (
    id TEXT PRIMARY KEY,
    dialogue_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    sequence_number INTEGER NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    content TEXT NOT NULL,
    context_json TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(dialogue_id, sequence_number)
  );
  CREATE INDEX IF NOT EXISTS idx_dialogue_session ON dialogue_messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_dialogue_correlation ON dialogue_messages(correlation_id);

  -- 12.0 意图锚点（Brain 路由时产出，漂移检测基准）
  CREATE TABLE IF NOT EXISTS intent_anchors (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    raw_message TEXT NOT NULL,
    goal TEXT NOT NULL,
    constraints_json TEXT,
    output_type TEXT NOT NULL,
    entities_json TEXT,
    route_reason TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_anchor_session ON intent_anchors(session_id);

  -- 12.0 漂移检测信号记录
  CREATE TABLE IF NOT EXISTS drift_signals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    checkpoint_type TEXT NOT NULL,
    alignment_score REAL NOT NULL,
    needs_intervention INTEGER NOT NULL DEFAULT 0,
    drift_description TEXT,
    suggested_action TEXT,
    actual_action TEXT,
    intent_anchor_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_drift_session ON drift_signals(session_id);
  CREATE INDEX IF NOT EXISTS idx_drift_time ON drift_signals(created_at);

  -- 13.0 灵魂版：Brain 观察队列（持久化所有 Agent 间通信 + 工具调用 + 用户交互）
  -- Brain 三段式工作模型：OBSERVE 阶段零 LLM 写入此表，INTERVENE/REVIEW 按需读取
  -- 设计：2D 隔离 (session_id, task_id)、优先级 (0=critical 1=normal 2=verbose)、滚动窗口 500 条
  CREATE TABLE IF NOT EXISTS brain_observations (
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
  CREATE INDEX IF NOT EXISTS idx_brain_obs_session ON brain_observations(session_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_brain_obs_type ON brain_observations(observation_type, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_brain_obs_priority ON brain_observations(priority, created_at DESC);

  -- 13.0 Agent 间对话审计表：记录所有 Agent 间 request/response 对话内容
  -- 前端 agent-chat 面板从此表读取数据，支持实时查看 Agent 协作过程
  CREATE TABLE IF NOT EXISTS agent_chat_messages (
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
  CREATE INDEX IF NOT EXISTS idx_agent_chat_session ON agent_chat_messages(session_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_chat_task ON agent_chat_messages(task_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_chat_agents ON agent_chat_messages(from_agent, to_agent, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_chat_correlation ON agent_chat_messages(correlation_id);

  -- 13.0 Agent 工具调用审计表：记录每个 Agent 的工具调用详情
  -- Brain 审核时从此表读取工具调用上下文（与 tool_calls 表互补，按 agent 维度索引）
  CREATE TABLE IF NOT EXISTS agent_tool_calls (
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
  CREATE INDEX IF NOT EXISTS idx_agent_tool_session ON agent_tool_calls(session_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_tool_task ON agent_tool_calls(task_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_tool_agent ON agent_tool_calls(agent_name, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_tool_name ON agent_tool_calls(tool_name, success, created_at DESC);

  -- 13.0 灵魂版：Brain 决策历史表（路由/审核/权限/纠偏/聚合洞察/意愿行动）
  -- 与 migrations.ts 中的 migrateCreateBrainDecisionsTable 保持同步（IF NOT EXISTS 幂等）
  CREATE TABLE IF NOT EXISTS brain_decisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    decision_type TEXT NOT NULL
      CHECK(decision_type IN ('route','review','permission','correction','aggregated_insight','will_action')),
    input_summary TEXT NOT NULL,
    output_json TEXT NOT NULL,
    confidence REAL,
    outcome TEXT CHECK(outcome IN ('good','bad','neutral')),
    feedback_source TEXT
      CHECK(feedback_source IS NULL OR feedback_source IN ('user_correction','metric_signal','evolution_engine')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    lesson TEXT,
    resolved_at INTEGER,
    task_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_brain_decisions_type_session
    ON brain_decisions(decision_type, session_id);
  CREATE INDEX IF NOT EXISTS idx_brain_decisions_outcome
    ON brain_decisions(outcome) WHERE outcome IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_brain_decisions_created
    ON brain_decisions(created_at);
  CREATE INDEX IF NOT EXISTS idx_brain_decisions_task
    ON brain_decisions(task_id) WHERE task_id IS NOT NULL;

  -- 13.0 §5.3.8 + §8.8: 用户偏好持久化表（跨 session 行为偏好 + 90 天自动过期）
  -- 与 migrations.ts 中的 migrateCreateUserPreferencesTable 保持同步（IF NOT EXISTS 幂等）
  CREATE TABLE IF NOT EXISTS user_preferences (
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
  CREATE INDEX IF NOT EXISTS idx_user_preferences_user_key
    ON user_preferences(user_id, pref_key);
  CREATE INDEX IF NOT EXISTS idx_user_preferences_expires
    ON user_preferences(expires_at) WHERE expires_at IS NOT NULL;
`;

// 13.0 §13.20: brain_corrections 表 — 追踪 Brain 纠偏频次
export const BRAIN_CORRECTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS brain_corrections (
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
  CREATE INDEX IF NOT EXISTS idx_brain_corrections_agent_time
    ON brain_corrections(agent_name, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_brain_corrections_severity_time
    ON brain_corrections(severity, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_brain_corrections_session
    ON brain_corrections(session_id, created_at DESC);
`;

export const KNOWLEDGE_FTS_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    summary, detail, content=knowledge, content_rowid=rowid, tokenize='trigram'
  );

  CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
    INSERT INTO knowledge_fts(rowid, summary, detail) VALUES (new.rowid, new.summary, new.detail);
  END;

  CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, summary, detail) VALUES ('delete', old.rowid, old.summary, old.detail);
  END;

  CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge
    WHEN old.summary IS NOT new.summary OR old.detail IS NOT new.detail BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, summary, detail) VALUES ('delete', old.rowid, COALESCE(old.summary, ''), COALESCE(old.detail, ''));
    INSERT INTO knowledge_fts(rowid, summary, detail) VALUES (new.rowid, COALESCE(new.summary, ''), COALESCE(new.detail, ''));
  END;
`;
