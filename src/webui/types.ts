/**
 * L3 webui — 公共类型与常量（契约篇 §6.8 Web 通道第一刀，默认层第十四行，
 * Ring 2 真·可卸件）。
 *
 * 件职责 = 单机回环 Web 通道后端：node:http 微路由 + SSE 活体流 + 静态分发
 * （SPA 资产随包）。鉴权 = 回环三防线（绑定/Host/Origin——技术栈篇 §4.4），
 * v1 无 token。依赖零新增（node:http 手写 + contracts typebox 再导出面）。
 */

import { Type, type Static } from '../contracts/typebox.js';
import type { SessionEvent } from '../contracts/events.js';
import type { UiService } from '../channels/types.js';

/* ------------------------------------------------------------------ */
/* config 面（行 schema——loader 启动一次校验） */
/* ------------------------------------------------------------------ */

/** webui 行配置 schema（契约篇 §6.8：enabled 缺省 false——行惰性无害零监听） */
export const WEBUI_APP_CONFIG_SCHEMA = Type.Object({
  enabled: Type.Optional(
    Type.Boolean({ description: 'false（缺省）= 行惰性零监听——官方默认层带行但出厂零端口零惊喜' }),
  ),
  port: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 65535, description: '监听端口（enabled 而未配时生效；缺省 7860）' }),
  ),
  host: Type.Optional(
    Type.String({ description: '监听地址（缺省 127.0.0.1；显式非回环值 = 装配期拒启 WEBUI_BIND_FORBIDDEN）' }),
  ),
});

/** webui 行配置（Static 推导） */
export type WebuiAppConfig = Static<typeof WEBUI_APP_CONFIG_SCHEMA>;

/** 监听端口缺省值（契约篇 §6.8） */
export const DEFAULT_WEBUI_PORT = 7860;
/** 监听地址缺省值（回环——防线① 的缺省形态） */
export const DEFAULT_WEBUI_HOST = '127.0.0.1';

/* ------------------------------------------------------------------ */
/* 依赖闭包面（官方件特权模式——宿主资源全经组合根闭包注入，零新 ctx 服务名） */
/* ------------------------------------------------------------------ */

/**
 * display 族信封载荷（结构子集模式——webui 模块边不含 chat/agent，只钉归属键
 * 与事件判别键，载荷字段全透传不窄化）：chat 件 `SessionEventEnvelope`
 * 结构兼容本型（组合根接线点编译期即验；goal 对 ctx.agent 的窄结构先例同款）。
 */
export interface WebuiDisplayEnvelope {
  /** 事件归属会话（转接层补键） */
  readonly sessionId: string;
  /** loop 活体事件——只约束 `type` 判别键，其余字段透传（十型联合住 agent 模块） */
  readonly event: { readonly type: string } & Readonly<Record<string, unknown>>;
}

/** display 族订阅者（经组合根 addDisplay 接入点转投——旁听非独占，TUI 并行消费） */
export type WebuiDisplaySink = (envelope: WebuiDisplayEnvelope) => void;

/** GET /api/sessions 清单条目（线格式 v1——契约篇 §6.8 端点面） */
export interface WebuiSessionSummary {
  /** 会话 id */
  readonly id: string;
  /** 应用域键（活条目从 DriverEntry.appId、近史行从 sessions.app 列——NULL 归 chat） */
  readonly appId: string;
  /** 工作目录（sessions 行直出；可缺省） */
  readonly cwd?: string;
  /** 创建时刻（epoch 毫秒——sessions 行 createdAt 列直出；store 行迟到时可缺省） */
  readonly createdAt?: number;
  /** 最近事件时刻（epoch 毫秒——events 表 MAX(time) 聚合，sessions 表无此列） */
  readonly updatedAt?: number;
  /** 是否活会话（驱动注册表在场且未退役 = 可 submit；false = 只读〔已闭 store 兜底〕） */
  readonly active: boolean;
  /** 应用强调色（D4 theme 条款 web 兑现——sessionsFor 组装时按条目 appId 取清单 theme.accent；缺席 = 前端缺省色） */
  readonly accent?: string;
}

