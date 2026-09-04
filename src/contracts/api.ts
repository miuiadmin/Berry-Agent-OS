/**
 * L0 contracts — API 治理元数据单源 + 协商层纯函数（契约篇 §6.13，2026-09-03
 * 第八十七批落码）。
 *
 * 本文件 = API 面身份层的机器可读真相源（§6.13.1 六真相源中的三处）：
 * - `VIRTUAL_API_KEYS`：虚拟模块键表（键 + tier + since + formFactors——§6.13.3
 *   键级 tier 载体；loader 注入表、抽取器、check-api 三面共取此单源）
 * - `SERVICE_CATALOG`：ctx 服务面目录（§1.5 表的码面镜像——逐符号 tier）
 * - `CAPABILITIES`：能力面目录（surface.json 顶层 capabilities[] 的声明位，
 *   §6.13.5 ctx.host.capabilities 派生源）
 * - `DATA_DESCRIPTOR_API_KEYS`：data.json 词表三档（§1.5 表尾双键一桥面）
 *
 * 加协商层纯函数（§6.13.4 装载门四出口 + 版本比较语义）与 ctx.host 自省面
 * 类型（§6.13.5——HostFace 应用侧形态 / HostFaceData 桥接档纯 JSON 快照）。
 * 全部纯数据/纯函数：零副作用、jiti 可载（工具面 check-api/抽取器直接 import）。
 */
import { AppError } from './errors.js';
import {
  API_EXPERIMENTAL_UNDECLARED,
  API_VERSION_MALFORMED,
  API_VERSION_MISMATCH,
  API_CAPABILITY_MISSING,
} from './errors.js';

/* ---------------- 稳定性四级（§6.13.3） ---------------- */

/**
 * API 稳定性 tier 词汇（§6.13.3 四级表的前三级——internal 结构性不可达不进
 * 公开面，故不在本联合）。stable/experimental 执法粒度 = 键级；deprecated 恒
 * 逐符号。目录宿主符号（本文件各目录 + LiveEventDefinition /
 * SessionEventTypeDefinition）以此类型为**必填字段**——TS 编译期即红扛零隐式
 * （第八十七批载体精化，规范 §6.13.3 标级载体分职句）。
 */
export type ApiTier = 'stable' | 'experimental' | 'deprecated';

/** 运行形态三态（§6.13.10 多形态层；server 形挂账——现役 standalone/daemon） */
export type FormFactor = 'standalone' | 'daemon' | 'server';

/** apiVersion 格式：MAJOR.MINOR 两段（API 面无 patch——§6.13.2） */
const API_VERSION_FORMAT = /^\d+\.\d+$/;

/** 全形态集（capabilities/键表缺省 formFactors 值——登记面少写字面量） */
const ALL_FORM_FACTORS: readonly FormFactor[] = ['standalone', 'daemon', 'server'];

/* ---------------- 真相源 #1：虚拟模块键表（§6.13.1 / §6.13.3 键级载体） ---------------- */

/** 虚拟模块键登记项（§6.13.3 键级 tier 载体——tier 列在此单源） */
export interface VirtualApiKeyEntry {
  /** 虚拟模块说明符（应用 import 所写键名——loader 注入表键域） */
  readonly key: string;
  /** 稳定性 tier（键级单一整键——混合键结构性不设） */
  readonly tier: ApiTier;
  /** 该键进入 API 面的 apiVersion（首快照全 1.0——预置号非承诺起点，§6.13.2 M5） */
  readonly since: string;
  /** 形态适用集（现役六键全形态可用） */
  readonly formFactors: readonly FormFactor[];
  /**
   * 宿主驻留键旗标（API 治理进化刀 G——§1.2 桥接状态纪律终态）：true = 注入物
   * 是宿主进程内活对象（pi-ai provider 工厂面 / 宿主同实例 better-sqlite3 包装），
   * 跨域无等价物——分域行（worker/external 载体）装载期 import 此键由 import
   * 门禁 realm 感知拒绝（§6.13 契约篇 §1.2「宿主驻留面禁被分域行装载引用」）。
   * 纯转发/纯数据键（typebox 三键 + berryagent 桶）任意 realm 安全 = false。
   * 装载器的拒收集从本表机器派生（勿手抄第二清单）。
   */
  readonly hostResident: boolean;
}

