/**
 * App 根组件测试（P1-3 SPA 测试轨——SSE 分派与状态机的数据流回归锁）。
 *
 * mock 边界（纪律：mock 只停 IO 腿）：`./api` 取数腿整体 vi.mock（组件不触
 * 网络层）、EventSource 全局桩（jsdom 不实现 SSE——App 构造即被捕获，测试
 * 驱动 onopen/onmessage 模拟信封帧）。React/子组件全真。
 *
 * 锁五面：首载自动选活会话、乐观提交行、SSE 信封四族分派（session 镜像 /
 * notify）、401 翻引导闸 + 放行整套重建（复盘 #45）、superseded 审批应答
 * 示警（刀三）。另附 previewOf/relTime 两纯函数单测。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 仅 ApiError 值导入（:204 构造用——vi.mock 工厂同源类；其余十一件只在 mock 工厂内
// 出现，测试体零直接引用，不导入——noUnusedLocals 绿）
import { ApiError } from './api';
import { App, previewOf, relTime } from './app';
import type { ProjectedMessage, SessionSummary } from './types';

/* ---------------- mock 边界 ---------------- */

/** ./api 全件 mock 面（hoisted——vi.mock 工厂引用；件数须随 api.ts 导出面同步） */
const api = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  fetchMessages: vi.fn(),
  fetchTodo: vi.fn(),
  fetchApprovals: vi.fn(),
  submitMessage: vi.fn(),
  openSession: vi.fn(),
  authBootstrap: vi.fn(),
  interruptSession: vi.fn(),
  decideApproval: vi.fn(),
  fetchFiles: vi.fn(),
  fetchSymbols: vi.fn(),
}));

vi.mock('./api', async (importOriginal) => {
  // 面同步执法（遗漏大扫 20260902 #10）：App 渲染 MentionInput（app.tsx footer），
  // 其 import 的每个 ./api 导出都从本工厂取——api.ts 新增导出而桩未跟，缺席导出
  // 以 undefined 静默进组件，直到某条测试触发才 TypeError（面漂移假绿家族：
  // 注释自称「全件 mock 面」无人执法）。importOriginal 取真面键集对照，缺席
  // 即 throw——vi.mock 工厂抛错使本文件全部用例红（响亮早红非延迟炸）。
  const actual = await importOriginal<Record<string, unknown>>();
  const missing = Object.keys(actual).filter((k) => !(k in api) && k !== 'ApiError');
  if (missing.length > 0) {
    throw new Error(`./api mock 面缺席导出（补桩或核面）：${missing.join(', ')}`);
  }
  // ApiError 类在工厂内实现（App 的 instanceof 判据消费本类——测试同 import 即同源）
  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, ...api };
});

/** EventSource 桩（jsdom 无 SSE 实现——实例捕获 + 帧驱动 + close 记账） */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  /** DOM EventSource.readyState 常量（组件永久失败腿判定消费——0=CONNECTING/2=CLOSED） */
  static readonly CLOSED = 2 as const;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  /** 连接态（0=CONNECTING/1=OPEN/2=CLOSED——F-2 永久失败腿的驱动位，测试手拨） */
  readyState = 0;
  closed = false;
  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

/* ---------------- 夹具 ---------------- */

/** 活会话 berrycode 条目（首载自动选中目标） */
function liveSession(): SessionSummary {
  return { id: 'live-1', appId: 'berrycode', cwd: '/w/proj', active: true, updatedAt: Date.now() };
}

