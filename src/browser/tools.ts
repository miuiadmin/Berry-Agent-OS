/**
 * L3 browser — 工具面十件（契约篇 §6.10 工具表，第四十九批刀二）。
 *
 * 形态先例 = web 件（fetch 工具 + ctx.fetch 服务两层并存）：工具面消费
 * ctx.browser 服务取 per-session 隔离态；引擎首用才起（工具注册不依赖引擎
 * 在线——lsp 同款惰性）。
 *
 * effect 分账：navigate/back/forward/snapshot/screenshot/console 为 read
 * （只读模式可浏览可看），click/type/press/scroll 为 write（走三段管道守门
 * 审批——fail-closed 缺省 write 同律）。
 *
 * 错误两律（MCP 调用期同律 + 安全拦截例外）：
 * - **语义失败是数据不升 AppError**：ref 过期/元素无盒/键名非法/历史端点 →
 *   isError 文本结果（模型可读可自纠——「先重拍快照」类指引在文本里）；
 * - **安全拦截复用 web 件同码**：navigate 前置 requireHttpUrl +
 *   assertPublicHost（WEB_URL_INVALID / WEB_PRIVATE_TARGET——SSRF 防线第三
 *   消费面，单源同码）。
 */

import { Type } from '../contracts/typebox.js';
import { AppError } from '../contracts/errors.js';
import type { AgentToolResult, ToolDefinition } from '../contracts/tools.js';
import { assertPublicHost, requireHttpUrl, type HostLookup } from '../web/index.js';
import type { BrowserService } from './app.js';
import type { CdpRpc } from './cdp.js';
import { renderAccessibilitySnapshot, type FlatDocNode } from './a11y.js';
import type { SnapshotRefEntry } from './capture.js';
import { saveScreenshot } from './screenshots.js';
import type { SessionBrowserState } from './types.js';

/** 工具注册依赖束（app.ts apply 接线——register = ctx.tools.register 直投） */
export interface BrowserToolsDeps {
  /** ctx.browser 服务面（引擎惰性取用） */
  readonly service: BrowserService;
  /** 数据目录（截图落盘锚） */
  readonly dataDir: string;
  /**
   * 导航限流面（组合根单例——与 web 件 fetch 共享同一 InflightGates；
   * browser_navigate acquire/release 编舞同 fetch-core，契约篇 §6.10 第三消费位）
   */
  readonly gates: { acquire(host: string, signal?: AbortSignal): Promise<void>; release(host: string): void };
  /** 注册面（返回注销器——app.ts effect 回卷统一收） */
  readonly register: (def: ToolDefinition) => () => void;
  /** DNS lookup 注入缝（缺省真解析——测试注入假实现；web 件同缝惯例） */
  readonly dnsLookup?: HostLookup;
}

/** 会话键归一（与 engine 同律：匿名兜底 '_default'——截图目录/序号键） */
function sessionKeyOf(sessionId: string | undefined): string {
  return sessionId ?? '_default';
}

/** 睡眠（页态结算轮询节拍——工具有自身预算帽） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 页态读取（title/url/readyState 三合一——Runtime.evaluate 单发取值）。
 * 结算轮询：readyState 未到 complete 时重读（帽 ~3.6s——navigate 主体等待
 * 在协议腿自身，此处只等渲染追平，慢页给当前态不硬等）。
 */
async function pageState(rpc: CdpRpc, sessionId: string): Promise<{ title: string; url: string; readyState: string }> {
  let last = { title: '', url: '', readyState: '' };
  for (let i = 0; i < 12; i++) {
    const res = await rpc.request(
      'Runtime.evaluate',
      {
        expression: 'JSON.stringify({ t: document.title, u: location.href, r: document.readyState })',
        returnByValue: true,
      },
      { sessionId },
    );
    const raw = (res as { result?: { result?: { value?: unknown } } })?.result?.result?.value;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as { t?: string; u?: string; r?: string };
        last = { title: parsed.t ?? '', url: parsed.u ?? '', readyState: parsed.r ?? '' };
      } catch {
        // 形态异常保旧值——下一轮再试
      }
    }
    if (last.readyState === 'complete') break;
    await sleep(300);
  }
  return last;
}