/**
 * 虚拟模块键表——六键全 `stable`（§6.13.3「现役六键全 stable」：berryagent/llm
 * 与 berryagent/sqlite 是已落码正路非预览）。loader.ts 的 VIRTUAL_MODULE_KEYS
 * 由本表派生（注入表不另持键单源）；实验件未来以新键 + tier 'experimental' 进。
 * hostResident 列（刀 G）：llm/sqlite 两键注入物是宿主进程内活对象不可过界，
 * 分域装载期拒；其余四键纯转发/纯数据面任意 realm 安全。
 */
export const VIRTUAL_API_KEYS: readonly VirtualApiKeyEntry[] = [
  { key: 'berryagent', tier: 'stable', since: '1.0', formFactors: ALL_FORM_FACTORS, hostResident: false },
  { key: 'typebox', tier: 'stable', since: '1.0', formFactors: ALL_FORM_FACTORS, hostResident: false },
  { key: 'typebox/value', tier: 'stable', since: '1.0', formFactors: ALL_FORM_FACTORS, hostResident: false },
  { key: 'typebox/compile', tier: 'stable', since: '1.0', formFactors: ALL_FORM_FACTORS, hostResident: false },
  { key: 'berryagent/llm', tier: 'stable', since: '1.0', formFactors: ALL_FORM_FACTORS, hostResident: true },
  { key: 'berryagent/sqlite', tier: 'stable', since: '1.0', formFactors: ALL_FORM_FACTORS, hostResident: true },
];

/* ---------------- 真相源 #2：ctx 服务面目录（§1.5 表码面镜像） ---------------- */

/** ctx 具名服务目录项（逐符号 tier——§6.13.3 非虚拟键面半边） */
export interface ServiceCatalogEntry {
  /** ctx.get(name) 服务名（官方名位单段式） */
  readonly name: string;
  /** 服务归属模块（§1.5 表「归属模块」列） */
  readonly module: string;
  /**
   * 服务面契约接口名（API 治理进化刀 B——§6.13.4 方法级符号）：指向宿主模块
   * 公开面导出的 interface 声明名（provide 对象 satisfies 本型——面漂移编译期
   * 即红）。抽取器按 module 列寻址接口源文件、枚举其成员，每方法/属性一符号
   * 进 surface.json exports[]（module='services'，symbol=`服务名.成员名`）。
   * 接口缺失的宿主模块同笔补契约接口声明（§6.13.4 刀 B 条款）。
   */
  readonly faceInterface: string;
  /** 一句话语义（§1.5 表同列——surface.json 文档面消费） */
  readonly note: string;
  /** 稳定性 tier（必填——零隐式载体） */
  readonly tier: ApiTier;
}

/**
 * ctx 服务面目录：§1.5 表服务行的码面镜像（host API 面的服务半边——surface.json
 * 逐条收录）。新增 ctx.provide 官方服务时同笔增条（drift 闸守快照，目录本身是
 * 声明面——声明即 API）。memory/schedule 两面现役以工具/挂钟形态提供（非 ctx
 * 具名服务），不在此列；首条真实 ctx.memory 服务落地时增条。
 */