/** 首载缺省应答（清单一条活会话 + 一条用户消息 + todo 一项） */
function primeHappyLoad(): void {
  api.fetchSessions.mockResolvedValue([{ id: 'closed-1', appId: 'chat', active: false }, liveSession()]);
  api.fetchMessages.mockResolvedValue([{ type: 'user', seq: 1, content: '你好' }] satisfies ProjectedMessage[]);
  api.fetchTodo.mockResolvedValue([{ content: '任务一', status: 'in_progress', activeForm: '正在做任务一' }]);
  api.fetchApprovals.mockResolvedValue([]);
  api.submitMessage.mockResolvedValue(undefined);
  api.decideApproval.mockResolvedValue({ accepted: true });
  api.authBootstrap.mockResolvedValue(undefined);
  // @-mention 两段缺省（App footer 的 MentionInput 消费——本文件用例不触发 '@'，
  // 缺省应答是防未来输入文本含 '@' 时 undefined 桩 TypeError）
  api.fetchFiles.mockResolvedValue([]);
  api.fetchSymbols.mockResolvedValue(null);
}

/** 驱动一条 SSE 信封帧（onmessage 直灌——act 包裹 React 状态更新） */
function sendFrame(es: FakeEventSource, env: unknown): void {
  act(() => {
    es.onmessage?.({ data: JSON.stringify(env) });
  });
}

/** 等到首载收束（用户行 '你好' 上屏——fetchMessages 应答锚；'berrycode' 双命中不可作锚） */
async function untilLoaded(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText('你好')).toBeTruthy();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  primeHappyLoad();
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ---------------- 组件面 ---------------- */

describe('App 首载与选中', () => {
  it('清单 → 自动选第一条活会话（闭会话跳过）+ 投影/todo 双拉渲染', async () => {
    render(<App />);
    // 用户行 + todo 面板两面上屏（loadView 双拉收束）；顶栏与清单行 'berrycode' 双命中点数断言
    await untilLoaded();
    expect(screen.getAllByText('berrycode')).toHaveLength(2);
    expect(screen.getByText(/正在做任务一/)).toBeTruthy();
    expect(api.fetchMessages).toHaveBeenCalledWith('live-1');
    expect(api.fetchTodo).toHaveBeenCalledWith('live-1');
  });

  it('SSE effect 即刻接线：mount 即构造 EventSource（gate ok 形态）', async () => {
    render(<App />);
    await untilLoaded();
    expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/events');
  });
});

describe('App 乐观提交', () => {
  it('发送即上屏 user 行 + 提交腿落账 + 输入框清空（不等 durable 镜像）', async () => {
    render(<App />);
    await untilLoaded();
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: '新消息' } });
    fireEvent.click(screen.getByText('发送'));
    expect(screen.getByText('新消息')).toBeTruthy(); // 乐观行同步现
    expect(api.submitMessage).toHaveBeenCalledWith('live-1', '新消息', expect.any(String)); // 第三参 = requestId 幂等键（A12）
    // getByPlaceholderText 返 HTMLElement——输入框值断言窄型到 HTMLInputElement
    expect((screen.getByPlaceholderText(/输入消息/) as HTMLInputElement).value).toBe('');
  });
});

describe('App SSE 信封分派', () => {
  it('todo/write 帧全量替换面板（CR-1 之外的另一帧——表内容更新）', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/正在做任务一/)).toBeTruthy();
    });
    const es = FakeEventSource.instances[0]!;
    sendFrame(es, {
      kind: 'session',
      sessionId: 'live-1',
      payload: { type: 'todo/write', data: { items: [{ content: '帧驱动任务', status: 'pending' }] } },
    });
    expect(screen.getByText(/帧驱动任务/)).toBeTruthy();
    expect(screen.queryByText(/正在做任务一/)).toBeNull();
  });

  it('approval/asked 帧挂 inline 卡 + decided 帧摘卡（角标/卡面两数据源同律）', async () => {
    render(<App />);
    await untilLoaded();
    const es = FakeEventSource.instances[0]!;
    sendFrame(es, {
      kind: 'session',
      sessionId: 'live-1',
      payload: { type: 'approval/asked', data: { approvalId: 'ap-1', summary: '写配置文件' } },
    });
    expect(await screen.findByText('写配置文件')).toBeTruthy();
    expect(screen.getByText('待审批')).toBeTruthy();
    sendFrame(es, {
      kind: 'session',
      sessionId: 'live-1',
      payload: { type: 'approval/decided', data: { approvalId: 'ap-1' } },
    });
    await waitFor(() => {
      expect(screen.queryByText('写配置文件')).toBeNull();
    });
  });

  it('notify 族广播进状态条；display 族只喂查看中会话（他会话帧忽略）', async () => {
    render(<App />);
    await untilLoaded();
    const es = FakeEventSource.instances[0]!;
    sendFrame(es, { kind: 'notify', payload: { message: '维护通知文案' } });
    expect(screen.getByText('维护通知文案')).toBeTruthy();
    // 非查看会话的 display 帧不进活体（CR-14 只重拉当前查看会话同族判据）
    sendFrame(es, {
      kind: 'display',
      sessionId: 'other-9',
      payload: { type: 'message_update', message: { content: [{ type: 'text', text: '别处的流' }] } },
    });
    expect(screen.queryByText(/别处的流/)).toBeNull();
  });
});

