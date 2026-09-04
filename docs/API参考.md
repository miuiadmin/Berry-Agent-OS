# API 参考

> 本文件由 `tools/generate-api-reference.mjs` 从 `src/contracts/api-surface.json` 生成（`npm run build` 尾挂再生；生成物与面快照的漂移由 `npm run lint:topology` 内的 API 治理门禁逐字节守护）——勿手编。
> 稳定性分级与兼容承诺见 docs/应用开发指南.md「API 稳定性与兼容性」节与仓库 COMPATIBILITY.md；本文件只派生符号面。

当前 apiVersion：`1.0`。导出 459 项、能力 14 项。

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

### 常量

- `ACCENT_COLOR_NAMES` — accent 白名单色名： schema literals 的单一事实源；名→RGB 映射住通道壳（channels/theme.ts——contracts 无渲染语义，只裁名字合法性）。stable（minor 只增不破），since 1.0，全形态
- `AGENT_CONTINUE_INVALID` — agent：continueRun 续入点非法——末消息经 convertToLlm 后必须是 user 或 toolResult。stable（minor 只增不破），since 1.0，全形态
- `AGENT_DELIVER_AS_UNSUPPORTED` — agent：sendUserMessage 显式携带 deliverAs（'steer'/'inject' 定向投递为 M2+ 预留位——缺省三通道自适应即全部现行业务所需，显式指定即拒不做半实现）。stable（minor 只增不破），since 1.0，全形态
- `AGENT_ROLE_EXISTS` — agent：自定义消息角色重复注册或与标准角色（user/assistant/toolResult）冲突。stable（minor 只增不破），since 1.0，全形态
- `AGENT_ROLE_INVALID` — agent：自定义消息角色名格式非法——装载面必含 / 域前缀、宿主面无 / 单段。stable（minor 只增不破），since 1.0，全形态
- `AGENT_SESSION_INACTIVE` — agent：sendUserMessage 显式 session 键查无活驱动。stable（minor 只增不破），since 1.0，全形态
- `AGENT_SESSION_KEY_REQUIRED` — agent：backgroundWake 投递未带显式 session 键。stable（minor 只增不破），since 1.0，全形态
- `API_CAPABILITY_MISSING` — API 协商：应用要求本构建缺席的能力——server 形装载器拒绝面。stable（minor 只增不破），since 1.0，全形态
- `API_EXPERIMENTAL_UNDECLARED` — API 协商：import 实验键未在清单 api 块 experimental 数组声明——装载期拒。stable（minor 只增不破），since 1.0，全形态
- `API_VERSION_MALFORMED` — API 协商：apiVersion 字面格式非法（非 MAJOR.MINOR——清单校验后的执法面防御式复验；前置校验归 APP_INVALID 语境，本码 = 运行期残余逃逸的 fail-loud）。stable（minor 只增不破），since 1.0，全形态
- `API_VERSION_MISMATCH` — API 协商：宿主 apiVersion 低于应用声明 minApiVersion 硬地板——拒载。stable（minor 只增不破），since 1.0，全形态
- `APP_APPLY_FAILED` — 应用：apply 执行抛错（message 载原始错误；作用域 LIFO 回卷半途注册，失败行不留残骸）。stable（minor 只增不破），since 1.0，全形态
- `APP_APPLY_TIMEOUT` — 应用：apply 挂起超时。stable（minor 只增不破），since 1.0，全形态
- `APP_CONFIG_INVALID` — 应用：组合树行 config 未通过应用声明的 schema。stable（minor 只增不破），since 1.0，全形态
- `APP_DUPLICATE` — apps：应用 id 撞名。stable（minor 只增不破），since 1.0，全形态
- `APP_ENTRY_UNRESOLVED` — 应用：组合树行引用的应用入口解析失败。stable（minor 只增不破），since 1.0，全形态
- `APP_EVENT_RATE` — 应用：per-scope 事件派发频率超限。stable（minor 只增不破），since 1.0，全形态
- `APP_IMPORT_FORBIDDEN` — 应用：import 来源门禁越界。stable（minor 只增不破），since 1.0，全形态
- `APP_INJECT_UNRESOLVED` — 应用：inject 依赖无法满足（缺提供方或依赖环——轮次激活零进展即判，即刻响亮并列 pending 清单，不做墙上钟超时）。stable（minor 只增不破），since 1.0，全形态
- `APP_INSTALL_FAILED` — 应用：装机子进程失败。stable（minor 只增不破），since 1.0，全形态
- `APP_INVALID` — apps：应用清单校验失败（schema 拒绝式——未知字段/缺 id/label、components 空集、id 形状不合法等；message 载位置与首错路径）。stable（minor 只增不破），since 1.0，全形态
- `APP_LOAD_FAILED` — 应用：模块 import 失败（jiti 转译/执行入口文件抛错——语法错、依赖缺等）。stable（minor 只增不破），since 1.0，全形态
- `APP_MAIN_DB_FORBIDDEN` — 应用：第六键 berryagent/sqlite 包装拒开主库。stable（minor 只增不破），since 1.0，全形态
- `APP_NOT_FOUND` — apps：进入面未知应用 id。stable（minor 只增不破），since 1.0，全形态
- `APP_SHAPE_INVALID` — 应用：模块形状非法。stable（minor 只增不破），since 1.0，全形态
- `APP_SHUTDOWN_QUIESCE_VIOLATED` — app：关停序 quiesce 断言失败——全 settle 后仍有非退役驱动 isRunning。stable（minor 只增不破），since 1.0，全形态
- `AppIdPattern` — 应用 id 形状正则源（组成行 apps 数组元素校验共用——第三十六批作用域数组化导出；清单 schema 与组合树行校验同源单一定义）。stable（minor 只增不破），since 1.0，全形态
- `AppManifestSchema` — 应用清单 schema。stable（minor 只增不破），since 1.0，全形态
- `BRIDGE_CALL_TIMEOUT` — bridge：在途 ask 超时（监督面「在途 ask 超时」判据的执行面；超时与取消同路径——本地结算 + 发 cancel 让对端停工）。stable（minor 只增不破），since 1.0，全形态
- `BRIDGE_CANCELLED` — bridge：调用方主动取消的本地结算。stable（minor 只增不破），since 1.0，全形态
- `BRIDGE_ENCODE_FAILED` — bridge：消息编码失败（send 时点载荷不可编码。stable（minor 只增不破），since 1.0，全形态
- `BRIDGE_HANDLER_FAILED` — bridge：处理器抛出非 AppError 异常的信封桶（家族词保码过界、非家族词统一入桶——对端回卷为 AppError 后按码分派不受影响）。stable（minor 只增不破），since 1.0，全形态
- `BRIDGE_METHOD_NOT_FOUND` — bridge：ask 的 service/method 无处理方（拼写错或声明面收窄——宁响亮不静默，对称 EVENT_UNKNOWN 纪律在 RPC 面的对偶）。stable（minor 只增不破），since 1.0，全形态
- `BRIDGE_SURFACE_NARROWED` — bridge：worker 域 v1 同步收窄面。stable（minor 只增不破），since 1.0，全形态
- `BRIDGE_WORKER_EXITED` — bridge：对端域死亡（worker exit/terminate 或本端 dispose——在途出站调用一律以此结算；宿主侧即「域死结算」的调用面）。stable（minor 只增不破），since 1.0，全形态
- `BROWSER_CONFIG_CONFLICT` — browser：行 config 双配冲突。stable（minor 只增不破），since 1.0，全形态
- `BROWSER_CONNECT_FAILED` — browser：引擎连接期一码收口。stable（minor 只增不破），since 1.0，全形态
- `BROWSER_ENGINE_NOT_FOUND` — browser：引擎发现序全缺席（config executablePath / 系统 Chrome 知名位 / 数据目录专用引擎皆不在场）——工具结果附 /browser install 安装指引。stable（minor 只增不破），since 1.0，全形态
- `BROWSER_INSTALL_FAILED` — browser：装机面失败。stable（minor 只增不破），since 1.0，全形态
- `BROWSER_NODE_UNSUPPORTED` — browser：运行时 Node 版本不达标。stable（minor 只增不破），since 1.0，全形态
- `CAPABILITIES` — 能力面目录：官方可卸件能力起算集。stable（minor 只增不破），since 1.0，全形态
- `CHECKPOINT_BLOB_CORRUPT` — checkpoint：blob 损坏（磁盘内容与文件名承诺 hash 不符——掉电撕裂/外部损坏；读侧 sha256 复核 fail-loud，恢复中止未 fork 快照保留——会话篇 §5.3 读侧 sha256 校验，成熟度扫描 20260901 P1-6）。stable（minor 只增不破），since 1.0，全形态
- `COMPOSITION_ROW_INVALID` — composition：组合树行 schema 违规。stable（minor 只增不破），since 1.0，全形态
- `CONTEXT_DISPOSED` — context：作用域已销毁后仍调用其 API（stale ctx 护栏，/reload 必然配套）。stable（minor 只增不破），since 1.0，全形态
- `CONTEXT_EFFECT_INVALID` — context：ctx.effect 回调返回值不是函数（Disposer 契约违规）。stable（minor 只增不破），since 1.0，全形态
- `CONTEXT_EFFECT_LIMIT` — context：作用域在册 effect 合计达上限（10^4——context 注册族 effect/on/provide 注销器/registerMessageRole/registerSessionEventType/fork 级联全走 pushEffect 单点一条钟罩全族；计数基准 = 活注册，手动注销/回卷即减非历史累计）。stable（minor 只增不破），since 1.0，全形态
- `CONTEXT_FORK_LIMIT` — context：fork 直系子作用域计数达上限。stable（minor 只增不破），since 1.0，全形态
- `CONTEXT_SERVICE_EXISTS` — context：ctx.provide 同名服务重复注册（组合树装配错误，响亮失败不静默覆盖）。stable（minor 只增不破），since 1.0，全形态
- `CONTEXT_SERVICE_NAME_INVALID` — context：ctx.provide 服务名形状不合。stable（minor 只增不破），since 1.0，全形态
- `CONTEXT_SERVICE_NOT_FOUND` — context：通过 ctx.get 取用未注册的服务。stable（minor 只增不破），since 1.0，全形态
- `CONTRACT_BAD_ERROR_CODE` — contracts：错误码注册表自身的护栏违规（格式非法）。stable（minor 只增不破），since 1.0，全形态
- `CONTRACT_DUPLICATE_ERROR_CODE` — contracts：错误码注册表自身的护栏违规（标识符重复注册）。stable（minor 只增不破），since 1.0，全形态
- `CORE_EVENT_TYPES` — 核心事件类型词汇。stable（minor 只增不破），since 1.0，全形态
- `DAEMON_ALREADY_RUNNING` — daemon：单实例仲裁失败（daemon.json O_EXCL 撞既有文件且判活为真——M6 三钉后陈旧态已先行清扫，仍撞 = 真有活 daemon；「不猜 pid、活判据 = processStartId 匹配」）。stable（minor 只增不破），since 1.0，全形态
- `DAEMON_START_TIMEOUT` — daemon：start ready-gate 超时（spawn 后须 token 端点真握手〔GET /api/sessions 返 200〕未在预算内达成——health 公开探活不构成活证，M4 两语义分立；超时即杀子进程响亮非零）。stable（minor 只增不破），since 1.0，全形态
- `DAEMON_STOP_TIMEOUT` — daemon：stop 信号序预算尽（SIGTERM 后 30s 内进程未消失且 SIGKILL 后 5s 仍在——罕见形态〔D 状态进程/僵尸被收养〕，人工介入出口）。stable（minor 只增不破），since 1.0，全形态
- `DATA_DESCRIPTOR_API_KEYS` — data.json 词表三档（§1.5 表尾「双键一桥」面）：app（认领键）/ declaredEvents （词表账本）/ cacheSubdir（缓存免删信任子目录——布局预留）。stable（minor 只增不破），since 1.0，全形态
- `EVENT_DUPLICATE` — events：自定义事件登记撞名。stable（minor 只增不破），since 1.0，全形态
- `EVENT_HANDLER_TIMEOUT` — events：waterfall 钩子消费点挂起超时。stable（minor 只增不破），since 1.0，全形态
- `EVENT_HOST_RESERVED` — events：非官方名位作用域 on/emit/waterfall/parallel/serial 宿主保留词。stable（minor 只增不破），since 1.0，全形态
- `EVENT_MODE_MISMATCH` — events：派发方法与事件声明的 mode 不一致（mode 是事件公开契约的一部分——应用侧静态 CI 罩不住，运行时执法）。stable（minor 只增不破），since 1.0，全形态
- `EVENT_UNKNOWN` — events：on/emit/waterfall/parallel/serial 五面遇到未注册事件名（目录 ∪ 装载期 customs 之外——拼错名 = 监听器永不触发的静默死亡，改为响亮失败）。stable（minor 只增不破），since 1.0，全形态
- `EXEC_ENV_FORBIDDEN` — exec：env.inherit 名单命中凭证族（后缀 _API_KEY 等）或宿主保留前缀（ANTHROPIC_/OPENAI_/APP_）——机器堵名单走私，显式 set 值不在此列。stable（minor 只增不破），since 1.0，全形态
- `EXEC_SPAWN_FAILED` — exec：子进程未启动。stable（minor 只增不破），since 1.0，全形态
- `FS_DECODE_NON_UTF8` — fs：edit 前置读遇非 UTF-8 终局拒改。stable（minor 只增不破），since 1.0，全形态
- `FS_DECODE_UNDECIDABLE` — fs：read 终段不可判定。stable（minor 只增不破），since 1.0，全形态
- `FS_NOT_FOUND` — fs：目标文件/目录不存在（read/ls/delete 的 fail 形态；read 仍登记 absent 观察）。stable（minor 只增不破），since 1.0，全形态
- `FS_NOT_OBSERVED` — fs：观察态 CAS——文件未读过（无观察版本）即拒绝修改（第七批安全四件之一）。stable（minor 只增不破），since 1.0，全形态
- `FS_OUTSIDE_WRITABLE_ROOTS` — fs：目标路径不在可写根内（fence containment 检查失败，防误操作护栏）。stable（minor 只增不破），since 1.0，全形态
- `FS_PATCH_FAILED` — fs：apply_patch 补丁解析或应用失败（格式非法/hunk 不匹配/Add 目标已存在等，message 细说）。stable（minor 只增不破），since 1.0，全形态
- `FS_VERSION_CONFLICT` — fs：写入时文件版本与观察版本不符（并发修改守卫）。stable（minor 只增不破），since 1.0，全形态
- `FS_WRITE_TARGET_DRIFTED` — fs：写串行段内写目标漂移。stable（minor 只增不破），since 1.0，全形态
- `GOAL_ACTIVE_EXISTS` — goal：goal_set 时本会话已有 active 行（一径：先申报终态或 /goal stop 再重设）。stable（minor 只增不破），since 1.0，全形态
- `GOAL_GATE_FAILED` — goal：机器可验完成判据（gates）fail-closed 回执——验证不过 / 超时 / 畸形 / 审批拒时置 completed 被拒（第三十九批 T3-A 预注册，结构化载荷含 kind + 失败原因类型）。stable（minor 只增不破），since 1.0，全形态
- `GOAL_NOT_FOUND` — goal：操作的目标行不存在（goal_update 无行——goal_set 先设定）。stable（minor 只增不破），since 1.0，全形态
- `GOAL_TODO_SCOPE` — goal：todo 载荷段约束违规——非 goal 段申报 goal 段词汇（role/task_class/resume_when/deferred/follow_up），或 goal 段内 deferred 缺 resume_when、completed 缺二择一（第三十九批 T2-A 预注册，执法位 = todo 工具执行段）。stable（minor 只增不破），since 1.0，全形态
- `GOAL_TRANSITION_INVALID` — goal：状态机转移非法（如 needs-resume 态申报终态 / completed 行再 stop——machine.ts 转移表执法）。stable（minor 只增不破），since 1.0，全形态
- `JOB_CONCURRENCY_LIMIT` — jobs：per-owner running 态并发达上限（16——帽在 createEntry 单点执法罩住一切 kind：subagent 委派/exec 后台/第三方 kind 同受；undefined owner = operator 直控面同规共桶）。stable（minor 只增不破），since 1.0，全形态
- `JOB_KIND_DUPLICATE` — jobs：JobKind 登记撞名（与内置或已登记 kind 重名——词汇表拒绝静默覆盖）。stable（minor 只增不破），since 1.0，全形态
- `JOB_KIND_UNKNOWN` — jobs：创建 Job 用了未注册的 kind（内置 'subagent'/'process'；应用自定义须先 registerKind——反模式 #4「宁拒绝不静默丢」对偶面）。stable（minor 只增不破），since 1.0，全形态
- `JOB_NOT_FOUND` — jobs：按 id 操纵的 Job 不存在。stable（minor 只增不破），since 1.0，全形态
- `JOB_OWNER_MISMATCH` — jobs：围栏鉴权失败——带主 Job 被非 owner 会话视角请求取消。stable（minor 只增不破），since 1.0，全形态
- `LIVE_EVENT_CATALOG` — 总线活体事件目录。stable（minor 只增不破），since 1.0，全形态
- `LLM_BUDGET_EXCEEDED` — llm：后台预算闸门拒发——complete(priority:'background') 且 !canAfford。stable（minor 只增不破），since 1.0，全形态
- `LLM_COMPLETE_API_KEY_FORBIDDEN` — llm：ctx.llm.complete 参数面携带 apiKey。stable（minor 只增不破），since 1.0，全形态
- `LLM_COMPLETE_FAILED` — llm：ctx.llm.complete 单发补全以错误终态收束（载 pi-ai 错误文案；401/429/超时细码族随 §3.4 M2 载荷定稿一并落）。stable（minor 只增不破），since 1.0，全形态
- `LLM_COMPLETE_SCHEMA_UNSUPPORTED` — llm：ctx.llm.complete 请求结构化输出（schema）——M1 pi-ai 面无结构化输出腿，保留签名位响亮拒绝（精确面随 M2 provider 钩子收口）。stable（minor 只增不破），since 1.0，全形态
- `LLM_INFLIGHT_LIMIT` — llm：per-provider 在飞请求达帽。stable（minor 只增不破），since 1.0，全形态
- `LLM_MODEL_NOT_FOUND` — llm：模型查无——provider 未注册或其目录中无该 model id（fail-loud，不静默降级到别的模型）。stable（minor 只增不破），since 1.0，全形态
- `LLM_MODEL_SPEC_INVALID` — llm：模型标识格式非法——必须是 "provider/model-id" 形式（首斜杠分割，model-id 可再含斜杠如 openrouter 路径式 id）。stable（minor 只增不破），since 1.0，全形态
- `LSP_CONNECT_FAILED` — lsp：connect 期一码收口。stable（minor 只增不破），since 1.0，全形态
- `MANIFEST_API_KEYS` — 清单键 tier 目录。stable（minor 只增不破），since 1.0，全形态
- `MCP_CONNECT_FAILED` — mcp：connect 期一码收口。stable（minor 只增不破），since 1.0，全形态
- `PERSIST_BATCH_WRITE_FAILED` — persist：write-behind 批量落盘失败（批次保留、自动重试暂停，显式 flush 重试——会话篇 §6 链第 2 步）。stable（minor 只增不破），since 1.0，全形态
- `PROMPT_SECTION_DUPLICATE` — prompts：具名提示词段撞名（段 id 已注册——与 TOOL_DUPLICATE 同纪律，拒绝静默覆盖）。stable（minor 只增不破），since 1.0，全形态
- `PROMPT_SECTION_INVALID` — prompts：具名提示词段 id 非法（须小写含 `/` 应用域前缀，如 `memory/core`。stable（minor 只增不破），since 1.0，全形态
- `SANDBOX_ESCALATION_INVALID` — safety：升权请求非法——非严格变宽档位 / sandbox_permissions 与 justification 未成对 / 理由为空句。stable（minor 只增不破），since 1.0，全形态
- `SANDBOX_MODE_INVALID` — safety：sandbox/mode 事件载荷不是三档词汇之一（fold 时 fail-loud——拼错档位静默沿用旧档是 fail-open）。stable（minor 只增不破），since 1.0，全形态
- `SANDBOX_UNAVAILABLE` — safety：请求受限档但本机无可用沙箱后端——fail-closed 拒绝裸跑。stable（minor 只增不破），since 1.0，全形态
- `SESSION_CORE_TYPE_FORBIDDEN` — session：应用经 ctx.sessions.appendEvent 伪造核心事件词汇（user/message 等内核词的写入权属宿主——归因/审批/结算语义绑在宿主写点，装载面只许自注册词汇）。stable（minor 只增不破），since 1.0，全形态
- `SESSION_EVENT_DATA_INVALID` — session：事件 data 含非 JSON 值（undefined/function/symbol/bigint/循环引用），写入前拒绝。stable（minor 只增不破），since 1.0，全形态
- `SESSION_EVENT_TOO_LARGE` — session：单事件 data 体积超护栏（默认 64 KiB，会话篇 §1.2 拍板）——fail-loud 拒绝不吞垃圾。stable（minor 只增不破），since 1.0，全形态
- `SESSION_FORK_BOUNDARY_INVALID` — session：fork 边界非法（落在 open turn 内——必须落在 turn 闭合之后，会话篇 §5）。stable（minor 只增不破），since 1.0，全形态
- `SESSION_FORMAT_UNSUPPORTED` — session：会话格式/版本不支持（升级后的旧库拒绝打开，不迁移，会话篇拍板；未知事件类型非 ignorable 同用此码）。stable（minor 只增不破），since 1.0，全形态
- `SESSION_SURFACE_OP_INVALID` — session：surfaceOp 遮蔽校验失败（区间非法/溯源不完整/引用未来 seq/tool-result 改了 content 之外字段）。stable（minor 只增不破），since 1.0，全形态
- `SESSION_WRITE_CONFLICT` — session：同一会话同一时刻只允许单写者——第二写者追加即响亮拒绝（第八批 #13 护栏）。stable（minor 只增不破），since 1.0，全形态
- `SKILLS_PROVIDER_INVALID` — skills：registerProvider 注册时点首调形状断言不过。stable（minor 只增不破），since 1.0，全形态
- `SUBAGENT_CAPABILITY_UNSUPPORTED` — subagent：能力协商失败——请求携带 outputSchema/maxDepth/toolFilter/persona 任一而 provider 未声明对应能力。stable（minor 只增不破），since 1.0，全形态
- `SUBAGENT_DEPTH_EXCEEDED` — subagent：委派深度超帽（子 header.delegationDepth 超 min(请求 maxDepth, 装配默认帽)——§6.5 单调下界执法，fail-loud 子装配即刻销毁）。stable（minor 只增不破），since 1.0，全形态
- `SUBAGENT_PROVIDER_DUPLICATE` — subagent：provider 注册撞名（词汇表拒绝静默覆盖——与事件/kind 同纪律）。stable（minor 只增不破），since 1.0，全形态
- `SUBAGENT_PROVIDER_NOT_FOUND` — subagent：start 引用的 provider 名未注册（清单面 = ctx.subagents.list()）。stable（minor 只增不破），since 1.0，全形态
- `TODO_WRITE_TOO_LARGE` — todo：整表序列化字节超 60KiB 内容预算（第九轮 #21 修死——schema 静态形状上限被 gate.spec 数组形态击穿后，execute 段动态道响亮拒绝不截断：todo/write 是 fold/回显/gates 的机器消费面，截断毁语义）。stable（minor 只增不破），since 1.0，全形态
- `TOOL_ARGUMENTS_INVALID` — tools：参数 schema 校验失败（三段管道入口前置步，不合法参数不进守门/执行段）。stable（minor 只增不破），since 1.0，全形态
- `TOOL_BLOCKED` — tools：守门段拒绝（block 决策短路——结构化拒绝结果直接返回模型，不进执行段）。stable（minor 只增不破），since 1.0，全形态
- `TOOL_DESCRIPTION_REJECTED` — tools：工具描述命中注入模式拒绝注册。stable（minor 只增不破），since 1.0，全形态
- `TOOL_DUPLICATE` — tools：同名工具重复注册（注册表装配错误，响亮失败）。stable（minor 只增不破），since 1.0，全形态
- `TOOL_EXECUTE_EVENT` — 执行段活体事件名。stable（minor 只增不破），since 1.0，全形态
- `TOOL_GATE_FAILED` — tools：守门段监听器自身异常（fail-closed：视为 block，绝不放行）。stable（minor 只增不破），since 1.0，全形态
- `TOOL_NOT_STARTED` — tools：工具调用被取消时工具尚未开始执行（恢复 reducer 合成终态用，会话篇 §4）。stable（minor 只增不破），since 1.0，全形态
- `TOOL_OUTCOME_UNKNOWN` — tools：工具已启动但结果未知（超时/崩溃后的合成终态）。stable（minor 只增不破），since 1.0，全形态
- `TOOL_POST_EXECUTE_EVENT` — 后处理段活体事件名。stable（minor 只增不破），since 1.0，全形态
- `TOOL_PRE_EXECUTE_EVENT` — 守门段活体事件名。stable（minor 只增不破），since 1.0，全形态
- `TOOL_REGISTRY_LIMIT` — tools：两层注册表（全局层+域层）合计件数达上限（10^3——良性行为距阈值两个数量级，超限 = 失控或泄漏）。stable（minor 只增不破），since 1.0，全形态
- `TOOL_REGISTRY_RATE` — tools：register/unregister 变更频率超限（容量 240 / 回填 600 每分钟全局令牌桶——每次变更触 tools_change ≤64KiB 快照，高频注册武器化 header 快照〔R4〕；容量吃下单次 /reload 全量重注册突发，回填 10 op/s 撑热迭代不触顶）。stable（minor 只增不破），since 1.0，全形态
- `TOOL_SCHEMA_INVALID` — tools：工具参数 schema 根节点非 object。stable（minor 只增不破），since 1.0，全形态
- `TOOL_TIMEOUT` — tools：工具执行超时（三段管道 execute 段的时长上限触发）。stable（minor 只增不破），since 1.0，全形态
- `TOOL_TIMEOUT_FLOOR_MS` — 装载面注册 timeoutMs 下限：正数过小钳至此值，<= 0 拒绝（TOOL_TIMEOUT_INVALID）。stable（minor 只增不破），since 1.0，全形态
- `TOOL_TIMEOUT_INVALID` — tools：注册面 timeoutMs 非法（<= 0。stable（minor 只增不破），since 1.0，全形态
- `TOOLS_CHANGE_EVENT` — 工具集变更活体事件名（动态注册/禁用后触发请求重组装）。stable（minor 只增不破），since 1.0，全形态
- `WEB_DOWNLOAD_FAILED` — web：装机下载失败族。stable（minor 只增不破），since 1.0，全形态
- `WEB_FETCH_FAILED` — web：网络层失败（DNS 解析失败/连接拒绝/超时/TLS 错误等——message 载底层原因）。stable（minor 只增不破），since 1.0，全形态
- `WEB_PRIVATE_TARGET` — web：目标地址命中私网/保留段清单（IANA 特殊用途注册表全收——DNS 解析全部地址逐一过检；SSRF fence 核心）。stable（minor 只增不破），since 1.0，全形态
- `WEB_REDIRECT_LIMIT` — web：重定向超 5 跳上限。stable（minor 只增不破），since 1.0，全形态
- `WEB_URL_INVALID` — web：URL 非法。stable（minor 只增不破），since 1.0，全形态
- `WEBUI_BIND_FORBIDDEN` — webui：显式非回环绑定被拒。stable（minor 只增不破），since 1.0，全形态
- `WEBUI_PORT_IN_USE` — webui：端口被占用（EADDRINUSE——apply 内 await listen 失败即抛，行 failed → 官方件失败行非空 = 启动断言拒启）。stable（minor 只增不破），since 1.0，全形态