export const SERVICE_CATALOG: readonly ServiceCatalogEntry[] = [
  {
    name: 'agent',
    module: 'chat',
    faceInterface: 'AgentServiceFace',
    note: '对话驱动控制（sendUserMessage 等官方件面）',
    tier: 'stable',
  },
  {
    name: 'tools',
    module: 'tools',
    faceInterface: 'ToolsService',
    note: '工具注册面（register/listFor——S2 两层模型）',
    tier: 'stable',
  },
  {
    name: 'sessions',
    module: 'session',
    faceInterface: 'SessionsServiceFace',
    note: '会话事件读写与投影导线（appendEvent/deriveMessages 等）',
    tier: 'stable',
  },
  {
    name: 'llm',
    module: 'llm',
    faceInterface: 'LlmService',
    note: '模型服务面（complete 单发等——pi-ai 适配层）',
    tier: 'stable',
  },
  {
    name: 'jobs',
    module: 'subagent',
    faceInterface: 'JobsServiceFace',
    note: 'Job 注册表（终态条目结算序保留帽 256）',
    tier: 'stable',
  },
  {
    name: 'subagents',
    module: 'subagent',
    faceInterface: 'SubagentsServiceFace',
    note: '委派 provider 注册与程序化发起',
    tier: 'stable',
  },
  {
    name: 'prompts',
    module: 'app',
    faceInterface: 'PromptsService',
    note: 'systemPrompt 具名追加段注册',
    tier: 'stable',
  },
  {
    name: 'paths',
    module: 'app',
    faceInterface: 'PathsService',
    note: '目录服务（dataDir/appDataDir/workspaceRoot）',
    tier: 'stable',
  },
  {
    name: 'apps',
    module: 'app',
    faceInterface: 'AppsService',
    note: '装载管理 reconciliation 进程内服务',
    tier: 'stable',
  },
  {
    name: 'skills',
    module: 'skills',
    faceInterface: 'SkillsService',
    note: '技能来源注册（skills_change 广播）',
    tier: 'stable',
  },
  {
    name: 'approval',
    module: 'safety',
    faceInterface: 'ApprovalService',
    note: '动作级审批（ask/never/allowed-once）',
    tier: 'stable',
  },
  {
    name: 'sandbox',
    module: 'safety',
    faceInterface: 'SandboxService',
    note: '沙箱纯包装（三档文件效果词汇）',
    tier: 'stable',
  },
  {
    name: 'exec',
    module: 'exec',
    faceInterface: 'ExecService',
    note: 'spawn 管道服务（进程组树杀/超时归因）',
    tier: 'stable',
  },
  {
    name: 'fetch',
    module: 'web',
    faceInterface: 'WebService',
    note: '受控 fetch 原语（SSRF 五卫生件同面）',
    tier: 'stable',
  },
  {
    name: 'channels',
    module: 'channels',
    faceInterface: 'ChannelsService',
    note: '通道服务面（多会话呈现/提问队列）',
    tier: 'stable',
  },
  {
    name: 'ui',
    module: 'channels',
    faceInterface: 'UiService',
    note: '观众面（notify 广播/hasAudience 探针）',
    tier: 'stable',
  },
  {
    name: 'browser',
    module: 'browser',
    faceInterface: 'BrowserService',
    note: '浏览器自动化服务面（CDP 桥）',
    tier: 'stable',
  },
  {
    name: 'compaction',
    module: 'compaction',
    faceInterface: 'CompactionServiceFace',
    note: '长会话压缩触发面（闲时重播种等）',
    tier: 'stable',
  },
];

/* ---------------- 真相源 #6：data.json 词表三档（§1.5 表尾双键一桥） ---------------- */

/** data.json 描述符键目录项（形状真相 = src/app/apps.ts AppDataDescriptor——本目录记 API 面 tier） */
export interface DescriptorKeyEntry {
  /** data.json 顶键名 */
  readonly key: string;
  /** 语义（§1.5 表尾三档） */
  readonly note: string;
  /** 稳定性 tier（必填——零隐式载体） */
  readonly tier: ApiTier;
}

/**
 * data.json 词表三档（§1.5 表尾「双键一桥」面）：app（认领键）/ declaredEvents
 * （词表账本）/ cacheSubdir（缓存免删信任子目录——布局预留）。宿主单写单读，
 * 应用不直读——但属已拍板数据布局面，surface.json 收录供 diff 判级。
 */