/** ref 查表（miss = 快照过期或跨会话混用——语义失败律：isError 数据面） */
function lookupRef(refs: ReadonlyMap<string, SnapshotRefEntry>, ref: string): SnapshotRefEntry {
  const entry = refs.get(ref);
  if (entry === undefined) {
    throw new Error(`ref「${ref}」不在最近快照的 ref 表中——先调 browser_snapshot 重拍快照，再用返回的 @eN 引用`);
  }
  return entry;
}

/**
 * ref → 元素中心坐标（DOM.getBoxModel 内容 quad 四角均值）。
 * 无盒模型 = 元素当前不可见（display:none / 未渲染）——语义失败。
 */
async function refBoxCenter(
  rpc: CdpRpc,
  sessionId: string,
  entry: SnapshotRefEntry,
): Promise<{ x: number; y: number }> {
  const res = await rpc.request('DOM.getBoxModel', { backendNodeId: entry.backendNodeId }, { sessionId });
  const quad = (res as { model?: { quad?: unknown } })?.model?.quad;
  if (!Array.isArray(quad) || quad.length < 8 || quad.some((v) => typeof v !== 'number')) {
    throw new Error(`元素「${entry.role} "${entry.name}"」当前无盒模型（不可见/未渲染）——可能需先滚动到位或元素已移除`);
  }
  const q = quad as number[];
  const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
  const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
  return {
    x: xs.reduce((a, b) => a + b, 0) / 4,
    y: ys.reduce((a, b) => a + b, 0) / 4,
  };
}

/** 语义失败包装（AppError 原样透传——安全拦截/协议错误是身份；纯 Error 归数据面） */
function asDataError(err: unknown): AgentToolResult {
  if (err instanceof AppError) throw err;
  return { content: [{ type: 'text', text: `失败：${(err as Error).message}` }], isError: true };
}

// ---------------------------------------------------------------------------
// 键序模型（browser_press 消费——白名单 fail-loud，键盘合成三事件律）
// ---------------------------------------------------------------------------

/** 非打印键定义（key/code/CDP vk 码三键；text 在场 = 需合成 keypress 字符） */
const NAMED_KEYS: Readonly<
  Record<string, { readonly key: string; readonly code: string; readonly vk: number; readonly text?: string }>
> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }, // text '\r' = 表单提交/textarea 换行所需
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
};

/** 修饰键 → CDP modifiers 位（Alt=1 Ctrl=2 Meta=4 Shift=8——协议钉死） */
const MODIFIER_BITS: Readonly<Record<string, number>> = {
  control: 2,
  ctrl: 2,
  alt: 1,
  meta: 4,
  command: 4,
  shift: 8,
};

