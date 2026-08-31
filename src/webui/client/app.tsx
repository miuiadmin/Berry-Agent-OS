/**
 * SPA 根组件——会话清单侧栏 + 对话视图 + todo 常驻面板三栏布局。
 *
 * 渲染模型（契约篇 §6.8 刀二细化）：**投影为真相 + SSE 为活体增强**——
 * - 消息主列表恒来自拉投影腿（GET messages，SPA 零折叠逻辑）；SSE display
 *   族只驱动「当前 run 未入投影的尾部增量」；
 * - message_update.message 是累积快照——流式文本**整体替换**渲染（CR-13），
 *   非 token delta 追加；
 * - durable 镜像（session 族）到达 = 投影已前进，**只重拉当前查看会话**
 *   （CR-14）：turn/end → 全量重拉；user/message → 重拉 + todo 面板归零
 *   （CR-1——『用户输入段』边界：新段旧表不越界）；todo/write → 面板全量
 *   替换（session_start 是 bus 活词从不入 durable 镜像——清单刷新由全局
 *   turn/end 与 onopen 三发覆盖，复盘 #40）；
 * - daemon 形态引导闸（复盘 #45）：任一 API 401 → 全屏 token 引导屏
 *   （POST /api/auth 换 HttpOnly cookie）→ 纪元 +1 载入/SSE 整套重建；
 *   --port 手动形态无鉴权永不 401，闸恒放行。
 * - 半程态合并（CR-2）：投影中无配对 toolResult 的 toolCall 按 pending 卡
 *   渲染，display 族 tool_execution_* 帧按 toolCallId 同键覆盖其状态/输出
 *   （详见 chat-view.tsx）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApprovalDecision,
  PendingApproval,
  ProjectedMessage,
  RewindRow,
  SessionSummary,
  SseEnvelope,
  TodoItem,
} from './types';
import {
  ApiError,
  authBootstrap,
  decideApproval,
  fetchApprovals,
  fetchMessages,
  fetchSessions,
  fetchTodo,
  interruptSession,
  openSession,
  submitMessage,
} from './api';
import { SessionList } from './session-list';
import { ChatView } from './chat-view';
import { TodoPanel } from './todo-panel';
import { MentionInput } from './mention-input';
import { textOf } from './text';

/** 工具卡活态（display 族 tool_execution_* 帧累积——同 toolCallId 覆盖） */
export interface LiveTool {
  /** 工具名（帧透传） */
  name: string;
  /** 参数 JSON 串预览（start 帧携带） */
  argsText?: string;
  /** 输出预览（end 帧携带；start→end 窗口期缺省） */
  output?: string;
  /** 错误旗（end 帧） */
  isError?: boolean;
  /** 是否收束（end 帧后 true——卡片停转态） */
  done: boolean;
}

/** 当前 run 的活体增量（display 族累积；turn 落账重拉后整体清空） */
export interface LiveState {
  /** 流式 assistant 文本（累积快照——message_update.message 整体替换） */
  streamText: string;
  /** 流是否已收束（message_end 后停光标闪烁） */
  streamDone: boolean;
  /** 工具卡活态：toolCallId → LiveTool */
  tools: Map<string, LiveTool>;
}

/** 活体增量空态（agent_start 复位用） */
function emptyLive(): LiveState {
  return { streamText: '', streamDone: false, tools: new Map() };
}

/** todo/write 事件载荷防御归一（镜像 chat 件 normalizeItems——坏项丢弃不炸读） */
function normalizeTodo(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { content, status, activeForm } = entry as Record<string, unknown>;
    if (typeof content !== 'string' || content === '') continue;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue;
    out.push({ content, status, ...(typeof activeForm === 'string' ? { activeForm } : {}) });
  }
  return out;
}