export const DATA_DESCRIPTOR_API_KEYS: readonly DescriptorKeyEntry[] = [
  { key: 'app', note: '跨行 id 改名的数据认领凭据（收割 named export name 兜底行 id）', tier: 'stable' },
  { key: 'declaredEvents', note: '自定义事件词名清单（null = 收割失败 unknown 档）', tier: 'stable' },
  { key: 'cacheSubdir', note: '免删信任缓存子目录（布局预留字段）', tier: 'stable' },
];

/* ---------------- 能力面目录（§6.13.5 capabilities 派生源） ---------------- */

/** 能力目录项（surface.json 顶层 capabilities[] 的声明位形态） */
export interface CapabilityEntry {
  /** 能力名：`件域.能力` 两段式（§6.13.5 名空间——字符集与事件词汇同纪律） */
  readonly name: string;
  /** 形态适用集（现役两形态；server 形随真实落码登记） */
  readonly formFactors: readonly FormFactor[];
  /** 提供方（官方件行引用形——能力是件的语义单位非符号投影） */
  readonly providedBy: string;
}

/**
 * 能力面目录：官方可卸件能力起算集（§6.13.5——ctx.host.capabilities 读此层）。
 * 语义 = **本构建面**（编译进包即有——组合树是否挂载属运行时态，由 ctx.apps.list
 * 回答，两问不混）。构建差能力（如 OSS 构建缺 browser.cloudDriver）随真实构建
 * 分叉日登记。
 */
export const CAPABILITIES: readonly CapabilityEntry[] = [
  { name: 'memory.store', formFactors: ['standalone', 'daemon'], providedBy: 'builtin:memory' },
  { name: 'subagent.delegate', formFactors: ['standalone', 'daemon'], providedBy: 'builtin:subagent' },
  { name: 'goal.autopilot', formFactors: ['standalone', 'daemon'], providedBy: 'builtin:goal' },
  { name: 'scheduler.tick', formFactors: ['standalone', 'daemon'], providedBy: 'builtin:scheduler' },
  { name: 'mcp.bridge', formFactors: ['standalone', 'daemon'], providedBy: 'builtin:mcp' },
  { name: 'web.fetch', formFactors: ['standalone', 'daemon'], providedBy: 'builtin:web' },
  { name: 'compaction.longSession', formFactors: ['standalone', 'daemon'], providedBy: 'builtin:compaction' },
  { name: 'admin.apps', formFactors: ['standalone', 'daemon'], providedBy: 'builtin:admin' },
  { name: 'checkpoint.rewind', formFactors: ['standalone', 'daemon'], providedBy: 'builtin:checkpoint' },
  { name: 'lsp.bridge', formFactors: ['standalone', 'daemon'], providedBy: 'builtin:lsp' },
  { name: 'channels.multi', formFactors: ['standalone', 'daemon'], providedBy: 'builtin:channels' },
  { name: 'web.channel', formFactors: ['standalone', 'daemon'], providedBy: 'builtin:webui' },
  { name: 'obs.metrics', formFactors: ['standalone', 'daemon'], providedBy: 'builtin:obs' },
  { name: 'browser.automation', formFactors: ['standalone', 'daemon'], providedBy: 'builtin:browser' },
];

/* ---------------- 版本比较与装载门（§6.13.4） ---------------- */

/**
 * apiVersion 比较（§6.13.4 版本比较语义）：MAJOR.MINOR 逐段数值比较——禁字符串
 * 比较（"1.10" > "1.9"）。格式非法抛 API_VERSION_MALFORMED（调用方 = 清单
 * 校验后的执法面，正常路径格式已验；错误码名勘正——遗漏大扫 20260904 U0）。
 * @returns 负数 = a < b；0 = 相等；正数 = a > b
 */
export function compareApiVersions(a: string, b: string): number {
  const pa = parseApiVersion(a);
  const pb = parseApiVersion(b);
  return pa[0] !== pb[0] ? pa[0] - pb[0] : pa[1] - pb[1];
}