### 类型

- `AgentMessage` — AgentMessage = 标准三角色 ∪ 自定义角色。stable（minor 只增不破），since 1.0，全形态
- `AgentTool` — loop 可执行的工具定义。stable（minor 只增不破），since 1.0，全形态
- `AgentToolResult` — 工具执行结果（最终或部分）。stable（minor 只增不破），since 1.0，全形态
- `ApiBlock` — 清单 api 块形状。stable（minor 只增不破），since 1.0，全形态
- `ApiGateResult` — 装载门裁决结果。stable（minor 只增不破），since 1.0，全形态
- `ApiTier` — API 稳定性 tier 词汇。stable（minor 只增不破），since 1.0，全形态
- `AppActivatedPayload` — app/activated 载荷：{ 组合树行 id, 应用声明名, apply 耗时打点 }。stable（minor 只增不破），since 1.0，全形态
- `AppApply` — 应用唯一合法形状（§1.1）：一种函数，钉死。stable（minor 只增不破），since 1.0，全形态
- `AppContext` — 装载运行时核心 API。stable（minor 只增不破），since 1.0，全形态
- `AppEventHandler` — 事件处理器：参数由事件发布方约定；返回值仅 waterfall 采用（与 context 模块 EventHandler 同形——在此独立声明保持零依赖）。stable（minor 只增不破），since 1.0，全形态
- `AppFailedPayload` — app/failed 载荷：{ 组合树行 id, 错误码（APP_ 族）, 错误信息, 栈（可选） }。stable（minor 只增不破），since 1.0，全形态
- `AppLoadResult` — 加载结果（组合根启动断言与 ctx.apps.list 的数据源）。stable（minor 只增不破），since 1.0，全形态
- `AppLogger` — 装载面 logger 最小结构（context.Logger 的结构子集——contracts 零依赖层不引 context 模块；宿主 Logger 字段更宽，结构性可赋值到本面）。stable（minor 只增不破），since 1.0，全形态
- `AppManifest` — 应用清单（schema 静态推导类型——校验通过的产物形状）。stable（minor 只增不破），since 1.0，全形态
- `AppModule` — 应用模块的运行时契约（§1.2 named export 四件 + default）。stable（minor 只增不破），since 1.0，全形态
- `AppPlanRow` — 装载计划行（组合树合成产物 → 加载器输入）：三态互斥—— 有 entry（文件应用）或 builtin（官方件）= 激活行；有 skip = 跳过行（不 import，禁用不要求已装）；有 unresolved = 入口解析失败行。stable（minor 只增不破），since 1.0，全形态
- `AppSkippedPayload` — app/skipped 载荷：{ 组合树行 id, 跳过原因 }。stable（minor 只增不破），since 1.0，全形态
- `AppSkipReason` — 跳过原因词汇（§2.2 增补 1：disabled 静态禁用 / platform 平台门控；目录信任略过随信任门补）。stable（minor 只增不破），since 1.0，全形态
- `AssistantMessage` — 助手消息（流式组装终值；stopReason=error/aborted 时错误即数据，见 AssistantStream）。stable（minor 只增不破），since 1.0，全形态
- `AssistantStream` — 流式响应：异步迭代事件 + 最终消息取值口。stable（minor 只增不破），since 1.0，全形态
- `AssistantStreamEvent` — 流式事件（pi-ai AssistantMessageEvent 同构 12 型）。stable（minor 只增不破），since 1.0，全形态
- `BuiltinAppModule` — 官方件模块（§6.1 `builtin:` 前缀命名空间，2026-08-24 M2 记忆应用纵切）：与 AppModule 同形，唯 apply 替位 default（宿主随包函数引用，不经 jiti、不受应用零 import 规则约束）。stable（minor 只增不破），since 1.0，全形态
- `CapabilityEntry` — 能力目录项（surface.json 顶层 capabilities[] 的声明位形态）。stable（minor 只增不破），since 1.0，全形态
- `CommandCompletionItem` — 命令参数补全候选项（getArgumentCompletions 的返回元素；镜像 pi-tui AutocompleteItem——value 是补入文本、label 是展示行、description 单行说明）。stable（minor 只增不破），since 1.0，全形态
- `CommandDefinition` — 斜杠命令定义。stable（minor 只增不破），since 1.0，全形态
- `CompositionReloadedPayload` — composition/reloaded 载荷：三态行 id 清单（/reload 后订阅方可对账「实际跑的是什么」）。stable（minor 只增不破），since 1.0，全形态
- `CompositionRow` — 组合树行（§5.1，第三十六批作用域数组化）：每行 = 一个应用实例，字段级后写胜出合成。stable（minor 只增不破），since 1.0，全形态
- `CustomMessage` — 自定义角色消息（role 必须已经注册——装载面或宿主面之一）。stable（minor 只增不破），since 1.0，全形态
- `DeliverChannel` — 三通道：steer（run 中入队）/ followUp（闲时唤醒开轮）/ inject（只落日志不唤醒）。stable（minor 只增不破），since 1.0，全形态
- `DescriptorKeyEntry` — data.json 描述符键目录项（形状真相 = src/app/apps.ts AppDataDescriptor——本目录记 API 面 tier）。stable（minor 只增不破），since 1.0，全形态
- `EventName` — 活体事件名。stable（minor 只增不破），since 1.0，全形态
- `EventQueryCursor` — 组合游标 = 上页最旧一行的排序键三元组。stable（minor 只增不破），since 1.0，全形态
- `EventQueryOptions` — queryEvents 过滤与分页参数（挂 ctx.sessions 装载面，单原语）。stable（minor 只增不破），since 1.0，全形态
- `EventQueryResult` — queryEvents 返回形。stable（minor 只增不破），since 1.0，全形态
- `EventQueryRow` — 查询结果行（物理事实表行的直读形态；data 原样 JSON、服务面不截断——呈现截断归工具层）。stable（minor 只增不破），since 1.0，全形态
- `ExecEnvTable` — 子进程环境声明式变更表—— deny-by-default 白名单之上的显式叠加： - 隐式继承 = 白名单命中者自动透传（机器运行必需族 + 证书 + 代理）； - inherit = 显式追加透传名单（命中凭证族/宿主保留前缀 = EXEC_ENV_FORBIDDEN 响亮拒——机器堵的是名单走私；值本身取自宿主进程环境，缺者跳过）； - set = 显式值任意名合法（凭证经 config/凭证库正路取得后显式传递合法）； - unset = 从最终环境移除该名（可撤白名单内的名字）。stable（minor 只增不破），since 1.0，全形态
- `ExecOptions` — ctx.exec 原语侧选项（bash 工具侧无 env/stdin——两侧不对称是刻意的）。stable（minor 只增不破），since 1.0，全形态
- `ExecResult` — ctx.exec 原语侧结果（退出非零是正常返回不是错误——失败二分）。stable（minor 只增不破），since 1.0，全形态
- `ExecService` — ctx.exec 服务面：与模型可调用的 bash 工具走 **同一条三段 waterfall**——服务内部合成内部 ToolDefinition（名 `exec`，不进模型词汇表）+ 内部 toolCallId，守门段照过、gate/decision 照落账。stable（minor 只增不破），since 1.0，全形态
- `ExecuteInput` — 执行段入参（可变对象；around-dispatch 接管者读它执行替换逻辑）。stable（minor 只增不破），since 1.0，全形态
- `FormFactor` — 运行形态三态。stable（minor 只增不破），since 1.0，全形态
- `GateAction` — 守门决策（守门监听器的返回值）。stable（minor 只增不破），since 1.0，全形态
- `GateDecisionPayload` — gate/decision durable 载荷（结构同形于 session 模块 GateDecisionData—— 会话篇 §1.1；tools 不依赖 session，装配层把本回调接线到 session.append）。stable（minor 只增不破），since 1.0，全形态
- `GateDecisionSink` — 管道侧 gate/decision 回调（app 装配层注入，写 durable 事件；抛错 = 装配错误上抛）。stable（minor 只增不破），since 1.0，全形态
- `GateInput` — 守门段入参（可变对象——mutate 语义靠就地改写 args 实现）。stable（minor 只增不破），since 1.0，全形态
- `GateSummary` — API 声明门裁决摘要（API 治理进化刀 I 传导形单源——四处共用同一形： readApiGateAtRoot 出口 / AppPlanRow.apiGate 行字段 / 装配根 quickRow·loadEntry 腿 / app/activated 载荷 gate 键）。stable（minor 只增不破），since 1.0，全形态
- `HostFace` — 宿主自省面——应用问宿主，而非探测猜。stable（minor 只增不破），since 1.0，全形态
- `HostFaceData` — HostFace 的纯 JSON 数据快照（冷读 m5 桥接档过河物）：worker 域/外部载体桥只传数据、对岸物化同形只读面——方法面（has/list/enabled）由宿主与对岸各自在快照上派生，不随桥走。stable（minor 只增不破），since 1.0，全形态
- `ImageContent` — 图片块（多模态附件；base64 数据）。stable（minor 只增不破），since 1.0，全形态
- `JobController` — 手动结算面（provider 自持生命周期的形态——subagent/process 两 kind用）。stable（minor 只增不破），since 1.0，全形态
- `JobCreateOptions` — 建 Job 选项（ownerSessionId 缺省 = 无主——operator 直控面（TUI 等宿主侧）。stable（minor 只增不破），since 1.0，全形态
- `JobHandle` — Job 活句柄（创建方持有 = 直接处置权；间接访问走服务面围栏）。stable（minor 只增不破），since 1.0，全形态
- `JobSettleDetail` — 结算明细（终态附带的人类/模型可读信息；output 与 error 互斥于成功/失败路）。stable（minor 只增不破），since 1.0，全形态
- `JobsServiceFace` — ctx.jobs 服务面。stable（minor 只增不破），since 1.0，全形态
- `JobStatus` — Job 全程状态（stopping = 已收到取消请求但 executor 尚未落终态）。stable（minor 只增不破），since 1.0，全形态
- `JobTerminal` — Job 唯一终态（状态机终点；first-wins——第一个落定的终态胜出）。stable（minor 只增不破），since 1.0，全形态
- `JobView` — Job 只读快照（list/get 返回；活状态经 handle 读）。stable（minor 只增不破），since 1.0，全形态
- `LiveEventDefinition` — 活体事件目录项。stable（minor 只增不破），since 1.0，全形态
- `LlmContext` — 单次 LLM 请求上下文。stable（minor 只增不破），since 1.0，全形态
- `LlmTool` — LLM 工具描述。stable（minor 只增不破），since 1.0，全形态
- `Message` — LLM 边界标准三角色。stable（minor 只增不破），since 1.0，全形态
- `MessageRoleDefinition` — 自定义角色定义。stable（minor 只增不破），since 1.0，全形态
- `MessageSource` — user 消息归因词汇（会话篇 §3.1 dsh-8 定稿，五值 + v2 预留）：谁把这条消息放进历史——真人输入 / 通道转发 / 应用注入 / 定时投递 / 子代理结算回投。stable（minor 只增不破），since 1.0，全形态
- `ModelInfo` — 模型目录只读投影（ctx.llm.listModels()/getModel() 返回形。stable（minor 只增不破），since 1.0，全形态
- `PostInput` — 后处理段入参（可变对象——改写 result 靠就地改写字段）。stable（minor 只增不破），since 1.0，全形态
- `PromptSection` — 具名提示词段（pi-4(a) 拍板）：id 小写含 `/` 应用域前缀（宿主自留地为无 `/`）。stable（minor 只增不破），since 1.0，全形态
- `PromptsService` — ctx.prompts 服务面（注册 systemPrompt 具名追加段）。stable（minor 只增不破），since 1.0，全形态
- `RowAppProbe` — 行作用域投影探针：rowId → appId 数组的活查询面。stable（minor 只增不破），since 1.0，全形态
- `RowSandbox` — 行沙箱块：行声明的进程隔离相位—— 载体三值 + 收窄三子键（fs/net/caps）。stable（minor 只增不破），since 1.0，全形态
- `SandboxMeta` — 沙箱元数据。stable（minor 只增不破），since 1.0，全形态
- `ServiceCatalogEntry` — ctx 具名服务目录项。stable（minor 只增不破），since 1.0，全形态
- `SessionEvent` — durable 事件信封（会话篇 §1.1 唯一权威）：会话事件日志的唯一条目形态。stable（minor 只增不破），since 1.0，全形态
- `SessionEventCategory` — 事件类别三分法（会话篇 §1.1）：决定事件在投影/存储分层中的处理方式。stable（minor 只增不破），since 1.0，全形态
- `SessionEventTypeDefinition` — 事件类型注册项。stable（minor 只增不破），since 1.0，全形态
- `Skill` — 一个已加载技能（SKILL.md 解析产物；正文原文保留供 read 全文与显式激活）。stable（minor 只增不破），since 1.0，全形态
- `SkillDiagnostic` — 技能加载诊断（warning = 单点问题不断流；collision = 同名落选记录）。stable（minor 只增不破），since 1.0，全形态
- `SkillDiagnosticCode` — 诊断码（稳定词汇；warning 不断流，collision 记录 first-wins 落选者）。stable（minor 只增不破），since 1.0，全形态
- `SkillProvenance` — 晋升溯源：技能由记忆晋升而来时，作者（模型/用户）在 frontmatter 声明源记忆条目 id——审批面与审计面据此把技能清算回记忆（记忆再经 source_refs 清算回事件，宪章「痕迹可清算」三级全链）。stable（minor 只增不破），since 1.0，全形态
- `SkillSourceLevel` — 技能来源层级（§4.4 优先级 project > user > package；同名 first-wins）。stable（minor 只增不破），since 1.0，全形态
- `SkillsProvider` — 技能提供方。stable（minor 只增不破），since 1.0，全形态
- `StopReason` — LLM 调用终态（pi-ai 同构七值）。stable（minor 只增不破），since 1.0，全形态
- `StreamFn` — 模型层注入签名（llm 模块整体替换位——agent 与 llm 两模块的唯一会合点，故落在 contracts）。stable（minor 只增不破），since 1.0，全形态
- `StreamFnOptions` — StreamFn 每次调用的选项（model 为模型 id 字符串——解析归 llm 模块，loop 不持模型对象）。stable（minor 只增不破），since 1.0，全形态
- `SubagentCapabilities` — provider 能力声明（五布尔，声明式——§6.1 钉死；context 位 = 第三十一批）。stable（minor 只增不破），since 1.0，全形态
- `SubagentExecution` — provider 执行体（start 产物——dispose 幂等；服务面包装为 SubagentRun）。stable（minor 只增不破），since 1.0，全形态
- `SubagentProvider` — 子代理 provider 契约（§6.1 钉死；实现见 subagent/inprocess.ts 与外部收编应用）。stable（minor 只增不破），since 1.0，全形态
- `SubagentProviderInfo` — list() 只读清单项（委派工具披露面：名 + 能力声明）。stable（minor 只增不破），since 1.0，全形态
- `SubagentRequest` — 服务面请求（SubagentStart 全字段 + 路由/形态两字段）。stable（minor 只增不破），since 1.0，全形态
- `SubagentResult` — 子代理结算契约（父收到的全部——中间过程不进父上下文）。stable（minor 只增不破），since 1.0，全形态
- `SubagentRun` — 服务面启动产物（SubagentExecution + provider 名 + 后台模式的 Job 句柄）。stable（minor 只增不破），since 1.0，全形态
- `SubagentSettlement` — 结算回调载荷（§6.4 落码注记——service opts.onSettle 的入参）： background 链 = Job settle → onSettle → execution.dispose（通知先于子所有权释放）； foreground 链 = onSettle 后 dispose 归调用方。stable（minor 只增不破），since 1.0，全形态
- `SubagentsServiceFace` — ctx.subagents 服务面。stable（minor 只增不破），since 1.0，全形态
- `SubagentStart` — provider.start 的请求面（服务面已过能力协商；provider/background 字段已剥离）。stable（minor 只增不破），since 1.0，全形态
- `SubagentStopReason` — 子运行终态（§6.1 显式注册可扩展——字面量联合 + 字符串逃生口）。stable（minor 只增不破），since 1.0，全形态
- `SurfaceOp` — 遮蔽指令：改历史的唯一合法形态（会话篇 §2）——新事件携带，在派生表面遮蔽 [start, end] 区间旧节点。stable（minor 只增不破），since 1.0，全形态
- `TextContent` — 文本块（user/assistant/toolResult 通用）。stable（minor 只增不破），since 1.0，全形态
- `ThinkingContent` — 思考块（仅 assistant；供应商推理内容回放）。stable（minor 只增不破），since 1.0，全形态
- `ThinkingLevel` — 思考档位（pi-ai 同构七值；xhigh/max 仅部分模型家族支持）。stable（minor 只增不破），since 1.0，全形态
- `ToolCallBlock` — 工具调用块（仅 assistant 内联；arguments 已是解析后的对象）。stable（minor 只增不破），since 1.0，全形态
- `ToolCallOrigin` — 工具调用面类别（P1-2 增补 7③——§3.1「callOrigin 调用面类别」条的值域）： - 'model'：模型工具调用（loop 经 toAgentTool 包装进管道）； - 'service'：宿主服务面复入（exec 服务/web fetch 服务在同一管道执行—— 守门行按面别分叉〔如服务路不按模型工具面审批〕的显式判别词，取代对合成 def 名的字符串嗅探）。stable（minor 只增不破），since 1.0，全形态
- `ToolCtx` — 工具执行上下文（ToolDefinition.execute 的第二参数）。stable（minor 只增不破），since 1.0，全形态
- `ToolDefinition` — ctx.tools.register 的注册面。stable（minor 只增不破），since 1.0，全形态
- `ToolExecutionMode` — 工具批执行策略。stable（minor 只增不破），since 1.0，全形态
- `ToolPipelineExecutor` — 管道执行器（三段管道的包装面——Ring 1 行树化批 2026-08-26 类型安家 contracts：服务面携带它，宿主消费方〔exec 服务等〕与行替换件同源同过守门）。stable（minor 只增不破），since 1.0，全形态
- `ToolResultMessage` — 工具结果消息（与 assistant 内 toolCall 按 toolCallId 配对）。stable（minor 只增不破），since 1.0，全形态
- `ToolsService` — ctx.tools 服务面：工具注册表（register/listFor 两层模型）——第三方经 `ctx.get<ToolsService>('tools')` 取全类型。stable（minor 只增不破），since 1.0，全形态
- `ToolUpdateCallback` — 工具进度回调（partial 结果流式上报；promise 结算后的调用被忽略）。stable（minor 只增不破），since 1.0，全形态
- `Usage` — 一次 LLM 调用的 token 用量。stable（minor 只增不破），since 1.0，全形态
- `UserMessage` — 用户消息（content 允许纯文本或图文块数组）。stable（minor 只增不破），since 1.0，全形态
- `VirtualApiKeyEntry` — 虚拟模块键登记项。stable（minor 只增不破），since 1.0，全形态

