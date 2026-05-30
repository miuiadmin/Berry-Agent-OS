CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`org_node_id` text,
	`superior_id` text,
	`user_id` text NOT NULL,
	`agent_type` text DEFAULT 'team' NOT NULL,
	`name` text NOT NULL,
	`avatar` text,
	`role_description` text,
	`provider` text NOT NULL,
	`config` text NOT NULL,
	`thinking_level` text,
	`custom_env` text,
	`custom_args` text,
	`l2_capabilities` text DEFAULT '["learning","skills"]' NOT NULL,
	`roles` text,
	`workspace_path` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_active_at` integer,
	`prior_session_id` text,
	`prior_work_dir` text,
	`archived_at` integer,
	`archived_by` text,
	`trust_level` text DEFAULT 'probation' NOT NULL,
	`consecutive_approvals` integer DEFAULT 0 NOT NULL,
	`total_rejections` integer DEFAULT 0 NOT NULL,
	`total_executions` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`success_rate` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_node_id`) REFERENCES `org_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`comment_id` text,
	`file_name` text NOT NULL,
	`storage_path` text NOT NULL,
	`mime_type` text,
	`size` integer,
	`uploaded_by_type` text NOT NULL,
	`uploaded_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`comment_id`) REFERENCES `task_comments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`parent_id` text,
	`author_type` text NOT NULL,
	`author_id` text NOT NULL,
	`comment_type` text DEFAULT 'comment' NOT NULL,
	`content` text NOT NULL,
	`metadata` text,
	`resolved_at` integer,
	`resolved_by_type` text,
	`resolved_by_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`agent_id` text NOT NULL,
	`task_id` text,
	`job_id` text,
	`trace_id` text,
	`trigger_type` text NOT NULL,
	`status` text NOT NULL,
	`phase` text DEFAULT 'pending' NOT NULL,
	`input_prompt` text,
	`output` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_tokens` integer,
	`total_cost` real,
	`tool_calls` integer DEFAULT 0,
	`error_type` text,
	`progress_data` text,
	`checkpoint` text,
	`review_status` text DEFAULT 'pending' NOT NULL,
	`reviewed_by` text,
	`review_note` text,
	`review_guidance` text,
	`review_action_data` text,
	`review_retry_count` integer DEFAULT 0 NOT NULL,
	`review_escalated_to` text,
	`redo_count` integer DEFAULT 0 NOT NULL,
	`previous_execution_id` text,
	`duration_ms` integer,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`error` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`agent_id` text NOT NULL,
	`title` text,
	`session_type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`compressed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `session_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`avatar` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_workspace_id_user_id_unique` ON `workspace_members` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`issue_prefix` text,
	`issue_counter` integer DEFAULT 0 NOT NULL,
	`context` text,
	`review_mode` text DEFAULT 'trust_based' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);--> statement-breakpoint
CREATE TABLE `org_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`description` text,
	`type` text NOT NULL,
	`path` text NOT NULL,
	`depth` integer DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`org_node_id` text,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`default_columns` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_node_id`) REFERENCES `org_nodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`color` text,
	`wip_limit` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_columns_project_id_position_unique` ON `task_columns` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`view_type` text DEFAULT 'board' NOT NULL,
	`filters` text NOT NULL,
	`sort_by` text,
	`group_by` text,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`id` text PRIMARY KEY NOT NULL,
	`blocking_task_id` text NOT NULL,
	`blocked_task_id` text NOT NULL,
	`dependency_type` text DEFAULT 'finish_to_start' NOT NULL,
	`created_by_type` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`blocking_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blocked_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_dependencies_blocking_task_id_blocked_task_id_unique` ON `task_dependencies` (`blocking_task_id`,`blocked_task_id`);--> statement-breakpoint
CREATE TABLE `task_label_links` (
	`task_id` text NOT NULL,
	`label_id` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`label_id`) REFERENCES `task_labels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_label_links_task_id_label_id_unique` ON `task_label_links` (`task_id`,`label_id`);--> statement-breakpoint
CREATE TABLE `task_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_labels_workspace_id_name_unique` ON `task_labels` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `task_reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`emoji` text NOT NULL,
	`reactor_type` text NOT NULL,
	`reactor_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_reactions_target_type_target_id_emoji_reactor_type_reactor_id_unique` ON `task_reactions` (`target_type`,`target_id`,`emoji`,`reactor_type`,`reactor_id`);--> statement-breakpoint