/**
 * API 族错误消息公共指路尾注（公开锚——查 10：运行时字符串不得指路知识域）。
 *
 * 指路目标 = 仓库公开文档面（docs/应用开发指南.md「API 稳定性与兼容性」节 +
 * COMPATIBILITY.md）——第三方应用作者顺错误消息可达；知识域篇名/章节号
 * （gitignored）禁入运行时字符串（§6.13.8 查 10——机器面由 check-api 查 10
 * 执法，滤词单源在 tools/api-doc-sections.mjs）。本模块四条拒载消息统一缀此
 * 尾注：拒载消息自带「下一步去哪读」。模块私有（不入公开根分桶—— INTERNAL_
 * API_EXPORTS 白名单无需扩）。
 */
const API_DOC_ANCHOR_NOTE = 'API 治理语义见 docs/应用开发指南.md「API 稳定性与兼容性」节与仓库 COMPATIBILITY.md。';

/** 解析 apiVersion 为 [MAJOR, MINOR] 数值对；格式非法即抛（单点执法） */
function parseApiVersion(v: string): [number, number] {
  if (!API_VERSION_FORMAT.test(v)) {
    throw new AppError(
      API_VERSION_MALFORMED,
      `apiVersion 格式非法：${v}（应为 MAJOR.MINOR，如 "1.0"）${API_DOC_ANCHOR_NOTE}`,
    );
  }
  const [major, minor] = v.split('.');
  return [Number(major), Number(minor)];
}

/**
 * 断言 apiVersion 格式合法（清单校验面用——错误归 APP_INVALID 语境由调用方包，
 * 本函数只做纯格式判定的复用体）。
 */
export function isValidApiVersion(v: string): boolean {
  return API_VERSION_FORMAT.test(v);
}

/**
 * API 兼容执法收剑点火位（契约篇 §6.13.4「批 4 翻必填」+ §6.13.12「机器建设
 * 在窗口内、兼容执法单点收剑」——2026-09-03 第九十一批落位）。
 *
 * - `false`（现役）= pre-release 窗口容忍态：api 块缺席走 legacy 出口聚合 warn；
 * - `true`（首个 dist-tag=latest 当笔翻转）= 点火：api 块缺席从 warn 变拒载
 *   （`API_VERSION_MISMATCH`），min fail-loud 对全体应用生效。
 *
 * **散拷禁令**：常量消费面恰两处（全面复盘 20260903-91 刀五扩面——就绪度审计
 * 20260903 P2 勘正注释）——adjudicateApiGate 出口 4（行为面：缺块 warn/拒载）
 * 与抽取器 enforcement 纪元章（tools/extract-api-surface.mjs——只读单源盖章
 * 进面快照，不改不散播，§6.13.4 点火可见性立条）；测试经纯函数 `ignited`
 * 参数注入两态，不改常量。点火日翻转 = 改此单点 + 同笔测试 + 快照再生成
 * （enforcement 纪元章随翻转变色——查 1 自然拦）。
 */
export const API_ENFORCEMENT_IGNITED = false;

/** 清单 api 块形状（AppManifestSchema 的 api 键运行时形——§6.13.4） */
export interface ApiBlock {
  /** 硬地板：宿主 apiVersion < min 即拒载（api 块在场则必填） */
  readonly minApiVersion: string;
  /** 行为锚（可选——缺省 = min 粘性锚：不声明恒持 min 时点面） */
  readonly targetApiVersion?: string;
  /** 实验键启用声明（键级——import 实验键未声明 = 装载期拒） */
  readonly experimental?: readonly string[];
}

/** 装载门裁决结果（§6.13.4 四出口的机器形态——legacy 态不拒载只聚合 warn） */
export interface ApiGateResult {
  /** 出口：legacy（api 块缺席）/ admit（三兼容出口统称——钳制细节见 effectiveTarget） */
  readonly status: 'legacy' | 'admit';
  /** 生效 target = min(宿主 apiVersion, targetApiVersion)（钳制出口的核心值） */
  readonly effectiveTarget: string;
  /** 声明的实验键集合（experimental import 门禁数据源——loader 消费） */
  readonly experimentalKeys: ReadonlySet<string>;
}