### 函数

- `AppError` — 进程内唯一错误基类。stable（minor 只增不破），since 1.0，全形态
- `compareApiVersions` — apiVersion 比较：MAJOR.MINOR 逐段数值比较——禁字符串比较（"1.10" > "1.9"）。stable（minor 只增不破），since 1.0，全形态
- `describeError` — 错误 → 统一文案口径（loop 工具结果 / app run 级兜底共用，杜绝各处手拼格式分叉）。stable（minor 只增不破），since 1.0，全形态
- `exclusiveAppOf` — 「该区行」谓词：行 apps 键**恰一元素** = 该应用区独占行——返回该应用 id；缺席（系统相位）或多元素（跨区共享行） = undefined。stable（minor 只增不破），since 1.0，全形态
- `findLiveEvent` — 目录查询：按名取定义（含判断某事件是否已知总线活体事件）。stable（minor 只增不破），since 1.0，全形态
- `getMessageRoleDefinition` — 查角色定义（标准角色与未注册名返回 undefined——消费方自行分派）。stable（minor 只增不破），since 1.0，全形态
- `getSessionEventType` — 查询类型定义；未注册返回 undefined（调用方按 ignorable 语义决定拒绝与否）。stable（minor 只增不破），since 1.0，全形态
- `isCoreSessionEventType` — 是否核心事件词（内核词——写入权与注册权均属宿主）：appendEvent 写侧与 registerAppSessionEventType 注册侧同判据单一来源（两道闸一道尺）。stable（minor 只增不破），since 1.0，全形态
- `isStandardMessage` — 是否标准三角色消息（AgentMessage 联合消费方的窄化守卫）。stable（minor 只增不破），since 1.0，全形态
- `isStandardRole` — 是否标准角色（convertToLlm 透传分支的判据）。stable（minor 只增不破），since 1.0，全形态
- `isValidApiVersion` — 断言 apiVersion 格式合法（清单校验面用——错误归 APP_INVALID 语境由调用方包，本函数只做纯格式判定的复用体）。stable（minor 只增不破），since 1.0，全形态
- `listErrorCodes` — 枚举全部已注册错误码（CI 校验 / 诊断输出用）。stable（minor 只增不破），since 1.0，全形态
- `listMessageRoles` — 枚举全部已注册自定义角色名（目录清单 / 诊断输出用）。stable（minor 只增不破），since 1.0，全形态
- `listSessionEventTypes` — 枚举全部已注册事件类型（CI 校验 / 诊断输出用）。stable（minor 只增不破），since 1.0，全形态
- `registerAppMessageRole` — 装载面注册一个自定义消息角色（`ctx.registerMessageRole` 的落点）：角色名必含 `/` 域前缀（`memory/recall` 式）——应用域归属从名字可判，与 prompt 段同纪律。stable（minor 只增不破），since 1.0，全形态
- `registerAppSessionEventType` — 注册一个事件类型（装载面入口——`ctx.registerSessionEventType` 的落点）。stable（minor 只增不破），since 1.0，全形态
- `registerErrorCode` — 注册一个错误码并返回它（注册即使用，`const X = registerErrorCode('X')`）。stable（minor 只增不破），since 1.0，全形态
- `registerHostMessageRole` — 宿主面注册一个自定义消息角色：无 `/` 单段名（`bash-execution` 式）—— 装配层注册内置角色（bash 执行记录/系统通知/compaction 摘要/子代理结算标注）。stable（minor 只增不破），since 1.0，全形态
- `registerSessionEventType` — 注册一个事件类型（宿主面入口；核心清单在下方模块加载时已全量注册）。stable（minor 只增不破），since 1.0，全形态
- `resolveRowCarrier` — 行载体解析：sandbox 块缺席时 **缺省 ≠ 裸 main**——`builtin:` 行（官方豁免）缺省 main；第三方行缺省 external（出生即进程墙——缺块不是裸奔通道）。stable（minor 只增不破），since 1.0，全形态
- `validateAppManifest` — 校验应用清单（拒绝式——坏清单 APP_INVALID 响亮拒绝，message 载位置与首错路径）。stable（minor 只增不破），since 1.0，全形态

