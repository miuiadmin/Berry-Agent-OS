# API 参考

> 本文件由 `tools/generate-api-reference.mjs` 从 `src/contracts/api-surface.json` 生成（`npm run build` 尾挂再生，check-api 查 8 drift 守护）——勿手编。
> 稳定性分级与兼容承诺的语义权威 = 设计文档「应用契约与扩展点」API 治理章（§6.13）；本文件只派生符号面。

当前 apiVersion：`1.0`。导出 367 项、能力 14 项。

## 目录

- [`berryagent`](#berryagent)
- [`berryagent/llm`](#berryagentllm)
- [`berryagent/sqlite`](#berryagentsqlite)
- [`data-keys`](#data-keys)
- [`live-events`](#live-events)
- [`manifest`](#manifest)
- [`services`](#services)
- [`session-events`](#session-events)
- [`typebox`](#typebox)
- [`typebox/compile`](#typeboxcompile)
- [`typebox/value`](#typeboxvalue)
- [能力面（capabilities）](#能力面capabilities)

## `berryagent`

- `ACCENT_COLOR_NAMES` — stable（minor 只增不破），since 1.0，全形态
- `AGENT_CONTINUE_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `AGENT_DELIVER_AS_UNSUPPORTED` — stable（minor 只增不破），since 1.0，全形态
- `AGENT_ROLE_EXISTS` — stable（minor 只增不破），since 1.0，全形态
- `AGENT_ROLE_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `AGENT_SESSION_INACTIVE` — stable（minor 只增不破），since 1.0，全形态
- `AGENT_SESSION_KEY_REQUIRED` — stable（minor 只增不破），since 1.0，全形态
- `AgentMessage` — stable（minor 只增不破），since 1.0，全形态
- `AgentTool` — stable（minor 只增不破），since 1.0，全形态
- `AgentToolResult` — stable（minor 只增不破），since 1.0，全形态
- `API_CAPABILITY_MISSING` — stable（minor 只增不破），since 1.0，全形态
- `API_EXPERIMENTAL_UNDECLARED` — stable（minor 只增不破），since 1.0，全形态
- `API_VERSION_MALFORMED` — stable（minor 只增不破），since 1.0，全形态
- `API_VERSION_MISMATCH` — stable（minor 只增不破），since 1.0，全形态
- `ApiBlock` — stable（minor 只增不破），since 1.0，全形态
- `ApiGateResult` — stable（minor 只增不破），since 1.0，全形态
- `ApiTier` — stable（minor 只增不破），since 1.0，全形态
- `APP_APPLY_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `APP_APPLY_TIMEOUT` — stable（minor 只增不破），since 1.0，全形态
- `APP_CONFIG_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `APP_DUPLICATE` — stable（minor 只增不破），since 1.0，全形态
- `APP_ENTRY_UNRESOLVED` — stable（minor 只增不破），since 1.0，全形态
- `APP_EVENT_RATE` — stable（minor 只增不破），since 1.0，全形态
- `APP_IMPORT_FORBIDDEN` — stable（minor 只增不破），since 1.0，全形态
- `APP_INJECT_UNRESOLVED` — stable（minor 只增不破），since 1.0，全形态
- `APP_INSTALL_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `APP_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `APP_LOAD_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `APP_MAIN_DB_FORBIDDEN` — stable（minor 只增不破），since 1.0，全形态
- `APP_NOT_FOUND` — stable（minor 只增不破），since 1.0，全形态
- `APP_SHAPE_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `APP_SHUTDOWN_QUIESCE_VIOLATED` — stable（minor 只增不破），since 1.0，全形态
- `AppActivatedPayload` — stable（minor 只增不破），since 1.0，全形态
- `AppApply` — stable（minor 只增不破），since 1.0，全形态
- `AppContext` — stable（minor 只增不破），since 1.0，全形态
- `AppError` — stable（minor 只增不破），since 1.0，全形态
- `AppEventHandler` — stable（minor 只增不破），since 1.0，全形态
- `AppFailedPayload` — stable（minor 只增不破），since 1.0，全形态
- `AppIdPattern` — stable（minor 只增不破），since 1.0，全形态
- `AppLoadResult` — stable（minor 只增不破），since 1.0，全形态
- `AppLogger` — stable（minor 只增不破），since 1.0，全形态
- `AppManifest` — stable（minor 只增不破），since 1.0，全形态
- `AppManifestSchema` — stable（minor 只增不破），since 1.0，全形态
- `AppModule` — stable（minor 只增不破），since 1.0，全形态
- `AppPlanRow` — stable（minor 只增不破），since 1.0，全形态
- `AppSkippedPayload` — stable（minor 只增不破），since 1.0，全形态
- `AppSkipReason` — stable（minor 只增不破），since 1.0，全形态
- `AssistantMessage` — stable（minor 只增不破），since 1.0，全形态
- `AssistantStream` — stable（minor 只增不破），since 1.0，全形态
- `AssistantStreamEvent` — stable（minor 只增不破），since 1.0，全形态
- `BRIDGE_CALL_TIMEOUT` — stable（minor 只增不破），since 1.0，全形态
- `BRIDGE_CANCELLED` — stable（minor 只增不破），since 1.0，全形态
- `BRIDGE_ENCODE_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `BRIDGE_HANDLER_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `BRIDGE_METHOD_NOT_FOUND` — stable（minor 只增不破），since 1.0，全形态
- `BRIDGE_SURFACE_NARROWED` — stable（minor 只增不破），since 1.0，全形态
- `BRIDGE_WORKER_EXITED` — stable（minor 只增不破），since 1.0，全形态
- `BROWSER_CONFIG_CONFLICT` — stable（minor 只增不破），since 1.0，全形态
- `BROWSER_CONNECT_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `BROWSER_ENGINE_NOT_FOUND` — stable（minor 只增不破），since 1.0，全形态
- `BROWSER_INSTALL_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `BROWSER_NODE_UNSUPPORTED` — stable（minor 只增不破），since 1.0，全形态
- `BuiltinAppModule` — stable（minor 只增不破），since 1.0，全形态
- `CAPABILITIES` — stable（minor 只增不破），since 1.0，全形态
- `CapabilityEntry` — stable（minor 只增不破），since 1.0，全形态
- `CHECKPOINT_BLOB_CORRUPT` — stable（minor 只增不破），since 1.0，全形态
- `CommandCompletionItem` — stable（minor 只增不破），since 1.0，全形态
- `CommandDefinition` — stable（minor 只增不破），since 1.0，全形态
- `compareApiVersions` — stable（minor 只增不破），since 1.0，全形态
- `COMPOSITION_ROW_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `CompositionReloadedPayload` — stable（minor 只增不破），since 1.0，全形态
- `CompositionRow` — stable（minor 只增不破），since 1.0，全形态
- `CONTEXT_DISPOSED` — stable（minor 只增不破），since 1.0，全形态
- `CONTEXT_EFFECT_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `CONTEXT_EFFECT_LIMIT` — stable（minor 只增不破），since 1.0，全形态
- `CONTEXT_FORK_LIMIT` — stable（minor 只增不破），since 1.0，全形态
- `CONTEXT_SERVICE_EXISTS` — stable（minor 只增不破），since 1.0，全形态
- `CONTEXT_SERVICE_NAME_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `CONTEXT_SERVICE_NOT_FOUND` — stable（minor 只增不破），since 1.0，全形态
- `CONTRACT_BAD_ERROR_CODE` — stable（minor 只增不破），since 1.0，全形态
- `CONTRACT_DUPLICATE_ERROR_CODE` — stable（minor 只增不破），since 1.0，全形态
- `CORE_EVENT_TYPES` — stable（minor 只增不破），since 1.0，全形态
- `CustomMessage` — stable（minor 只增不破），since 1.0，全形态
- `DAEMON_ALREADY_RUNNING` — stable（minor 只增不破），since 1.0，全形态
- `DAEMON_START_TIMEOUT` — stable（minor 只增不破），since 1.0，全形态
- `DAEMON_STOP_TIMEOUT` — stable（minor 只增不破），since 1.0，全形态
- `DATA_DESCRIPTOR_API_KEYS` — stable（minor 只增不破），since 1.0，全形态
- `describeError` — stable（minor 只增不破），since 1.0，全形态
- `DescriptorKeyEntry` — stable（minor 只增不破），since 1.0，全形态
- `EVENT_DUPLICATE` — stable（minor 只增不破），since 1.0，全形态
- `EVENT_HANDLER_TIMEOUT` — stable（minor 只增不破），since 1.0，全形态
- `EVENT_HOST_RESERVED` — stable（minor 只增不破），since 1.0，全形态
- `EVENT_MODE_MISMATCH` — stable（minor 只增不破），since 1.0，全形态
- `EVENT_UNKNOWN` — stable（minor 只增不破），since 1.0，全形态
- `EventName` — stable（minor 只增不破），since 1.0，全形态
- `EventQueryCursor` — stable（minor 只增不破），since 1.0，全形态
- `EventQueryOptions` — stable（minor 只增不破），since 1.0，全形态
- `EventQueryResult` — stable（minor 只增不破），since 1.0，全形态
- `EventQueryRow` — stable（minor 只增不破），since 1.0，全形态
- `exclusiveAppOf` — stable（minor 只增不破），since 1.0，全形态
- `EXEC_ENV_FORBIDDEN` — stable（minor 只增不破），since 1.0，全形态
- `EXEC_SPAWN_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `ExecEnvTable` — stable（minor 只增不破），since 1.0，全形态
- `ExecOptions` — stable（minor 只增不破），since 1.0，全形态
- `ExecResult` — stable（minor 只增不破），since 1.0，全形态
- `ExecService` — stable（minor 只增不破），since 1.0，全形态
- `ExecuteInput` — stable（minor 只增不破），since 1.0，全形态
- `findLiveEvent` — stable（minor 只增不破），since 1.0，全形态
- `FormFactor` — stable（minor 只增不破），since 1.0，全形态
- `FS_DECODE_NON_UTF8` — stable（minor 只增不破），since 1.0，全形态
- `FS_DECODE_UNDECIDABLE` — stable（minor 只增不破），since 1.0，全形态
- `FS_NOT_FOUND` — stable（minor 只增不破），since 1.0，全形态
- `FS_NOT_OBSERVED` — stable（minor 只增不破），since 1.0，全形态
- `FS_OUTSIDE_WRITABLE_ROOTS` — stable（minor 只增不破），since 1.0，全形态
- `FS_PATCH_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `FS_VERSION_CONFLICT` — stable（minor 只增不破），since 1.0，全形态
- `FS_WRITE_TARGET_DRIFTED` — stable（minor 只增不破），since 1.0，全形态
- `GateAction` — stable（minor 只增不破），since 1.0，全形态
- `GateDecisionPayload` — stable（minor 只增不破），since 1.0，全形态
- `GateDecisionSink` — stable（minor 只增不破），since 1.0，全形态
- `GateInput` — stable（minor 只增不破），since 1.0，全形态
- `getMessageRoleDefinition` — stable（minor 只增不破），since 1.0，全形态
- `getSessionEventType` — stable（minor 只增不破），since 1.0，全形态
- `GOAL_ACTIVE_EXISTS` — stable（minor 只增不破），since 1.0，全形态
- `GOAL_GATE_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `GOAL_NOT_FOUND` — stable（minor 只增不破），since 1.0，全形态
- `GOAL_TODO_SCOPE` — stable（minor 只增不破），since 1.0，全形态
- `GOAL_TRANSITION_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `HostFace` — stable（minor 只增不破），since 1.0，全形态
- `HostFaceData` — stable（minor 只增不破），since 1.0，全形态
- `ImageContent` — stable（minor 只增不破），since 1.0，全形态
- `isCoreSessionEventType` — stable（minor 只增不破），since 1.0，全形态
- `isStandardMessage` — stable（minor 只增不破），since 1.0，全形态
- `isStandardRole` — stable（minor 只增不破），since 1.0，全形态
- `isValidApiVersion` — stable（minor 只增不破），since 1.0，全形态
- `JOB_CONCURRENCY_LIMIT` — stable（minor 只增不破），since 1.0，全形态
- `JOB_KIND_DUPLICATE` — stable（minor 只增不破），since 1.0，全形态
- `JOB_KIND_UNKNOWN` — stable（minor 只增不破），since 1.0，全形态
- `JOB_NOT_FOUND` — stable（minor 只增不破），since 1.0，全形态
- `JOB_OWNER_MISMATCH` — stable（minor 只增不破），since 1.0，全形态
- `JobController` — stable（minor 只增不破），since 1.0，全形态
- `JobCreateOptions` — stable（minor 只增不破），since 1.0，全形态
- `JobHandle` — stable（minor 只增不破），since 1.0，全形态
- `JobSettleDetail` — stable（minor 只增不破），since 1.0，全形态
- `JobsServiceFace` — stable（minor 只增不破），since 1.0，全形态
- `JobStatus` — stable（minor 只增不破），since 1.0，全形态
- `JobTerminal` — stable（minor 只增不破），since 1.0，全形态
- `JobView` — stable（minor 只增不破），since 1.0，全形态
- `listErrorCodes` — stable（minor 只增不破），since 1.0，全形态
- `listMessageRoles` — stable（minor 只增不破），since 1.0，全形态
- `listSessionEventTypes` — stable（minor 只增不破），since 1.0，全形态
- `LIVE_EVENT_CATALOG` — stable（minor 只增不破），since 1.0，全形态
- `LiveEventDefinition` — stable（minor 只增不破），since 1.0，全形态
- `LLM_BUDGET_EXCEEDED` — stable（minor 只增不破），since 1.0，全形态
- `LLM_COMPLETE_API_KEY_FORBIDDEN` — stable（minor 只增不破），since 1.0，全形态
- `LLM_COMPLETE_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `LLM_COMPLETE_SCHEMA_UNSUPPORTED` — stable（minor 只增不破），since 1.0，全形态
- `LLM_INFLIGHT_LIMIT` — stable（minor 只增不破），since 1.0，全形态
- `LLM_MODEL_NOT_FOUND` — stable（minor 只增不破），since 1.0，全形态
- `LLM_MODEL_SPEC_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `LlmContext` — stable（minor 只增不破），since 1.0，全形态
- `LlmTool` — stable（minor 只增不破），since 1.0，全形态
- `LSP_CONNECT_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `MANIFEST_API_KEYS` — stable（minor 只增不破），since 1.0，全形态
- `MCP_CONNECT_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `Message` — stable（minor 只增不破），since 1.0，全形态
- `MessageRoleDefinition` — stable（minor 只增不破），since 1.0，全形态
- `MessageSource` — stable（minor 只增不破），since 1.0，全形态
- `ModelInfo` — stable（minor 只增不破），since 1.0，全形态
- `PERSIST_BATCH_WRITE_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `PostInput` — stable（minor 只增不破），since 1.0，全形态
- `PROMPT_SECTION_DUPLICATE` — stable（minor 只增不破），since 1.0，全形态
- `PROMPT_SECTION_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `PromptSection` — stable（minor 只增不破），since 1.0，全形态
- `PromptsService` — stable（minor 只增不破），since 1.0，全形态
- `registerAppMessageRole` — stable（minor 只增不破），since 1.0，全形态
- `registerAppSessionEventType` — stable（minor 只增不破），since 1.0，全形态
- `registerErrorCode` — stable（minor 只增不破），since 1.0，全形态
- `registerHostMessageRole` — stable（minor 只增不破），since 1.0，全形态
- `registerSessionEventType` — stable（minor 只增不破），since 1.0，全形态
- `resolveRowCarrier` — stable（minor 只增不破），since 1.0，全形态
- `RowAppProbe` — stable（minor 只增不破），since 1.0，全形态
- `RowSandbox` — stable（minor 只增不破），since 1.0，全形态
- `SANDBOX_ESCALATION_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `SANDBOX_MODE_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `SANDBOX_UNAVAILABLE` — stable（minor 只增不破），since 1.0，全形态
- `SandboxMeta` — stable（minor 只增不破），since 1.0，全形态
- `ServiceCatalogEntry` — stable（minor 只增不破），since 1.0，全形态
- `SESSION_CORE_TYPE_FORBIDDEN` — stable（minor 只增不破），since 1.0，全形态
- `SESSION_EVENT_DATA_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `SESSION_EVENT_TOO_LARGE` — stable（minor 只增不破），since 1.0，全形态
- `SESSION_FORK_BOUNDARY_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `SESSION_FORMAT_UNSUPPORTED` — stable（minor 只增不破），since 1.0，全形态
- `SESSION_SURFACE_OP_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `SESSION_WRITE_CONFLICT` — stable（minor 只增不破），since 1.0，全形态
- `SessionEvent` — stable（minor 只增不破），since 1.0，全形态
- `SessionEventCategory` — stable（minor 只增不破），since 1.0，全形态
- `SessionEventTypeDefinition` — stable（minor 只增不破），since 1.0，全形态
- `Skill` — stable（minor 只增不破），since 1.0，全形态
- `SkillDiagnostic` — stable（minor 只增不破），since 1.0，全形态
- `SkillDiagnosticCode` — stable（minor 只增不破），since 1.0，全形态
- `SkillProvenance` — stable（minor 只增不破），since 1.0，全形态
- `SKILLS_PROVIDER_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `SkillSourceLevel` — stable（minor 只增不破），since 1.0，全形态
- `SkillsProvider` — stable（minor 只增不破），since 1.0，全形态
- `Static` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）
- `StopReason` — stable（minor 只增不破），since 1.0，全形态
- `StreamFn` — stable（minor 只增不破），since 1.0，全形态
- `StreamFnOptions` — stable（minor 只增不破），since 1.0，全形态
- `SUBAGENT_CAPABILITY_UNSUPPORTED` — stable（minor 只增不破），since 1.0，全形态
- `SUBAGENT_DEPTH_EXCEEDED` — stable（minor 只增不破），since 1.0，全形态
- `SUBAGENT_PROVIDER_DUPLICATE` — stable（minor 只增不破），since 1.0，全形态
- `SUBAGENT_PROVIDER_NOT_FOUND` — stable（minor 只增不破），since 1.0，全形态
- `SubagentCapabilities` — stable（minor 只增不破），since 1.0，全形态
- `SubagentExecution` — stable（minor 只增不破），since 1.0，全形态
- `SubagentProvider` — stable（minor 只增不破），since 1.0，全形态
- `SubagentProviderInfo` — stable（minor 只增不破），since 1.0，全形态
- `SubagentRequest` — stable（minor 只增不破），since 1.0，全形态
- `SubagentResult` — stable（minor 只增不破），since 1.0，全形态
- `SubagentRun` — stable（minor 只增不破），since 1.0，全形态
- `SubagentSettlement` — stable（minor 只增不破），since 1.0，全形态
- `SubagentsServiceFace` — stable（minor 只增不破），since 1.0，全形态
- `SubagentStart` — stable（minor 只增不破），since 1.0，全形态
- `SubagentStopReason` — stable（minor 只增不破），since 1.0，全形态
- `SurfaceOp` — stable（minor 只增不破），since 1.0，全形态
- `TextContent` — stable（minor 只增不破），since 1.0，全形态
- `ThinkingContent` — stable（minor 只增不破），since 1.0，全形态
- `ThinkingLevel` — stable（minor 只增不破），since 1.0，全形态
- `TODO_WRITE_TOO_LARGE` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_ARGUMENTS_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_BLOCKED` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_DESCRIPTION_REJECTED` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_DUPLICATE` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_EXECUTE_EVENT` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_GATE_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_NOT_STARTED` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_OUTCOME_UNKNOWN` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_POST_EXECUTE_EVENT` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_PRE_EXECUTE_EVENT` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_REGISTRY_LIMIT` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_REGISTRY_RATE` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_SCHEMA_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_TIMEOUT` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_TIMEOUT_FLOOR_MS` — stable（minor 只增不破），since 1.0，全形态
- `TOOL_TIMEOUT_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `ToolCallBlock` — stable（minor 只增不破），since 1.0，全形态
- `ToolCallOrigin` — stable（minor 只增不破），since 1.0，全形态
- `ToolCtx` — stable（minor 只增不破），since 1.0，全形态
- `ToolDefinition` — stable（minor 只增不破），since 1.0，全形态
- `ToolExecutionMode` — stable（minor 只增不破），since 1.0，全形态
- `ToolPipelineExecutor` — stable（minor 只增不破），since 1.0，全形态
- `ToolResultMessage` — stable（minor 只增不破），since 1.0，全形态
- `TOOLS_CHANGE_EVENT` — stable（minor 只增不破），since 1.0，全形态
- `ToolsService` — stable（minor 只增不破），since 1.0，全形态
- `ToolUpdateCallback` — stable（minor 只增不破），since 1.0，全形态
- `TSchema` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）
- `Type` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）
- `Usage` — stable（minor 只增不破），since 1.0，全形态
- `UserMessage` — stable（minor 只增不破），since 1.0，全形态
- `validateAppManifest` — stable（minor 只增不破），since 1.0，全形态
- `Value` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）
- `VirtualApiKeyEntry` — stable（minor 只增不破），since 1.0，全形态
- `WEB_DOWNLOAD_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `WEB_FETCH_FAILED` — stable（minor 只增不破），since 1.0，全形态
- `WEB_PRIVATE_TARGET` — stable（minor 只增不破），since 1.0，全形态
- `WEB_REDIRECT_LIMIT` — stable（minor 只增不破），since 1.0，全形态
- `WEB_URL_INVALID` — stable（minor 只增不破），since 1.0，全形态
- `WEBUI_BIND_FORBIDDEN` — stable（minor 只增不破），since 1.0，全形态
- `WEBUI_PORT_IN_USE` — stable（minor 只增不破），since 1.0，全形态

## `berryagent/llm`

- `anthropicMessagesApi` — stable（minor 只增不破），since 1.0，全形态
- `createProvider` — stable（minor 只增不破），since 1.0，全形态
- `hasApi` — stable（minor 只增不破），since 1.0，全形态
- `lazyApi` — stable（minor 只增不破），since 1.0，全形态

## `berryagent/sqlite`

- `openDatabase` — stable（minor 只增不破），since 1.0，全形态

## `data-keys`

- `app` — stable（minor 只增不破），since 1.0，全形态
- `cacheSubdir` — stable（minor 只增不破），since 1.0，全形态
- `declaredEvents` — stable（minor 只增不破），since 1.0，全形态

## `live-events`

- `agent_pre_step` — stable（minor 只增不破），since 1.0，全形态
- `app/activated` — stable（minor 只增不破），since 1.0，全形态
- `app/failed` — stable（minor 只增不破），since 1.0，全形态
- `app/skipped` — stable（minor 只增不破），since 1.0，全形态
- `app/uninstalled` — stable（minor 只增不破），since 1.0，全形态
- `approval/answer` — stable（minor 只增不破），since 1.0，全形态
- `composition/reloaded` — stable（minor 只增不破），since 1.0，全形态
- `context_transform` — stable（minor 只增不破），since 1.0，全形态
- `echo/par` — stable（minor 只增不破），since 1.0，全形态
- `echo/ser` — stable（minor 只增不破），since 1.0，全形态
- `echo/tick` — stable（minor 只增不破），since 1.0，全形态
- `echo/wf` — stable（minor 只增不破），since 1.0，全形态
- `job_settled` — stable（minor 只增不破），since 1.0，全形态
- `obs/alert` — stable（minor 只增不破），since 1.0，全形态
- `prompts_change` — stable（minor 只增不破），since 1.0，全形态
- `session_shutdown` — stable（minor 只增不破），since 1.0，全形态
- `session_start` — stable（minor 只增不破），since 1.0，全形态
- `session/event` — stable（minor 只增不破），since 1.0，全形态
- `skills_change` — stable（minor 只增不破），since 1.0，全形态
- `tools_change` — stable（minor 只增不破），since 1.0，全形态
- `tools_execute` — stable（minor 只增不破），since 1.0，全形态
- `tools_post_execute` — stable（minor 只增不破），since 1.0，全形态
- `tools_pre_execute` — stable（minor 只增不破），since 1.0，全形态
- `turn_stopping` — stable（minor 只增不破），since 1.0，全形态
- `user_input` — stable（minor 只增不破），since 1.0，全形态
- `worker/froze` — stable（minor 只增不破），since 1.0，全形态
- `worker/oom` — stable（minor 只增不破），since 1.0，全形态
- `worker/spawned` — stable（minor 只增不破），since 1.0，全形态

## `manifest`

- `agent` — stable（minor 只增不破），since 1.0，全形态
- `api` — stable（minor 只增不破），since 1.0，全形态
- `budget` — stable（minor 只增不破），since 1.0，全形态
- `components` — stable（minor 只增不破），since 1.0，全形态
- `default` — stable（minor 只增不破），since 1.0，全形态
- `entry` — stable（minor 只增不破），since 1.0，全形态
- `grants` — stable（minor 只增不破），since 1.0，全形态
- `id` — stable（minor 只增不破），since 1.0，全形态
- `label` — stable（minor 只增不破），since 1.0，全形态
- `theme` — stable（minor 只增不破），since 1.0，全形态

## `services`

- `agent` — stable（minor 只增不破），since 1.0，全形态
- `approval` — stable（minor 只增不破），since 1.0，全形态
- `apps` — stable（minor 只增不破），since 1.0，全形态
- `browser` — stable（minor 只增不破），since 1.0，全形态
- `channels` — stable（minor 只增不破），since 1.0，全形态
- `compaction` — stable（minor 只增不破），since 1.0，全形态
- `exec` — stable（minor 只增不破），since 1.0，全形态
- `fetch` — stable（minor 只增不破），since 1.0，全形态
- `jobs` — stable（minor 只增不破），since 1.0，全形态
- `llm` — stable（minor 只增不破），since 1.0，全形态
- `paths` — stable（minor 只增不破），since 1.0，全形态
- `prompts` — stable（minor 只增不破），since 1.0，全形态
- `sandbox` — stable（minor 只增不破），since 1.0，全形态
- `sessions` — stable（minor 只增不破），since 1.0，全形态
- `skills` — stable（minor 只增不破），since 1.0，全形态
- `subagents` — stable（minor 只增不破），since 1.0，全形态
- `tools` — stable（minor 只增不破），since 1.0，全形态
- `ui` — stable（minor 只增不破），since 1.0，全形态

## `session-events`

- `app/uninstalled` — stable（minor 只增不破），since 1.0，全形态
- `approval/asked` — stable（minor 只增不破），since 1.0，全形态
- `approval/decided` — stable（minor 只增不破），since 1.0，全形态
- `apps/deprecation-used` — stable（minor 只增不破），since 1.0，全形态
- `assistant/message` — stable（minor 只增不破），since 1.0，全形态
- `checkpoint/rewind` — stable（minor 只增不破），since 1.0，全形态
- `checkpoint/snapshot` — stable（minor 只增不破），since 1.0，全形态
- `compaction/end` — stable（minor 只增不破），since 1.0，全形态
- `compaction/failed` — stable（minor 只增不破），since 1.0，全形态
- `compaction/start` — stable（minor 只增不破），since 1.0，全形态
- `compaction/summary` — stable（minor 只增不破），since 1.0，全形态
- `gate/decision` — stable（minor 只增不破），since 1.0，全形态
- `git/range` — stable（minor 只增不破），since 1.0，全形态
- `goal/evidence` — stable（minor 只增不破），since 1.0，全形态
- `goal/summary` — stable（minor 只增不破），since 1.0，全形态
- `goal/summary-failed` — stable（minor 只增不破），since 1.0，全形态
- `llm/retry` — stable（minor 只增不破），since 1.0，全形态
- `llm/usage` — stable（minor 只增不破），since 1.0，全形态
- `memory/diff` — stable（minor 只增不破），since 1.0，全形态
- `request/header` — stable（minor 只增不破），since 1.0，全形态
- `sandbox/mode` — stable（minor 只增不破），since 1.0，全形态
- `session/end-seed` — stable（minor 只增不破），since 1.0，全形态
- `todo/write` — stable（minor 只增不破），since 1.0，全形态
- `tool/call` — stable（minor 只增不破），since 1.0，全形态
- `tool/result` — stable（minor 只增不破），since 1.0，全形态
- `turn/end` — stable（minor 只增不破），since 1.0，全形态
- `turn/start` — stable（minor 只增不破），since 1.0，全形态
- `user/message` — stable（minor 只增不破），since 1.0，全形态

## `typebox`

- `Static` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）
- `TSchema` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）
- `Type` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）

## `typebox/compile`

- `Code` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）
- `Compile` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）

## `typebox/value`

- `Value` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）

## 能力面（capabilities）

能力 = 宿主能力目录登记的语义单位（providedBy 归因官方件；`ctx.host.capabilities` 派生源；server 形装载器按此拒载要求缺席能力的应用）。

- `admin.apps` — builtin:admin，daemon / standalone
- `browser.automation` — builtin:browser，daemon / standalone
- `channels.multi` — builtin:channels，daemon / standalone
- `checkpoint.rewind` — builtin:checkpoint，daemon / standalone
- `compaction.longSession` — builtin:compaction，daemon / standalone
- `goal.autopilot` — builtin:goal，daemon / standalone
- `lsp.bridge` — builtin:lsp，daemon / standalone
- `mcp.bridge` — builtin:mcp，daemon / standalone
- `memory.store` — builtin:memory，daemon / standalone
- `obs.metrics` — builtin:obs，daemon / standalone
- `scheduler.tick` — builtin:scheduler，daemon / standalone
- `subagent.delegate` — builtin:subagent，daemon / standalone
- `web.channel` — builtin:webui，daemon / standalone
- `web.fetch` — builtin:web，daemon / standalone
