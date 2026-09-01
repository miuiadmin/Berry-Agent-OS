/**
 * L0 contracts — 错误码族（内核篇 §5.3，第八批拍板 #11：单一路线钉死）。
 *
 * 四条规则：
 * 1. SCREAMING_SNAKE + 模块前缀的**字符串码**是唯一错误词汇（TOOL_/FS_/SESSION_/CONTEXT_/…）；
 * 2. 所有码在 contracts 显式注册（与事件类型同纪律，CI 可校验）；
 * 3. 进程内统一 AppError 单基类 `{code, message, cause?}`——**类名层级废弃**，
 *    catch 一律按 code 分派（不 instanceof 具体子类）；
 * 4. durable 事件里错误一律写码（不写本地化文案）。
 */

/**
 * 进程内唯一错误基类。
 *
 * 用法：`throw new AppError('FS_NOT_OBSERVED', '文件未读过，拒绝修改', { cause: err })`
 * 捕获：`catch (e) { if (e instanceof AppError && e.code === 'FS_NOT_OBSERVED') … }`
 * 禁止为具体错误场景派生子类——场景差异全部体现在 code 上。
 */
export class AppError extends Error {
  /** 机器可分派的错误码（唯一判据，注册于下方注册表） */
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'AppError';
    this.code = code;
  }
}

/** 已注册错误码集合（注册即词汇表，listErrorCodes 供 CI / dump 诊断枚举） */
const registry = new Set<string>();

/** 错误码格式：大写字母开头，仅大写字母/数字/下划线，至少含一个下划线（模块前缀分隔） */
const CODE_FORMAT = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;

/**
 * 注册一个错误码并返回它（注册即使用，`const X = registerErrorCode('X')`）。
 * 重复注册或格式非法直接抛错——错误词汇必须在编译/测试期就钉死，不留运行时漂移。
 */
export function registerErrorCode(code: string): string {
  if (!CODE_FORMAT.test(code)) {
    throw new AppError('CONTRACT_BAD_ERROR_CODE', `错误码格式非法：${code}（应为 SCREAMING_SNAKE + 模块前缀）`);
  }
  if (registry.has(code)) {
    throw new AppError('CONTRACT_DUPLICATE_ERROR_CODE', `错误码重复注册：${code}`);
  }
  registry.add(code);
  return code;
}

/** 枚举全部已注册错误码（CI 校验 / 诊断输出用） */
export function listErrorCodes(): string[] {
  return [...registry].sort();
}

/**
 * 错误 → 统一文案口径（loop 工具结果 / app run 级兜底共用，杜绝各处手拼格式分叉）。
 * AppError 携带错误码前缀 `[CODE]`（运行时骨架篇 §3.4：M1 过渡态——结构化
 * errorCode 字段是 M2 升级项，此前至少让码进文本，杜绝纯文案吞码）。
 */