/** todo 条目窄类型（chat 件 TodoItem 结构子集——status 收 string 判别面留给前端；同款先例 WebuiDisplayEnvelope） */
export interface WebuiTodoItem {
  /** 条目内容（祈使句短语） */
  readonly content: string;
  /** 状态三值：pending / in_progress / completed（chat 件 TodoStatus 的结构兼容面） */
  readonly status: string;
  /** 进行中条目的现在进行时描述（渲染时优先于 content） */
  readonly activeForm?: string;
}

/* ------------------------------------------------------------------ */
/* 刀三：审批应答面 + 工作区补全面公共类型（契约篇 §6.8 刀三落码形态细化条） */
/* ------------------------------------------------------------------ */

/** web 应答闭集（TUI 四值闭集减 cancel——cancel 无 web 产出面，spec 钉死） */
export type WebuiApprovalDecision = 'approve' | 'reject' | 'always';

/**
 * claim 载荷（answerer 时点的 enriched 结构子集——safety ApprovalRequest 的
 * 词面拷贝，webui 结构上不见 safety：组合根接线点编译期即验，WebuiTodoItem
 * 同款先例）。suggestedEntry 在场 = 审批卡呈现「始终允许」三态按钮。
 */
export interface WebuiApprovalDetail {
  /** 目标动作摘要（人可读一行） */
  readonly summary: string;
  /** 请求方/理由（升权审批的目标档与 justification） */
  readonly reason?: string;
  /** 「始终允许」草案（allowlist 条目形状——tool + pattern 两键） */
  readonly suggestedEntry?: { readonly tool: string; readonly pattern: string };
  /** 归属标签（根路审批无 ownership——sessionId 缺省 undefined 档） */
  readonly ownership?: { readonly appId?: string; readonly sessionId: string };
  /** 出队优先级（background 时卡面注记） */
  readonly priority?: string;
}

/**
 * claim 桥面（行面晚绑桥第一用例）：assembly 持晚绑 holder，本件 apply 建
 * registry 后经 `deps.approvals.mountClaim` 挂真身、ctx.effect 回卷摘除——
 * 未开面/行卸载 = holder 空 = answerer 纯 TUI 腿。@returns undefined = 无
 * web 腿（未决条目不存在/已决）。
 */
export type WebuiApprovalClaim = (
  approvalId: string,
  detail: WebuiApprovalDetail,
) => Promise<WebuiApprovalDecision> | undefined;

/**
 * claim 桥挂载物（daemon 刀一·per-ownership 帽拓宽；刀二·armed 计数键拓
 * 宽）：原桥只挂 claim 函数，帽面数据源（pendingCountBy）与在场 SSE 连接
 * 计数（attachedCount）在 webui 行 apply 内部不可达——拓宽为挂载对象，
 * answerer 的帽判据/武装判据与竞速腿同一登记簿/通道单源。行回卷整体摘除
 * （三键同生死——它们本就是同一簿与同一通道的两面）。
 */
export interface WebuiApprovalMount {
  /** claim 面（answerer 竞速的 web 腿） */
  readonly claim: WebuiApprovalClaim;
  /** 未决数按 ownership 域分桶（帽面数据源——undefined 键 = 宿主桶） */
  readonly pendingCountBy: (ownerAppId: string | undefined) => number;
  /**
   * 在场 SSE 连接计数（daemon 刀二 armed 判据数据源，契约篇 §6.8 P2）：
   * ask 时点活取——>0 = 有持 token 的活连接在场（attach 客户端/SPA/监控
   * 尾），answerer 不武装（超时降发改由在场腿应答）；=0 = 无人在场才武装。
   * 诚实边界：任何持 token 连接皆计入（含 curl 监控尾——armed 判据宁保守）。
   */
  readonly attachedCount: () => number;
}

