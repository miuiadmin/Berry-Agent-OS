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
/** context：作用域已销毁后仍调用其 API（stale ctx 护栏，/reload 必然配套） */
export const CONTEXT_DISPOSED = registerErrorCode('CONTEXT_DISPOSED');
/**
 * context：ctx.effect 回调返回值不是函数（Disposer 契约违规）。
 * 注册期即拒而非回卷期爆炸——jiti 直载的插件代码无类型护栏，文档化的
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

/** prompts：具名提示词段 id 非法（须小写含 `/` 插件域前缀，如 `memory/core`——防撞宿主自留地；pi-4(a) 拍板，契约篇 §1.3 落码形态①） */
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
/** fs：apply_patch 补丁解析或应用失败（格式非法/hunk 不匹配/Add 目标已存在等，message 细说） */
export const FS_PATCH_FAILED = registerErrorCode('FS_PATCH_FAILED');

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
/** session：插件经 ctx.sessions.appendEvent 伪造核心事件词汇（user/message 等内核词的写入权属宿主——归因/审批/结算语义绑在宿主写点，插件面只许自注册词汇） */
export const SESSION_CORE_TYPE_FORBIDDEN = registerErrorCode('SESSION_CORE_TYPE_FORBIDDEN');
/** persist：write-behind 批量落盘失败（批次保留、自动重试暂停，显式 flush 重试——会话篇 §6 链第 2 步） */
export const PERSIST_BATCH_WRITE_FAILED = registerErrorCode('PERSIST_BATCH_WRITE_FAILED');
/** agent：自定义消息角色重复注册或与标准角色（user/assistant/toolResult）冲突（骨架篇 §2.3 显式注册纪律） */
export const AGENT_ROLE_EXISTS = registerErrorCode('AGENT_ROLE_EXISTS');
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
/** safety：请求受限档但本机无可用沙箱后端——fail-closed 拒绝裸跑（骨架篇 §7.1） */
export const SANDBOX_UNAVAILABLE = registerErrorCode('SANDBOX_UNAVAILABLE');
/** safety：升权请求非法——非严格变宽档位 / sandbox_permissions 与 justification 未成对 / 理由为空句（骨架篇 §7.4） */
export const SANDBOX_ESCALATION_INVALID = registerErrorCode('SANDBOX_ESCALATION_INVALID');
/** safety：sandbox/mode 事件载荷不是三档词汇之一（fold 时 fail-loud——拼错档位静默沿用旧档是 fail-open） */
export const SANDBOX_MODE_INVALID = registerErrorCode('SANDBOX_MODE_INVALID');

/* ------------------------------------------------------------------ */
/* 插件加载器码族（契约篇 §6.2 落码 2026-08-23 M2 加载器本体纵切）——     */
/* 逐行失败进启动断言清单（§1.6 apply 抛错即响，不静默跳过不带病运行）。 */
/* ------------------------------------------------------------------ */

/** plugin：模块 import 失败（jiti 转译/执行入口文件抛错——语法错、依赖缺等） */
export const PLUGIN_LOAD_FAILED = registerErrorCode('PLUGIN_LOAD_FAILED');
/** plugin：模块形状非法（default 非函数 / name 缺失或非字符串 / inject/optionalInject 非 string[] / config schema 非法——契约篇 §1.1/§1.2 单形状纪律） */
export const PLUGIN_SHAPE_INVALID = registerErrorCode('PLUGIN_SHAPE_INVALID');
/** plugin：组合树行 config 未通过插件声明的 schema（启动一次性校验失败即响，契约篇 §1.2） */
export const PLUGIN_CONFIG_INVALID = registerErrorCode('PLUGIN_CONFIG_INVALID');
/** plugin：inject 依赖无法满足（缺提供方或依赖环——轮次激活零进展即判，即刻响亮并列 pending 清单，不做墙上钟超时） */
export const PLUGIN_INJECT_UNRESOLVED = registerErrorCode('PLUGIN_INJECT_UNRESOLVED');
/** plugin：apply 执行抛错（message 载原始错误；作用域 LIFO 回卷半途注册，失败行不留残骸） */
export const PLUGIN_APPLY_FAILED = registerErrorCode('PLUGIN_APPLY_FAILED');
/** plugin：组合树行引用的插件入口解析失败（加载器永不自动安装——启动断言指引安装，契约篇 §6.1 硬规则） */
export const PLUGIN_ENTRY_UNRESOLVED = registerErrorCode('PLUGIN_ENTRY_UNRESOLVED');
/** composition：组合树行 schema 违规（overlay 缺 id / 字段类型错 / 未知字段 / fixed 行被禁用——pre-release 拒绝式，契约篇 §6.5） */
export const COMPOSITION_ROW_INVALID = registerErrorCode('COMPOSITION_ROW_INVALID');