/** 工具结果输出预览（AgentToolResult 形态宽——字符串直出、对象按已知键递解） */
export function previewOf(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const text = r.output ?? r.content ?? r.text ?? r.message;
    if (typeof text === 'string') return text;
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

/** epoch 毫秒 → 相对时长短文案（清单行用；缺省值容缺） */
export function relTime(ms: number | undefined): string {
  if (ms === undefined) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/**
 * 引导屏（复盘 #45——daemon 形态 401 检出时接管全屏）：贴 daemon token 走
 * POST /api/auth 换 HttpOnly cookie，成功后回调放行。token 从环境读、
 * 输入框 type=password 不回显明文复述。
 */
function BootstrapGate({ onOk }: { onOk: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  /** 提交中旗（防双发；成功路径不回落——闸随即放行整屏卸载） */
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const value = token.trim();
    if (value === '' || busy) return;
    setBusy(true);
    setError('');
    try {
      await authBootstrap(value);
      onOk();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'token 不符' : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-4 text-neutral-200">
      <form
        className="w-full max-w-sm space-y-3 rounded-xl border border-neutral-800 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="text-sm font-medium">daemon 访问令牌</div>
        <div className="text-xs text-neutral-500">
          首次访问需一次性引导：贴 daemon token 换 HttpOnly cookie，此后免输。token 存于宿主数据目录
          daemon/daemon-token。
        </div>
        <input
          type="password"
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-600"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="daemon token"
          autoFocus
        />
        {error !== '' && <div className="text-xs text-red-400">{error}</div>}
        <button
          type="submit"
          className="w-full rounded-lg bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50"
          disabled={busy || token.trim() === ''}
        >
          {busy ? '验证中…' : '进入'}
        </button>
      </form>
    </div>
  );
}

/** App 根：状态面全在此（清单/查看指针/消息投影/todo/活体增量/连接态/状态条） */
export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [viewedId, setViewedId] = useState<string | undefined>(undefined);
  /** 查看指针的同步镜像——SSE onmessage 闭包里取最新值而不重订阅 */
  const viewedRef = useRef<string | undefined>(undefined);
  const [messages, setMessages] = useState<ProjectedMessage[]>([]);
  const [todo, setTodo] = useState<TodoItem[] | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [input, setInput] = useState('');
  /** SSE 连接态（false = 断线重连中——浏览器 EventSource 自带重连） */
  const [connected, setConnected] = useState(false);
  /** 状态条文案（notify 族广播 / API 错误——一次性信息不打断布局） */
  const [notice, setNotice] = useState('');
  /**
   * 未决审批·角标面（刀三）：GET /api/approvals 恢复 + asked 帧注册、decided
   * 帧摘除——侧栏角标数据源（刷新/晚连接重挂；已决不恢复是 parity 诚实）。
   */
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  /**
   * 未决审批·inline 卡面（刀三）：asked 帧驱动 only（恢复面不挂 inline——
   * 非当前会话卡无处挂，冷读 #5/#13）；decided 帧摘除。
   */
  const [liveCards, setLiveCards] = useState<PendingApproval[]>([]);
  /** checkpoint 转录行（刀三）：rewind 帧活体 only——surface 词不进投影 */
  const [rewinds, setRewinds] = useState<RewindRow[]>([]);
  /**
   * 引导闸门态（复盘 #45）：'ok' = 无鉴权或 cookie 已在（--port 手动形态恒
   * ok）；'needed' = 检出任一 401 → 引导屏接管。放行时配 authEpoch +1 重键
   * 两 effect（cookie 已种，fetch/EventSource 同源默认携带）。
   */
  const [gate, setGate] = useState<'ok' | 'needed'>('ok');
  /** 引导成功纪元（只增计数——effect 依赖之一，换 key 即整套重建） */
  const [authEpoch, setAuthEpoch] = useState(0);

  /** 错误入状态条（ApiError 带状态码；其余按名字）。401 特判 = 翻引导闸 */
  const noteError = useCallback((err: unknown) => {
    // daemon 形态 cookie 缺席：所有 /api 均回 401（EventSource 亦永久失败）
    // ——与其在状态条反复报错，不如整屏引导换 cookie（一次性动作）
    if (err instanceof ApiError && err.status === 401) {
      setGate('needed');
      return;
    }
    const text = err instanceof ApiError ? `${err.message}（HTTP ${err.status}）` : String(err);
    setNotice(text);
  }, []);

  /** 刷会话清单（mount / onopen 三发 / turn/end 后——轻量 GET） */
  const refreshSessions = useCallback(() => {
    fetchSessions().then(setSessions).catch(noteError);
  }, [noteError]);

  /** 加载查看会话（消息投影 + todo 并行拉取）。竞态护栏：迟到应答不覆盖新查看会话 */
  const loadView = useCallback(
    async (id: string) => {
      setLive(null); // 活体只属于当前查看会话的当前 run——切会话/换段即弃
      try {
        const [nextMessages, nextTodo] = await Promise.all([fetchMessages(id), fetchTodo(id)]);
        if (viewedRef.current !== id) return;
        setMessages(nextMessages);
        setTodo(nextTodo);
      } catch (err) {
        noteError(err);
      }
    },
    [noteError],
  );

  /** 选中会话（清单点击/开新——指针两写 + 拉取） */
  const select = useCallback(
    (id: string) => {
      viewedRef.current = id;
      setViewedId(id);
      void loadView(id);
    },
    [loadView],
  );

  /* 首载：清单 → 自动选第一条活会话（无活条目回落首行只读面）+ 审批角标恢复
   * （gate/authEpoch 重键：引导放行后带 cookie 整套重跑；闸未开即不烧请求） */
  useEffect(() => {
    if (gate !== 'ok') return;
    (async () => {
      try {
        const list = await fetchSessions();
        setSessions(list);
        const first = list.find((s) => s.active) ?? list[0];
        if (first !== undefined) select(first.id);
      } catch (err) {
        noteError(err);
      }
    })();
    // 审批恢复面静默失败（非致命——角标缺席只是少一层提醒，不打扰状态条）
    fetchApprovals()
      .then(setApprovals)
      .catch(() => undefined);
  }, [gate, authEpoch, select, noteError]);

  /* SSE 活体流（gate/authEpoch 重键——闸未开不留旧连接，放行后重建即带 cookie；
   * 信封四族分派，全部判据只对查看中会话起作用） */
  useEffect(() => {
    if (gate !== 'ok') return;
    const es = new EventSource('/api/events');
    es.onopen = () => {
      setConnected(true);
      // 复盘 #46（契约篇 §6.8「onopen 恒重拉三发」——与 attach 同律）：重连后
      // 信封不回补断线窗，帧只从当下开始流——三发把投影前进/清单变化/审批
      // 进出一次补齐，不依赖任何序号（首连同理：零帧前的状态全靠这三发）
      refreshSessions();
      const id = viewedRef.current;
      if (id !== undefined) void loadView(id);
      fetchApprovals()
        .then(setApprovals)
        .catch(() => undefined);
    };
    es.onerror = () => setConnected(false); // 断线——浏览器自动重连，状态条示红
    es.onmessage = (me: MessageEvent<string>) => {
      let env: SseEnvelope;
      try {
        env = JSON.parse(me.data) as SseEnvelope;
      } catch {
        return; // 坏帧丢弃（帧合成纪律 = 单行 JSON，坏帧属异常面）
      }
      const isViewed = env.sessionId !== undefined && env.sessionId === viewedRef.current;
      if (env.kind === 'session') {
        // durable 镜像族：payload = SessionEvent 本体（channel 组帧上提，省一字段）
        const ev = env.payload as { type?: string } & Record<string, unknown>;
        switch (ev.type) {
          // 复盘 #40：session_start 是 bus 活词（rootCtx.emit）从不入 durable
          // 事件账——session 族恒镜像词，此 case 结构性不可达，已删。清单
          // 刷新由全局 turn/end 与 onopen 三发覆盖。
          case 'turn/end':
            refreshSessions(); // updatedAt 前进
            if (isViewed) void loadView(viewedRef.current!); // 全量重拉 + 清活体
            return;
          case 'user/message':
            if (isViewed) {
              setTodo(null); // CR-1：新输入段边界——面板即归零（重拉真值随后对齐）
              void loadView(viewedRef.current!);
            }
            return;
          case 'todo/write':
            if (isViewed) setTodo(normalizeTodo((ev.data as { items?: unknown } | undefined)?.items));
            return;
          case 'approval/asked': {
            // 审批帧是操作面不是渲染面——他会话帧不忽略（冷读 #5：后台会话
            // 审批全程可见是 web 应答面核心价值）。载荷 {approvalId, summary}。
            const data = ev.data as { approvalId?: unknown; summary?: unknown } | undefined;
            if (typeof data?.approvalId !== 'string') return;
            const entry: PendingApproval = {
              approvalId: data.approvalId,
              sessionId: env.sessionId,
              summary: typeof data.summary === 'string' ? data.summary : '',
            };
            const upsert = (list: readonly PendingApproval[]) => [
              ...list.filter((a) => a.approvalId !== entry.approvalId),
              entry,
            ];
            setApprovals(upsert);
            setLiveCards(upsert);
            // 复盘 #47：durable 载荷结构性只有两键——富字段（suggestedEntry/
            // reason/ownership/priority）在服务端 claim 时点富化，帧载荷永远
            // 不带；不补拉则三态按钮（gated on suggestedEntry）在线不可达。
            // 按 attach 先例重拉 GET /api/approvals 以 approvalId 同键合并进
            // liveCards（信封 sessionId 优先——簿面条目缺省档防御）。静默失败：
            // 重拉败则薄卡留任（应答面仍可用）
            void fetchApprovals()
              .then((list) => {
                setApprovals(list);
                setLiveCards((prev) =>
                  prev.map((c) => {
                    const rich = list.find((x) => x.approvalId === c.approvalId);
                    return rich === undefined ? c : { ...rich, sessionId: c.sessionId ?? rich.sessionId };
                  }),
                );
              })
              .catch(() => undefined);
            return;
          }
          case 'approval/decided': {
            // 卡终结 + 角标退场（两源同判——不分谁先胜，decided 是单写真值）
            const data = ev.data as { approvalId?: unknown } | undefined;
            if (typeof data?.approvalId !== 'string') return;
            const drop = (list: readonly PendingApproval[]) => list.filter((a) => a.approvalId !== data.approvalId);
            setApprovals(drop);
            setLiveCards(drop);
            return;
          }
          case 'checkpoint/rewind': {
            // 转录行（活体 only——surface 词不进投影，刷新消失是 parity 诚实）
            const data = ev.data as { id?: unknown; newSessionId?: unknown; files?: unknown } | undefined;
            const rid = data?.id;
            const rnew = data?.newSessionId;
            const sid = env.sessionId;
            if (typeof rid !== 'string' || typeof rnew !== 'string' || typeof sid !== 'string') return;
            setRewinds((prev) => [
              ...prev,
              { sessionId: sid, id: rid, newSessionId: rnew, files: Number(data?.files) || 0 },
            ]);
            return;
          }
          default:
            return;
        }
      }
      if (env.kind === 'display') {
        // display 族：payload = AgentEvent 本体——只喂查看中会话的活体增量
        if (!isViewed) return;
        const ev = env.payload as { type?: string } & Record<string, unknown>;
        switch (ev.type) {
          case 'agent_start':
            setLive(emptyLive()); // 新 run 复位
            return;
          case 'message_update':
          case 'message_end': {
            // 累积快照替换渲染（CR-13）：message 整体替换，不追加
            const text = textOf((ev.message as { content?: unknown } | undefined)?.content);
            setLive((prev) => ({
              streamText: text,
              streamDone: ev.type === 'message_end',
              tools: prev?.tools ?? new Map(),
            }));
            return;
          }
          case 'tool_execution_start': {
            const callId = String(ev.toolCallId);
            const name = String(ev.toolName);
            const argsText = ev.args === undefined ? undefined : JSON.stringify(ev.args, null, 2);
            setLive((prev) => {
              const tools = new Map(prev?.tools ?? []);
              tools.set(callId, { name, argsText, done: false });
              return { ...(prev ?? emptyLive()), tools };
            });
            return;
          }
          case 'tool_execution_end': {
            const callId = String(ev.toolCallId);
            const name = String(ev.toolName);
            const output = previewOf(ev.result);
            const isError = ev.isError === true;
            setLive((prev) => {
              const tools = new Map(prev?.tools ?? []);
              tools.set(callId, { name, output, isError, done: true });
              return { ...(prev ?? emptyLive()), tools };
            });
            return;
          }
          default:
            return; // turn_*/message_start/tool_execution_update v1 不消费
        }
      }
      if (env.kind === 'notify') {
        const message = (env.payload as { message?: string } | undefined)?.message;
        if (typeof message === 'string') setNotice(message);
        return;
      }
      if (env.kind === 'status') {
        const status = (env.payload as { status?: string } | undefined)?.status;
        if (status === 'connected')
          setConnected(true); // 重连成功的最低信号
        else if (typeof status === 'string') setNotice(status);
      }
    };
    return () => es.close();
  }, [gate, authEpoch, loadView, refreshSessions]);

  /** 开新会话（POST /api/sessions——一条龙服务端内化，前端只收清单条目） */
  const onOpen = useCallback(async () => {
    try {
      const summary = await openSession();
      setSessions((prev) => [summary, ...prev.filter((s) => s.id !== summary.id)]);
      select(summary.id);
    } catch (err) {
      noteError(err);
    }
  }, [select, noteError]);

  /**
   * 审批应答（刀三）：POST decide 只 resolve 服务端 resolver——durable 写在
   * 服务端单写漏斗；superseded（TUI 先决）如实示警。终结呈现双保险：decided
   * SSE 帧是真值，乐观摘除兜底 SSE 断线窗（帧迟到时幂等）。
   */
  const onDecide = useCallback(
    async (approvalId: string, decision: ApprovalDecision) => {
      try {
        const res = await decideApproval(approvalId, decision);
        if (!res.accepted) setNotice('该审批已在 TUI 侧应答（web 端操作未生效）');
        const drop = (list: readonly PendingApproval[]) => list.filter((a) => a.approvalId !== approvalId);
        setApprovals(drop);
        setLiveCards(drop);
      } catch (err) {
        noteError(err);
      }
    },
    [noteError],
  );

  /**
   * 引导放行（复盘 #45）：闸回 ok + 纪元 +1——载入/SSE 两 effect 随之整套
   * 重建（fetch/EventSource 同源默认携 cookie，此后免输）。
   */
  const onAuthed = useCallback(() => {
    setGate('ok');
    setAuthEpoch((n) => n + 1);
  }, []);

  /**
   * 打断在飞 run（复盘 #48——TUI Ctrl+C 的 web 等价面）。404 = 无在飞 run
   * （目标不在册/已闭/本就空闲）——诚实告知非报错。
   */
  const onInterrupt = useCallback(async () => {
    const id = viewedRef.current;
    if (id === undefined) return;
    try {
      await interruptSession(id);
      setNotice('已请求打断当前 run');
    } catch (err) {
      setNotice(err instanceof ApiError && err.status === 404 ? '无在飞 run 可打断' : String(err));
    }
  }, []);

  /** 提交（乐观 user 行先行——durable 镜像重拉后由真值替换；失败回滚重拉） */
  const onSubmit = useCallback(async () => {
    const text = input.trim();
    const id = viewedRef.current;
    const target = sessions.find((s) => s.id === id);
    if (text === '' || id === undefined || target === undefined) return;
    if (!target.active) {
      setNotice('已闭会话只读（复活面挂后续刀）');
      return;
    }
    setInput('');
    setMessages((prev) => [...prev, { type: 'user', seq: -Date.now(), content: text }]);
    try {
      await submitMessage(id, text);
    } catch (err) {
      noteError(err);
      void loadView(id);
    }
  }, [input, sessions, noteError, loadView]);

  const viewed = sessions.find((s) => s.id === viewedId);

  /** 角标计数（按归属会话聚合——根路审批 sessionId 落信封，天然有主） */
  const approvalCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of approvals) {
      if (a.sessionId === undefined) continue;
      counts.set(a.sessionId, (counts.get(a.sessionId) ?? 0) + 1);
    }
    return counts;
  }, [approvals]);

  /** inline 卡按查看会话过滤（非当前会话只走角标——冷读 #5 分层） */
  const viewedCards = useMemo(() => liveCards.filter((a) => a.sessionId === viewedId), [liveCards, viewedId]);
  const viewedRewinds = useMemo(() => rewinds.filter((r) => r.sessionId === viewedId), [rewinds, viewedId]);

  // 引导屏接管（所有 hook 已收束——早退不破 hook 序；放行后走正常渲染）
  if (gate === 'needed') return <BootstrapGate onOk={onAuthed} />;

  return (
    <div
      className="flex h-full flex-col"
      style={viewed?.accent !== undefined ? { ['--accent' as string]: viewed.accent } : undefined}
    >
      {/* 顶栏：连接态 + 应用域 + 打断 + 状态条 */}
      <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2 text-sm">
        <span
          className={`inline-block size-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`}
          title={connected ? 'SSE 已连接' : 'SSE 断线重连中'}
        />
        <span className="font-medium" style={{ color: 'var(--accent)' }}>
          {viewed?.appId ?? '—'}
        </span>
        {/* 打断（复盘 #48）：只对 active 会话呈现——已闭只读面无在飞 run 可断 */}
        {viewed?.active === true && (
          <button
            className="rounded-md border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400 hover:text-neutral-200"
            onClick={() => void onInterrupt()}
            title="打断当前会话在飞 run（与 TUI Ctrl+C 同源）"
          >
            打断
          </button>
        )}
        <span className="truncate text-neutral-500">{notice}</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <SessionList
          sessions={sessions}
          viewedId={viewedId}
          approvalCounts={approvalCounts}
          onSelect={select}
          onOpen={() => void onOpen()}
        />
        <ChatView
          messages={messages}
          live={live}
          approvals={viewedCards}
          rewinds={viewedRewinds}
          onDecide={(id, d) => void onDecide(id, d)}
        />
        <TodoPanel todo={todo} />
      </div>
      {/* 输入面：已闭会话禁用（只读）；@-mention 两段补全（刀三） */}
      <footer className="border-t border-neutral-800 p-3">
        <div className="flex gap-2">
          <MentionInput
            value={input}
            onChange={setInput}
            onSubmit={() => void onSubmit()}
            disabled={viewed === undefined || !viewed.active}
            placeholder={
              viewed?.active === false ? '已闭会话只读' : '输入消息，Enter 提交；@ 补全文件，@路径# 补全符号'
            }
          />
          <button
            className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-950"
            style={{ background: 'var(--accent)' }}
            disabled={viewed === undefined || !viewed.active || input.trim() === ''}
            onClick={() => void onSubmit()}
          >
            发送
          </button>
        </div>
      </footer>
    </div>
  );
}