### 转发（forwarded）

- `Static` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）
- `TSchema` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）
- `Type` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）
- `Value` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）

## `berryagent/llm`

- `anthropicMessagesApi` — stable（minor 只增不破），since 1.0，全形态
- `createProvider` — stable（minor 只增不破），since 1.0，全形态
- `hasApi` — stable（minor 只增不破），since 1.0，全形态
- `lazyApi` — stable（minor 只增不破），since 1.0，全形态

## `berryagent/sqlite`

- `openDatabase` — 打开应用自管库（better-sqlite3 全量 Database 实例——自管库不强制 readonly，读写权限是应用自己的领地；主库路径命中即抛 APP_MAIN_DB_FORBIDDEN）。stable（minor 只增不破），since 1.0，全形态

## `data-keys`

- `app` — 跨行 id 改名的数据认领凭据（收割 named export name 兜底行 id）。stable（minor 只增不破），since 1.0，全形态
- `cacheSubdir` — 免删信任缓存子目录（布局预留字段）。stable（minor 只增不破），since 1.0，全形态
- `declaredEvents` — 自定义事件词名清单（null = 收割失败 unknown 档）。stable（minor 只增不破），since 1.0，全形态

## `live-events`

- `agent_pre_step` — handler 短路返回 { stop: true } = run 正常收场（非 mid-run 硬断，「正在跑的轮跑完为止」不破）；未短路须 next() 透传。stable（minor 只增不破），since 1.0，全形态
- `app/activated` — 应用行激活成功：载荷 { id, name, applyMs?, events?, gate? }——组合树行 id + 应用声明名 + apply 耗时打点 + 自定义事件词清单 + API 声明门裁决摘要（gate.status/gate.effectiveTarget 两键——行无 apiGate 则键缺席）；加载器 boot 逐行必发。stable（minor 只增不破），since 1.0，全形态
- `app/failed` — 应用行失败（载荷 { id, code, message }——APP_ 码族；启动断言据此响亮列出，不静默跳过）。stable（minor 只增不破），since 1.0，全形态
- `app/skipped` — 应用行跳过（载荷 { id, reason }——reason: disabled 静态禁用 / platform 平台门控；目录信任略过随信任门落地补）。stable（minor 只增不破），since 1.0，全形态
- `app/uninstalled` — 应用行卸载完成。stable（minor 只增不破），since 1.0，全形态
- `approval/answer` — 审批应答瀑布。stable（minor 只增不破），since 1.0，全形态
- `composition/reloaded` — 组合树重载完成。stable（minor 只增不破），since 1.0，全形态
- `context_transform` — S1 双参：第二参 = 归属会话 id（transformContext 桥随批传入），handler 须 next(messages, sessionId) 逐参透传——waterfall 兜底仅保首参，单参调用丢键）。stable（minor 只增不破），since 1.0，全形态
- `echo/par` — Echo 金样收窄面探针词·parallel。stable（minor 只增不破），since 1.0，全形态
- `echo/ser` — Echo 金样收窄面探针词·serial（同 echo/par——测试资产：收窄清单 v1 逐项核的差分判据；零订阅者，载荷无语义）。stable（minor 只增不破），since 1.0，全形态
- `echo/tick` — Echo 金样事件词汇。stable（minor 只增不破），since 1.0，全形态
- `echo/wf` — Echo 金样收窄面探针词·waterfall（同 echo/par——测试资产：收窄清单 v1 逐项核的差分判据；零订阅者，链尾 next 原样透传）。stable（minor 只增不破），since 1.0，全形态
- `job_settled` — 后台任务到达终态。stable（minor 只增不破），since 1.0，全形态
- `obs/alert` — 观测告警触发面（rollup 写入内联执法：过阈 + 冷却窗外触发；载荷 { ruleId, metric, agg, value, threshold, windowHours }）。stable（minor 只增不破），since 1.0，全形态
- `prompts_change` — systemPrompt 段集合变更通知：载荷 = 现行段 id 清单 id 字典序；与 tools_change 同族。stable（minor 只增不破），since 1.0，全形态
- `session_shutdown` — 优雅关闭广播，宿主 bounded 等待全部清理器。stable（minor 只增不破），since 1.0，全形态
- `session_start` — 会话建立或恢复完成（含崩溃修复结果）/ delegation fork 建子会话 / 装载收口补播。stable（minor 只增不破），since 1.0，全形态
- `session/event` — SessionEvent 写入后的活体通知，载荷 { sessionId, event }。stable（minor 只增不破），since 1.0，全形态
- `skills_change` — 技能提供方链变更通知。stable（minor 只增不破），since 1.0，全形态
- `tools_change` — 工具注册表变更通知。stable（minor 只增不破），since 1.0，全形态
- `tools_execute` — 工具执行瀑布。stable（minor 只增不破），since 1.0，全形态
- `tools_post_execute` — 工具执行后审计瀑布。stable（minor 只增不破），since 1.0，全形态
- `tools_pre_execute` — 工具执行前守门瀑布。stable（minor 只增不破），since 1.0，全形态
- `turn_stopping` — 模型 run 结算后逐个征询是否续跑：载荷 { sessionId, stopReason }；每次 runWithRetry 结算后、followUp 循环复查前派发，全部 stopReason 都发、dismantled 跳过；续跑 = handler 内经会话面 deliver 投递（running 走 steer 由循环消费——零新返回值）；消费点竞速挂起钟 5s。stable（minor 只增不破），since 1.0，全形态
- `user_input` — 派发点 = 全部批消费位（run 入口/followUp drain/重试 drain/turn 边界 steer 注入），凡不进 run 批的 inject 审计路不过；消费点竞速挂起钟 5s）。stable（minor 只增不破），since 1.0，全形态
- `worker/froze` — worker 域心跳冻结判定。stable（minor 只增不破），since 1.0，全形态
- `worker/oom` — worker 域内存超限死亡归因。stable（minor 只增不破），since 1.0，全形态
- `worker/spawned` — worker 域 spawn 即派发。stable（minor 只增不破），since 1.0，全形态