/* ------------------------------------------------------------------ */
/* 事件词汇执法码族（契约篇 §1.1，2026-08-23 M2 /reload 纵切）——        */
/* 「显式注册」的运行时半边：拼错事件名不再静默 no-op。                  */
/* ------------------------------------------------------------------ */

/** events：on/emit/waterfall/parallel/serial 五面遇到未注册事件名（目录 ∪ 装载期 customs 之外——拼错名 = 监听器永不触发的静默死亡，改为响亮失败） */
export const EVENT_UNKNOWN = registerErrorCode('EVENT_UNKNOWN');
/** events：自定义事件登记撞名（与目录或已登记 custom 重名——词汇表拒绝静默覆盖，契约篇 §1.2 events 第四件） */
export const EVENT_DUPLICATE = registerErrorCode('EVENT_DUPLICATE');
/** events：派发方法与事件声明的 mode 不一致（mode 是事件公开契约的一部分——插件侧静态 CI 罩不住，运行时执法） */
export const EVENT_MODE_MISMATCH = registerErrorCode('EVENT_MODE_MISMATCH');
/** plugin：装机子进程失败（npm install / git clone 等退出非零——message 载命令与输出尾行；三源分发见契约篇 §6.1） */
export const PLUGIN_INSTALL_FAILED = registerErrorCode('PLUGIN_INSTALL_FAILED');

/* ------------------------------------------------------------------ */
/* Job 注册表码族（运行时骨架篇 §6.2 落码注记，2026-08-24 subagent 纵切一） */
/* ——kind 词汇与事件词汇同纪律：显式注册、未注册即响亮拒绝。            */
/* ------------------------------------------------------------------ */

/** jobs：创建 Job 用了未注册的 kind（内置 'subagent'/'process'；插件自定义须先 registerKind——反模式 #4「宁拒绝不静默丢」对偶面） */
export const JOB_KIND_UNKNOWN = registerErrorCode('JOB_KIND_UNKNOWN');
/** jobs：JobKind 登记撞名（与内置或已登记 kind 重名——词汇表拒绝静默覆盖） */
export const JOB_KIND_DUPLICATE = registerErrorCode('JOB_KIND_DUPLICATE');
/** jobs：按 id 操纵的 Job 不存在（已结算条目不删除，仅终态后不可再变——NOT_FOUND 即 id 拼错或未创建过） */
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
/* DETACHED 码退役）——sendUserMessage 是插件注入正门：预留位一律响亮拒绝。 */
/* ------------------------------------------------------------------ */

/** agent：sendUserMessage 显式携带 deliverAs（'steer'/'inject' 定向投递为 M2+ 预留位——缺省三通道自适应即全部现行业务所需，显式指定即拒不做半实现） */
export const AGENT_DELIVER_AS_UNSUPPORTED = registerErrorCode('AGENT_DELIVER_AS_UNSUPPORTED');

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

/* ------------------------------------------------------------------ */
/* 应用面码族（契约篇 §5.4 应用面第二纵切，2026-08-25——清单文件唯一源   */
/* 的校验面：清单坏 = 宁拒绝不误读，与组合树行校验同纪律）。            */
/* ------------------------------------------------------------------ */

/** apps：应用清单校验失败（schema 拒绝式——未知字段/缺 id/label、components 空集、id 形状不合法等；message 载位置与首错路径） */
export const APP_INVALID = registerErrorCode('APP_INVALID');
/** apps：应用 id 撞名（官方裸名是保留字——第三方强制含 `/` 域前缀正是防撞官方裸名的碰撞域，契约篇 §5.4 冷读钉死） */
export const APP_DUPLICATE = registerErrorCode('APP_DUPLICATE');