/**
 * 装载门序（§6.13.4 四出口全定义，冷读 B2 裁决形态）。纯函数：清单 api 块 ×
 * 宿主 apiVersion → 裁决。出口：
 * 1. 宿主 < min → 抛 `API_VERSION_MISMATCH`（拒载——message 载 expected/actual/
 *    升级指引三段）；
 * 2. min ≤ 宿主 < target → 钳制不警示（生效 target = min(宿主, target)）；
 * 3. 宿主 > target → 正常兼容态不警示（editions 设计目的）；
 * 4. api 块缺席 → 点火前 status 'legacy'（调用方聚合 per-boot warn）；点火后
 *    （`API_ENFORCEMENT_IGNITED` 翻 true）抛 `API_VERSION_MISMATCH` 拒载——
 *    「批 4 翻必填」的唯一机器翻转点。
 * 格式/不变式（min ≤ target）由清单校验先执法（validateAppManifest）——本函数
 * 防御式复验格式，不变式信任前置校验。
 *
 * @param ignited 点火位注入（缺省 = `API_ENFORCEMENT_IGNITED` 常量单源——测试
 *   两态注入专用参数，产码调用点不传）。
 */
export function adjudicateApiGate(
  api: ApiBlock | undefined,
  hostApiVersion: string,
  appId: string,
  ignited: boolean = API_ENFORCEMENT_IGNITED,
): ApiGateResult {
  // 出口 4：api 块缺席——点火前 legacy 容忍态（面/行为按宿主当前——不进任何兼容
  // 模式）；点火后拒载（min fail-loud 全体生效的机器形态）
  if (api === undefined) {
    if (ignited) {
      throw new AppError(
        API_VERSION_MISMATCH,
        `应用 ${appId} 清单缺 api 块——兼容执法已点火（api 块必填），` +
          `须在 .app.yaml 补 ` +
          `api:\n  minApiVersion: <宿主当前 apiVersion 或更旧>` +
          `\n（批 4 翻必填——min fail-loud 与兼容模式对全体应用生效）。${API_DOC_ANCHOR_NOTE}`,
      );
    }
    return { status: 'legacy', effectiveTarget: hostApiVersion, experimentalKeys: new Set() };
  }
  const min = api.minApiVersion;
  const target = api.targetApiVersion ?? min; // 粘性锚：缺省 = min 的值
  parseApiVersion(min); // 防御式格式复验（前置校验已红过一次）
  parseApiVersion(hostApiVersion);
  // 出口 1：硬地板拒载（fail-loud 三段消息）
  if (compareApiVersions(hostApiVersion, min) < 0) {
    throw new AppError(
      API_VERSION_MISMATCH,
      `应用 ${appId} 声明 minApiVersion ${min}，宿主 API 面版本 ${hostApiVersion} 低于地板——拒载。` +
        `升级指引：升级 berry-agent-os 宿主包（npm i -g berry-agent-os@latest）或联系应用作者放宽 minApiVersion。${API_DOC_ANCHOR_NOTE}`,
    );
  }
  // 出口 2/3：钳制与兼容统称 admit——生效 target = min(宿主, target)（钳制出口
  // 的值在兼容出口自然等于 target，两出口同式不分支——「钳制不警示」的机器形态）
  const effectiveTarget = compareApiVersions(hostApiVersion, target) < 0 ? hostApiVersion : target;
  return { status: 'admit', effectiveTarget, experimentalKeys: new Set(api.experimental ?? []) };
}

/**
 * experimental import 门禁（§6.13.4 执法点——与 transform 门禁同执法位的纯裁决核）：
 * import 实验键而清单未声明 → 抛 `API_EXPERIMENTAL_UNDECLARED`。契约即知情：
 * 能用可破面 = 你签了字。键表之外的说明符不属本门禁（白名单三道另辖）。
 */
