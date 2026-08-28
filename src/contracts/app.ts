/**
 * L0 contracts — 应用清单契约（契约篇 §5.4 应用面第二纵切，2026-08-25 落码）。
 *
 * 应用 = 应用组装的声明面：**清单文件是应用包唯一源**（第十六批 B 案拍板——
 * 废 named export `apps` 通道，一个包可携带 0..N 份清单，清单引用组件件）。
 * 本文件只定 schema 与校验；yaml 解析、目录发现、组件在场断言归 app 组合层
 * （app/app-registry.ts——冷读裁决：解析归 app 层，yaml 依赖已在 app）。
 *
 * 拒绝式纪律（pre-release 窗口）：未知字段即 APP_INVALID，不做宽容读取——
 * 与 overlay 行校验、应用 config 校验同纪律。
 */

import { AppError, APP_INVALID } from './errors.js';
import { Type, type Static, type TSchema } from './typebox.js';
import { Value } from 'typebox/value';

/**
 * 应用 id 形状：小写段（字母数字开头，可含 . _ -），可选单层 `/` 域前缀。
 * 官方清单可用裸名（保留字——chat/hermes 等）；第三方清单强制含 `/`
 * （防撞官方裸名 = APP_DUPLICATE 碰撞域）。「第三方必含 /」由第三方发现面
 * 执法（装载身份串规则同源），schema 层两形皆合法。
 */
const APP_ID_PATTERN = '^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)?$';

/**
 * 应用 id 形状正则源（组成行 apps 数组元素校验共用——第三十六批作用域数组化
 * 导出；清单 schema 与组合树行校验同源单一定义）。
 */
export const AppIdPattern = APP_ID_PATTERN;