## `manifest`

- `agent` — 代理装配默认位（model/persona/toolFilter/skills）。stable（minor 只增不破），since 1.0，全形态
- `api` — API 协商声明块（min/target/experimental）。stable（minor 只增不破），since 1.0，全形态
- `budget` — 预算声明（dailyTokens/memoryMb）。stable（minor 只增不破），since 1.0，全形态
- `components` — 组件清单（装载身份串）。stable（minor 只增不破），since 1.0，全形态
- `default` — 默认应用声明（官方清单专属词汇）。stable（minor 只增不破），since 1.0，全形态
- `entry` — 启动面声明（command/delegable/background）。stable（minor 只增不破），since 1.0，全形态
- `grants` — 授权申请（writableRoots/approval 预设）。stable（minor 只增不破），since 1.0，全形态
- `id` — 应用 id（裸名官方保留 / 含 / 第三方域前缀）。stable（minor 只增不破），since 1.0，全形态
- `label` — 人读标签（UI 文案位）。stable（minor 只增不破），since 1.0，全形态
- `theme` — 前台渲染主题（accent 强调色）。stable（minor 只增不破），since 1.0，全形态

## `services`

- `agent` — 对话驱动控制（sendUserMessage 等官方件面）。stable（minor 只增不破），since 1.0，全形态
- `agent.onRunSettled` — 订阅 run 结算（每个 run 终结派发一次；载荷含归属 sessionId——多驱动下订阅方按其路由；Disposer 注销——挂 ctx.effect 即随应用回卷）。stable（minor 只增不破），since 1.0，全形态
- `agent.reseedTimeline` — 闲时重播种（compaction 纵切装配缺口第 4 件——会话篇 §2 增补 3）：以当前投影重建目标会话驱动时间线（resetTimeline 原位原语）。stable（minor 只增不破），since 1.0，全形态
- `agent.sendUserMessage` — 三通道注入（构造 UserMessage 经三级解析序路由到目标驱动；返回 void——steer 入队语义下 run 边界模糊，§9.3 ask 是等待结果的另一面 ⏳）。stable（minor 只增不破），since 1.0，全形态
- `approval` — 动作级审批（ask/never/allowed-once）。stable（minor 只增不破），since 1.0，全形态
- `approval.ask` — 动作级审批：一次请求 → 一个 outcome（闭集，绝不悬空）。stable（minor 只增不破），since 1.0，全形态
- `approval.policyMode` — 当前策略档（诊断/审计输出用）。stable（minor 只增不破），since 1.0，全形态
- `apps` — 装载管理 reconciliation 进程内服务。stable（minor 只增不破），since 1.0，全形态
- `apps.applyLoad` — boot 与 /reload 后装配方回灌最新装载结果（同实例就地更新——服务集恒定）。stable（minor 只增不破），since 1.0，全形态
- `apps.configure` — 行配置写入：patch 顶层键整值替换（与 overlay 字段级后写胜出同族语义，不引入深合并），合并后完整 config 经应用声明 schema 校验（复用装载期同 schema）才落 overlay。stable（minor 只增不破），since 1.0，全形态
- `apps.install` — 装机（三源分发按 ref 形态自动判定）——**D2 仓库态**：只进装机子树 + provenance 落账，**不写组合行 = 零生效**（install→reload 旧链废止——零行无物可热应用）。stable（minor 只增不破），since 1.0，全形态
- `apps.list` — 装载状态清单（组合树行序；装载前视角的行 = planned 兜底）。stable（minor 只增不破），since 1.0，全形态
- `apps.markFailed` — 运行时单行失败状态面：装载后的运行期失败路径；boot/reload 装载失败走 applyLoad 三态清单不经此面（事件广播由调用方/fleet 负责，此处只保 list 状态源不漂移）。stable（minor 只增不破），since 1.0，全形态
- `apps.mount` — 挂载：吃**装机推导 id**——账本反查装机物，写一条 overlay 组合行使其生效。stable（minor 只增不破），since 1.0，全形态
- `apps.requestReload` — 重载请求投递（同条导线——reload 真身住组合根，服务面只投递）：排队语义宿主侧承载（run 进行中排队、run 结算后自动排水），件不自带重建权。stable（minor 只增不破），since 1.0，全形态
- `apps.toggle` — 禁用状态翻转（overlay 行 disabled 置 true / 删键）。stable（minor 只增不破），since 1.0，全形态
- `apps.uninstall` — 双相卸载——inspect 相：零副作用只读预检（装机物 + 全部挂载行 + 数据域体积 + 词表三档 + 受影响会话计数 + 级联强警示）。stable（minor 只增不破），since 1.0，全形态
- `apps.unmount` — 卸挂载（D2 删行动词）：吃**行 id**——删 overlay 行保码（装机物与账本不动、行 config 随行删；重挂回装机推导 config 缺省——mount 的 config 位承载显式重配）。stable（minor 只增不破），since 1.0，全形态
- `apps.update` — 按源分派更新——**键域 = 装机 id**（D2 迁包键：两态后 overlay 无行的仓库态件也可更新；账本反查装机物与原始 spec）：npm 按装机 spec 重装 / git 删目录按账本原 ref 重克隆 / local no-op（改动即见）；三源通尾重收割词表账本 + provenance 精确版本刷新。stable（minor 只增不破），since 1.0，全形态
- `browser` — 浏览器自动化服务面（CDP 桥）。stable（minor 只增不破），since 1.0，全形态
- `browser.acquireContext` — per-session 隔离态取用（路由键 = ToolCtx.sessionId；匿名兜底 '_default'）。stable（minor 只增不破），since 1.0，全形态
- `browser.dispose` — 行回卷永久关停（诊断/测试面——生产回卷走 ctx.effect）。stable（minor 只增不破），since 1.0，全形态
- `browser.status` — 引擎诊断态（idle/starting/running/closed——boot 通知与日志同源）。stable（minor 只增不破），since 1.0，全形态
- `channels` — 通道服务面（多会话呈现/提问队列）。stable（minor 只增不破），since 1.0，全形态
- `channels.listCommands` — 已注册命令清单（/help 展示；按名排序）。stable（minor 只增不破），since 1.0，全形态
- `channels.registerCommand` — 注册斜杠命令（同名后写胜出；返回注销器，幂等）。stable（minor 只增不破），since 1.0，全形态
- `channels.registerRenderer` — 注册消息渲染器（同角色后写胜出；返回注销器，幂等）。stable（minor 只增不破），since 1.0，全形态
- `channels.rendererFor` — 查角色渲染器（无则 undefined——调用方回落内置渲染）。stable（minor 只增不破），since 1.0，全形态
- `compaction` — 长会话压缩触发面（闲时重播种等）。stable（minor 只增不破），since 1.0，全形态
- `compaction.compactForOverflow` — mid-run 溢出压缩（durable 五步，reason='overflow'）：'compacted' = 五步全落投影已缩；'nothing' = 无可压；'failed' = 摘要调用抛错（已落 compaction/failed）。stable（minor 只增不破），since 1.0，全形态
- `compaction.drain` — 在飞压缩汇流快照：per-session 在飞互斥位 values 的 Promise.all（快照语义；tail 恒不拒；无在飞 = 已结算 Promise 直返）。stable（minor 只增不破），since 1.0，全形态
- `exec` — spawn 管道服务（进程组树杀/超时归因）。stable（minor 只增不破），since 1.0，全形态
- `exec.exec` — 受守门段管辖的 shell 执行便捷口（与 bash 工具同一管道，不旁路）。stable（minor 只增不破），since 1.0，全形态
- `fetch` — 受控 fetch 原语（SSRF 五卫生件同面）。stable（minor 只增不破），since 1.0，全形态
- `fetch.downloadToFile` — 装机下载原语。stable（minor 只增不破），since 1.0，全形态
- `fetch.fetch` — 受控 fetch 原语：与 fetch 工具同一 execute 同一卫生件（SSRF 五卫生件同面 ——守门/落账不旁路；异常面 throw AppError，WEB_* 码族）。stable（minor 只增不破），since 1.0，全形态
- `jobs` — Job 注册表（终态条目结算序保留帽 256）。stable（minor 只增不破），since 1.0，全形态
- `jobs.cancel` — 按 id 请求取消（围栏：带主 Job 须以同 session id 请求，否则 JOB_OWNER_MISMATCH；无 as 视角 = operator 直控）。stable（minor 只增不破），since 1.0，全形态
- `jobs.create` — 手动入口（provider 自持生命周期）：subagent 映射 aborted→killed / error→failed、 process 映射进程退出码——终态语义归 executor，注册表不代答。stable（minor 只增不破），since 1.0，全形态
- `jobs.drain` — 取消全部（或指定 owner 的）Job 并 await 全部结算落定——owner dispose / 作用域回卷的排空面。stable（minor 只增不破），since 1.0，全形态
- `jobs.get` — 按 id 查快照（不存在 undefined；带主 Job 须同 session id 视角查——围栏与 cancel 同规）。stable（minor 只增不破），since 1.0，全形态
- `jobs.list` — 清单（ownerSessionId 过滤 = 会话视角；缺省全量 = operator 视角）。stable（minor 只增不破），since 1.0，全形态
- `jobs.registerKind` — JobKind 显式注册（未注册 kind 创建即 JOB_KIND_UNKNOWN——与事件词汇同纪律）；返回注销 Disposer。stable（minor 只增不破），since 1.0，全形态
- `jobs.run` — 糖入口：fn resolve→completed（携带 output）/ reject→failed（describeError）； signal 已 abort 时无论 resolve/reject 一律落 killed（取消意图胜出——auto-wire 即 executor 侧适配）。stable（minor 只增不破），since 1.0，全形态
- `llm` — 模型服务面（complete 单发等——pi-ai 适配层）。stable（minor 只增不破），since 1.0，全形态
- `llm.canAfford` — 预算闸门查询（记忆篇铁律 4 宿主化数据源）：'foreground' 恒 true；'background' = 当日后台累计 tokens（in+out）< 限额。stable（minor 只增不破），since 1.0，全形态
- `llm.classifyError` — 错误桶判定（S4 前置债批——全仓唯一一份桶表 recovery.ts classifyAssistantError 的服务面公开位）：chat 件等宿主内消费方经 ctx 取用（chat 拓扑边不含 llm，判定器经服务面注入驱动——「应用侧禁写第二份分桶」的执法前提是宿主面可得）。stable（minor 只增不破），since 1.0，全形态
- `llm.complete` — 单发受托管补全（本文件主角）。stable（minor 只增不破），since 1.0，全形态
- `llm.getModel` — 单模型查询（listModels 的点查形态，同表同账；id = "provider/model-id" 全形）。stable（minor 只增不破），since 1.0，全形态
- `llm.isContextOverflowFor` — 溢出判定（第四十五批溢出兜底——窗口携带）：recovery.isContextOverflow 的服务面公开位。stable（minor 只增不破），since 1.0，全形态
- `llm.listModels` — 模型目录只读投影：pi-ai Models 接口包装（与主对话同一 Models 实例——registerProvider 增补即刻可见），不新开特权口（pi-11：宿主数据不开放读面 = 生态直读私有格式的起点）。stable（minor 只增不破），since 1.0，全形态
- `llm.registerProvider` — 注册/替换 provider（按 id upsert）；返回注销函数（应用卸载路径）。stable（minor 只增不破），since 1.0，全形态
- `llm.unregisterProvider` — 按 id 移除 provider。stable（minor 只增不破），since 1.0，全形态
- `paths` — 目录服务（dataDir/appDataDir/workspaceRoot）。stable（minor 只增不破），since 1.0，全形态
- `paths.appDataDir` — 应用数据根：`<数据目录>/apps/<id>/`（首取即建目录，幂等缓存）。stable（minor 只增不破），since 1.0，全形态
- `paths.dataDir` — 数据目录根（组合树/overlay/装机子树所在）。stable（minor 只增不破），since 1.0，全形态
- `paths.workspaceRoot` — canonical 工作区根（2026-08-26 挖矿批 P0-1）：context 模块 commondir 归并既有能力再导出——多个检索/文件类应用需要锚定工作区而不许读 env 猜 cwd。stable（minor 只增不破），since 1.0，全形态
- `prompts` — systemPrompt 具名追加段注册。stable（minor 只增不破），since 1.0，全形态
- `prompts.listSections` — 现行段 id 清单（字典序——载荷与诊断面同源）。stable（minor 只增不破），since 1.0，全形态
- `prompts.materialize` — 具名段物化（id 字典序拼接，段间空行分隔）：render() 抛错 = 应用 bug，宿主捕获后渲染诊断占位 + log error，不杀重建（与失败行不杀进程同根）。stable（minor 只增不破），since 1.0，全形态
- `prompts.registerSection` — 注册具名段；返回注销函数（挂调用方作用域 effect 由应用侧负责）。stable（minor 只增不破），since 1.0，全形态
- `sandbox` — 沙箱纯包装（三档文件效果词汇）。stable（minor 只增不破），since 1.0，全形态
- `sandbox.confine` — 纯包装：受限档策略下把消费方 argv 变为受限 argv（消费方自行 spawn）。stable（minor 只增不破），since 1.0，全形态
- `sandbox.listBackends` — 当前后端链快照（诊断/审计输出用）。stable（minor 只增不破），since 1.0，全形态
- `sandbox.registerBackend` — 注册沙箱后端（后端应用行；返回注销器，幂等）。stable（minor 只增不破），since 1.0，全形态
- `sessions` — 会话事件读写与投影导线（appendEvent/deriveMessages 等）。stable（minor 只增不破），since 1.0，全形态
- `sessions.adopt` — 会话收养（会话篇 §5.3）：S3 open 收养路的件可达导线——fork 产物或任意持久会话经此切前台。stable（minor 只增不破），since 1.0，全形态
- `sessions.appendEvent` — 事件追加（应用词专属——核心词写入权属宿主，核心词在此响亮拒绝）；无路由落点返回 undefined 降级。stable（minor 只增不破），since 1.0，全形态
- `sessions.appendWithSurfaceOp` — 遮蔽载体宿主代写（会话篇 §2 增补 6）：应用携 surfaceOp 的 user/message 载体经宿主写权落账（五执法点在装配侧收口）；无路由落点返回 undefined。stable（minor 只增不破），since 1.0，全形态
- `sessions.createSession` — 导入会话（会话篇 §5.1）：origin='import' 钉死；四道卫生闸洗外部种子 → durable 承诺（ensureSeeded + flush 屏障）→ 返回 sessionId 不返回活引用。stable（minor 只增不破），since 1.0，全形态
- `sessions.currentSessionId` — 当前路由会话 id（无路由落点 undefined）。stable（minor 只增不破），since 1.0，全形态
- `sessions.deriveMessages` — 模型历史投影只读（应用读当前会话投影走此面，禁自扫原始流绕投影）。stable（minor 只增不破），since 1.0，全形态
- `sessions.eventsOfType` — 事件枚举（读侧同抛未知词——拼错事件名的无声死不设）；无落点 = 空数组。stable（minor 只增不破），since 1.0，全形态
- `sessions.fork` — fork 露头（会话篇 §5.2）：以调用链当前会话的前缀为种子分叉——回退正路（checkpoint-rewind）= fork + adopt 切换后写。stable（minor 只增不破），since 1.0，全形态
- `sessions.isBusy` — run 在跑探针：缺省 = 当前路由会话；不在册会话恒 false。stable（minor 只增不破），since 1.0，全形态
- `sessions.lastClosedBoundary` — 路由会话的「最后闭合 turn 边界」（回退正路读面针——checkpoint 件 forkSeq 唯一取值口）：物理全日志的闭合前缀长度。stable（minor 只增不破），since 1.0，全形态
- `sessions.logLength` — 当前路由会话日志长度（goal 激活锚唯一取值口；无落点 undefined）。stable（minor 只增不破），since 1.0，全形态
- `sessions.projectedJsonChars` — 投影 JSON 字符总长（compaction 判据底账；无落点降级 2 = 空数组「[]」）。stable（minor 只增不破），since 1.0，全形态
- `sessions.queryEvents` — 跨会话有界时间窗查询（会话篇 §3.4 单原语）——sanctioned 直读事实表（读物理库；需精确可传 flushFirst: true）。stable（minor 只增不破），since 1.0，全形态
- `skills` — 技能来源注册（skills_change 广播）。stable（minor 只增不破），since 1.0，全形态
- `skills.diagnostics` — 上次 refresh 的诊断快照。stable（minor 只增不破），since 1.0，全形态
- `skills.get` — 按名取技能（未知名 → undefined）。stable（minor 只增不破），since 1.0，全形态
- `skills.list` — 当前合并产物（上次 refresh 的快照；服务构造后为空，须 refresh 才有内容）。stable（minor 只增不破），since 1.0，全形态
- `skills.refresh` — 重扫全部提供方并合并（first-wins + 冲突诊断 + symlink 去重）；返回合并产物。stable（minor 只增不破），since 1.0，全形态
- `skills.registerProvider` — 注册技能提供方（追加序即优先序；返回注销器，幂等）。stable（minor 只增不破），since 1.0，全形态
- `skills.renderAvailableSkills` — 渐进披露清单（§4.3：<available_skills> XML；隐藏技能排除；无可见技能 → ''）。stable（minor 只增不破），since 1.0，全形态
- `subagents` — 委派 provider 注册与程序化发起。stable（minor 只增不破），since 1.0，全形态
- `subagents.list` — 已注册 provider 清单（注册序）。stable（minor 只增不破），since 1.0，全形态
- `subagents.register` — 注册 provider（撞名 SUBAGENT_PROVIDER_DUPLICATE）；返回注销 Disposer。stable（minor 只增不破），since 1.0，全形态
- `subagents.start` — 启动一次性委派：查 provider → 能力协商布尔检查 → provider.start； background:true 经 ctx.jobs 注册（stopReason→Job 终态映射见落码注记）。stable（minor 只增不破），since 1.0，全形态
- `tools` — 工具注册面（register/listFor——S2 两层模型）。stable（minor 只增不破），since 1.0，全形态
- `tools.compositionFor` — 驱动组成面 = 全局层 ∪ 本驱动应用域层 ∪ 本驱动层（域键升级批新增——组成面不能只活在 chat 件 open 的局部算式里，goal 续跑 wakeToolFilter 等运行期消费方需要同一投影）。stable（minor 只增不破），since 1.0，全形态
- `tools.executor` — 管道执行器（三段管道包装面——Ring 1 行树化批：件 apply 构造并随服务携带）。stable（minor 只增不破），since 1.0，全形态
- `tools.get` — 按名查找（**全局层同口径**——只查全局层；未注册返回 undefined，调用方决定 fail 形态）。stable（minor 只增不破），since 1.0，全形态
- `tools.list` — 全局层全量快照（次序 = 注册序；诊断面/无会话语境的消费方用）。stable（minor 只增不破），since 1.0，全形态
- `tools.listFor` — 应用域视角全量快照 = 全局层 ∪ 该应用域层（次序 = 全局注册序在前、应用域注册序在后；键 = appId——域键升级批键义升级，参数从 sessionId 改 appId）。stable（minor 只增不破），since 1.0，全形态
- `tools.register` — 注册工具（即时生效；返回注销器，幂等）。stable（minor 只增不破），since 1.0，全形态
- `tools.stats` — 注册面打点（B2 P5 打点先行，2026-08-27 刀〇a）：registered = 现存件数（全局层 + 全部域层）；totalAdds/totalRemoves = 开机以来累计注册/注销次数（高频注册武器化监控的数据源——阈值执法随护栏族另批，本面只出数）。stable（minor 只增不破），since 1.0，全形态
- `tools.toAgentTool` — loop 面适配：包一层三段管道的 AgentTool（薄适配器，无状态）。stable（minor 只增不破），since 1.0，全形态
- `ui` — 观众面（notify 广播/hasAudience 探针）。stable（minor 只增不破），since 1.0，全形态
- `ui.attach` — 通道后端接入/摘除（通道 start/stop 时调用；返回摘除器）。stable（minor 只增不破），since 1.0，全形态
- `ui.confirm` — 是/否确认（无交互通道时 fail-closed 返回 false；abort 同 false）。stable（minor 只增不破），since 1.0，全形态
- `ui.hasAudience` — 观众探针（任一在线后端自报有观众——基建大扫 #44 修订 R-2 保守口径）：探针语义 =「有人可收」非「通道在场」——后端可选自报 hasAudience()（TUI 缺省恒真、webui 报在线连接数 > 0、无后端即假）。stable（minor 只增不破），since 1.0，全形态
- `ui.input` — 自由文本输入（无交互通道返回 ''）。stable（minor 只增不破），since 1.0，全形态
- `ui.notify` — 一次性通知：广播到全部在线通道。stable（minor 只增不破），since 1.0，全形态
- `ui.select` — 单选（通道不支持 select 时降级为 input；无交互通道返回 ''；abort 同 ''）。stable（minor 只增不破），since 1.0，全形态
- `ui.setStatus` — 状态行更新：广播到全部在线通道。stable（minor 只增不破），since 1.0，全形态
- `ui.setWidget` — 自定义渲染槽：恒降级 notify（刀 2 后端键删面——v1 全通道零 setWidget 实现，应用面保留统一降级语义；WidgetSpec 定稿时随 Disposer 形态重建后端键）。stable（minor 只增不破），since 1.0，全形态

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

### 转发（forwarded）

- `Static` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）
- `TSchema` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）
- `Type` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）

## `typebox/compile`

### 转发（forwarded）

- `Code` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）
- `Compile` — stable（minor 只增不破），since 1.0，全形态（forwarded 转发——tier 承诺归上游 typebox）

## `typebox/value`

### 转发（forwarded）

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