CREATE TABLE `task_subscribers` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`subscriber_type` text NOT NULL,
	`subscriber_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_subscribers_task_id_subscriber_type_subscriber_id_unique` ON `task_subscribers` (`task_id`,`subscriber_type`,`subscriber_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`column_id` text NOT NULL,
	`parent_task_id` text,
	`number` integer NOT NULL,
	`identifier` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`assignee_type` text,
	`assignee_id` text,
	`creator_type` text NOT NULL,
	`creator_id` text NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`estimated_hours` real,
	`actual_hours` real,
	`acceptance_criteria` text,
	`metadata` text,
	`start_date` integer,
	`due_date` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`column_id`) REFERENCES `task_columns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_workspace_id_number_unique` ON `tasks` (`workspace_id`,`number`);--> statement-breakpoint
CREATE TABLE `agent_reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text,
	`prompt` text NOT NULL,
	`trigger_at` integer NOT NULL,
	`recurring_cron` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_fired_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `cron_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`round_id` text,
	`status` text NOT NULL,
	`total_agents` integer,
	`completed_count` integer DEFAULT 0,
	`failed_count` integer DEFAULT 0,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`summary` text,
	FOREIGN KEY (`job_id`) REFERENCES `cron_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `cron_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`cron_expression` text,
	`interval_minutes` integer,
	`schedule_type` text NOT NULL,
	`webhook_secret` text,
	`webhook_token` text,
	`event_filter` text,
	`concurrency_policy` text DEFAULT 'queue' NOT NULL,
	`execution_mode` text DEFAULT 'run_only' NOT NULL,
	`admission_gate` integer DEFAULT 1 NOT NULL,
	`prompt` text NOT NULL,
	`chain_config` text,
	`fan_out_config` text,
	`session_mode` text DEFAULT 'new' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`max_retries` integer DEFAULT 3 NOT NULL,
	`retry_delay_ms` integer DEFAULT 5000 NOT NULL,
	`last_triggered_at` integer,
	`next_trigger_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `job_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`job_type` text NOT NULL,
	`source_id` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`error` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`max_retries` integer DEFAULT 3 NOT NULL,
	`timeout_ms` integer DEFAULT 300000 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`workspace_id` text,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`source` text,
	`importance` real DEFAULT 0.5 NOT NULL,
	`access_count` integer DEFAULT 0 NOT NULL,
	`published_plugin_id` text,
	`last_accessed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_memory_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`memory_id` text NOT NULL,
	`source` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`assigned_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`memory_id`) REFERENCES `workspace_memories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_memory_bindings_agent_id_memory_id_unique` ON `agent_memory_bindings` (`agent_id`,`memory_id`);--> statement-breakpoint
CREATE TABLE `global_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`origin` text DEFAULT 'evolved' NOT NULL,
	`source_workspace_id` text,
	`source_memory_id` text,
	`importance` real DEFAULT 0.6 NOT NULL,
	`tags` text,
	`recall_count` integer DEFAULT 0 NOT NULL,
	`verified_at` integer,
	`archived` integer DEFAULT 0 NOT NULL,
	`last_recalled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workspace_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`owner_agent_id` text,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`origin` text DEFAULT 'evolved' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`importance` real DEFAULT 0.5 NOT NULL,
	`tags` text,
	`recall_count` integer DEFAULT 0 NOT NULL,
	`verified_at` integer,
	`source_execution_id` text,
	`archived` integer DEFAULT 0 NOT NULL,
	`last_recalled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_plugin_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`source` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`config_json` text,
	`assigned_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_plugin_bindings_agent_id_plugin_id_unique` ON `agent_plugin_bindings` (`agent_id`,`plugin_id`);--> statement-breakpoint
CREATE TABLE `plugin_hooks` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`event` text NOT NULL,
	`handler_path` text NOT NULL,
	`priority` integer DEFAULT 50 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_hooks_plugin_id_event_unique` ON `plugin_hooks` (`plugin_id`,`event`);--> statement-breakpoint
CREATE TABLE `plugin_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`input_schema` text NOT NULL,
	`output_schema` text,
	`permission_scope` text DEFAULT 'readonly' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_tools_plugin_id_tool_name_unique` ON `plugin_tools` (`plugin_id`,`tool_name`);--> statement-breakpoint
CREATE TABLE `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`description` text,
	`scope` text DEFAULT 'private' NOT NULL,
	`owner_agent_id` text,
	`workspace_id` text,
	`user_id` text NOT NULL,
	`source` text DEFAULT 'evolved' NOT NULL,
	`risk_level` text DEFAULT 'low' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`has_prompt` integer DEFAULT 0 NOT NULL,
	`has_tools` integer DEFAULT 0 NOT NULL,
	`has_code` integer DEFAULT 0 NOT NULL,
	`has_hooks` integer DEFAULT 0 NOT NULL,
	`has_service` integer DEFAULT 0 NOT NULL,
	`prompt_content` text,
	`prompt_priority` real DEFAULT 0.5,
	`prompt_activation_rules` text,
	`manifest_json` text,
	`permissions_json` text,
	`evolution_json` text,
	`importance` real DEFAULT 0.6 NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`previous_versions` text,
	`promoted_from_id` text,
	`promoted_at` integer,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`preferences` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_preferences_workspace_id_user_id_unique` ON `notification_preferences` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link` text,
	`read` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`job_id` text NOT NULL,
	`trigger_event` text,
	`dedupe_key` text,
	`signature_status` text,
	`status` text NOT NULL,
	`request_headers` text,
	`request_body` text,
	`response_status` integer,
	`error` text,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `cron_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_job_id_dedupe_key_unique` ON `webhook_deliveries` (`job_id`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `usage_hourly` (
	`id` text PRIMARY KEY NOT NULL,
	`bucket_hour` integer NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_tokens` integer DEFAULT 0 NOT NULL,
	`task_count` integer DEFAULT 0 NOT NULL,
	`total_cost` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_hourly_bucket_hour_workspace_id_agent_id_model_unique` ON `usage_hourly` (`bucket_hour`,`workspace_id`,`agent_id`,`model`);--> statement-breakpoint
CREATE TABLE `team_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`category` text,
	`org_structure` text NOT NULL,
	`agent_configs` text NOT NULL,
	`is_public` integer DEFAULT 0 NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