describe('App 引导闸（复盘 #45——daemon 401 → token 屏 → 放行重建）', () => {
  it('任一 API 401 翻闸：引导屏接管 + 零 EventSource；token 验证成功后整套重建', async () => {
    api.fetchSessions.mockRejectedValue(new ApiError(401, 'GET /api/sessions → 401'));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('daemon 访问令牌')).toBeTruthy();
    });
    expect(FakeEventSource.instances.filter((i) => !i.closed)).toHaveLength(0); // 闸未开零活连接（mount 期那条已 close）
    // 放行：贴 token 提交 → authBootstrap 成功 → 纪元 +1 重跑载入
    api.fetchSessions.mockResolvedValue([liveSession()]);
    fireEvent.change(screen.getByPlaceholderText('daemon token'), { target: { value: 'tok-1' } });
    fireEvent.click(screen.getByText('进入'));
    await waitFor(() => {
      expect(api.authBootstrap).toHaveBeenCalledWith('tok-1');
    });
    await untilLoaded();
    expect(api.fetchSessions).toHaveBeenCalledTimes(2); // 闸前一次（401）+ 放行后一次
    expect(FakeEventSource.instances.length).toBeGreaterThan(0); // SSE 随纪元重建
  });

  it('token 不符（401 应答）：留闸示「token 不符」，不放行', async () => {
    api.fetchSessions.mockRejectedValue(new ApiError(401, 'GET /api/sessions → 401'));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('daemon 访问令牌')).toBeTruthy();
    });
    api.authBootstrap.mockRejectedValue(new ApiError(401, 'auth → 401'));
    fireEvent.change(screen.getByPlaceholderText('daemon token'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByText('进入'));
    await waitFor(() => {
      expect(screen.getByText('token 不符')).toBeTruthy();
    });
    expect(screen.getByText('daemon 访问令牌')).toBeTruthy(); // 闸仍在
    expect(api.fetchSessions).toHaveBeenCalledTimes(1); // 未重建
  });
});