/** GET /api/approvals 清单条目（未决审批——卡片恢复/侧栏角标面数据源） */
export interface WebuiPendingApproval {
  /** 审批 id（ask 内 randomUUID——卡片键） */
  readonly approvalId: string;
  /** 归属会话（镜像信封 sessionId；根路审批缺省 undefined 档） */
  readonly sessionId?: string;
  /** 目标动作摘要 */
  readonly summary: string;
  /** 请求方/理由 */
  readonly reason?: string;
  /** 「始终允许」草案（在场 = 三态按钮） */
  readonly suggestedEntry?: { readonly tool: string; readonly pattern: string };
  /** 归属标签 */
  readonly ownership?: { readonly appId?: string; readonly sessionId: string };
  /** 出队优先级（'background' 时卡面注记） */
  readonly priority?: string;
  /** 已决旗（镜像标决/decide 落决——registry 内部使用，list 恒过滤已决故对外恒 undefined） */
  readonly decided?: string;
}

/** 工作区符号补全条目（GET /api/workspace/symbols 元素——lsp documentSymbol 投影） */
export interface WebuiSymbolItem {
  /** 符号名（插入锚） */
  readonly name: string;
  /** 定义行号（1-based；协议缺失时省） */
  readonly line?: number;
  /** LSP SymbolKind 数值（协议直传——前端不做词表翻译） */
  readonly kind?: number;
}

/** 符号查询应答（warming 档 = 服务器预热中，前端可提示稍后再试） */
export interface WebuiSymbolQuery {
  readonly symbols: readonly WebuiSymbolItem[];
  readonly warming?: boolean;
}

/**
 * webui 件构造依赖（组合根闭包注入——构造点早于 ring1 装载，全部为活取值/
 * 纯函数形态，调用时点恒在装载后）。刀二已扩 openSession/todoFor；刀三扩
 * `approvals` / `workspaceRoot` / `symbolsFor` 三键（落码形态见 §6.8 刀三条）。
 */
