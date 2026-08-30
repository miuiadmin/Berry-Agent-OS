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
   * claim 桥挂载点（刀三行面晚绑桥第一用例）：apply 建 registry 后挂真身，
   * 返回摘除器（ctx.effect 回卷调——holder 置空，answerer 竞速退回纯 TUI 腿）。
   */
  readonly approvals: { readonly mountClaim: (claim: WebuiApprovalClaim) => () => void };
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
  /** 宿主版本号（GET /api/health 报告面——app/version.ts 同源经组合根注入，webui 边不含 app 模块） */
  readonly version: string;
}

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