/** 应用清单 schema（契约篇 §5.4——拒绝式，additionalProperties: false 全层贯穿） */
export const AppManifestSchema = Type.Object(
  {
    /** 应用 id（裸名 = 官方保留字；含 / = 第三方域前缀。会话域打标 sessions.app 用此值） */
    id: Type.String({ minLength: 1, pattern: APP_ID_PATTERN }),
    /** 人读标签（UI 文案位——/app 清单、dump-config 打印） */
    label: Type.String({ minLength: 1 }),
    /**
     * 组件清单（按装载身份串解析：`builtin:<name>` / npm 包名——匹配键 = 组合树
     * 行 plugin 字段的值域，不按行 id、不按 module.name）。在场断言装载期执行：
     * 缺场 = 应用级隔离（不拒启），诊断走 dump-config + debug 日志。
     */
    components: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    /** 代理装配默认位（model/persona/toolFilter 已于第三纵切落码消费——chat 件 open 装配；skills 键已收未消费） */
    agent: Type.Optional(
      Type.Object(
        {
          /** 缺省模型标识（"provider/model-id"） */
          model: Type.Optional(Type.String({ minLength: 1 })),
          /** 人格提示词（对应面 SubagentStart.persona——第三纵切起消费于 chat 件 open 装配） */
          persona: Type.Optional(Type.String()),
          /** 工具白名单（对应面 SubagentStart.toolFilter——工具名数组） */
          toolFilter: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          /** 技能集（装配默认位——技能 id 数组） */
          skills: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        },
        { additionalProperties: false },
      ),
    ),
    /** 启动面声明（三形态：前台 /app 与委派 delegable 已消费；后台 jobs 消费面挂账——见 background 注） */
    entry: Type.Optional(
      Type.Object(
        {
          /** 前台命令名（TUI `/app <command>` 进入；缺省无前台入口） */
          command: Type.Optional(Type.String({ minLength: 1 })),
          /** 是否可被委派启动（true = 自动注册为委派目标） */
          delegable: Type.Optional(Type.Boolean()),
          /** 是否可作为后台 job 常驻（消费面挂账：清单→job 启动导线 v1 未接，接线窗 = 真实后台应用需求 / ctx.schedule 落地） */
          background: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    /** 授权申请（装载期与守门行 grants 交集；approval 预设槽位已收键〔第二十四批案 C〕——§5.4 第 4 条；writableRoots 交集导线 v1 挂账，随 D2 或首个真实第三方应用清单接线） */
    grants: Type.Optional(
      Type.Object(
        {
          /** 申请的可写根（绝对路径；与 safety 守门行安装面交集后生效——交集导线 v1 未接，挂账见上） */
          writableRoots: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          /**
           * 审批预设槽位申请（第二十四批案 C）：应用申请 (sandboxMode, approvalPolicy)
           * 打包预设，装配层解析为两 knob 装配参数。词汇镜像 safety 面
           * SandboxMode / ApprovalPolicyMode（contracts 不依赖 safety——DAG 反向；
           * 装配点类型收窄双保险）。优先序 = 显式旗标 > 应用预设 > 全局缺省。
           */
          approval: Type.Optional(
            Type.Object(
              {
                /** 沙箱档预设（'read-only' | 'workspace-write' | 'danger-full-access'） */
                sandboxMode: Type.Optional(
                  Type.Union([
                    Type.Literal('read-only'),
                    Type.Literal('workspace-write'),
                    Type.Literal('danger-full-access'),
                  ]),
                ),
                /** 审批策略预设（'ask' | 'never'） */
                approvalPolicy: Type.Optional(Type.Union([Type.Literal('ask'), Type.Literal('never')])),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    /** 预算声明（canAfford app 维数据源——未声明 = 恒 true 不闸） */
    budget: Type.Optional(
      Type.Object(
        {
          /** 当日 tokens 限额（in+out 合计；跨运行聚合 = subagent per-child tokenBudget 的日聚合版） */
          dailyTokens: Type.Integer({ minimum: 1 }),
          /**
           * 内存维度预算（MB，正整数）：应用组件命中 worker 行时装载期映射
           * resourceLimits.maxOldGenerationSizeMb（Node 原生执法）；多应用共享
           * 组件取最严（min）；main 域组件无硬执行面（声明性）。缺省 = 宿主
           * 全局 512MB 兜底。
           */
          memoryMb: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** 应用清单（schema 静态推导类型——校验通过的产物形状） */
export type AppManifest = Static<typeof AppManifestSchema>;

/**
 * 校验应用清单（拒绝式——坏清单 APP_INVALID 响亮拒绝，message 载位置与首错路径）。
 * @param raw yaml 解析产物（unknown——调用方保证来自解析器）
 * @param where 诊断位置串（如 `apps/hermes.app.yaml`——错误信息锚点）
 * @returns 通过校验的清单（原对象引用——schema 无默认值填充，零拷贝）
 */
export function validateAppManifest(raw: unknown, where: string): AppManifest {
  if (!Value.Check(AppManifestSchema as TSchema, raw)) {
    // typebox 1.x 错误载荷字段是 instancePath（JSON 指针）——首错位置进诊断（与加载器 config 校验同惯例）
    const first = [...Value.Errors(AppManifestSchema as TSchema, raw)].at(0);
    const loc = first ? first.instancePath || first.schemaPath || '(根)' : '(根)';
    throw new AppError(
      APP_INVALID,
      `${where}：应用清单校验失败（首错位置 ${loc}：${first?.message ?? '形状不符'}——拒绝式 schema，未知字段/缺字段/类型错皆拒）`,
    );
  }
  return raw as AppManifest;
}

/* ------------------------------------------------------------------ */
/* prompts 服务面（契约篇 §1.5 服务行 + §1.2 注记④——类型单一来源住     */
/* contracts，2026-08-25 Hermes 探针 #11 落码；app/prompts.ts 实现之，  */
/* 第三方经 ctx.get<PromptsService>('prompts') 取全类型）              */
/* ------------------------------------------------------------------ */

/** 具名提示词段（pi-4(a) 拍板）：id 小写含 `/` 应用域前缀（宿主自留地为无 `/`） */
export interface PromptSection {
  /** 段 id（应用域前缀防撞；分节序按 id 字典序——/reload 稳定） */
  readonly id: string;
  /**
   * 内容渲染：仅在重建时点求值一次，产物随快照冻结（抛错不杀重建——渲染诊断占位）。
   *
   * 语境参数（S2，契约篇 §1.3 落码形态①）：`sessionId` = 本次物化归属的会话键——
   * 会话键控段（如记忆简报）用它冻结**该会话**的基线（多驱动并存各归各纪元）；
   * `undefined` = 诊断物化（无会话语界——只渲染内容，不冻结任何基线）。
   */
  render(sessionId?: string): string;
}

/** ctx.prompts 服务面（注册 systemPrompt 具名追加段） */
export interface PromptsService {
  /**
   * 注册具名段；返回注销函数（挂调用方作用域 effect 由应用侧负责）。
   * 注册/注销均广播 prompts_change（载荷 = 现行段 id 清单，字典序）。
   */
  registerSection(section: PromptSection): () => void;
  /** 现行段 id 清单（字典序——载荷与诊断面同源） */
  listSections(): readonly string[];
  /**
   * 具名段物化（id 字典序拼接，段间空行分隔）：render() 抛错 = 应用 bug，
   * 宿主捕获后渲染诊断占位 + log error，不杀重建（与失败行不杀进程同根）。
   * 无段返回 ''（调用方 filter 掉——不产生空分节）。
   *
   * `sessionId` 透传给各段 render（语境参数——会话键控段冻结该会话基线；
   * 缺省 = 诊断物化，不冻结）。
   */
  materialize(sessionId?: string): string;
}

/* ============================================================================
 * 应用模块形状 + 组合树行 + 装载计划契约（原 contracts/plugin.ts 并入，
 * 第三十六批「一切皆应用」词汇笔拍板 6——装载单位词汇统一 app，契约面单文件收口）。
 * 三个词汇族：
 * 1. 应用模块形状（AppModule——契约篇 §1.1 单形状钉死 + §1.2 named export 三件）；
 * 2. 组合树行（CompositionRow——§5.1 空根 + 官方默认层 + 用户 overlay）；
 * 3. 装载计划与生命周期载荷（AppPlanRow / App*Payload——§2.2 增补 1 事件组）。
 * AppContext（§1.2 落码注记④）：应用作者看到的 ctx 核心面在此声明——第三方经
 * `berryagent` 虚拟面取完整类型；宿主 context 模块的 Context 结构性覆盖本面
 * （vitest expect-type 编译期锁，漂移即红）。服务面不在 ctx 上，经
 * get<ToolsService>('tools') 等取用（接口同住 contracts）。
 * ==========================================================================*/
import type { LiveEventDefinition } from './events.js';
import type { MessageRoleDefinition } from './messages.js';
import type { SessionEventTypeDefinition } from './session-events.js';

/**
 * 装载面 logger 最小结构（context.Logger 的结构子集——contracts 零依赖层
 * 不引 context 模块；宿主 Logger 字段更宽，结构性可赋值到本面）。
 */
export interface AppLogger {
  /** 最低优先级诊断（dev 缺省开；纪律红线：只在 debug 出现的行为必须另有 durable 面） */
  debug(message: string, fields?: Record<string, unknown>): void;
  /** 常规运行信息 */
  info(message: string, fields?: Record<string, unknown>): void;
  /** 异常但可继续（降级/回退路径） */
  warn(message: string, fields?: Record<string, unknown>): void;
  /** 失败留痕（不中断的回卷异常等） */
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 事件处理器：参数由事件发布方约定；返回值仅 waterfall 采用（与 context
 * 模块 EventHandler 同形——在此独立声明保持零依赖）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 处理器参数形态由各事件定义方收口
export type AppEventHandler = (...args: any[]) => any;

/**
 * 装载运行时核心 API（骨架篇 §9.1 的应用视图——§1.2 注记④）。
 * 宿主 Context 结构性覆盖本面；服务解析后经 get<T>() 取具体服务接口。
 */
export interface AppContext {
  /** 注册可逆副作用：立即执行 fn，其返回的清理函数入栈；作用域销毁按 LIFO 自动回卷 */
  effect(fn: () => () => void): () => void;
  /** 订阅事件；返回退订函数（随作用域卸载自动退订）；prepend 插队首位（守门拦截器用） */
  on(event: string, handler: AppEventHandler, opts?: { prepend?: boolean }): () => void;
  /** 广播事件：全部监听器触发；单个失败隔离（记 error 日志，不中断其余） */
  emit(event: string, ...args: unknown[]): void;
  /** 并发触发全部监听器并等待完成；异常隔离同 emit */
  parallel(event: string, ...args: unknown[]): Promise<void>;
  /** 按注册序串行触发全部监听器；异常隔离（失败记日志、继续下一个） */
  serial(event: string, ...args: unknown[]): Promise<void>;
  /**
   * 瀑布链：末位参数 next 是链尾委托；每个监听器收到 (...args, next)，
   * 必须调用 next() 才继续下游——不调即短路（工具管道三段依赖此语义）。
   */
  waterfall<T>(event: string, ...argsWithNext: unknown[]): Promise<T>;
  /** 取服务实现；未注册抛 CONTEXT_SERVICE_NOT_FOUND（必需依赖——缺即装配错误） */
  get<T = unknown>(name: string): T;
  /** 软依赖探测取服务：未注册返回 undefined、不抛错（禁轮询/鸭子探测——缺即降级分支） */
  tryGet<T = unknown>(name: string): T | undefined;
  /** 注册自有具名服务供他应用 inject 消费；返回注销函数（随作用域回卷） */
  provide<T>(name: string, impl: T): () => void;
  /**
   * 注册自定义消息角色（骨架篇 §2.3——装载面）：角色名必含 `/` 域前缀
   * （`memory/recall` 式）；格式非法 AGENT_ROLE_INVALID、撞名/撞标准角色
   * AGENT_ROLE_EXISTS。挂作用域 effect 栈随卸载自动回卷（与 on/provide 同
   * 纪律）；返回值供提前手动注销。官方件同走此面（官方非特权）。
   */
  registerMessageRole(name: string, definition: MessageRoleDefinition): () => void;
  /**
   * 注册应用自有会话事件词汇（会话篇 §2.1——appendEvent 的钥匙）：type 小写
   * 斜线式 `<域>/<动作>`；核心词拒注册 SESSION_CORE_TYPE_FORBIDDEN（内核词
   * 写入权属宿主）；surface 类别词汇负有投影折叠形态声明义务（v1 规范钉死）。
   * 挂作用域 effect 栈随卸载自动回卷（/reload 重装重注册）；返回值供提前
   * 手动注销。注册成功后 ctx.sessions.appendEvent(type, data) 即可写。
   */
  registerSessionEventType(def: SessionEventTypeDefinition): () => void;
  /** 本作用域配置视图（只读快照；组合树行 config 经应用 schema 校验后冻结） */
  readonly config: Readonly<Record<string, unknown>>;
  /** 带作用域前缀的子 logger */
  readonly logger: AppLogger;
  /** 生命周期信号：作用域销毁时 abort——长任务/定时器的取消依据 */
  readonly signal: AbortSignal;
}

/**
 * 应用唯一合法形状（§1.1）：一种函数，钉死。
 * 同步或异步初始化均可；接收 ctx（AppContext——§1.2 注记④ 实类型面）与
 * 经 schema 校验后的只读配置。
 */
export type AppApply = (ctx: AppContext, config?: Readonly<Record<string, unknown>>) => void | Promise<void>;

/**
 * 应用模块的运行时契约（§1.2 named export 四件 + default）。
 * 加载器按此做形状校验（APP_SHAPE_INVALID），不做声明合并、不分派多形状。
 */
export interface AppModule {
  /** 入口函数：注册自身贡献（一切注册走 ctx.effect/可逆注册 API——注册即 effect） */
  default: AppApply;
  /** 行 id/日志归因标识（必填、非空字符串；与组合树行 id 可不同——不一致时告警不拒绝） */
  name: string;
  /** 硬依赖服务清单：声明即等待（轮次激活——全就绪才激活，无解响亮失败） */
  inject?: readonly string[];
  /** 软依赖服务清单：不阻塞激活、不超时失败；激活后经 ctx.tryGet 探测（缺省 undefined） */
  optionalInject?: readonly string[];
  /** 配置 JSON Schema（TypeBox 生成或手写）：组合树行 config 据此启动时一次性校验 */
  config?: TSchema;
  /**
   * 自定义活体事件声明（§1.1 逃生口，2026-08-23 M2 /reload 纵切）：name/mode/note
   * 三必填、name 小写含 `/`（防撞宿主词汇域）。加载器在装载阶段①（一切 apply 之前）
   * 统一登记——跨应用订阅无顺序洞；词汇集运行期恒定（boot//reload 两时点外不增不减）。
   */
  events?: readonly LiveEventDefinition[];
  /**
   * 应用自带技能目录清单（§1.2 第六件，2026-08-25 第二十二批即刻批① + 2026-08-26
   * 冷读闸回写）：相对**应用包根**（= 入口文件所在目录）的路径数组（如 `["./skills"]`，
   * 不用 glob）。加载器在行作用域 fork 后、apply 之前经注册回调桥接 skills 服务
   * package 层（context 不引 skills——组合根注入回调，拓扑 seam）；目录缺失产
   * `package-missing` warning 诊断不杀行。纯技能包 = 本字段 + name + default 空
   * 实现三件零逻辑即合法应用形态（superpowers 式技能生态直通）。
   */
  skills?: readonly string[];
}

/**
 * 官方件模块（§6.1 `builtin:` 前缀命名空间，2026-08-24 M2 记忆应用纵切）：
 * 与 AppModule 同形，唯 apply 替位 default（宿主随包函数引用，不经 jiti、
 * 不受应用零 import 规则约束）。组合根官方件注册表按 `builtin:<name>` 收纳，
 * 装载管线与文件应用完全同轨（形状/config 校验、Kahn 轮次激活、三生命周期事件）。
 */
export interface BuiltinAppModule extends Omit<AppModule, 'default'> {
  /** 入口函数（与 AppModule.default 同签名——命名差异只为「非模块导出」的语义清晰） */
  apply: AppApply;
  /**
   * 包根锚点自述（2026-08-27 刀 1，契约篇 §3.4 第一刀细化段——builtin 件技能
   * 携带的桥接锚）：**仅 builtin 行生效的宿主侧扩展**——jiti 装载的文件应用
   * 模块对象上即使带此键也被加载器忽略（不入 validateModuleShape、不对第三方
   * 开放——包根可指应用目录外的暗道不存在），故挂本类型面而非 AppModule
   * （named export 契约六件不动）。值由模块自身 `import.meta.url` 运行时求值
   * （dirname）——与文件应用的入口路径推导同为**位置事实而非声明**，结构上
   * 不可能漂；loader 技能桥优先取自述、无则回落入口推导（同一
   * AppSkillsInfo.packageRoot 字段两来源，非两套机制）。
   */
  packageRoot?: string;
}

/**
 * 行沙箱块（契约篇 §1.7 第三十七批，2026-08-29）：行声明的进程隔离相位——
 * 载体三值 + 收窄三子键（fs/net/caps）。词汇随第三十七批题 1 案乙独立成块
 * （不塞 config、不造第二机制）；**缺块 ≠ 裸 main**（闩一缺省两分派，见
 * resolveRowCarrier）。
 * - carrier v1 全值可声明（main/worker 落码、external 预留——external 行装载期
 *   fail-closed 拒载，过渡冻结见契约篇 §1.7 第三十七批增补 2b）；
 * - net 子键 v1 **声明即拒**（COMPOSITION_ROW_INVALID——无执法基线的声明 =
 *   宣示与现实脱节，闩二推论）；
 * - fs/caps v1 只校验 plain-object 形状（深层形态随 carrier 落码批定）。
 */
export interface RowSandbox {
  /**
   * 运行载体：'main' 同进程 / 'worker' worker 线程域（apply 过界执行）/
   * 'external' 外部进程域（per-行域——OS 层进程墙，v1 预留词 fail-closed）。
   * builtin 官方件行声明本块（任何 carrier）= 拒（官方随包件恒 main 域——
   * 双执法点：validateRow 第一 + 加载器第二，契约篇 §1.7 第三十七批增补 9）。
   */
  carrier: 'main' | 'worker' | 'external';
  /** fs 收窄（v1 只校验对象形状——执法面随 carrier 落码批） */
  fs?: Record<string, unknown>;
  /** net 收窄——v1 声明即 COMPOSITION_ROW_INVALID 拒绝（无执法基线不收声明） */
  net?: Record<string, unknown>;
  /** 能力收窄（v1 只校验对象形状——执法面随 carrier 落码批） */
  caps?: Record<string, unknown>;
}

/**
 * 行载体解析（闩一缺省两分派，契约篇 §1.7 第三十七批题 3）：sandbox 块缺席时
 * **缺省 ≠ 裸 main**——`builtin:` 行（官方豁免）缺省 main；第三方行缺省
 * external（出生即进程墙——缺块不是裸奔通道）。块在场则以块 carrier 为准。
 * 纯函数住 contracts（context 加载器 / app 组合根 / dump-config 三消费面共取，
 * 拓扑上 contracts 是三者共同可达的最低层）。
 */
export function resolveRowCarrier(row: { pkg?: string; sandbox?: RowSandbox }): 'main' | 'worker' | 'external' {
  if (row.sandbox !== undefined) return row.sandbox.carrier;
  return row.pkg !== undefined && !row.pkg.startsWith('builtin:') ? 'external' : 'main';
}

/** 组合树行（§5.1，第三十六批作用域数组化）：每行 = 一个应用实例，字段级后写胜出合成 */
export interface CompositionRow {
  /** 行 id：组合树中该应用实例的稳定标识（overlay 按 id 替换/insert/disable 的键） */
  id: string;
  /**
   * 应用引用（第三十六批 plugin→pkg 键改名——装载单位词汇统一 app 后行键随包
   * 语义定名）：包名（装入 <数据目录>/apps/node_modules 子树）或显式相对/绝对
   * 路径。overlay 替换行省略 = 沿用官方层该 id 的引用只改其余字段；insert 行
   * 必须自带。
   */
  pkg?: string;
  /** 行配置（经应用声明 schema 校验后冻结注入 ctx.config；整体替换不做深合并） */
  config?: Record<string, unknown>;
  /**
   * 禁用（P2-1 数组形态，第三十六批作用域数组化吸收）：true = 静态禁用（行
   * 可见不激活）；平台字符串（'darwin'/'linux'/'win32'）= 单平台门控；平台
   * 字符串数组 = 多平台门控（合成期 `.includes(process.platform)` 命中即禁）。
   * 空数组 = 拒行（COMPOSITION_ROW_INVALID——零语义键值不落盘）。fixed 行
   * 禁用 = 合成期即响。
   */
  disabled?: boolean | string | readonly string[];
  /** 官方默认层安全栈强制点标记：用户 overlay 不可 disable（仅官方层行可携带） */
  fixed?: boolean;
  /**
   * 行沙箱块（契约篇 §1.7 第三十七批；并入原 runtime 单键——词汇随 sandbox
   * 块案乙收口）：缺块经 resolveRowCarrier 缺省两分派（官方 main / 第三方
   * external），非裸 main。详见 RowSandbox。
   */
  sandbox?: RowSandbox;
  /**
   * 挂载目标键（契约篇 §5.1 挂载目标两档；第三十六批 app 单值→apps 数组——
   * 作用域数组化）：缺省 = **全局作用域**（作用域 = OS——官方件档位，注册面落
   * 全局层、进一切组成面）；`[<应用id>, …]` 非空数组 = **应用作用域集**（一行
   * 可枚举多应用 = 共享件，新能力：现行单值无法表达「同时服务两应用」）。取值
   * 域 = 在册应用清单 id，元素过 appId 模式校验、重复元素拒、空数组拒行；合成
   * 期四触发拒绝式执法（loadComposition）：未知应用 id / Ring 1 必备行带 apps /
   * 官方引用行带 apps（判源 = 行引用形：`builtin:` 前缀或省略沿用官方层——官方
   * 件作用域恒系统）/ 第三方行缺省挂系统拒（触发②，D2 开闸）。跨区行（多应用
   * 挂载）语义见 §5.1：per-app reload 单区回卷时跨区行不随区回卷（等同系统区
   * 待遇）。
   */
  apps?: readonly string[];
}

/**
 * 行挂载目标投影探针（契约篇 §5.1 D1 清单投影批，2026-08-27；第三十六批
 * 数组化改形）：rowId → appId 数组的活查询面。组合根构造并维护（boot 与
 * /reload 各自从组合树重建投影——闭包读活视图，服务构造时点无关），注入
 * 三个注册面服务做 D1 注册面路由：
 * - tools：无显式键注册经 caller 链取行 id → 查本面 → 命中即按数组**投多域**
 *   （多应用行的工具落每个应用域层——一行投多 app，d36 方案 §3.2）；
 * - skills / channels：同径命中即装载期拒载（两注册面 v1 无域层——app 行注册
 *   = 全局漏注入破坏应用隔离，契约篇 §5.1 D1 注册面路由裁死）。
 * `size()` 供异步注册窗口的 warn 门限探测（零应用行 = 无隔离语义可破坏 → 不警）。
 */
export interface RowAppProbe {
  /** 行 id → 挂载应用 id 数组（行无 apps 键 / 查无此行返回 undefined；非空数组 = 应用行） */
  get(rowId: string): readonly string[] | undefined;
  /** 组合树携带 apps 键的行数（warn 门限探测——0 = 零应用行） */
  size(): number;
}

/** 跳过原因词汇（§2.2 增补 1：disabled 静态禁用 / platform 平台门控；目录信任略过随信任门补） */
export type AppSkipReason = 'disabled' | 'platform';

/**
 * 装载计划行（组合树合成产物 → 加载器输入）：三态互斥——
 * 有 entry（文件应用）或 builtin（官方件）= 激活行；有 skip = 跳过行
 * （不 import，禁用不要求已装）；有 unresolved = 入口解析失败行。
 */
export interface AppPlanRow {
  /** 组合树行 id */
  id: string;
  /**
   * 组合树行应用引用透传（装载身份串——组合树 `CompositionRow.pkg` 原样，
   * 含 `builtin:` 前缀串）。激活行与未解析行携带（归因完整）；skip 行不带。
   * 应用内存预算（budget.memoryMb）经它与清单 components 字面比对命中 worker 行（join 键）。
   */
  pkg?: string;
  /** 入口文件绝对路径（文件应用激活行必有；builtin 行无） */
  entry?: string;
  /** 官方件模块引用（`builtin:` 行激活时必有——注册表查得，不经 jiti） */
  builtin?: BuiltinAppModule;
  /** 行配置（激活行可有；经应用 schema 校验后注入） */
  config?: Record<string, unknown>;
  /** 跳过原因（有值即不激活） */
  skip?: AppSkipReason;
  /** 入口解析失败原因（加载器永不自动安装——进启动断言指引安装） */
  unresolved?: string;
  /**
   * 行沙箱块透传（CompositionRow.sandbox 原样——加载器经 resolveRowCarrier
   * 解析载体分派：worker 行走分域装载管线（装载校验过界 + apply 于 worker 域
   * 执行，契约篇 §1.7）、external 行 fail-closed 拒载〔第三十七批增补 2b
   * 过渡冻结〕、builtin 行携块防御性拒载〔第二执法点〕）。
   */
  sandbox?: RowSandbox;
}

/**
 * app/activated 载荷：{ 组合树行 id, 应用声明名, apply 耗时打点 }。
 * applyMs（B2 P5 打点先行，2026-08-27 刀〇a）：装载器激活计时（fork→apply 返回
 * 的墙钟差）——诊断面（/apps、dump-config）展示每应用启动开销，为后续阈值
 * 调校供数据，不参与任何控制流。
 */
export interface AppActivatedPayload {
  readonly id: string;
  readonly name: string;
  /** apply 耗时（毫秒，含技能注册回调；不含 import/形状校验——那是装载期不是激活期） */
  readonly applyMs: number;
  /**
   * 本 boot 装载期声明的自定义事件词名清单（契约篇 §3.4 第二刀，2026-08-27
   * 刀 2——词表三档的 live 档来源）：装载阶段①登记词汇处顺带收割名字随载荷
   * 上行；undefined = 未声明任何自定义事件。uninstall 检视对 activated 行优先
   * 读本档（活词表优先于 data.json 账本——同一次装载的真值）。不参与控制流。
   */
  readonly events?: readonly string[];
}

/** app/failed 载荷：{ 组合树行 id, 错误码（APP_ 族）, 错误信息 } */
export interface AppFailedPayload {
  readonly id: string;
  readonly code: string;
  readonly message: string;
}

/** app/skipped 载荷：{ 组合树行 id, 跳过原因 } */
export interface AppSkippedPayload {
  readonly id: string;
  readonly reason: AppSkipReason;
}

/** 加载结果（组合根启动断言与 ctx.apps.list 的数据源） */
export interface AppLoadResult {
  /** 激活成功的行（组合树行 id + 应用声明名） */
  readonly activated: readonly AppActivatedPayload[];
  /** 失败的行（启动断言响亮列出——组合根据此拒绝启动） */
  readonly failed: readonly AppFailedPayload[];
  /** 跳过的行（显式禁用/平台门控——可见但不激活） */
  readonly skipped: readonly AppSkippedPayload[];
}