export function assertExperimentalDeclared(
  specifier: string,
  declared: ReadonlySet<string>,
  appId: string | undefined,
): void {
  const entry = VIRTUAL_API_KEYS.find((k) => k.key === specifier);
  if (entry === undefined || entry.tier !== 'experimental') return;
  if (declared.has(specifier)) return;
  throw new AppError(
    API_EXPERIMENTAL_UNDECLARED,
    `import 实验键 ${specifier} 未在清单声明——应用 ${appId ?? '(未知应用)'} 须在 .app.yaml ` +
      `api 块 experimental 数组显式点名该键方能启用（契约即知情：实验键任意 minor 可破可删）${API_DOC_ANCHOR_NOTE}`,
  );
}

/**
 * 能力需求执法核（§6.13.10——server 形装载器拒绝要求缺席能力的应用的纯裁决体；
 * 现役 standalone/daemon 全能力在构建面，真实消费方 = server 形装载器〔挂账〕）。
 * 能力缺席即抛 `API_CAPABILITY_MISSING`（结构化 message 载缺席清单与形态差说明）。
 */
export function requireCapabilities(
  required: readonly string[],
  present: ReadonlySet<string>,
  formFactor: FormFactor,
  appId: string,
): void {
  const missing = required.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new AppError(
      API_CAPABILITY_MISSING,
      `应用 ${appId} 要求能力 [${missing.join(', ')}]，本构建（形态 ${formFactor}）不提供——` +
        `server 形 API 面是显式能力集非「少装几个件」。${API_DOC_ANCHOR_NOTE}`,
    );
  }
}

/* ---------------- ctx.host 自省面（§6.13.5） ---------------- */

/**
 * 宿主自省面——应用问宿主，而非探测猜（dsh 病根正解；§6.13.5 面定义）。
 * 应用侧经 `ctx.host` 只读取得；装配根一次性注入（ContextRuntime 持有，fork
 * 共享运行时天然级联）。
 */
export interface HostFace {
  /** 宿主包版本（package.json version） */
  readonly version: string;
  /** API 面版本（package.json apiVersion——§6.13.2 独立号） */
  readonly apiVersion: string;
  /** 运行形态（standalone 单机缺省 / daemon 常驻 / server 多租户挂账） */
  readonly formFactor: FormFactor;
  /** 本构建面能力集（has = 构建面有无，非组合树挂载态——两问不混） */
  readonly capabilities: {
    has(name: string): boolean;
    list(): string[];
  };
  /** 实验面启用探针：键在本构建面在场且 tier = experimental */
  readonly experimental: {
    enabled(name: string): boolean;
  };
}

/**
 * HostFace 的纯 JSON 数据快照（冷读 m5 桥接档过河物）：worker 域/外部载体桥
 * 只传数据、对岸物化同形只读面——方法面（has/list/enabled）由宿主与对岸各自
 * 在快照上派生，不随桥走。
 */
export interface HostFaceData {
  readonly version: string;
  readonly apiVersion: string;
  readonly formFactor: FormFactor;
  /** 能力名清单（has/list 的数据底座——派生源 surface.json capabilities[]） */
  readonly capabilities: readonly string[];
  /** 实验键清单（experimental.enabled 的数据底座——键表 tier=experimental 子集） */
  readonly experimentalKeys: readonly string[];
}

/** 由数据快照物化 HostFace（宿主与 worker 对岸共用同形构造——桥接纪律 m5） */
export function materializeHostFace(data: HostFaceData): HostFace {
  const capabilitySet = new Set(data.capabilities);
  const experimentalSet = new Set(data.experimentalKeys);
  return {
    version: data.version,
    apiVersion: data.apiVersion,
    formFactor: data.formFactor,
    capabilities: {
      has: (name: string) => capabilitySet.has(name),
      list: () => [...capabilitySet],
    },
    experimental: {
      enabled: (name: string) => experimentalSet.has(name),
    },
  };
}