export interface WebuiAppDeps {
  /** display 信封流接入点（与 tui-main front.addDisplay 同源点分流——旁听非独占） */
  readonly addDisplay: (sink: WebuiDisplaySink) => void;
  /**
   * 定向提交：进目标会话驱动的 submit（running 时入 steering 队列、闲时开 run
   * ——驱动自治）。@returns 目标不存在或已闭（retired）= false（HTTP 404 判据）
   */
  readonly submitTo: (sessionId: string, text: string) => boolean;
  /**
   * 会话消息投影（拉投影腿——deriveMessages 产物）。@returns 会话不在册 =
   * undefined（HTTP 404 判据；webui 不解释投影内容，序列化透传）。已闭会话
   * 由组合根走 store 装载只读派生（刀二规范细化——本键对服务面只表现为
   * 「在册」）
   */
  readonly historyFor: (sessionId: string) => readonly unknown[] | undefined;
  /** 会话清单投影（驱动注册表活会话 ∪ sessions 表近史——组合根合并两源） */
  readonly sessionsFor: () => readonly WebuiSessionSummary[];
  /**
   * 开新会话（刀二 = `POST /api/sessions` 腿）：registry.open() 一条龙——默认
   * 应用解析 per-open 活取、驻留（既有条目不退役）+ 切宿主前台 focus，与
   * TUI `/app new` 同款语义（不为 web 特设「不切前台」参数）。
   * @returns undefined = 开不出（无持久层或默认应用兜底态——HTTP 503 两因）；成功 = 清单条目（201 载荷）
   */
  readonly openSession: () => Promise<WebuiSessionSummary | undefined>;
  /**
   * todo 折叠（刀二 = `GET /api/sessions/:id/todo` 腿——foldCurrentTodo 归一
   * 产物）。@returns null = 无表（合法档）；undefined = 会话不在册（HTTP 404）
   */
  readonly todoFor: (sessionId: string) => readonly WebuiTodoItem[] | null | undefined;
  /** ctx.ui 聚合面活取值（attach webui 广播后端用——builtins 构造点早于 ring1 装载） */
  readonly ui: () => UiService;
  /**
   * claim 桥挂载点（刀三行面晚绑桥第一用例；daemon 刀一拓宽为挂载对象）：
   * apply 建 registry 后挂真身（claim + pendingCountBy 两键同挂），返回摘除器
   * （ctx.effect 回卷调——holder 置空，answerer 竞速退回纯 TUI 腿）。
   */
  readonly approvals: { readonly mountClaim: (mount: WebuiApprovalMount) => () => void };
  /**
   * 工作区根活取值（刀三 @-mention 文件补全行走锚）：返回**原始 workspace**
   * （与 fs 工具族/LSP resolvePath 同锚——canonical 差集 v1 不入补全面，spec 钉死）。
   */
  readonly workspaceRoot: () => string;
  /**
   * documentSymbol 查询晚绑桥（刀三行面晚绑桥第二用例——lsp 行 mountSymbols
   * 挂真身）。@returns undefined = 无路由/熔断/文件不在盘（404）；warming 档 =
   * 未活实例 fire-and-forget 预热中。didOpen 副作用（文档同步盘真相）注记披露。
   */
  readonly symbolsFor: (path: string) => Promise<WebuiSymbolQuery | undefined>;
  /**
   * 打断目标会话在飞 run（daemon 刀一·协议正确性层 = `POST /api/sessions/:id/interrupt`
   * 腿）：registry 条目 driver.interrupt——abort 当轮 run（捎跑续批不传染，与
   * TUI Ctrl+C 打断同源面）。@returns 目标不在册/已闭/无在飞 run = false（404）
   */
  readonly interruptFor?: (sessionId: string) => boolean;
  /**
   * cordon 旗活取值（daemon 刀一·D6：write-behind 落盘失败置位——降级面拒绝
   * 新写意图防「服务看着在、账必丢」）。true = 拒面生效：submit 与开新会话
   * 两端点 503；decide/interrupt/SSE/读面可达不拒（operator 收场面保全）；
   * health 披露 degraded。缺省不传 = 无降级面（非 daemon 形态）。
   */
  readonly cordoned?: () => boolean;
  /**
   * write-behind 运行态活取值（基建大扫 #27）：health 载荷 `writeBehind` 键的
   * 数据源——`{paused, sessions, events}` 三值（闩态 + 积压两数）。闩态与
   * cordoned 两独立信号：paused = 批落失败自动重试暂停（任一批成功即复位，
   * 瞬态可自愈）；cordoned = 组合根一次性闩（置位后不清）。缺省不传 = 无
   * 持久层（:memory: 诊断形态）——health 不携带该键。
   */
  readonly writeBehindStats?: () => { paused: boolean; sessions: number; events: number };
  /**
   * 鉴权物（daemon 刀一·P1 起为 daemon 形态注入位；复盘 S-1 勘正——结构不变式
   * 「监听 ⇒ 鉴权」升格为件本体保证）：组合根注入则用注入值（daemon 持久 token）；
   * **缺席时件本体 apply 期自足生成进程内一次性 token**（32 字节随机 hex、只存
   * 进程内存不落盘——0600 不防同 uid，落盘即被同 uid 沙箱应用可读等于没防），
   * 经 `mountEphemeralAuth` 挂载点上交组合根披露。在场（两源恒在场）时 /api 族
   * 全量执法（豁免 /api/health 探活与 /api/auth 签发自身）+ POST /api/auth cookie 桥。
   */
  readonly auth?: { readonly token: string };
  /**
   * 一次性鉴权面挂载点（复盘 S-1：件自足生成 token 后上交组合根的通道——
   * mountSymbols/mountApprovalClaim 同款 holder-mount 形态）。件本体 apply 期
   * 调用（仅 `auth` 注入缺席时），返回摘除器由件本体 ctx.effect 回卷收账。
   * 组合根侧 holder 决定披露形态（TUI notify / run stderr；daemon 形态注入
   * auth 故不自足、不双披）。缺省不传（单测直构 deps 面）= 面不上交、token
   * 仍生效（执法不依赖披露接线正确性）。
   */
  readonly mountEphemeralAuth?: (face: WebuiEphemeralAuthFace) => () => void;
  /** 宿主版本号（GET /api/health 报告面——app/version.ts 同源经组合根注入，webui 边不含 app 模块） */
  readonly version: string;
}