/** 可打印单字符白名单（标点全席——键名白名单 fail-loud 的「单字符」档） */
const PRINTABLE_KEY = /^[a-zA-Z0-9 ,.\-_/\\;:'"[\]{}()<>?!@#$%^&*+=|`~]$/;

/** press 键输入解析产物（CDP 派键事件合成所需的完整形态） */
interface ParsedKey {
  readonly key: string;
  readonly code: string | undefined;
  readonly vk: number;
  /** 在场 = 可打印字符/Enter（keyDown 合成 keypress 用）；缺席 = 纯控制键 */
  readonly text?: string;
  readonly modifiers: number;
}
/**
 * 键输入解析（白名单执法）：单可打印字符 / 具名键（小写）/'+' 组合修饰键。
 * 白名单外（F 键/多字符杂串）响亮拒绝并列出合法面——禁透传任意 vk 码。
 */
function parseKeyInput(raw: string): ParsedKey {
  const parts = raw.split('+');
  let modifiers = 0;
  let token = raw;
  if (parts.length > 1) {
    for (const m of parts.slice(0, -1)) {
      const bit = MODIFIER_BITS[m.toLowerCase()];
      if (bit === undefined) {
        throw new Error(`未知修饰键「${m}」（支持：Control/Ctrl/Alt/Meta/Command/Shift）`);
      }
      modifiers |= bit;
    }
    token = parts[parts.length - 1]!;
  }
  if (token.length === 1) {
    if (!PRINTABLE_KEY.test(token)) throw new Error(`非法单键「${token}」`);
    return {
      key: token,
      code: /^[a-z]$/i.test(token) ? `Key${token.toUpperCase()}` : /^[0-9]$/.test(token) ? `Digit${token}` : undefined,
      vk: /^[a-zA-Z0-9]$/.test(token) ? token.toUpperCase().charCodeAt(0) : 0,
      text: token,
      modifiers,
    };
  }
  const named = NAMED_KEYS[token.toLowerCase()];
  if (named === undefined) {
    throw new Error(
      `未知键名「${token}」（支持：可打印单字符 / ${Object.keys(NAMED_KEYS).join(' / ')}；组合键用 + 连接，如 Control+A）`,
    );
  }
  return { ...named, modifiers };
}

// ---------------------------------------------------------------------------
// 工具面十件
// ---------------------------------------------------------------------------

/**
 * 注册工具面十件（app.ts apply 接线——返回全注销器）。
 * 每件工具体内 acquire：引擎惰性 ensure + per-session context + 续命本 session。
 */
export function registerBrowserTools(deps: BrowserToolsDeps): Array<() => void> {
  const { service, dataDir, register } = deps;
  /** per-session 截图序号（文件名即时序——滚动清理按 mtime 兜底） */
  const shotSeq = new Map<string, number>();
  /**
   * 引擎回退注记簿（路由键 → 本代 engineNote——acquire 时刷新，#27）：
   * 发现序回退代工具结果需标 fallbackWarning（规范条款），注记随 SessionHandle
   * 到场、按路由键暂存供结果装饰面读取（execute 体内 acquire 不外传 handle，
   * 键控暂存避免跨 async 交错串话——同键并发调用读到的是同代同值）。
   */
  const engineNoteByKey = new Map<string, string>();
  /** 取隔离态（每工具调用主口——SessionHandle 携 rpc/session/capture/engineNote） */
  const acquire = async (sessionId: string | undefined) => {
    const handle = await service.acquireContext(sessionId);
    // 注记随取用刷新：新代无回退即清键（簿不跨代漏报旧回退）
    const key = sessionKeyOf(sessionId);
    if (handle.engineNote === undefined) engineNoteByKey.delete(key);
    else engineNoteByKey.set(key, handle.engineNote);
    return handle;
  };

  /** ---- browser_navigate（read）——SSRF 前置 + Page.navigate + 页态结算 ---- */
  const navigate: ToolDefinition = {
    name: 'browser_navigate',
    description:
      '导航当前会话的浏览器页面到指定 URL。仅接受 http/https 且目标为公网主机（私网/回环地址会被拒绝）。返回页面标题与最终 URL。',
    parameters: Type.Object({
      url: Type.String({ description: '目标 URL（http/https）' }),
    }),
    effect: 'read',
    timeoutMs: 60_000,
    execute: async (args, tctx) => {
      try {
        // SSRF 前置（web 件卫生三件同源复用——私网拒绝同码 WEB_PRIVATE_TARGET）
        const url = requireHttpUrl(String(args.url));
        await assertPublicHost(url.hostname, deps.dnsLookup);
        // 导航限流（组合根单例——与 fetch 同一 InflightGates 第三消费位；
        // acquire→Page.navigate→release 编舞同 fetch-core：统一出口必还槽）
        await deps.gates.acquire(url.host, tctx.signal);
        let nav: { frameId?: string; errorText?: string };
        let state: { title: string; url: string; readyState: string };
        try {
          const { rpc, session } = await acquire(tctx.sessionId);
          nav = (await rpc.request('Page.navigate', { url: url.href }, { sessionId: session.sessionId })) as {
            frameId?: string;
            errorText?: string;
          };
          if (nav.errorText !== undefined) {
            // 导航被引擎拒绝（net::ERR_* 族）——数据面（模型可换 URL 自纠）
            return { content: [{ type: 'text', text: `导航失败：${nav.errorText}` }], isError: true };
          }
          state = await pageState(rpc, session.sessionId);
        } finally {
          deps.gates.release(url.host); // 双槽必还（导航/页态全程占槽——失败路径同律）
        }
        return {
          content: [
            { type: 'text', text: `已导航：${state.url}\n标题：${state.title || '(无)'}\n就绪：${state.readyState}` },
          ],
          details: { url: state.url, title: state.title, readyState: state.readyState },
        };
      } catch (err) {
        return asDataError(err);
      }
    },
  };

  /** ---- browser_back / browser_forward（read）——历史栈行走 ---- */
  const historyStep = (name: 'browser_back' | 'browser_forward', delta: -1 | 1): ToolDefinition => ({
    name,
    description:
      delta === -1
        ? '浏览器历史后退一步（等价浏览器后退按钮）。已在历史最端时返回错误提示。'
        : '浏览器历史前进一步（等价浏览器前进按钮）。已在历史最端时返回错误提示。',
    parameters: Type.Object({}),
    effect: 'read',
    timeoutMs: 30_000,
    execute: async (_args, tctx) => {
      try {
        const { rpc, session } = await acquire(tctx.sessionId);
        const hist = (await rpc.request('Page.getNavigationHistory', undefined, { sessionId: session.sessionId })) as {
          currentIndex?: number;
          entries?: Array<{ id: number; url?: string }>;
        };
        const cur = hist.currentIndex ?? 0;
        const entries = hist.entries ?? [];
        const target = entries[cur + delta];
        if (target === undefined) {
          return {
            content: [
              {
                type: 'text',
                text: delta === -1 ? '已在历史最前端（无更多后退记录）' : '已在历史最末端（无更多前进记录）',
              },
            ],
            isError: true,
          };
        }
        await rpc.request('Page.navigateToHistoryEntry', { entryId: target.id }, { sessionId: session.sessionId });
        const state = await pageState(rpc, session.sessionId);
        return {
          content: [
            {
              type: 'text',
              text: `${delta === -1 ? '已后退' : '已前进'}到：${state.url}\n标题：${state.title || '(无)'}`,
            },
          ],
          details: { url: state.url, title: state.title },
        };
      } catch (err) {
        return asDataError(err);
      }
    },
  });

  /** ---- browser_snapshot（read）——a11y 缩进树 + ref 表换代 ---- */
  const snapshot: ToolDefinition = {
    name: 'browser_snapshot',
    description:
      '拍取当前页面的可访问性（a11y）快照：缩进树文本呈现页面结构，可交互元素（按钮/链接/输入框等）带 @eN 引用。后续 click/type 用 @eN 指定目标。每次快照 ref 表整体换代（旧 @eN 失效）。',
    parameters: Type.Object({}),
    effect: 'read',
    timeoutMs: 20_000,
    execute: async (_args, tctx) => {
      try {
        const { rpc, session, capture } = await acquire(tctx.sessionId);
        const doc = (await rpc.request(
          'DOM.getFlattenedDocumentTree',
          { depth: -1 },
          { sessionId: session.sessionId },
        )) as { nodes?: FlatDocNode[] };
        const nodes = doc.nodes ?? [];
        const snap = renderAccessibilitySnapshot(nodes);
        // ref 表换代（per-snapshot 整体替换——跨快照混用禁）
        capture.refs = new Map(
          snap.refs.map((r) => [r.ref, { backendNodeId: r.backendNodeId, role: r.role, name: r.name }]),
        );
        return {
          content: [{ type: 'text', text: snap.text || '（页面无可见元素——空文档）' }],
          details: { refCount: snap.refs.length, truncated: snap.truncated },
        };
      } catch (err) {
        return asDataError(err);
      }
    },
  };

  /** ---- browser_click（write）——ref 查表 → 盒模型中心 → 真鼠标事件 ---- */
  const click: ToolDefinition = {
    name: 'browser_click',
    description:
      '点击页面元素。ref 必须来自最近一次 browser_snapshot 返回的 @eN 引用（点击前如页面已变化请重拍快照）。',
    parameters: Type.Object({
      ref: Type.String({ description: 'browser_snapshot 返回的 @eN 引用' }),
      button: Type.Optional(
        Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')], {
          description: '鼠标键（缺省 left）',
        }),
      ),
      clickCount: Type.Optional(Type.Number({ minimum: 1, maximum: 3, description: '连击数（双击 = 2）' })),
    }),
    effect: 'write',
    timeoutMs: 15_000,
    execute: async (args, tctx) => {
      try {
        const { rpc, session, capture } = await acquire(tctx.sessionId);
        const entry = lookupRef(capture.refs, String(args.ref));
        const { x, y } = await refBoxCenter(rpc, session.sessionId, entry);
        const button = (args.button ?? 'left') as 'left' | 'right' | 'middle';
        const clickCount = typeof args.clickCount === 'number' ? args.clickCount : 1;
        // 真用户事件路径：mousePressed + mouseReleased 成对（双击靠 clickCount=2）
        const base = { x, y, button, clickCount };
        await rpc.request(
          'Input.dispatchMouseEvent',
          { type: 'mousePressed', ...base },
          { sessionId: session.sessionId },
        );
        await rpc.request(
          'Input.dispatchMouseEvent',
          { type: 'mouseReleased', ...base },
          { sessionId: session.sessionId },
        );
        return {
          content: [
            {
              type: 'text',
              text: `已点击 ${entry.role} "${entry.name}"（@${args.ref}，x=${Math.round(x)}, y=${Math.round(y)}）`,
            },
          ],
          details: { ref: String(args.ref), role: entry.role, name: entry.name, x: Math.round(x), y: Math.round(y) },
        };
      } catch (err) {
        return asDataError(err);
      }
    },
  };

  /** ---- browser_type（write）——ref 聚焦 + insertText（Unicode 全覆盖） ---- */
  const type: ToolDefinition = {
    name: 'browser_type',
    description:
      '向输入框/文本域输入文本。ref 必须来自最近一次 browser_snapshot（点击聚焦后走输入法通道——中文等非 ASCII 全覆盖）。',
    parameters: Type.Object({
      ref: Type.String({ description: 'browser_snapshot 返回的 @eN 引用（须为 textbox/searchbox 类元素）' }),
      text: Type.String({ description: '要输入的文本（支持任意 Unicode）' }),
    }),
    effect: 'write',
    timeoutMs: 15_000,
    execute: async (args, tctx) => {
      try {
        const { rpc, session, capture } = await acquire(tctx.sessionId);
        const entry = lookupRef(capture.refs, String(args.ref));
        const text = String(args.text);
        // 聚焦 = 点击盒中心（真用户路径）；insertText 不触发键事件（IME 同形态）
        const { x, y } = await refBoxCenter(rpc, session.sessionId, entry);
        const base = { x, y, button: 'left' as const, clickCount: 1 };
        await rpc.request(
          'Input.dispatchMouseEvent',
          { type: 'mousePressed', ...base },
          { sessionId: session.sessionId },
        );
        await rpc.request(
          'Input.dispatchMouseEvent',
          { type: 'mouseReleased', ...base },
          { sessionId: session.sessionId },
        );
        await rpc.request('Input.insertText', { text }, { sessionId: session.sessionId });
        return {
          content: [{ type: 'text', text: `已向 ${entry.role} "${entry.name}" 输入 ${text.length} 字符` }],
          details: { ref: String(args.ref), role: entry.role, name: entry.name, chars: text.length },
        };
      } catch (err) {
        return asDataError(err);
      }
    },
  };

  /** ---- browser_press（write）——键序白名单 + 三事件合成 ---- */
  const press: ToolDefinition = {
    name: 'browser_press',
    description:
      '按键（作用于页面当前焦点）。支持可打印单字符、具名键（enter/tab/escape/backspace/delete/home/end/pageup/pagedown/arrowup/arrowdown/arrowleft/arrowright）及 ' +
      ' 组合修饰（如 Control+A → 组合键）。',
    parameters: Type.Object({
      key: Type.String({ description: '按键名（如 "a" / "Enter" / "Control+A"）' }),
    }),
    effect: 'write',
    timeoutMs: 15_000,
    execute: async (args, tctx) => {
      try {
        const { rpc, session } = await acquire(tctx.sessionId);
        const k = parseKeyInput(String(args.key));
        const base = {
          key: k.key,
          ...(k.code === undefined ? {} : { code: k.code }),
          windowsVirtualKeyCode: k.vk,
          nativeVirtualKeyCode: k.vk,
          ...(k.modifiers === 0 ? {} : { modifiers: k.modifiers }),
        };
        // 有 text（可打印字符/Enter）= keyDown 合成 keypress + keyUp；
        // 纯控制键 = rawKeyDown（不产字符）+ keyUp
        await rpc.request(
          'Input.dispatchKeyEvent',
          {
            type: k.text === undefined ? 'rawKeyDown' : 'keyDown',
            ...base,
            ...(k.text === undefined ? {} : { text: k.text, unmodifiedText: k.text }),
          },
          { sessionId: session.sessionId },
        );
        await rpc.request('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, { sessionId: session.sessionId });
        return {
          content: [{ type: 'text', text: `已按键 ${String(args.key)}` }],
          details: { key: String(args.key), modifiers: k.modifiers },
        };
      } catch (err) {
        return asDataError(err);
      }
    },
  };

  /** ---- browser_scroll（write）——整页滚动手势 ---- */
  const scroll: ToolDefinition = {
    name: 'browser_scroll',
    description: '整页滚动（上下左右四向）。缺省每次 600 像素。',
    parameters: Type.Object({
      direction: Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')], {
        description: '滚动方向',
      }),
      amount: Type.Optional(Type.Number({ minimum: 1, maximum: 10_000, description: '像素数（缺省 600）' })),
    }),
    effect: 'write',
    timeoutMs: 15_000,
    execute: async (args, tctx) => {
      try {
        const { rpc, session } = await acquire(tctx.sessionId);
        const direction = String(args.direction) as 'up' | 'down' | 'left' | 'right';
        const amount = typeof args.amount === 'number' ? args.amount : 600;
        // CDP 语义：yDistance 正 = 向下滚；xDistance 正 = 向左滚（协议原文）
        const xDistance = direction === 'left' ? amount : direction === 'right' ? -amount : 0;
        const yDistance = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
        await rpc.request(
          'Input.synthesizeScrollGesture',
          { x: 0, y: 0, xDistance, yDistance, speed: 600 },
          { sessionId: session.sessionId },
        );
        // 页面锚点回读（规范工具表 scroll 行承诺 title+url——与 navigate/back/
        // forward 同律；滚动后模型直拿位置反馈，省一次补拍快照定位）
        const state = await pageState(rpc, session.sessionId);
        const label = { up: '向上', down: '向下', left: '向左', right: '向右' }[direction];
        return {
          content: [
            { type: 'text', text: `已${label}滚动 ${amount}px\n页面：${state.url}\n标题：${state.title || '(无)'}` },
          ],
          details: { direction, amount, url: state.url, title: state.title },
        };
      } catch (err) {
        return asDataError(err);
      }
    },
  };

  /** ---- browser_screenshot（read）——PNG 落盘（字节永不进结果） ---- */
  const screenshot: ToolDefinition = {
    name: 'browser_screenshot',
    description: '截取当前页面 PNG 截图并落盘（每会话滚动保留最近 20 张）。返回文件路径与字节数——图像字节不进对话。',
    parameters: Type.Object({
      fullPage: Type.Optional(Type.Boolean({ description: '整页截图（含视口外内容，缺省 false）' })),
    }),
    effect: 'read',
    timeoutMs: 20_000,
    execute: async (args, tctx) => {
      try {
        const { rpc, session } = await acquire(tctx.sessionId);
        const fullPage = args.fullPage === true;
        const shot = (await rpc.request(
          'Page.captureScreenshot',
          { format: 'png', ...(fullPage ? { captureBeyondViewport: true } : {}) },
          { sessionId: session.sessionId },
        )) as { data?: string };
        if (typeof shot.data !== 'string' || shot.data === '') {
          return { content: [{ type: 'text', text: '截图失败：引擎返回空数据' }], isError: true };
        }
        const png = Buffer.from(shot.data, 'base64');
        const key = sessionKeyOf(tctx.sessionId);
        const seq = (shotSeq.get(key) ?? 0) + 1;
        shotSeq.set(key, seq);
        const saved = saveScreenshot(dataDir, key, seq, png);
        return {
          content: [{ type: 'text', text: `已截图：${saved.path}（${saved.bytes} 字节${fullPage ? '，整页' : ''}）` }],
          details: { path: saved.path, bytes: saved.bytes, fullPage },
        };
      } catch (err) {
        return asDataError(err);
      }
    },
  };

  /** ---- browser_console（read）——环形缓冲读取（最新在前） ---- */
  const console_: ToolDefinition = {
    name: 'browser_console',
    description:
      '读取当前会话页面的 console 输出缓冲（含未捕获异常与自动 dismiss 的 JS dialog；最新在前，环形容纳 200 条）。',
    parameters: Type.Object({
      level: Type.Optional(
        Type.Union(
          [
            Type.Literal('log'),
            Type.Literal('info'),
            Type.Literal('warning'),
            Type.Literal('error'),
            Type.Literal('debug'),
          ],
          { description: '级别过滤（缺省全部）' },
        ),
      ),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: '返回条数帽（缺省 50）' })),
    }),
    effect: 'read',
    timeoutMs: 5_000,
    execute: async (args, tctx) => {
      const { capture } = await acquire(tctx.sessionId);
      const level = args.level as string | undefined;
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      const all = capture.console.entries();
      const picked = all.filter((e) => level === undefined || e.level === level).slice(0, limit);
      const text =
        picked.length > 0
          ? picked.map((e) => `[${e.seq}] ${e.level}/${e.kind}: ${e.text}`).join('\n')
          : '（console 缓冲为空——尚无输出或引擎刚启动）';
      return {
        content: [{ type: 'text', text }],
        details: { buffered: all.length, returned: picked.length, level: level ?? null },
      };
    },
  };

  /**
   * 引擎回退披露装饰（遗漏大扫 20260901-b #27）：发现序回退代（engineNote
   * 在场）——工具结果文本尾附回退自述 + details 标 fallbackWarning。规范
   * 「工具结果标 fallbackWarning」条款的模型面通道（用户面 logger/notify
   * 原已有——此前模型对回退引擎全盲，engineNote 组装了却零消费）。
   */
  const withEngineNote = (def: ToolDefinition): ToolDefinition => ({
    ...def,
    execute: async (args, tctx) => {
      const result = await def.execute(args, tctx);
      const note = engineNoteByKey.get(sessionKeyOf(tctx.sessionId));
      if (note === undefined) return result;
      const content = result.content.map((c) =>
        c.type === 'text' ? { ...c, text: `${c.text}\n（引擎回退：${note}）` } : c,
      );
      // details 形态未知（工具各自定义）——原样并键保序，fallbackWarning 追加
      const details = { ...((result.details as Record<string, unknown> | undefined) ?? {}), fallbackWarning: note };
      return { ...result, content, details };
    },
  });

  // 十件注册（顺序即清单序：navigate/back/forward/snapshot/click/type/press/scroll/screenshot/console）
  const defs = [
    navigate,
    historyStep('browser_back', -1),
    historyStep('browser_forward', 1),
    snapshot,
    click,
    type,
    press,
    scroll,
    screenshot,
    console_,
  ];
  return defs.map((def) => register(withEngineNote(def)));
}