export function describeError(error: unknown): string {
  if (error instanceof AppError) {
    // 前缀幂等：管道侧 codedMessage 已把 `[CODE] ` 织进 message，此处不二叠
    // （他码前缀是正文一部分，不剥——仅同码前缀去重）
    const prefix = `[${error.code}] `;
    return error.message.startsWith(prefix) ? error.message : `${prefix}${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* 首批注册码——仅收录规范已拍板命名的码，后续模块落地时随用随注册。 */
/* 命名出处：内核篇 §5.3 / 会话篇 §4（恢复合成）/ 第七批（fs CAS）。 */
/* ------------------------------------------------------------------ */

/** context：通过 ctx.get 取用未注册的服务 */
export const CONTEXT_SERVICE_NOT_FOUND = registerErrorCode('CONTEXT_SERVICE_NOT_FOUND');
/** context：ctx.provide 同名服务重复注册（组合树装配错误，响亮失败不静默覆盖） */
export const CONTEXT_SERVICE_EXISTS = registerErrorCode('CONTEXT_SERVICE_EXISTS');
/**
 * context：ctx.provide 服务名形状不合（两段式分级，契约篇 §1.5，2026-08-27
 * 第三十三批 P2-1）。与 CONTEXT_SERVICE_EXISTS 分立——一管名字形状、一管重复
 * 注册。官方名位（宿主根作用域 + 行籍为官方的行）只收单段小写名（无斜杠）；
 * 第三方行必含恰一 `/` 域前缀（`厂商/服务名` 两段各自同字符集）——两段式使
 * 单段名在任一碰撞域结构性专属官方名位，第三方无法凭单段名遮蔽宿主词。
 */
export const CONTEXT_SERVICE_NAME_INVALID = registerErrorCode('CONTEXT_SERVICE_NAME_INVALID');
/** context：作用域已销毁后仍调用其 API（stale ctx 护栏，/reload 必然配套） */
export const CONTEXT_DISPOSED = registerErrorCode('CONTEXT_DISPOSED');
/**
 * context：ctx.effect 回调返回值不是函数（Disposer 契约违规）。
 * 注册期即拒而非回卷期爆炸——jiti 直载的应用代码无类型护栏，文档化的
 * 「fn 返回值入栈」契约必须配运行时校验补位（2026-08-25 Hermes 探针 #13）。
 */
export const CONTEXT_EFFECT_INVALID = registerErrorCode('CONTEXT_EFFECT_INVALID');
/** contracts：错误码注册表自身的护栏违规（格式/重复） */
export const CONTRACT_BAD_ERROR_CODE = registerErrorCode('CONTRACT_BAD_ERROR_CODE');
export const CONTRACT_DUPLICATE_ERROR_CODE = registerErrorCode('CONTRACT_DUPLICATE_ERROR_CODE');

/** tools：工具调用被取消时工具尚未开始执行（恢复 reducer 合成终态用，会话篇 §4） */
export const TOOL_NOT_STARTED = registerErrorCode('TOOL_NOT_STARTED');
/** tools：工具已启动但结果未知（超时/崩溃后的合成终态） */
export const TOOL_OUTCOME_UNKNOWN = registerErrorCode('TOOL_OUTCOME_UNKNOWN');
/** tools：工具执行超时（三段管道 execute 段的时长上限触发） */
export const TOOL_TIMEOUT = registerErrorCode('TOOL_TIMEOUT');
/** tools：参数 schema 校验失败（三段管道入口前置步，不合法参数不进守门/执行段） */
export const TOOL_ARGUMENTS_INVALID = registerErrorCode('TOOL_ARGUMENTS_INVALID');
/** tools：守门段拒绝（block 决策短路——结构化拒绝结果直接返回模型，不进执行段） */
export const TOOL_BLOCKED = registerErrorCode('TOOL_BLOCKED');
/** tools：守门段监听器自身异常（fail-closed：视为 block，绝不放行） */
export const TOOL_GATE_FAILED = registerErrorCode('TOOL_GATE_FAILED');
/** tools：同名工具重复注册（注册表装配错误，响亮失败） */
export const TOOL_DUPLICATE = registerErrorCode('TOOL_DUPLICATE');
/** tools：工具参数 schema 根节点非 object（注册面结构断言——顶层 union 会被 provider 网关剥成空声明面，契约篇 §3.1 根 object 硬规则，2026-08-31 全面复盘 #24） */
export const TOOL_SCHEMA_INVALID = registerErrorCode('TOOL_SCHEMA_INVALID');
/** tools：工具描述命中注入模式拒绝注册（注册面描述扫描，契约篇 §3.2/§6.6——描述是进模型上下文的文本，管道进 shell 形态 = 描述面执行漏洞） */
export const TOOL_DESCRIPTION_REJECTED = registerErrorCode('TOOL_DESCRIPTION_REJECTED');
/**
 * tools：注册面 timeoutMs 非法（<= 0——契约篇 §1.6 注册预算下限：装载面注册
 * 不许自管取消语义；「0 = 不设预算」保留给宿主内部合成 def（不经注册面）。
 * 拒绝式而非钳到 0：钳制会静默改变行为（应用以为无预算，长任务被杀还以为自管
 * 取消有效）——fail-loud。正数过小（< 1000ms）另钳至下限（存归一副本，不拒）。
 * 2026-08-27 刀〇a。
 */
export const TOOL_TIMEOUT_INVALID = registerErrorCode('TOOL_TIMEOUT_INVALID');

/** mcp：connect 期一码收口（spawn 失败/握手失败/startup 超时/相对路径 command——契约篇 §6.6；运行期服务器错误是数据不升 AppError） */
export const MCP_CONNECT_FAILED = registerErrorCode('MCP_CONNECT_FAILED');

/** lsp：connect 期一码收口（spawn 失败/initialize 握手失败/startup 超时/相对路径 command——契约篇 §6.7；调用期超时与服务器错误是数据不升 AppError，MCP 同律） */
export const LSP_CONNECT_FAILED = registerErrorCode('LSP_CONNECT_FAILED');

/** checkpoint：blob 损坏（磁盘内容与文件名承诺 hash 不符——掉电撕裂/外部损坏；读侧 sha256 复核 fail-loud，恢复中止未 fork 快照保留——会话篇 §5.3 读侧 sha256 校验，成熟度扫描 20260901 P1-6） */
export const CHECKPOINT_BLOB_CORRUPT = registerErrorCode('CHECKPOINT_BLOB_CORRUPT');

/** browser：引擎发现序全缺席（config executablePath / 系统 Chrome 知名位 / 数据目录专用引擎皆不在场）——工具结果附 /browser install 安装指引（契约篇 §6.10；诚实缺席不自动下载） */
export const BROWSER_ENGINE_NOT_FOUND = registerErrorCode('BROWSER_ENGINE_NOT_FOUND');

/** browser：引擎连接期一码收口（spawn 失败 / DevToolsActivePort 读取失败 / HTTP 握手失败 / WebSocket 建立失败——含双开 profile 锁与 Linux 缺系统库场景；契约篇 §6.10，MCP/LSP connect 一码同律） */
export const BROWSER_CONNECT_FAILED = registerErrorCode('BROWSER_CONNECT_FAILED');

/** browser：运行时 Node 版本不达标（< 22.19——WebSocket 全局缺席；engines 唯一运行时执法位，起链前拒不留半建态；契约篇 §6.10 生命周期收口⑥，遗漏大扫 20260901-b #15） */
export const BROWSER_NODE_UNSUPPORTED = registerErrorCode('BROWSER_NODE_UNSUPPORTED');

/** browser：行 config 双配冲突（cdpEndpoint 与 executablePath 同给——attach 既有引擎与指定引擎路径互斥；起链前 fail-loud，契约篇 §6.10，遗漏大扫 20260901-b #26） */
export const BROWSER_CONFIG_CONFLICT = registerErrorCode('BROWSER_CONFIG_CONFLICT');

/** prompts：具名提示词段 id 非法（须小写含 `/` 应用域前缀，如 `memory/core`——防撞宿主自留地；pi-4(a) 拍板，契约篇 §1.3 落码形态①） */
export const PROMPT_SECTION_INVALID = registerErrorCode('PROMPT_SECTION_INVALID');
/** prompts：具名提示词段撞名（段 id 已注册——与 TOOL_DUPLICATE 同纪律，拒绝静默覆盖） */
export const PROMPT_SECTION_DUPLICATE = registerErrorCode('PROMPT_SECTION_DUPLICATE');

/** fs：观察态 CAS——文件未读过（无观察版本）即拒绝修改（第七批安全四件之一） */
export const FS_NOT_OBSERVED = registerErrorCode('FS_NOT_OBSERVED');
/** fs：写入时文件版本与观察版本不符（并发修改守卫） */
export const FS_VERSION_CONFLICT = registerErrorCode('FS_VERSION_CONFLICT');
/** fs：目标文件/目录不存在（read/ls/delete 的 fail 形态；read 仍登记 absent 观察） */
export const FS_NOT_FOUND = registerErrorCode('FS_NOT_FOUND');
/** fs：目标路径不在可写根内（fence containment 检查失败，防误操作护栏） */
export const FS_OUTSIDE_WRITABLE_ROOTS = registerErrorCode('FS_OUTSIDE_WRITABLE_ROOTS');
/** fs：写串行段内写目标漂移（链外定键后父组件被共享写者 swap——物理写前重验 canonicalize 与定键值不符即拒，防宿主特权写被符号链交换重定向出 fence；复盘 20260901 S-2，骨架篇 §7.5② 竞速边界注记） */
export const FS_WRITE_TARGET_DRIFTED = registerErrorCode('FS_WRITE_TARGET_DRIFTED');
/** fs：apply_patch 补丁解析或应用失败（格式非法/hunk 不匹配/Add 目标已存在等，message 细说） */
export const FS_PATCH_FAILED = registerErrorCode('FS_PATCH_FAILED');
/** fs：edit 前置读遇非 UTF-8 终局拒改（决策树判为本地码页/BOM 非 UTF-8 族——防 mojibake 读入回写毁档；转档走 bash + iconv。骨架篇 §7.5，P1-3 挖矿 B11） */
export const FS_DECODE_NON_UTF8 = registerErrorCode('FS_DECODE_NON_UTF8');
/** fs：read 终段不可判定（既非 UTF-8 亦非本地码页可严格解码；含 encoding 逃生参数显式标签 strict 失败——消息携 hex 前缀与判定路径，模型可带 encoding 重读。骨架篇 §7.5，P1-3 挖矿 B11） */
export const FS_DECODE_UNDECIDABLE = registerErrorCode('FS_DECODE_UNDECIDABLE');

/** exec：子进程未启动（spawn 即败——ENOENT/EACCES/E2BIG 等，message 携 cause.code；绝不折算 exit 1。失败二分「未启动 ≠ 退出非零」见骨架篇 §9.3，pi-7 教训） */
export const EXEC_SPAWN_FAILED = registerErrorCode('EXEC_SPAWN_FAILED');
/** exec：env.inherit 名单命中凭证族（后缀 _API_KEY 等）或宿主保留前缀（ANTHROPIC_/OPENAI_/APP_）——机器堵名单走私，显式 set 值不在此列（契约篇 §1.2 E 组执法面②） */
export const EXEC_ENV_FORBIDDEN = registerErrorCode('EXEC_ENV_FORBIDDEN');

/* ------------------------------------------------------------------ */
/* web 码族（内核篇 §5.3，2026-08-26 web 刀规范先行——四码封顶不膨胀：  */
/* 字节超顶是截断标注、HTTP 非 2xx 是 isError 结果面，两者永不立码）。  */
/* ------------------------------------------------------------------ */

/** web：URL 非法（非 http/https 协议、畸形 URL、重定向 Location 不可解析——契约篇 §1.5.2 卫生件①） */
export const WEB_URL_INVALID = registerErrorCode('WEB_URL_INVALID');
/** web：目标地址命中私网/保留段清单（IANA 特殊用途注册表全收——DNS 解析全部地址逐一过检；SSRF fence 核心） */
export const WEB_PRIVATE_TARGET = registerErrorCode('WEB_PRIVATE_TARGET');
/** web：重定向超 5 跳上限（每跳重过私网+协议校验后仍到不了终点——契约篇 §1.5.2 卫生件②） */
export const WEB_REDIRECT_LIMIT = registerErrorCode('WEB_REDIRECT_LIMIT');
/** web：网络层失败（DNS 解析失败/连接拒绝/超时/TLS 错误等——message 载底层原因） */
export const WEB_FETCH_FAILED = registerErrorCode('WEB_FETCH_FAILED');
/** web：装机下载失败族（超独立字节预算 / 非 2xx / 域白名单外——契约篇 §6.10 downloadToFile；与抓取「非 2xx isError 结果面」有意分歧：装机物截断即废无截断交付语义） */
export const WEB_DOWNLOAD_FAILED = registerErrorCode('WEB_DOWNLOAD_FAILED');
/** browser：装机面失败（CfT 清单解析失败/平台无发行/zip 解包拒载——契约篇 §6.10 /browser install，第五十四批刀三余量） */
export const BROWSER_INSTALL_FAILED = registerErrorCode('BROWSER_INSTALL_FAILED');

/** session：会话格式/版本不支持（升级后的旧库拒绝打开，不迁移，会话篇拍板；未知事件类型非 ignorable 同用此码） */
export const SESSION_FORMAT_UNSUPPORTED = registerErrorCode('SESSION_FORMAT_UNSUPPORTED');
/** session：同一会话同一时刻只允许单写者——第二写者追加即响亮拒绝（第八批 #13 护栏） */
export const SESSION_WRITE_CONFLICT = registerErrorCode('SESSION_WRITE_CONFLICT');
/** session：事件 data 含非 JSON 值（undefined/function/symbol/bigint/循环引用），写入前拒绝 */
export const SESSION_EVENT_DATA_INVALID = registerErrorCode('SESSION_EVENT_DATA_INVALID');
/** session：单事件 data 体积超护栏（默认 64 KiB，会话篇 §1.2 拍板）——fail-loud 拒绝不吞垃圾 */
export const SESSION_EVENT_TOO_LARGE = registerErrorCode('SESSION_EVENT_TOO_LARGE');
/** session：surfaceOp 遮蔽校验失败（区间非法/溯源不完整/引用未来 seq/tool-result 改了 content 之外字段） */
export const SESSION_SURFACE_OP_INVALID = registerErrorCode('SESSION_SURFACE_OP_INVALID');
/** session：fork 边界非法（落在 open turn 内——必须落在 turn 闭合之后，会话篇 §5） */
export const SESSION_FORK_BOUNDARY_INVALID = registerErrorCode('SESSION_FORK_BOUNDARY_INVALID');
/** session：应用经 ctx.sessions.appendEvent 伪造核心事件词汇（user/message 等内核词的写入权属宿主——归因/审批/结算语义绑在宿主写点，装载面只许自注册词汇） */
export const SESSION_CORE_TYPE_FORBIDDEN = registerErrorCode('SESSION_CORE_TYPE_FORBIDDEN');
/** persist：write-behind 批量落盘失败（批次保留、自动重试暂停，显式 flush 重试——会话篇 §6 链第 2 步） */
export const PERSIST_BATCH_WRITE_FAILED = registerErrorCode('PERSIST_BATCH_WRITE_FAILED');
/** agent：自定义消息角色重复注册或与标准角色（user/assistant/toolResult）冲突（骨架篇 §2.3 显式注册纪律） */
export const AGENT_ROLE_EXISTS = registerErrorCode('AGENT_ROLE_EXISTS');
/** agent：自定义消息角色名格式非法——装载面必含 / 域前缀、宿主面无 / 单段（骨架篇 §2.3 落码注记双入口纪律） */
export const AGENT_ROLE_INVALID = registerErrorCode('AGENT_ROLE_INVALID');
/** agent：continueRun 续入点非法——末消息经 convertToLlm 后必须是 user 或 toolResult（骨架篇 §2.1） */
export const AGENT_CONTINUE_INVALID = registerErrorCode('AGENT_CONTINUE_INVALID');
/** llm：模型标识格式非法——必须是 "provider/model-id" 形式（首斜杠分割，model-id 可再含斜杠如 openrouter 路径式 id） */
export const LLM_MODEL_SPEC_INVALID = registerErrorCode('LLM_MODEL_SPEC_INVALID');
/** llm：模型查无——provider 未注册或其目录中无该 model id（fail-loud，不静默降级到别的模型） */
export const LLM_MODEL_NOT_FOUND = registerErrorCode('LLM_MODEL_NOT_FOUND');
/** llm：ctx.llm.complete 参数面携带 apiKey（凭证一律走 CredentialStore 缺省解析——参数面禁 apiKey 是骨架篇 §9.3 硬要求，防 OAuth token 洗白进 string apiKey；providerNative 透传槽内携带同理） */
export const LLM_COMPLETE_API_KEY_FORBIDDEN = registerErrorCode('LLM_COMPLETE_API_KEY_FORBIDDEN');
/** llm：ctx.llm.complete 请求结构化输出（schema）——M1 pi-ai 面无结构化输出腿，保留签名位响亮拒绝（精确面随 M2 provider 钩子收口） */
export const LLM_COMPLETE_SCHEMA_UNSUPPORTED = registerErrorCode('LLM_COMPLETE_SCHEMA_UNSUPPORTED');
/** llm：ctx.llm.complete 单发补全以错误终态收束（载 pi-ai 错误文案；401/429/超时细码族随 §3.4 M2 载荷定稿一并落） */
export const LLM_COMPLETE_FAILED = registerErrorCode('LLM_COMPLETE_FAILED');
/** llm：后台预算闸门拒发——complete(priority:'background') 且 !canAfford（当日后台累计 tokens 已达限额；记忆周期路捕获即「跳过本轮、下个周期再试」，骨架篇 §9.3） */
export const LLM_BUDGET_EXCEEDED = registerErrorCode('LLM_BUDGET_EXCEEDED');
/** llm：per-provider 在飞请求达帽（S4 前置债批，骨架篇 §3.2/§3.4——多驱动并发背压；归 transient 桶：并发压力自解，会话层退避后槽已释放；complete 单发路达帽同拒上抛、调用方自然重试） */
export const LLM_INFLIGHT_LIMIT = registerErrorCode('LLM_INFLIGHT_LIMIT');
/** safety：请求受限档但本机无可用沙箱后端——fail-closed 拒绝裸跑（骨架篇 §7.1） */
export const SANDBOX_UNAVAILABLE = registerErrorCode('SANDBOX_UNAVAILABLE');
/** safety：升权请求非法——非严格变宽档位 / sandbox_permissions 与 justification 未成对 / 理由为空句（骨架篇 §7.4） */
export const SANDBOX_ESCALATION_INVALID = registerErrorCode('SANDBOX_ESCALATION_INVALID');
/** safety：sandbox/mode 事件载荷不是三档词汇之一（fold 时 fail-loud——拼错档位静默沿用旧档是 fail-open） */
export const SANDBOX_MODE_INVALID = registerErrorCode('SANDBOX_MODE_INVALID');

/* ------------------------------------------------------------------ */
/* 应用加载器码族（契约篇 §6.2 落码 2026-08-23 M2 加载器本体纵切）——     */
/* 逐行失败进启动断言清单（§1.6 apply 抛错即响，不静默跳过不带病运行）。 */
/* ------------------------------------------------------------------ */

/** 应用：模块 import 失败（jiti 转译/执行入口文件抛错——语法错、依赖缺等） */
export const APP_LOAD_FAILED = registerErrorCode('APP_LOAD_FAILED');
/** 应用：模块形状非法（default 非函数 / name 缺失或非字符串 / inject/optionalInject 非 string[] / config schema 非法——契约篇 §1.1/§1.2 单形状纪律） */
export const APP_SHAPE_INVALID = registerErrorCode('APP_SHAPE_INVALID');
/** 应用：组合树行 config 未通过应用声明的 schema（启动一次性校验失败即响，契约篇 §1.2） */
export const APP_CONFIG_INVALID = registerErrorCode('APP_CONFIG_INVALID');
/** 应用：inject 依赖无法满足（缺提供方或依赖环——轮次激活零进展即判，即刻响亮并列 pending 清单，不做墙上钟超时） */
export const APP_INJECT_UNRESOLVED = registerErrorCode('APP_INJECT_UNRESOLVED');
/** 应用：apply 执行抛错（message 载原始错误；作用域 LIFO 回卷半途注册，失败行不留残骸） */
export const APP_APPLY_FAILED = registerErrorCode('APP_APPLY_FAILED');
/**
 * 应用：apply 挂起超时（缺省 10s——契约篇 §1.6 挂起转化条款时钟族之一：异步
 * 挂起与抛错同族，永不 resolve 且已返还控制按故障收尾；超时先回卷本作用域再进
 * 失败清单，迟到 reject 由装载器吞掉不进 unhandledRejection）。
 * 2026-08-27 刀〇a（隔离案一第二刀上半）。
 */
export const APP_APPLY_TIMEOUT = registerErrorCode('APP_APPLY_TIMEOUT');
/**
 * 应用：per-scope 事件派发频率超限（缺省 1000 次/分钟令牌桶——契约篇 §1.6
 * 事件频率护栏：失控应用高频派发会撑爆监听器面与 durable 落点，超限 fail-loud
 * 抛错而非静默丢弃；按**派发方**作用域分桶；宿主根作用域免计费——B-1 冷读
 * 裁决：root 桶实为全部会话流量的复用汇〔session/event 镜像 + tools_change
 * 广播〕，计费会在宿主写路径内自杀，应用永不持有 root 作用域〔fork 派生新名〕。
 * 刀〇a 落码 / 刀〇b 修正注记）。
 */
export const APP_EVENT_RATE = registerErrorCode('APP_EVENT_RATE');
/** 应用：组合树行引用的应用入口解析失败（加载器永不自动安装——启动断言指引安装，契约篇 §6.1 硬规则） */
export const APP_ENTRY_UNRESOLVED = registerErrorCode('APP_ENTRY_UNRESOLVED');
/** 应用：import 来源门禁越界（依赖图说明符不在白名单三道——虚拟面六键 / node: 内建 / 应用目录树内；jiti transform 全图静态扫描执法，契约篇 §1.2 执法面②，2026-08-26 挖矿批 P0-2） */
export const APP_IMPORT_FORBIDDEN = registerErrorCode('APP_IMPORT_FORBIDDEN');
/** 应用：第六键 berryagent/sqlite 包装拒开主库（自管库路径命中解析后主库绝对路径即抛——与 IMPORT_FORBIDDEN 分立：一管 import 门禁、一管库句柄门禁，契约篇 §1.2 注记①） */
export const APP_MAIN_DB_FORBIDDEN = registerErrorCode('APP_MAIN_DB_FORBIDDEN');
/** composition：组合树行 schema 违规（overlay 缺 id / 字段类型错 / 未知字段 / fixed 行被禁用——pre-release 拒绝式，契约篇 §6.5） */
export const COMPOSITION_ROW_INVALID = registerErrorCode('COMPOSITION_ROW_INVALID');
/**
 * skills：registerProvider 注册时点首调形状断言不过（骨架篇 §9.2，2026-08-27
 * 第三十三批 P2-1 B12）。防注册时点两路静默：① provider.list() 返回退化形
 * （缺 skills/diagnostics 键/元素非对象）——此前要到首次 refresh 才以裸
 * TypeError 炸（栈指向 merge 不指应用）；② list() 本身抛错——此前 refresh 期
 * 降 provider-failed 警告，「装上了但永远空」注册时点无感。断言只在注册入口
 * 一次（不随 refresh 重复）；运行期退化形由 refresh 的数组守卫降 warning。
 */
export const SKILLS_PROVIDER_INVALID = registerErrorCode('SKILLS_PROVIDER_INVALID');

/* ------------------------------------------------------------------ */
/* 桥接协议码族（契约篇 §1.7 错误面，2026-08-26 第二十七批刀二）——      */
/* carrier 级失败模式：AppError 家族词过界保码（信封 {code,message}）， */
/* 非家族异常入桶码；七码全部有消费者（bridge 模块），不预造。          */
/* ------------------------------------------------------------------ */

/** bridge：调用方主动取消的本地结算（AbortSignal 永不过界——取消消息化 + 桩本地立即结算不等对端往返；迟到 result 由迟到丢弃分支吸收，契约篇 §1.7） */
export const BRIDGE_CANCELLED = registerErrorCode('BRIDGE_CANCELLED');
/** bridge：对端域死亡（worker exit/terminate 或本端 dispose——在途出站调用一律以此结算；宿主侧即「域死结算」的调用面） */
export const BRIDGE_WORKER_EXITED = registerErrorCode('BRIDGE_WORKER_EXITED');
/** bridge：在途 ask 超时（监督面「在途 ask 超时」判据的执行面；超时与取消同路径——本地结算 + 发 cancel 让对端停工） */
export const BRIDGE_CALL_TIMEOUT = registerErrorCode('BRIDGE_CALL_TIMEOUT');
/** bridge：ask 的 service/method 无处理方（拼写错或声明面收窄——宁响亮不静默，对称 EVENT_UNKNOWN 纪律在 RPC 面的对偶） */
export const BRIDGE_METHOD_NOT_FOUND = registerErrorCode('BRIDGE_METHOD_NOT_FOUND');
/** bridge：处理器抛出非 AppError 异常的信封桶（家族词保码过界、非家族词统一入桶——对端回卷为 AppError 后按码分派不受影响） */
export const BRIDGE_HANDLER_FAILED = registerErrorCode('BRIDGE_HANDLER_FAILED');
/** bridge：worker 域 v1 同步收窄面（parallel/serial/waterfall/registerMessageRole/registerSessionEventType 等桩上直接 throw——收窄清单入册契约篇 §1.7，宁响亮不静默假实现） */
export const BRIDGE_SURFACE_NARROWED = registerErrorCode('BRIDGE_SURFACE_NARROWED');
/** bridge：消息编码失败（send 时点载荷不可编码——BigInt/循环引用等；**消息级失败**：载体仍健康，单消息丢弃/单调用结算不株连端点——2026-09-01 遗漏大扫 20260901-c #4 修死，载体在编码边界打型、端点 send() 据此分桶，契约篇 §1.7 消息面） */
export const BRIDGE_ENCODE_FAILED = registerErrorCode('BRIDGE_ENCODE_FAILED');

/* ------------------------------------------------------------------ */
/* 事件词汇执法码族（契约篇 §1.1，2026-08-23 M2 /reload 纵切）——        */
/* 「显式注册」的运行时半边：拼错事件名不再静默 no-op。                  */
/* ------------------------------------------------------------------ */

/** events：on/emit/waterfall/parallel/serial 五面遇到未注册事件名（目录 ∪ 装载期 customs 之外——拼错名 = 监听器永不触发的静默死亡，改为响亮失败） */
export const EVENT_UNKNOWN = registerErrorCode('EVENT_UNKNOWN');
/** events：自定义事件登记撞名（与目录或已登记 custom 重名——词汇表拒绝静默覆盖，契约篇 §1.2 events 第四件） */
export const EVENT_DUPLICATE = registerErrorCode('EVENT_DUPLICATE');
/** events：派发方法与事件声明的 mode 不一致（mode 是事件公开契约的一部分——应用侧静态 CI 罩不住，运行时执法） */
export const EVENT_MODE_MISMATCH = registerErrorCode('EVENT_MODE_MISMATCH');
/**
 * events：waterfall 钩子消费点挂起超时（缺省 5s——契约篇 §1.6 时钟族：loop
 * context_transform 消费点的桥钟；超时 reject 上抛走既有收尾路径〔loop 零
 * try/catch 纪律 → run failed〕。与 EVENT_ 族同前缀：执法对象都是事件词汇面）。
 * 工具管道 post 段同语义超时复用 TOOL_TIMEOUT（错误是数据、进 isError 结果面，
 * 码族随结果面走）。2026-08-27 刀〇a。
 */
export const EVENT_HANDLER_TIMEOUT = registerErrorCode('EVENT_HANDLER_TIMEOUT');
/**
 * events：非官方名位作用域 on/emit/waterfall/parallel/serial 宿主保留词
 * （目录 hostReserved 标注——session/event、approval/answer、tools_execute
 * 三词 v1，契约篇 §2.2 增补 9）。判据 = 行籍旗标 builtinRow（宿主根 ∪ 官方
 * 行 ∪ 承袭官方 id 的替换行；fork 级联）——第三方全局行/跨区行虽挂系统相位
 * 装载（zone='system'）行籍 false 照拒：装载相位 ≠ 信任位。2026-08-30 U1 小刀
 * （daemon 批前置——常驻形态把第三方行暴露窗口从会话时长放大到天级）。
 */
export const EVENT_HOST_RESERVED = registerErrorCode('EVENT_HOST_RESERVED');
/** 应用：装机子进程失败（npm install / git clone 等退出非零——message 载命令与输出尾行；三源分发见契约篇 §6.1） */
export const APP_INSTALL_FAILED = registerErrorCode('APP_INSTALL_FAILED');

/* ------------------------------------------------------------------ */
/* Job 注册表码族（运行时骨架篇 §6.2 落码注记，2026-08-24 subagent 纵切一） */
/* ——kind 词汇与事件词汇同纪律：显式注册、未注册即响亮拒绝。            */
/* ------------------------------------------------------------------ */

/** jobs：创建 Job 用了未注册的 kind（内置 'subagent'/'process'；应用自定义须先 registerKind——反模式 #4「宁拒绝不静默丢」对偶面） */
export const JOB_KIND_UNKNOWN = registerErrorCode('JOB_KIND_UNKNOWN');
/** jobs：JobKind 登记撞名（与内置或已登记 kind 重名——词汇表拒绝静默覆盖） */
export const JOB_KIND_DUPLICATE = registerErrorCode('JOB_KIND_DUPLICATE');
/** jobs：按 id 操纵的 Job 不存在（id 拼错或未创建过；终态条目超保留帽被逐出同判——结算序 FIFO 帽 256，骨架篇 §6.2 / 复盘 20260901 L-4） */
export const JOB_NOT_FOUND = registerErrorCode('JOB_NOT_FOUND');
/** jobs：围栏鉴权失败——带主 Job 被 非 owner 会话视角请求取消（owner 用 session id 围栏，骨架篇 §6.2） */
export const JOB_OWNER_MISMATCH = registerErrorCode('JOB_OWNER_MISMATCH');

/* ------------------------------------------------------------------ */
/* 子代理码族（运行时骨架篇 §6.1 落码注记，2026-08-24 subagent 纵切二） */
/* ——能力协商是启动前布尔检查：请求的能力 provider 未声明即响亮拒绝。  */
/* ------------------------------------------------------------------ */

/** subagent：start 引用的 provider 名未注册（清单面 = ctx.subagents.list()） */
export const SUBAGENT_PROVIDER_NOT_FOUND = registerErrorCode('SUBAGENT_PROVIDER_NOT_FOUND');
/** subagent：provider 注册撞名（词汇表拒绝静默覆盖——与事件/kind 同纪律） */
export const SUBAGENT_PROVIDER_DUPLICATE = registerErrorCode('SUBAGENT_PROVIDER_DUPLICATE');
/** subagent：能力协商失败——请求携带 outputSchema/maxDepth/toolFilter/persona 任一而 provider 未声明对应能力（start 前 fail-loud，不做运行时协商，骨架篇 §6.1【dsh】） */
export const SUBAGENT_CAPABILITY_UNSUPPORTED = registerErrorCode('SUBAGENT_CAPABILITY_UNSUPPORTED');
/** subagent：委派深度超帽（子 header.delegationDepth 超 min(请求 maxDepth, 装配默认帽)——§6.5 单调下界执法，fail-loud 子装配即刻销毁） */
export const SUBAGENT_DEPTH_EXCEEDED = registerErrorCode('SUBAGENT_DEPTH_EXCEEDED');

/* ------------------------------------------------------------------ */
/* agent 服务码族（运行时骨架篇 §9.3 ctx.agent，2026-08-24 goal 纵切一；  */
/* 2026-08-24 应用面第一纵切起服务与驱动同件同生命周期——无游离态，      */
/* DETACHED 码退役）——sendUserMessage 是应用注入正门：预留位一律响亮拒绝。 */
/* ------------------------------------------------------------------ */

/** agent：sendUserMessage 显式携带 deliverAs（'steer'/'inject' 定向投递为 M2+ 预留位——缺省三通道自适应即全部现行业务所需，显式指定即拒不做半实现） */
export const AGENT_DELIVER_AS_UNSUPPORTED = registerErrorCode('AGENT_DELIVER_AS_UNSUPPORTED');
/** agent：sendUserMessage 显式 session 键查无活驱动（多驱动路由 façade——键指向的会话已退役或不存在；调用方按码容错跳过即「退役即停摆」语义，骨架篇 §9.3 / 契约篇 §5.4 第 6 条 S1） */
export const AGENT_SESSION_INACTIVE = registerErrorCode('AGENT_SESSION_INACTIVE');
/** agent：backgroundWake 投递未带显式 session 键（后台触发不依赖调用链语义——结构性执法防链/focus 兜底静默错投，第二十四批题8B must-fix 的机器背书，骨架篇 §9.3） */
export const AGENT_SESSION_KEY_REQUIRED = registerErrorCode('AGENT_SESSION_KEY_REQUIRED');

/* ------------------------------------------------------------------ */
/* goal 码族（运行时骨架篇 §6.8 落码注记，2026-08-24 goal 纵切二）      */
/* —— 状态机转移非法一律响亮拒绝：宁拒绝不静默。                        */
/* ------------------------------------------------------------------ */

/** goal：goal_set 时本会话已有 active 行（一径：先申报终态或 /goal stop 再重设） */
export const GOAL_ACTIVE_EXISTS = registerErrorCode('GOAL_ACTIVE_EXISTS');
/** goal：操作的目标行不存在（goal_update 无行——goal_set 先设定） */
export const GOAL_NOT_FOUND = registerErrorCode('GOAL_NOT_FOUND');
/** goal：状态机转移非法（如 needs-resume 态申报终态 / completed 行再 stop——machine.ts 转移表执法） */
export const GOAL_TRANSITION_INVALID = registerErrorCode('GOAL_TRANSITION_INVALID');
/** goal：机器可验完成判据（gates）fail-closed 回执——验证不过 / 超时 / 畸形 / 审批拒时置 completed 被拒（第三十九批 T3-A 预注册，结构化载荷含 kind + 失败原因类型） */
export const GOAL_GATE_FAILED = registerErrorCode('GOAL_GATE_FAILED');
/** goal：todo 载荷段约束违规——非 goal 段申报 goal 段词汇（role/task_class/resume_when/deferred/follow_up），或 goal 段内 deferred 缺 resume_when、completed 缺二择一（第三十九批 T2-A 预注册，执法位 = todo 工具执行段） */
export const GOAL_TODO_SCOPE = registerErrorCode('GOAL_TODO_SCOPE');

/* ------------------------------------------------------------------ */
/* 应用面码族（契约篇 §5.4 应用面第二纵切，2026-08-25——清单文件唯一源   */
/* 的校验面：清单坏 = 宁拒绝不误读，与组合树行校验同纪律）。            */
/* ------------------------------------------------------------------ */

/** apps：应用清单校验失败（schema 拒绝式——未知字段/缺 id/label、components 空集、id 形状不合法等；message 载位置与首错路径） */
export const APP_INVALID = registerErrorCode('APP_INVALID');
/** apps：应用 id 撞名（官方裸名是保留字——第三方强制含 `/` 域前缀正是防撞官方裸名的碰撞域，契约篇 §5.4 冷读钉死） */
export const APP_DUPLICATE = registerErrorCode('APP_DUPLICATE');
/** apps：进入面未知应用 id（CLI `--app` / TUI `/app <id>`——注册表查无即此码；第三纵切，契约篇 §5.4） */
export const APP_NOT_FOUND = registerErrorCode('APP_NOT_FOUND');
/** app：关停序 quiesce 断言失败——全 settle 后仍有非退役驱动 isRunning（内核篇 §5.3 / 骨架篇 §1.3 S6 形态⑤：防「flush 时仍有在写者」的撕裂尾，断言是防不是治，正确性兜底是恢复协议） */
export const APP_SHUTDOWN_QUIESCE_VIOLATED = registerErrorCode('APP_SHUTDOWN_QUIESCE_VIOLATED');

/* ------------------------------------------------------------------ */
/* webui 码族（契约篇 §6.8 Web 通道第一刀，2026-08-30——回环三防线与     */
/* 端口占用的装配期执法面：fail-at-startup 拒启非运行期警告）。          */
/* ------------------------------------------------------------------ */

/** webui：显式非回环绑定被拒（config host 非 127.0.0.1/localhost/::1——服务器形态双皮到位前不开非回环监听，技术栈篇 §4.4 分界；行 failed 拒启） */
export const WEBUI_BIND_FORBIDDEN = registerErrorCode('WEBUI_BIND_FORBIDDEN');
/** webui：端口被占用（EADDRINUSE——apply 内 await listen 失败即抛，行 failed → 官方件失败行非空 = 启动断言拒启） */
export const WEBUI_PORT_IN_USE = registerErrorCode('WEBUI_PORT_IN_USE');

/* ------------------------------------------------------------------ */
/* daemon 码族（契约篇 §6.8 常驻执行体条·刀一，2026-08-30 第三十八批——  */
/* 生命周期命令面（start/stop）的响亮失败面：daemon.json O_EXCL 单实例   */
/* 仲裁 + ready-gate 真握手超时 + stop 信号序预算尽）。                  */
/* ------------------------------------------------------------------ */

/** daemon：单实例仲裁失败（daemon.json O_EXCL 撞既有文件且判活为真——M6 三钉后陈旧态已先行清扫，仍撞 = 真有活 daemon；「不猜 pid、活判据 = processStartId 匹配」） */
export const DAEMON_ALREADY_RUNNING = registerErrorCode('DAEMON_ALREADY_RUNNING');
/** daemon：start ready-gate 超时（spawn 后须 token 端点真握手〔GET /api/sessions 返 200〕未在预算内达成——health 公开探活不构成活证，M4 两语义分立；超时即杀子进程响亮非零） */
export const DAEMON_START_TIMEOUT = registerErrorCode('DAEMON_START_TIMEOUT');
/** daemon：stop 信号序预算尽（SIGTERM 后 30s 内进程未消失且 SIGKILL 后 5s 仍在——罕见形态〔D 状态进程/僵尸被收养〕，人工介入出口） */
export const DAEMON_STOP_TIMEOUT = registerErrorCode('DAEMON_STOP_TIMEOUT');

/* ------------------------------------------------------------------ */
/* 资源护栏族码族（契约篇 §1.6，2026-08-27 刀〇b——总量/频率失控面，与    */
/* 时钟族〔挂起〕正交。执法统一 fail-loud；例外两条不立码：#11 进度流是  */
/* 数据面丢弃 + 单条 warn、#13 切片是物理层多事务语义〔PERSIST_BATCH_    */
/* WRITE_FAILED 语义不变〕。                                            */
/* ------------------------------------------------------------------ */

/** context：作用域在册 effect 合计达上限（10^4——context 注册族 effect/on/provide 注销器/registerMessageRole/registerSessionEventType/fork 级联全走 pushEffect 单点一条钟罩全族；计数基准 = 活注册，手动注销/回卷即减非历史累计） */
export const CONTEXT_EFFECT_LIMIT = registerErrorCode('CONTEXT_EFFECT_LIMIT');
/** context：fork 直系子作用域计数达上限（128/作用域——fork 轰炸护栏，与 effect 帽同族；子 dispose 即释放名额非历史累计。契约篇 §1.5 fork 行，2026-08-31 技术债批） */
export const CONTEXT_FORK_LIMIT = registerErrorCode('CONTEXT_FORK_LIMIT');
/** tools：两层注册表（全局层+域层）合计件数达上限（10^3——良性行为距阈值两个数量级，超限 = 失控或泄漏） */
export const TOOL_REGISTRY_LIMIT = registerErrorCode('TOOL_REGISTRY_LIMIT');
/** tools：register/unregister 变更频率超限（容量 240 / 回填 600 每分钟全局令牌桶——每次变更触 tools_change ≤64KiB 快照，高频注册武器化 header 快照〔R4〕；容量吃下单次 /reload 全量重注册突发，回填 10 op/s 撑热迭代不触顶） */
export const TOOL_REGISTRY_RATE = registerErrorCode('TOOL_REGISTRY_RATE');
/** jobs：per-owner running 态并发达上限（16——帽在 createEntry 单点执法罩住一切 kind：subagent 委派/exec 后台/第三方 kind 同受；undefined owner = operator 直控面同规共桶） */
export const JOB_CONCURRENCY_LIMIT = registerErrorCode('JOB_CONCURRENCY_LIMIT');