/** daemon 鉴权 cookie 名（P1 M1 cookie 桥——非品牌词面；值 = token 本身） */
export const WEBUI_SESSION_COOKIE = 'daemon_session';

/**
 * 一次性鉴权面（复盘 S-1——非 daemon 一切监听形态件自足生成）：token 只存
 * 进程内存（不落盘）；port/host = 监听坐标（披露方拼回环 URL 用）。组合根经
 * mountEphemeralAuth 收面后按入口形态披露（TUI attach 后 notify / run stderr；
 * 测试面直接断言形状）。
 */
export interface WebuiEphemeralAuthFace {
  /** 32 字节随机数 hex（64 字符）——进程内一次性，随行回卷销亡 */
  readonly token: string;
  /** 监听端口（--port 旗标值或 overlay 配置值） */
  readonly port: number;
  /** 监听主机（回环钉死面——披露方据此确认回环坐标） */
  readonly host: string;
}

/**
 * submit requestId 去重缓存帽（daemon 刀一·协议正确性层：客户端重试同
 * requestId 不双投——服务端 LRU 按 UUID 插入序逐出最旧；128 覆盖正常重试窗）
 */
export const WEBUI_REQUEST_ID_CACHE = 128;

/**
 * per-ownership 未决审批帽（daemon 刀一·随刀件，~10/owner）：帽满即该 owner
 * 新 ask 即时收场 'unavailable'（fail-closed 同族）——防烂应用卡海塞满
 * registry MAX_ENTRIES=100 淹没合法审批。ownerAppId undefined = 宿主桶同帽
 * （根 ask 只来自 exec/fetch 服务路与 admin 闸路，多服务路并发合法审批同帽互济）
 */
export const WEBUI_APPROVAL_CAP_PER_OWNER = 10;

/* ------------------------------------------------------------------ */
/* SSE 线格式（帧合成钉死：每帧 data 载荷恒整体单次 JSON.stringify 单行） */
/* ------------------------------------------------------------------ */

/** SSE 信封 kind 四值（契约篇 §6.8 端点面） */
export type WebuiSseKind = 'session' | 'display' | 'notify' | 'status';

/** SSE 信封（GET /api/events 推送帧的 data 载荷） */
export interface WebuiSseEnvelope {
  /** 信封族：session = durable 镜像 / display = AgentEvent 信封流 / notify / status */
  readonly kind: WebuiSseKind;
  /** 归属会话（session/display 族恒带；notify/status 缺省） */
  readonly sessionId?: string;
  /** 族载荷：session = SessionEvent；display = AgentEvent；notify = {message,level?}；status = {status} */
  readonly payload: unknown;
}

/** notify 族载荷（UiBackend.notify 广播面） */
export interface WebuiNotifyPayload {
  readonly message: string;
  /** 通知级别（缺省 info） */
  readonly level?: string;
}

/** status 族载荷（UiBackend.setStatus 广播面） */
export interface WebuiStatusPayload {
  /** 状态行文本（空串 = 清空——聚合面语义透传） */
  readonly status: string;
}

/** session 族总线载荷（ctx 'session/event' 镜像信封——契约篇 §2.2） */
export interface WebuiSessionBusPayload {
  readonly sessionId: string;
  readonly event: SessionEvent;
}

/* ------------------------------------------------------------------ */
/* 服务限额与节律（契约篇 §6.8：连接帽 m5 / 心跳写侧 B1） */
/* ------------------------------------------------------------------ */

/** SSE 全局连接帽（超帽新连接 503——回环 operator 场景 SPA 正常 1-2 连接） */
export const WEBUI_MAX_CONNECTIONS = 16;
/** SSE 心跳注释行间隔（毫秒） */
export const WEBUI_PING_INTERVAL_MS = 30_000;
/** ping 写超时上限（毫秒）——写失败或超时即 reap 该连接（写侧信号驱动判死） */
export const WEBUI_WRITE_TIMEOUT_MS = 90_000;
/** POST 请求体字节帽（submit 文本远小于此——防误写/滥用，超帽 413） */
export const WEBUI_BODY_LIMIT_BYTES = 256 * 1024;