describe('App SSE 永久失败重臂（遗漏大扫 20260904-b F-2——EventSource 吃 HTTP 级拒绝即 CLOSED 永不再连）', () => {
  it('CLOSED 腿探鉴权：401 → 既有引导闸翻转 + 旧连接收口（修前 onerror 只翻红点假「重连中」卡死）', async () => {
    // daemon 重启换 token 的闲置窗口形态：EventSource 对 401 的 HTTP 级拒绝一次
    // 即 readyState=CLOSED 永不再连（真 Chrome 实测——浏览器自动重连只覆盖
    // CONNECTING 瞬断腿）。修前 onerror 只 setConnected(false) 翻红点：闸不
    // 翻、页面假「重连中」，事件零感知直到任一交互触发 fetch 才自愈。
    render(<App />);
    await untilLoaded(); // 先完成 happy 首载（此后才模拟 daemon 换 token）
    api.fetchSessions.mockRejectedValueOnce(new ApiError(401, 'GET /api/sessions → 401')); // CLOSED 腿探鉴权必吃 401
    const es = FakeEventSource.instances.at(-1)!;
    expect(es.closed).toBe(false); // 前置：首载连接活
    act(() => {
      es.readyState = FakeEventSource.CLOSED; // 手拨永久失败态（真 401 拒绝的等价驱动）
      es.onerror?.();
    });
    // 探鉴权 401 → noteError → 引导闸翻转（token 屏接管）
    await waitFor(() => {
      expect(screen.getByText('daemon 访问令牌')).toBeTruthy();
    });
    expect(es.closed).toBe(true); // 旧连接随闸收口（不再假活）
  });

  it('CLOSED 腿探活成功：退避 15s 重臂纪元——新 EventSource 重建（非鉴权性 HTTP 拒绝如连接帽 503 也能复活）', async () => {
    // 上一用例的 mockRejectedValueOnce 残队不被 clearAllMocks 清（只清 calls）——
    // mockReset 清实现与 once 队后重新 prime，保证本用例零污染独立
    api.fetchSessions.mockReset();
    primeHappyLoad();
    render(<App />);
    await untilLoaded();
    const es = FakeEventSource.instances.at(-1)!;
    vi.useFakeTimers(); // 退避计时器归假钟管（RTL+假钟纪律：advanceTimersByTimeAsync 不用 waitFor）
    try {
      act(() => {
        es.readyState = FakeEventSource.CLOSED;
        es.onerror?.();
      });
      // primeHappyLoad 使探活腿成功（非 401）→ 不翻闸，只排队退避重臂
      expect(screen.queryByText('daemon 访问令牌')).toBeNull();
      const before = FakeEventSource.instances.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(FakeEventSource.instances.length).toBe(before + 1); // 纪元 +1 → effect 重跑 → 新连接
      expect(es.closed).toBe(true); // 旧连接被 cleanup 收口
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('App 审批卡恢复（遗漏大扫 20260902-b #3——刷新/重连补挂应答卡）', () => {
  it('首载在册未决：查看中会话的 inline 应答卡恢复（非查看会话仍只角标档不渲染）', async () => {
    // 刷新形态：GET /api/approvals 已有在册未决（ask 发生在刷新前——asked 帧从未到达本端）
    api.fetchApprovals.mockResolvedValue([
      { approvalId: 'ap-r1', sessionId: 'live-1', summary: '刷新前遗留审批' },
      { approvalId: 'ap-r2', sessionId: 'other-9', summary: '他会话在册审批' },
    ]);
    render(<App />);
    await untilLoaded();
    // 修复前：恢复只喂角标面（approvals 状态），liveCards 空 → 整屏无应答控件
    expect(await screen.findByText('刷新前遗留审批')).toBeTruthy();
    expect(screen.getByText('待审批')).toBeTruthy(); // 卡面呈现（应答按钮在内）
    expect(screen.queryByText('他会话在册审批')).toBeNull(); // 非查看会话卡不渲染（渲染层过滤不变）
  });

  it('重连对账双向：断线窗内错过的在册审批补挂 + 他端已决摘除（-d #11 反向保序）', async () => {
    render(<App />);
    await untilLoaded();
    const es = FakeEventSource.instances[0]!;
    // 断线前本端挂过一张卡（asked 帧驱动）
    sendFrame(es, {
      kind: 'session',
      sessionId: 'live-1',
      payload: { type: 'approval/asked', data: { approvalId: 'ap-gone', summary: '断线窗内他端已决' } },
    });
    expect(await screen.findByText('断线窗内他端已决')).toBeTruthy();
    // 重连（onopen）：清单只剩 ap-r1——ap-gone 已决须摘、ap-r1 是断线窗内新 ask 须补挂
    api.fetchApprovals.mockResolvedValue([{ approvalId: 'ap-r1', sessionId: 'live-1', summary: '断线窗内新审批' }]);
    act(() => {
      es.onopen?.();
    });
    expect(await screen.findByText('断线窗内新审批')).toBeTruthy(); // 补挂方向（#3）
    await waitFor(() => {
      expect(screen.queryByText('断线窗内他端已决')).toBeNull(); // 摘除方向（-d #11）不回归
    });
  });
});

describe('App 审批应答 superseded（刀三——TUI 先决幂等回执）', () => {
  it('accepted:false 如实示警 + 卡面乐观摘除（decided 帧迟到幂等）', async () => {
    render(<App />);
    await untilLoaded();
    const es = FakeEventSource.instances[0]!;
    sendFrame(es, {
      kind: 'session',
      sessionId: 'live-1',
      payload: { type: 'approval/asked', data: { approvalId: 'ap-2', summary: '删除文件' } },
    });
    expect(await screen.findByText('删除文件')).toBeTruthy();
    api.decideApproval.mockResolvedValue({ accepted: false });
    fireEvent.click(screen.getAllByText('允许')[0]!);
    await waitFor(() => {
      // A16 中性化文案：accepted:false 只证「已应答」——本端在飞守门已挡本端
      // 重发，TUI 先决与另一 web 会话先决不可区分（修前文案误归因 TUI）
      expect(screen.getByText('该审批已被应答（本端或他端先行）')).toBeTruthy();
    });
    expect(screen.queryByText('删除文件')).toBeNull(); // 乐观摘除兜底
  });
});

describe('App 活体尾部多消息（A10——run 内第二条消息流式时先前消息不蒸发）', () => {
  it('message_start 开条收束前条：两条 assistant 文本 + 其间工具卡同屏且保序（修前红：单条 streamText 被整体替换，第一条蒸发）', async () => {
    render(<App />);
    await untilLoaded();
    const es = FakeEventSource.instances[0]!;
    /** display 族 message 帧驱动（message 载荷按帧型递进——CR-13 累积快照） */
    const msgFrame = (type: string, text: string) =>
      sendFrame(es, {
        kind: 'display',
        sessionId: 'live-1',
        payload: { type, message: { content: [{ type: 'text', text }] } },
      });
    // run 第一条消息：start → update → end（收束）
    msgFrame('message_start', '');
    msgFrame('message_update', '第一条回答');
    msgFrame('message_end', '第一条回答');
    // 工具执行（两消息之间的交错——帧序即活体序）+ 第二条消息开条流式
    sendFrame(es, {
      kind: 'display',
      sessionId: 'live-1',
      payload: { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} },
    });
    msgFrame('message_start', '');
    msgFrame('message_update', '第二条流式中');
    // 修前红位：message_update 只改单条 streamText——第二条整体替换第一条，
    // '第一条回答' 从屏上蒸发（投影落账前的窗口内不可见）
    expect(screen.getByText('第一条回答')).toBeTruthy();
    expect(screen.getByText(/第二条流式中/)).toBeTruthy();
    // DOM 保序：已收束消息 → 工具卡 → 流式末条（display 帧无时序锚——固定层序）
    const first = screen.getByText('第一条回答');
    const tool = screen.getByText('bash');
    const second = screen.getByText(/第二条流式中/);
    expect(first.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tool.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('App 提交失败防线（A12——requestId 幂等键 + 用户文本不蒸发）', () => {
  it('网络类失败同键重试一次成功：两次调用 requestId 同值（服务端同键早退不双投）+ 输入不回填', async () => {
    render(<App />);
    await untilLoaded();
    let calls = 0;
    api.submitMessage.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed'); // 网络腿（fetch reject——非 ApiError）
      return undefined;
    });
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: '重试可活' } });
    fireEvent.click(screen.getByText('发送'));
    // 修前红位：只调一次且不带 requestId——瞬断网络错直接进 catch 回滚重拉
    await waitFor(() => {
      expect(api.submitMessage).toHaveBeenCalledTimes(2);
    });
    const [c1, c2] = api.submitMessage.mock.calls;
    expect(c1?.[0]).toBe('live-1');
    expect(c1?.[1]).toBe('重试可活');
    expect(typeof c1?.[2]).toBe('string'); // 第三参 = 幂等键（修前缺席）
    expect(c2?.[2]).toBe(c1?.[2]); // 同键重试——服务端 LRU 去重早退
    expect((screen.getByPlaceholderText(/输入消息/) as HTMLInputElement).value).toBe(''); // 终态成功不回填
  });

  it('HTTP 级失败不重试直接收场：输入回填不蒸发 + 状态条示错（服务端已应答，重试无意义）', async () => {
    render(<App />);
    await untilLoaded();
    api.submitMessage.mockRejectedValue(new ApiError(503, 'submit → 503'));
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: '失败要保住' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => {
      expect((screen.getByPlaceholderText(/输入消息/) as HTMLInputElement).value).toBe('失败要保住'); // 修前红：''
    });
    expect(api.submitMessage).toHaveBeenCalledTimes(1); // ApiError = HTTP 级——不重试
    expect(screen.getByText(/submit → 503（HTTP 503）/)).toBeTruthy();
  });
});

describe('App checkpoint/rewind 刷清单（A14——fork 产新会话不等全局刷新）', () => {
  it('rewind 帧驱动 refreshSessions：侧栏清单即时前进（修前红：只挂转录行不刷清单）', async () => {
    render(<App />);
    await untilLoaded();
    const es = FakeEventSource.instances[0]!;
    const before = api.fetchSessions.mock.calls.length; // 首载一次（onopen 未触发）
    sendFrame(es, {
      kind: 'session',
      sessionId: 'live-1',
      payload: { type: 'checkpoint/rewind', data: { id: 'snap-1', newSessionId: 'new-1', files: 2 } },
    });
    expect(screen.getByText(/已回退至 snap-1/)).toBeTruthy(); // 转录行在场（既有行为不回归）
    expect(api.fetchSessions.mock.calls.length).toBe(before + 1); // 修前红：rewind 分支无 refreshSessions
  });
});

describe('App 审批卡在飞防双击（A16——应答在飞窗二连击只发一次 decide）', () => {
  it('永悬应答窗二连击「允许」：decideApproval 只被调一次（修前红：两次 POST）', async () => {
    render(<App />);
    await untilLoaded();
    const es = FakeEventSource.instances[0]!;
    sendFrame(es, {
      kind: 'session',
      sessionId: 'live-1',
      payload: { type: 'approval/asked', data: { approvalId: 'ap-3', summary: '双击测试' } },
    });
    expect(await screen.findByText('双击测试')).toBeTruthy();
    api.decideApproval.mockImplementation(() => new Promise(() => {})); // 永悬——在飞窗持续张开
    fireEvent.click(screen.getAllByText('允许')[0]!);
    fireEvent.click(screen.getAllByText('允许')[0]!); // 渲染帧前的双击（闭包态看不到的窗口）
    expect(api.decideApproval).toHaveBeenCalledTimes(1); // 修前红：2 次
  });
});

/* ---------------- 纯函数面 ---------------- */

describe('previewOf（工具结果输出预览归一）', () => {
  it('字符串直出 / 对象按已知键递解 / 未知对象 JSON 串 / nullish 缺省', () => {
    expect(previewOf('纯文本')).toBe('纯文本');
    expect(previewOf({ output: '对象输出' })).toBe('对象输出');
    expect(previewOf({ content: '内容键' })).toBe('内容键');
    expect(previewOf({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(previewOf(undefined)).toBeUndefined();
    expect(previewOf(null)).toBeUndefined();
    expect(previewOf(42)).toBe('42');
  });
});

describe('relTime（相对时长短文案）', () => {
  it('缺席空串 / 刚刚 / 分钟前 / 小时前 / 天前 四桶', () => {
    const now = Date.now();
    expect(relTime(undefined)).toBe('');
    expect(relTime(now)).toBe('刚刚');
    expect(relTime(now - 5 * 60_000)).toBe('5 分钟前');
    expect(relTime(now - 3 * 3_600_000)).toBe('3 小时前');
    expect(relTime(now - 2 * 86_400_000)).toBe('2 天前');
  });
});
