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
// 仅 ApiError 值导入（:204 构造用——vi.mock 工厂同源类；其余七件只在 mock 工厂内
// 出现，测试体零直接引用，不导入——noUnusedLocals 绿）
import { ApiError } from './api';
import { App, previewOf, relTime } from './app';
import type { ProjectedMessage, SessionSummary } from './types';

/* ---------------- mock 边界 ---------------- */

/** ./api 全件 mock 面（hoisted——vi.mock 工厂引用） */
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
}));

vi.mock('./api', () => {
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
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  closed = false;
  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

/* ---------------- 夹具 ---------------- */

/** 活会话 coder 条目（首载自动选中目标） */
function liveSession(): SessionSummary {
  return { id: 'live-1', appId: 'coder', cwd: '/w/proj', active: true, updatedAt: Date.now() };
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
}

/** 驱动一条 SSE 信封帧（onmessage 直灌——act 包裹 React 状态更新） */
function sendFrame(es: FakeEventSource, env: unknown): void {
  act(() => {
    es.onmessage?.({ data: JSON.stringify(env) });
  });
}

/** 等到首载收束（用户行 '你好' 上屏——fetchMessages 应答锚；'coder' 双命中不可作锚） */
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
    // 用户行 + todo 面板两面上屏（loadView 双拉收束）；顶栏与清单行 'coder' 双命中点数断言
    await untilLoaded();
    expect(screen.getAllByText('coder')).toHaveLength(2);
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
    expect(api.submitMessage).toHaveBeenCalledWith('live-1', '新消息');
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
      expect(screen.getByText('该审批已在 TUI 侧应答（web 端操作未生效）')).toBeTruthy();
    });
    expect(screen.queryByText('删除文件')).toBeNull(); // 乐观摘除兜底
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
