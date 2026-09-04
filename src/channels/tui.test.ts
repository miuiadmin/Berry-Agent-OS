/**
 * L4 channels — TUI 通道 S3 多会话呈现测试（契约篇 §5.4 S3 射面验收）。
 *
 * 假终端收集渲染帧（requestRender 经 setTimeout 调度——一轮宏任务后断言），
 * 三面验收：① 互不绞屏（聚焦者事件进正文、非聚焦者只摘要行）；② repaint
 * 清屏重画（历史按会话键重画 + 旧正文不再现）；③ 在飞占位槽（切入 running
 * 条目 → 占位开、message_update 全量快照直推续流、message_end 终值落正文）。
 * 键盘交互面（Editor/提问队列）：输入路由回归锁（TUI 专项扫雷 20260904
 * TUI-2 转正）——捕获式终端 + 记账宿主/命令表锁规范钉死的「命令>提问>消息」
 * 序与 quitKeys 拦截。
 */

import { describe, expect, it } from 'vitest';
import type { Terminal } from '@earendil-works/pi-tui';
import type { AssistantMessage } from '../contracts/llm.js';
import type { AgentEvent } from '../agent/events.js';
import type { AgentMessage } from '../contracts/messages.js';
import { createTuiChannel } from './tui.js';
import type { ChannelHost } from './types.js';
import type { DeliverChannel } from '../contracts/channels.js';
import type { CommandRegistry } from './commands.js';

/* ---------------- 假终端与事件构造 ---------------- */

/** 假终端：逐帧收集 write 输出（start/stop/光标面 no-op——不测键盘） */
function fakeTerminal(): Terminal & { frames: string[] } {
  const frames: string[] = [];
  return {
    start() {},
    stop() {},
    drainInput: async () => undefined,
    write(data: string) {
      frames.push(data);
    },
    get columns() {
      return 100;
    },
    get rows() {
      return 30;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    frames,
  };
}

/** 空命令注册表（本文件不派发命令——输入路由不触发；onChange 在场：TUI-8
 * 页脚尾段经其重算，注册表面是通道构造的必备依赖） */
const emptyCommands = {
  register: () => () => undefined,
  list: () => [],
  onChange: () => () => undefined,
} as unknown as CommandRegistry;

/** 空宿主（submit/requestQuit/interrupt 不应被触达——触达即断言失败） */
const strictHost: ChannelHost = {
  submit: () => expect.unreachable('本测试不应提交消息'),
  requestQuit: () => expect.unreachable('本测试不应请求退出'),
  interrupt: () => expect.unreachable('本测试不应请求中断'),
};

/** 零用量（AssistantMessage 构造腿） */
const NO_USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };

/** assistant 消息（完整腿——start/update/end 共用形状） */
const assistantMessage = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  usage: NO_USAGE,
  stopReason: 'stop',
  timestamp: 1,
});

/** message_update 事件（partial 全量快照语义——S3 在飞续流的载体） */
const messageUpdate = (text: string): AgentEvent => ({
  type: 'message_update',
  message: assistantMessage(text),
  streamEvent: { type: 'text_delta', contentIndex: 0, delta: text, partial: assistantMessage(text) },
});

/** user 历史消息（repaint 投影重画的载荷形状） */
const userHistory = (text: string): AgentMessage => ({ role: 'user', content: text, timestamp: 1 });

/** 刷渲染帧（requestRender 经 setTimeout 调度——宏任务一轮后帧已落；ms 可
 * 覆盖缺省 30：输入路由锁的命令/补全接受路需更长帧延迟余量） */
const flush = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- 用例 ---------------- */

describe('S3 TUI 分流呈现（互不绞屏执法面）', () => {
  it('聚焦者事件进正文；非聚焦者 agent_start/agent_end 落摘要行、message 事件不进正文', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    // 聚焦者 assistant 流式进正文
    tui.handle({ type: 'agent_start' });
    tui.handle({ type: 'message_start', message: assistantMessage('聚焦者的回答') });
    tui.handle(messageUpdate('聚焦者的回答'));
    tui.handle({ type: 'message_end', message: assistantMessage('聚焦者的回答') });
    // 非聚焦者（后台/退役统一）：agent_start/agent_end 摘要行 + message 不进正文
    tui.handleActivity('session-xxxx-background', { type: 'agent_start' });
    tui.handleActivity('session-xxxx-background', {
      type: 'message_start',
      message: assistantMessage('后台者的回答'),
    });
    tui.handleActivity('session-xxxx-background', { type: 'agent_end', status: 'completed', messages: [] });
    await flush();
    const all = terminal.frames.join('');
    expect(all).toContain('聚焦者的回答'); // 聚焦者全渲染
    expect(all).toContain('⧗ 会话 session- 后台工作中'); // 摘要行（短 id 前 8 位）
    expect(all).toContain('✓ 会话 session- 后台完成');
    expect(all).not.toContain('后台者的回答'); // 互不绞屏：后台正文不进聚焦屏
  });

  it('后台收场分档：failed → ✖ 失败 / aborted → ⏹ 已中止（基建大扫 #42）', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    tui.handleActivity('session-xxxx-background', { type: 'agent_start' });
    tui.handleActivity('session-xxxx-background', { type: 'agent_end', status: 'failed', messages: [] });
    tui.handleActivity('session-xxxx-bg2', { type: 'agent_start' });
    tui.handleActivity('session-xxxx-bg2', { type: 'agent_end', status: 'aborted', messages: [] });
    await flush();
    const all = terminal.frames.join('');
    // 修前恒显「✓ 后台完成」——失败 run 被伪装成成功，后台炸了用户毫不知情
    expect(all).toContain('✖ 会话 session- 后台失败');
    expect(all).toContain('⏹ 会话 session- 后台已中止');
    expect(all).not.toContain('✓ 会话 session- 后台完成');
  });

  it('聚焦者错误 assistant（errorMessage）落 ✖ [错误] 行（基建大扫 #42）', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    tui.handle({ type: 'agent_start' });
    tui.handle({
      type: 'message_end',
      message: { ...assistantMessage(''), stopReason: 'error', errorMessage: 'Provider is not configured: anthropic' },
    });
    await flush();
    // 修前：content 空的失败 assistant 一行都不出——模型 401 后屏上像什么都没发生
    expect(terminal.frames.join('')).toContain('✖ [错误] Provider is not configured: anthropic');
  });
});

describe('S3 repaint 清屏重画（focus 变化驱动）', () => {
  it('旧正文不再现、目标会话历史投影重画（按会话键取）', async () => {
    const terminal = fakeTerminal();
    const histories = new Map<string, AgentMessage[]>([['session-target', [userHistory('目标会话的历史问')]]]);
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      history: (sessionId) => (sessionId === undefined ? [] : (histories.get(sessionId) ?? [])),
    });
    // 聚焦者先落一答
    tui.handle({ type: 'message_start', message: assistantMessage('旧会话正文') });
    tui.handle({ type: 'message_end', message: assistantMessage('旧会话正文') });
    await flush();
    const beforeIndex = terminal.frames.length;
    // 切换：清屏重画到目标会话
    tui.repaint('session-target');
    await flush();
    const after = terminal.frames.slice(beforeIndex).join('');
    expect(after).toContain('目标会话的历史问'); // 历史投影按会话键重画
    expect(after).not.toContain('旧会话正文'); // 旧正文已被清出（差分删除不重打）
  });

  it('切入在飞条目：占位槽开 + message_update 快照直推续流 + message_end 终值落正文', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      history: () => [],
      entryStatus: (sessionId) => (sessionId === 'session-flying' ? 'running' : 'idle'),
    });
    tui.repaint('session-flying'); // 切入正在跑的条目（agent_start 已错过、状态可查）
    await flush();
    const afterRepaint = terminal.frames.join('');
    expect(afterRepaint).toContain('工作中'); // 状态行按 entryStatus 设定（TUI 完善批：转轮帧时变，只断语义文本）
    // 后续 message_update 的 partial 是全量快照——直推整块替换即自然续流（无需 message_start）
    tui.handle(messageUpdate('在飞会话的续流内容'));
    await flush();
    expect(terminal.frames.join('')).toContain('在飞会话的续流内容');
    tui.handle({ type: 'message_end', message: assistantMessage('在飞会话的续流内容') });
    await flush();
    expect(terminal.frames.join('')).toContain('在飞会话的续流内容'); // 终值落正文可见
  });

  it('单槽守卫（20260901-d #4）：repaint 占位槽后接 assistant message_start——旧槽自愈摘除不孤儿滞留', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      history: () => [],
      entryStatus: (sessionId) => (sessionId === 'session-flying' ? 'running' : 'idle'),
    });
    // 场景：run 处于工具执行窗口时切入（message_end 已落、下一条 assistant
    // message_start 未到）——repaint 开占位槽 A；工具结束后 message_start 到达
    tui.repaint('session-flying');
    await flush();
    tui.handle({ type: 'message_start', message: assistantMessage('工具结束后的新回复') });
    await flush();
    tui.handle(messageUpdate('工具结束后的新回复'));
    await flush();
    tui.handle({ type: 'message_end', message: assistantMessage('工具结束后的新回复') });
    await flush();
    const all = terminal.frames.join('');
    expect(all).toContain('工具结束后的新回复');
    // 占位 … 行只随 repaint 帧写一次：守卫生效时 message_start 的重开槽与旧槽
    // 内容同位同形（差分渲染零新写）；无守卫则插入第二行 …（孤儿容器永驻正文）
    expect(all.split('…').length - 1).toBe(1);
  });
});

describe('直播路渲染单源（20260901-d #5）——消息事件唯一渲染源，tool_execution_* 不双帧', () => {
  /** 带 toolCall 块的 assistant 消息（loop 真实转录形态：文本块 + 调用块同消息内联） */
  const assistantWithTool = (text: string): AssistantMessage => ({
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { cmd: 'ls' } },
    ],
    usage: NO_USAGE,
    stopReason: 'stop',
    timestamp: 1,
  });

  /** 工具结果消息（loop toolResultMessageOf 同形——toolResult 恒伴随 end 之后） */
  const toolResultMessage = (): AgentMessage => ({
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'file1 file2' }],
    details: {},
    isError: false,
    timestamp: 1,
  });

  it('同一工具轮：⚙ 与 ↳ 各恰一行（tool_execution_* 是执行层锚点不重复渲染）', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    // loop 实序：assistant 消息终值落账（⚙ 随 message_end assistantToolLines）→
    // tool_execution_start/end（执行层——不渲染）→ toolResult 消息（↳ 随其
    // message_start renderAgentMessage——与 repaint 历史投影同一渲染器）
    tui.handle({ type: 'agent_start' });
    tui.handle({ type: 'message_start', message: assistantWithTool('我来看看目录') });
    tui.handle({ type: 'message_end', message: assistantWithTool('我来看看目录') });
    tui.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { cmd: 'ls' },
    });
    tui.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'file1 file2' }], details: {}, isError: false },
      isError: false,
    });
    tui.handle({ type: 'message_start', message: toolResultMessage() });
    tui.handle({ type: 'message_end', message: toolResultMessage() });
    tui.handle({ type: 'agent_end', status: 'completed', messages: [] });
    await flush();
    const all = terminal.frames.join('');
    expect(all).toContain('我来看看目录');
    expect(all.split('⚙').length - 1).toBe(1); // 双源双帧修死：⚙ 只随 message_end 落一行
    expect(all.split('↳').length - 1).toBe(1); // ↳ 只随 toolResult message 落一行
  });

  it('repaint 行集对照：同段历史重画 ⚙/↳ 亦各恰一行（直播与重画行集恒一致）', async () => {
    const terminal = fakeTerminal();
    const history: AgentMessage[] = [userHistory('列目录'), assistantWithTool('我来看看目录'), toolResultMessage()];
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      history: (sessionId) => (sessionId === 'session-replay' ? history : []),
    });
    tui.repaint('session-replay');
    await flush();
    const after = terminal.frames.join('');
    expect(after).toContain('我来看看目录');
    expect(after.split('⚙').length - 1).toBe(1); // 历史投影单源同律
    expect(after.split('↳').length - 1).toBe(1);
  });
});

describe('notify 级别前缀（NotifyLevel 四值，success 档 2026-08-27 P2-1 新增）', () => {
  it('四档各落各行：info ℹ / success ✔ / warn ⚠ / error ✖；缺省 info', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    const backend = tui.ui();
    backend.notify('普通消息');
    backend.notify('成功消息', { level: 'success' });
    backend.notify('警告消息', { level: 'warn' });
    backend.notify('错误消息', { level: 'error' });
    await flush();
    const all = terminal.frames.join('');
    expect(all).toContain('ℹ 普通消息');
    expect(all).toContain('✔ 成功消息'); // success 档新前缀（此前不存在该级别）
    expect(all).toContain('⚠ 警告消息');
    expect(all).toContain('✖ 错误消息');
  });
});

describe('D4 theme 渲染轻件（focus 换装 + 各归各色 + 起屏一次 + 缺省恒等）', () => {
  /** cyan = #06b6d4 的 truecolor SGR 前缀（换装断言锚——映射值漂移即红） */
  const CYAN = '\x1b[38;2;6;182;212m';
  /** magenta = #d946ef 的 truecolor SGR 前缀 */
  const MAGENTA = '\x1b[38;2;217;70;239m';

  it('聚焦换装：repaint 按目标会话重算 ● 着色；摘要行各归各色（⧗/✓ 同族同律）', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      // 读源权威 = 条目 appId 活视图（宿主闭包路由的通道侧消费形态）
      themeFor: (sessionId) => (sessionId === 'session-a' ? 'cyan' : 'magenta'),
      entryStatus: () => 'idle',
    });
    // 聚焦 session-a：repaint 换装 → 在飞 ● 指示符随 cyan
    tui.repaint('session-a');
    tui.handle({ type: 'agent_start' });
    await flush();
    const focused = terminal.frames.join('');
    expect(focused).toContain(`${CYAN}⠋`); // 转轮帧着聚焦 accent（TUI 完善批：● → Loader 转轮，色经可变槽同律）
    expect(focused).not.toContain(`${CYAN} 工作中`); // 长文本不着（着色克制律）
    // 非聚焦 session-b：摘要行按归属会话 accent（magenta）各归各色
    tui.handleActivity('session-b', { type: 'agent_start' });
    await flush();
    const activity = terminal.frames.join('');
    expect(activity).toContain(`${MAGENTA}⧗ 会话 session-`);
    expect(activity).toContain(' 后台工作中'); // 尾段素文本
    tui.handleActivity('session-b', { type: 'agent_end', status: 'completed', messages: [] });
    await flush();
    expect(terminal.frames.join('')).toContain(`${MAGENTA}✓ 会话 session-`); // ✓ 同族同律
  });

  it('起屏一次（B1 冷读裁决）：start 初始渲染不走 repaint，主题仍随当前聚焦应用', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      title: 'Berry 1.0',
      // undefined = 当前聚焦（起屏路——与 history 同款可选参形态）
      themeFor: (sessionId) => (sessionId === undefined ? 'cyan' : 'cyan'),
    });
    tui.start();
    await flush();
    // 起屏即换装：footer title 段随 cyan（尾段「Enter 发送…」恒素）
    const all = terminal.frames.join('');
    expect(all).toContain(`${CYAN} Berry 1.0`);
    expect(all).toContain('Enter 发送'); // 尾段在场（恒不着色）
  });

  it('缺省恒等：themeFor 缺席 / 返回 undefined = 全程零 truecolor SGR（零色合法缺省态）', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      themeFor: () => undefined, // 无 app 域 / 无清单命中 → undefined
    });
    tui.repaint('session-a');
    tui.handle({ type: 'agent_start' });
    tui.handleActivity('session-b', { type: 'agent_start' });
    await flush();
    const all = terminal.frames.join('');
    expect(all).toContain(' 工作中'); // 素文本照常（转轮帧时变只断语义文本）
    expect(all).toContain('⧗ 会话 session- 后台工作中');
    expect(all).not.toContain('\x1b[38;2;'); // 全程零 truecolor（现状回归锁）
  });

  it('setStatus 外部文本恒不着色（状态行着色仅 ● 指示符）', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      themeFor: () => 'cyan',
    });
    tui.repaint('session-a');
    tui.ui().setStatus('外部状态文本');
    await flush();
    const all = terminal.frames.join('');
    expect(all).toContain(' 外部状态文本');
    expect(all).not.toContain(`${CYAN} 外部状态文本`); // setStatus 不吃 accent
  });
});

describe('interrupt 小刀——cancelAsks 退出兜底（包装面直测）', () => {
  it('在身/排队提问全收场（confirm false fail-closed）、无 signal 服务路 ask 不搁浅队首', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    const ui = tui.ui();
    // 服务路 ask 形态（ctx.exec/ctx.fetch 消费面）：无 signal、用户不在场——cancelAsks 的兜底对象
    //（confirm 是 UiBackend 可选方法——通道实现恒在场，非空断言即合法调用面）
    const first = ui.confirm!('服务路确认？');
    const second = ui.confirm!('排队的第二问');
    tui.cancelAsks();
    expect(await first).toBe(false); // 取消收场保守值（fail-closed：不批准 = 安全缺省）
    expect(await second).toBe(false); // 排队者同收（静默出队——cancelAll 不走 dismiss 行）
    await flush();
    const all = terminal.frames.join('');
    expect(all).toContain('? 服务路确认？'); // 队首曾上屏
    expect(all).not.toContain('排队的第二问'); // 排队者从未占屏（单输入框语义）
    expect(all).not.toContain('− '); // cancelAll 静默收场（dismiss 行仅 signal abort 路渲染）
    // 队列清空：兜底后新 ask 正常入队，且可再次被兜底收场（无僵尸队首）
    const third = ui.confirm!('兜底后的新问');
    tui.cancelAsks();
    expect(await third).toBe(false);
    tui.cancelAsks(); // 幂等——无提问在身为 no-op
  });
});

describe('消息流滚动帽（遗漏大扫 20260903 spec D1-2 修死——批 C 休眠 VStack 清理补刀）', () => {
  it('超帽丢最旧：maxMessageLines=6 下 10 条消息复起全帧重画只见尾 6 条', async () => {
    // 修前红位：批 C 换防 383f8b25 停屏期事件仍进组件树（requestRender 短路、
    // 树照长无帽）——桌面态长跑 + 后台长会话 = 内存无界累积、复起全量重画线性
    // 涨。观测面：frames 累积全部历史写，presence 断言看不见剪除——改走
    // stop()+start() 复起路（requestRender(true) 强制全帧重画），末帧即组件
    // 树真相快照。
    const terminal = fakeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal, maxMessageLines: 6 });
    tui.start(); // 首起路（screenStarted 置位——复起走强制全帧分支）
    // 10 条单行消息（message_end 无流式块直落正文，各 1 个 Text 子件）
    for (let i = 0; i < 10; i += 1) {
      tui.handle({ type: 'message_end', message: assistantMessage(`消息行${String(i).padStart(2, '0')}`) });
    }
    await flush();
    const frameCountBeforeRestart = terminal.frames.length; // 复起重画面分界
    tui.stop(); // 停屏（批 C 换防形态）
    tui.start(); // 复起路：requestRender(true) 全帧重画
    await flush();
    // 复起重画可能拆多次 write（光标转义 + 行块）——拼接复起点后全部写为快照
    const redraw = terminal.frames.slice(frameCountBeforeRestart).join('');
    expect(redraw).toContain('消息行09'); // 最新恒保留
    expect(redraw).toContain('消息行04'); // 帽内最旧一条（10-6=4 起）
    expect(redraw).not.toContain('消息行00'); // 修前红：无帽全量重画含最旧行
    expect(redraw).not.toContain('消息行03'); // 帽外三条整段剪除
  });
});

/* ---------------- 输入路由回归锁（TUI 专项扫雷 20260904 TUI-2 转正） ----------------
 * 契约篇 §5.4 钉死 onSubmit 路由序「斜杠命令 > 提问答案 > 普通消息」——命令在
 * prompt 期可达（/app、/quit 等逃生口不被吞；序曾翻转且有死锁史：挂起的 ask
 * promise 无人 resolve → 队首永久搁浅、后续 ask 全堵）。修前全仓零测试锁、
 * 穿网推演实证回归即 3323+ 全绿——本组把扫描探针（testgap-input-probe 七腿）
 * 转正为回归锁。捕获式终端 = 生产路径等价物（ProcessTerminal.start(onInput)
 * 把 stdin 字节交给 TuiBase.handleTerminalInput——捕获后 send() 同链）。 */

/** 捕获式假终端：start 捕获 onInput 回调，send() 即真实键盘路径（探针/桌面
 * FakeTuiTerminal 同款形态——渲染帧照收供回显断言） */
class CaptureTerminal implements Terminal {
  readonly frames: string[] = [];
  private inputHandler?: (data: string) => void;
  get columns(): number {
    return 100;
  }
  get rows(): number {
    return 30;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  start(onInput: (data: string) => void): void {
    this.inputHandler = onInput;
  }
  stop(): void {
    this.inputHandler = undefined;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.frames.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  /** 注入键盘字节（走捕获的生产 onInput 链——非旁路直调） */
  send(data: string): void {
    this.inputHandler?.(data);
  }
}

/** 记账宿主（strictHost 的宽松版——按用例记账而非恒 unreachable） */
function makeHost() {
  const log: string[] = [];
  return {
    log,
    host: {
      // submit 落账后 undefined 收场（刀 1 签名——ChannelHost 返回通道或 undefined）
      submit: (text: string) => {
        log.push(`submit:${text}`);
      },
      requestQuit: () => log.push('requestQuit'),
      interrupt: () => log.push('interrupt'),
    } satisfies ChannelHost,
  };
}

/** 记账命令注册表（dispatch 可编排结果：'ok' / 'unknown' / reject——tui.ts
 * onSubmit 命令腿三消费面全可断言；empty: true = 空注册表〔TUI-8 空表分档
 * 腿——attach 纯客户端 v1 形态：dispatch 存在但 list 空〕） */
function makeCommands(opts: { result?: 'ok' | 'unknown' | 'reject'; empty?: boolean } = {}) {
  const log: string[] = [];
  const result = opts.result ?? 'ok';
  const registry = {
    register: () => () => undefined,
    list: () => (opts.empty ? [] : [{ name: 'help', description: '帮助', handler: () => {} }]),
    lookup: (name: string) => ({ name, description: '', handler: () => {} }),
    dispatch: async (text: string): Promise<'ok' | 'unknown'> => {
      log.push(`dispatch:${text}`);
      if (result === 'reject') throw new Error('命令腿失败探针');
      return result;
    },
    parse: (t: string) => (t.startsWith('/') ? { name: t.slice(1), args: '' } : null),
    onChange: () => () => undefined,
  };
  return { log, registry: registry as unknown as CommandRegistry };
}

/** 逐字符键入（Editor 输入节流/组帧安全余量——探针同款 5ms 间隔） */
async function type(terminal: CaptureTerminal, text: string): Promise<void> {
  for (const ch of text) {
    terminal.send(ch);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('输入路由回归锁（契约篇 §5.4 命令>提问>消息序 + quitKeys 拦截——TUI-2）', () => {
  it('quitKeys 拦截：\\x03 → interrupt、\\x04 → requestQuit（consume 拦截——Editor 不见这两键）', async () => {
    const terminal = new CaptureTerminal();
    const { log, host } = makeHost();
    const tui = createTuiChannel({ host, commands: makeCommands().registry, terminal });
    tui.start();
    await flush();
    terminal.send('\x03'); // Ctrl+C 原始字节（raw mode 下不产信号——S6 形态④分档）
    terminal.send('\x04'); // Ctrl+D
    await flush();
    expect(log).toEqual(['interrupt', 'requestQuit']); // 两键各达其宿主面
    // 拦截即消费：两键不得漏成 Editor 内容（空提交忽略——submit 零触达）
    expect(log.filter((e) => e.startsWith('submit:'))).toEqual([]);
    tui.stop();
  });

  it('kitty 事件类型不双发：release 只算一次动作（E-1——TUI 第十一轮盲区 5）', async () => {
    const terminal = new CaptureTerminal();
    const { log, host } = makeHost();
    const hookLog: string[] = [];
    const tui = createTuiChannel({
      host,
      commands: makeCommands().registry,
      terminal,
      // escapeHook 记账不消费——与 quitKeys 同一监听器同缺陷族（Escape 释放形同样双发）
      escapeHook: () => {
        hookLog.push('escapeHook');
        return false;
      },
    });
    tui.start();
    await flush();
    // kitty flag 2 形态：CSI u 三腿——press（无事件类型字段）/ repeat（:2）/ release（:3）。
    // parseKey 剥掉事件类型后三腿解析出同一键 id（\x1b[99;5u 与 \x1b[99;5:3u 都是 'ctrl+c'），
    // 不滤 release 则一次按键双触发 interrupt/requestQuit/escapeHook。滤 release 不滤
    // repeat——repeat 是用户长按的真实重发，pi-tui 先例（tui.js 聚焦组件层）同此分档。
    terminal.send('\x1b[27;1:3u'); // Escape 释放 → escapeHook 不得触发
    terminal.send('\x1b[99;5u'); // ctrl+c 按下 → interrupt（第一声）
    terminal.send('\x1b[99;5:3u'); // ctrl+c 释放 → 不得再 interrupt
    terminal.send('\x1b[99;5:2u'); // ctrl+c 长按重发 → 真实意图，仍 interrupt
    terminal.send('\x1b[100;5u'); // ctrl+d 按下 → requestQuit（第一声）
    terminal.send('\x1b[100;5:3u'); // ctrl+d 释放 → 不得再 requestQuit
    await flush();
    expect(hookLog).toEqual([]); // Escape 释放不双发桌面 Esc 路由
    expect(log).toEqual(['interrupt', 'interrupt', 'requestQuit']);
    tui.stop();
  });

  it('普通文本 + Enter → host.submit（消息腿兜底）', async () => {
    const terminal = new CaptureTerminal();
    const { log, host } = makeHost();
    const cmds = makeCommands();
    const tui = createTuiChannel({ host, commands: cmds.registry, terminal });
    tui.start();
    await flush();
    await type(terminal, 'hello world');
    terminal.send('\r');
    await flush(150);
    expect(log).toEqual(['submit:hello world']);
    expect(cmds.log).toEqual([]); // 命令腿零触达（非斜杠前缀）
    tui.stop();
  });

  it('空提交忽略：裸 Enter 零路由（submit/dispatch 均零触达——防误触）', async () => {
    const terminal = new CaptureTerminal();
    const { log, host } = makeHost();
    const cmds = makeCommands();
    const tui = createTuiChannel({ host, commands: cmds.registry, terminal });
    tui.start();
    await flush();
    terminal.send('\r');
    await flush(150);
    expect(log).toEqual([]);
    expect(cmds.log).toEqual([]);
    tui.stop();
  });

  it("'/cmd' + Enter → commands.dispatch 优先 + ❯ 回显（host.submit 零触达）", async () => {
    const terminal = new CaptureTerminal();
    const { log, host } = makeHost();
    const cmds = makeCommands();
    const tui = createTuiChannel({ host, commands: cmds.registry, terminal });
    tui.start();
    await flush();
    await type(terminal, '/help');
    terminal.send('\r');
    await flush(200); // autocomplete 弹层期 Enter 的接受路可能有帧延迟（探针同款余量）
    expect(cmds.log).toEqual(['dispatch:/help']); // 命令腿命中
    expect(log).toEqual([]); // 普通消息腿零触达
    expect(terminal.frames.join('')).toContain('❯ /help'); // 命令本地回显在屏
    tui.stop();
  });

  it('unknown 命令回显：dispatch 返回 unknown → ✖ 未知命令行（不崩界面）', async () => {
    const terminal = new CaptureTerminal();
    const { host } = makeHost();
    const cmds = makeCommands({ result: 'unknown' });
    const tui = createTuiChannel({ host, commands: cmds.registry, terminal });
    tui.start();
    await flush();
    await type(terminal, '/nosuch');
    terminal.send('\r');
    await flush(200);
    expect(cmds.log).toEqual(['dispatch:/nosuch']);
    expect(terminal.frames.join('')).toContain('✖ 未知命令：/nosuch'); // unknown 分档回显
    tui.stop();
  });

  it('命令腿异常兜底：dispatch reject → ✖ 命令执行失败行（不崩界面）', async () => {
    const terminal = new CaptureTerminal();
    const { host } = makeHost();
    const cmds = makeCommands({ result: 'reject' });
    const tui = createTuiChannel({ host, commands: cmds.registry, terminal });
    tui.start();
    await flush();
    await type(terminal, '/help');
    terminal.send('\r');
    await flush(200);
    expect(terminal.frames.join('')).toContain('✖ 命令执行失败：命令腿失败探针'); // 异常分档回显
    tui.stop();
  });

  it('prompt 消费腿：提问在身时普通文本 + Enter → 答案收场（host.submit 零触达）', async () => {
    const terminal = new CaptureTerminal();
    const { log, host } = makeHost();
    const tui = createTuiChannel({ host, commands: makeCommands().registry, terminal });
    tui.start();
    await flush();
    const answer = tui.ui().input!('服务路问什么？'); // input 类型面可选、TUI 后端实装（探针证）——非空断言
    await flush();
    await type(terminal, '我的答案');
    terminal.send('\r');
    await flush(150);
    expect(await answer).toBe('我的答案'); // 消费为答案
    expect(log).toEqual([]); // 消息腿零触达（非命令输入不落 submit）
    tui.stop();
  });

  it('S5 序翻转锁：prompt 在身时 /cmd + Enter 仍派发命令（答案不吞逃生口）——补真答案正常收场', async () => {
    const terminal = new CaptureTerminal();
    const { log, host } = makeHost();
    const cmds = makeCommands();
    const tui = createTuiChannel({ host, commands: cmds.registry, terminal });
    tui.start();
    await flush();
    const answer = tui.ui().input!('服务路问什么？'); // input 类型面可选、TUI 后端实装（探针证）——非空断言
    await flush();
    await type(terminal, '/help');
    terminal.send('\r');
    await flush(200);
    expect(cmds.log).toEqual(['dispatch:/help']); // 命令先行——prompt 在身仍派发
    // ask promise 仍挂起（'/help' 未被吞为答案——序翻转前形态即此处吞）
    let stillPending = true;
    void answer.then(() => {
      stillPending = false;
    });
    await flush(50);
    expect(stillPending).toBe(true); // 修前红位：序若回翻（prompt 先于命令）此处即 false
    // 补真答案 → prompt 正常收场（逃生口可达 + 队列不搁浅两面同锁）
    await type(terminal, '真答案');
    terminal.send('\r');
    await flush(150);
    expect(await answer).toBe('真答案');
    expect(log).toEqual([]); // 全程零 submit（命令腿与答案腿各归其位）
    tui.stop();
  });
});

describe('TUI-8 空表分档（无命令面形态的诚实披露）', () => {
  it('空注册表 unknown → ✖ 本形态无斜杠命令面（不误导 /help；submit 零触达）', async () => {
    const terminal = new CaptureTerminal();
    const { log, host } = makeHost();
    const cmds = makeCommands({ result: 'unknown', empty: true }); // attach 纯客户端形态：dispatch 在、清单空
    const tui = createTuiChannel({ host, commands: cmds.registry, terminal });
    tui.start();
    await flush();
    await type(terminal, '/nosuch');
    terminal.send('\r');
    await flush(200);
    expect(cmds.log).toEqual(['dispatch:/nosuch']); // 仍走本地派发（统一语义不按空表分流）
    expect(log).toEqual([]); // 不投递（「原样投递」头注已勘正——输入被拦截）
    const all = terminal.frames.join('');
    expect(all).toContain('✖ 本形态无斜杠命令面：/nosuch 未投递'); // 空表分档文案
    expect(all).not.toContain('/help 查看清单'); // 空表不给误导性 /help 指引（修前红位：恒拼 /help 段）
    tui.stop();
  });

  it('页脚「/ 命令」段按注册表空否省略（非空保留原形）', async () => {
    // 空表：提示行不虚报命令能力（attach 形态）
    const emptyTerm = new CaptureTerminal();
    const emptyTui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal: emptyTerm });
    emptyTui.start();
    await flush();
    expect(emptyTerm.frames.join('')).not.toContain('/ 命令'); // 段省略（修前红位：恒拼段）
    expect(emptyTerm.frames.join('')).toContain('Enter 发送'); // 发送提示仍在
    emptyTui.stop();
    // 非空：原形保留（三段完整）
    const fullTerm = new CaptureTerminal();
    const fullTui = createTuiChannel({ host: strictHost, commands: makeCommands().registry, terminal: fullTerm });
    fullTui.start();
    await flush();
    expect(fullTerm.frames.join('')).toContain('Enter 发送 / / 命令'); // 非空表恒拼段
    fullTui.stop();
  });
});

/* ---------------- TUI 彻底完善批（技术栈篇 §4.1 应用视图四增强，2026-09-04） ---------------- */

describe('TUI 彻底完善批（四增强回归锁）', () => {
  it('增强 1：assistant 终值 Markdown 渲染——标题加粗/代码块青色 SGR 落屏', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    tui.handle({ type: 'agent_start' });
    tui.handle(messageUpdate('# 标题\n\n`code`'));
    tui.handle({
      type: 'message_end',
      message: assistantMessage('# 标题\n\n正文 `code` 段'),
    });
    await flush();
    const all = terminal.frames.join('');
    // Markdown 组件路径证据：标题经 heading 着色器（加粗 SGR）而非纯文本直落
    expect(all).toContain('\x1b[1m'); // heading 加粗
    expect(all).toContain('\x1b[36m'); // 行内代码青色
    expect(all).toContain('标题'); // 语义文本在场
  });

  it('增强 1：历史重画同走 Markdown（repaint 后 assistant 正文带加粗 SGR）', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      history: () =>
        [{ role: 'user', content: '问', timestamp: 1 }, assistantMessage('# 重画标题')] as unknown as AgentMessage[],
    });
    tui.repaint('session-x');
    await flush();
    expect(terminal.frames.join('')).toContain('\x1b[1m'); // 历史路径同走 Markdown
  });

  it('增强 1：自定义 assistant 渲染器优先——注册后回落行形态（优先级纪律不变）', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      rendererFor: (role) =>
        role === 'assistant' ? { role: 'assistant', render: () => ['[自定义] 行形态'] } : undefined,
    });
    tui.handle({ type: 'message_end', message: assistantMessage('# 不走 Markdown') });
    await flush();
    const all = terminal.frames.join('');
    expect(all).toContain('[自定义] 行形态');
    expect(all).not.toContain('\x1b[1m'); // Markdown 路径未走
  });

  it('增强 3：tool_execution_start 状态行实时工具名（状态面消费——正文 ⚙ 仍单源）', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    tui.handle({ type: 'agent_start' });
    tui.handle({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'read',
      args: { path: 'a.ts' },
    });
    await flush();
    const all = terminal.frames.join('');
    expect(all).toContain('⚙ read …'); // 状态行实时工具名
    // 正文零渲染不变：args 不落屏（正文 ⚙ 行只随 message_end）
    expect(all).not.toContain('a.ts');
  });

  it('增强 4：todo 面板渲染——四态记号 + activeForm 优先 + 溢出行 + todo 工具写后即显', async () => {
    const terminal = fakeTerminal();
    /** 可变 todo 状态（tool_execution_end 后翻转——验证写后即显触发器） */
    let items: ReadonlyArray<{
      content: string;
      status: 'pending' | 'in_progress' | 'completed' | 'deferred';
      activeForm?: string;
    }> = [
      { content: '第一项', status: 'completed' },
      { content: '第二项', status: 'in_progress', activeForm: '正在做第二项' },
      { content: '第三项', status: 'pending' },
      { content: '第四项', status: 'deferred' },
    ];
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      todoFor: () => items,
    });
    tui.repaint('session-x');
    await flush();
    let all = terminal.frames.join('');
    expect(all).toContain('☑ 第一项'); // 完成态记号
    expect(all).toContain('◐ 正在做第二项'); // 进行中 activeForm 优先
    expect(all).not.toContain('◐ 第二项'); // content 不重复出现（activeForm 覆盖）
    expect(all).toContain('☐ 第三项'); // 待办态
    expect(all).toContain('⊙ 第四项'); // 缓办态
    // 写后即显触发器：todo 工具结束后面板刷新（新条目立即可见——无需 agent_end）
    items = [...items.slice(0, 3), { content: '第五项', status: 'pending' }];
    tui.handle({
      type: 'tool_execution_end',
      toolCallId: 'c2',
      toolName: 'todo',
      result: { content: [{ type: 'text', text: 'ok' }] },
      isError: false,
    });
    await flush();
    all = terminal.frames.join('');
    expect(all).toContain('☐ 第五项'); // 刷新后新条目
    // 非 todo 工具不触发刷新（无谓重画）
    tui.handle({
      type: 'tool_execution_end',
      toolCallId: 'c3',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'ok' }] },
      isError: false,
    });
    await flush();
    expect(terminal.frames.join('')).not.toContain('bash'); // 状态/面板无泄漏
  });

  it('增强 4：溢出折叠 + null/空数组清板 + todoFor 缺席零面板', async () => {
    // 溢出：8 条 → 6 条可见 + 「+ 2 更多」
    const terminal = fakeTerminal();
    const eight = Array.from({ length: 8 }, (_, i) => ({ content: `任务${i + 1}`, status: 'pending' as const }));
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal, todoFor: () => eight });
    tui.repaint('s');
    await flush();
    const all = terminal.frames.join('');
    expect(all).toContain('任务6');
    expect(all).not.toContain('任务7'); // 超帽折叠
    expect(all).toContain('+ 2 更多');
    // null 清板
    const nullTerm = fakeTerminal();
    let current: ReadonlyArray<{ content: string; status: 'pending' }> | null = [
      { content: '有表', status: 'pending' },
    ];
    const nullTui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal: nullTerm,
      todoFor: () => current,
    });
    nullTui.repaint('s');
    await flush();
    expect(nullTerm.frames.join('')).toContain('☐ 有表');
    const frameMark = nullTerm.frames.length; // 清板断言分界（帧累积——只看新帧）
    current = null;
    nullTui.handle({ type: 'agent_end', status: 'completed', messages: [] });
    await flush();
    expect(nullTerm.frames.slice(frameMark).join('')).not.toContain('☐ 有表'); // 清板（新帧零面板行）
    // todoFor 缺席：agent_end 后零变化（面板从未渲染）
    const plainTerm = fakeTerminal();
    const plainTui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal: plainTerm });
    plainTui.handle({ type: 'agent_end', status: 'completed', messages: [] });
    await flush();
    expect(plainTerm.frames.join('')).not.toContain('☐');
  });
});

/* ---------------- TUI 强化批 2（技术栈篇 §4.1 应用视图强化批 2，2026-09-04） ---------------- */

/** 工具进度 update 事件（partialResult 全量快照——content 文本块为 bash 等工具的流式输出） */
const toolUpdate = (toolCallId: string, toolName: string, text: string): AgentEvent => ({
  type: 'tool_execution_update',
  toolCallId,
  toolName,
  args: {},
  partialResult: { content: [{ type: 'text', text }] },
});

/** turn_end 事件（message.usage 必填——增强 6 累计源） */
const turnEnd = (usage: AssistantMessage['usage']): AgentEvent => ({
  type: 'turn_end',
  message: { ...assistantMessage('轮'), usage },
  toolResults: [],
});

describe('TUI 强化批 2 增强 5——工具实时进度面板（状态面消费，正文零渲染不变）', () => {
  it('start 无 partial 不建行；update 建行显末条非空行、原位换行；end 即摘行', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    tui.handle({ type: 'agent_start' });
    // start 不建行（无 partial 的工具不占面板行——状态行工具名 Loader 已覆盖）
    tui.handle({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} });
    await flush();
    expect(terminal.frames.join('')).not.toContain('▸');
    // 首个 update 建行：partial 末条非空行（bash 逐行吐出——尾行即最新进度；空行跳过）
    tui.handle(toolUpdate('c1', 'bash', 'npm test\n\n✔ 3446 passed\n'));
    await flush();
    expect(terminal.frames.join('')).toContain('▸ bash · ✔ 3446 passed');
    // 后续 update 原位换行（新尾行替换旧尾行）
    tui.handle(toolUpdate('c1', 'bash', 'npm test\n\n✔ 3447 passed\n'));
    await flush();
    expect(terminal.frames.join('')).toContain('▸ bash · ✔ 3447 passed');
    // end 即摘行（瞬时面——行集不跨工具生命周期滞留）
    const mark = terminal.frames.length;
    tui.handle({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'bash',
      result: { content: [] },
      isError: false,
    });
    await flush();
    expect(terminal.frames.slice(mark).join('')).not.toContain('▸ bash');
  });

  it('无文本块行退化 `▸ 名 …`；帽 4 行溢出折叠；agent_end / repaint 清板', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    tui.handle({ type: 'agent_start' });
    // 无文本块（空 partial / 纯图像内容）→ 退化形态（工具在场但无文本进度可显）
    tui.handle({
      type: 'tool_execution_update',
      toolCallId: 'c0',
      toolName: 'probe',
      args: {},
      partialResult: { content: [] },
    });
    await flush();
    expect(terminal.frames.join('')).toContain('▸ probe …');
    // 摘掉 c0（下方帽断言的干净基数——面板空板起步）
    tui.handle({
      type: 'tool_execution_end',
      toolCallId: 'c0',
      toolName: 'probe',
      result: { content: [] },
      isError: false,
    });
    await flush();
    // 帽 4：6 个并行工具各 update → 前 4 行可见 + 「… + 2 更多」折叠行
    for (let i = 1; i <= 6; i++) tui.handle(toolUpdate(`c${i}`, `tool${i}`, `进度${i}`));
    await flush();
    const all = terminal.frames.join('');
    expect(all).toContain('▸ tool1 · 进度1');
    expect(all).toContain('▸ tool4 · 进度4');
    expect(all).not.toContain('▸ tool5'); // 超帽折叠（后建的 5/6 不占行）
    expect(all).toContain('… + 2 更多');
    // agent_end 清板（run 收场——瞬时面不滞留）
    const mark = terminal.frames.length;
    tui.handle({ type: 'agent_end', status: 'completed', messages: [] });
    await flush();
    expect(terminal.frames.slice(mark).join('')).not.toContain('▸');
    // repaint 清板（瞬时面不跨 repaint 保存——切入时在飞工具的行不跨会话带）
    tui.handle({ type: 'agent_start' });
    tui.handle(toolUpdate('c9', 'bash', '在飞输出'));
    await flush();
    const mark2 = terminal.frames.length;
    tui.repaint('session-other');
    await flush();
    expect(terminal.frames.slice(mark2).join('')).not.toContain('▸ bash');
  });
});

describe('TUI 强化批 2 增强 6——usage 状态行（run 级累计，状态面消费）', () => {
  it('turn_end 逐轮累计、agent_end 落「✓ 用量」行（k/M 紧凑格式）', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    tui.handle({ type: 'agent_start' });
    // 两轮累计：{400 入/100 出/total 500} + {2000 入/4000 出/total 6000} → {2400/4100/6500}
    tui.handle(turnEnd({ input: 400, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 500 }));
    tui.handle(turnEnd({ input: 2000, output: 4000, cacheRead: 0, cacheWrite: 0, totalTokens: 6000 }));
    await flush();
    // run 期间不可见（尾注在 agent_end 才落状态行）
    expect(terminal.frames.join('')).not.toContain('用量');
    tui.handle({ type: 'agent_end', status: 'completed', messages: [] });
    await flush();
    expect(terminal.frames.join('')).toContain('✓ 用量 6.5k（入 2.4k · 出 4.1k）');
  });

  it('cost 在场追加货币段；agent_start / repaint 清除（run 级尾注生命周期）', async () => {
    const terminal = fakeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    tui.handle({ type: 'agent_start' });
    // 小数值原样（<1000 不缩写）；cost.total 累计后追加 `· $N.NN` 段
    tui.handle(turnEnd({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.042 } }));
    tui.handle({ type: 'agent_end', status: 'completed', messages: [] });
    await flush();
    expect(terminal.frames.join('')).toContain('✓ 用量 2（入 1 · 出 1） · $0.04');
    // agent_start 清除（新 run 起跑——尾注让位「工作中」，归零重计）
    const mark = terminal.frames.length;
    tui.handle({ type: 'agent_start' });
    await flush();
    expect(terminal.frames.slice(mark).join('')).not.toContain('用量');
    // 再一 run 收场后 repaint 清除（聚焦切换——尾注不跨会话滞留）
    tui.handle(turnEnd({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10 }));
    tui.handle({ type: 'agent_end', status: 'completed', messages: [] });
    await flush();
    expect(terminal.frames.join('')).toContain('✓ 用量 10（入 5 · 出 5）');
    const mark2 = terminal.frames.length;
    tui.repaint('session-x');
    await flush();
    expect(terminal.frames.slice(mark2).join('')).not.toContain('用量');
  });
});

/* ---------------- 终端外显（增强 7——setTitle/setProgress 接线） ---------------- */

/** 外显记录终端（增强 7）：fakeTerminal 的 setTitle/setProgress 记录化——断言面 */
function chromeTerminal(): Terminal & { frames: string[]; titles: string[]; progress: boolean[] } {
  const base = fakeTerminal();
  /** setTitle 写下的标题串序（OSC 0 载荷） */
  const titles: string[] = [];
  /** setProgress 写下的进度态序（true = OSC 9;4;3 / false = OSC 9;4;0） */
  const progress: boolean[] = [];
  return Object.assign(base, {
    setTitle(title: string) {
      titles.push(title);
    },
    setProgress(active: boolean) {
      progress.push(active);
    },
    titles,
    progress,
  });
}

describe('增强 7 终端外显（进度态两形态分源 + 标题随聚焦换装）', () => {
  it('本地形态忙态：聚焦与非聚焦两路净计数驱动进度态——任一会话在飞即忙（后台 run 同占）', async () => {
    const terminal = chromeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    // 非聚焦后台 run 开跑 → 忙（终端标签页注意力模型——非聚焦后台 run 同样占忙态）
    tui.handleActivity('session-xxxx-background', { type: 'agent_start' });
    expect(terminal.progress).toEqual([true]);
    // 聚焦 run 并行开跑 → 净计数 2 仍忙（去重镜像——同态不重写 OSC）
    tui.handle({ type: 'agent_start' });
    expect(terminal.progress).toEqual([true]);
    // 后台先收 → 净计数 1 → 仍忙
    tui.handleActivity('session-xxxx-background', { type: 'agent_end', status: 'completed', messages: [] });
    expect(terminal.progress).toEqual([true]);
    // 聚焦收 → 净计数 0 → 闲
    tui.handle({ type: 'agent_end', status: 'completed', messages: [] });
    expect(terminal.progress).toEqual([true, false]);
    await flush();
  });

  it('计数防御位 clamp ≥ 0：错序/重复 end 不下探（负计数会让后到单 start 误判闲）', async () => {
    const terminal = chromeTerminal();
    const tui = createTuiChannel({ host: strictHost, commands: emptyCommands, terminal });
    // 错序：end 先到（无对应 start）——计数 clamp 在 0；false 是缺省态（去重零写）
    tui.handle({ type: 'agent_end', status: 'completed', messages: [] });
    expect(terminal.progress).toEqual([]);
    // 单 start 后必须忙：若错序 end 把计数推到 -1，本 start 只回到 0——忙态漏报即红
    tui.handle({ type: 'agent_start' });
    expect(terminal.progress).toEqual([true]);
    await flush();
  });

  it('attach 形态 busyFor 外源单源：登记簿派生活取——通道内计数停拨（SSE 错过窗免疫）', async () => {
    const terminal = chromeTerminal();
    // 登记簿替身（attach-main 的 runningBySession 同构——种子/增量单源）
    const registry = new Map<string, boolean>([['sess-remote', true]]);
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      busyFor: () => {
        for (const running of registry.values()) if (running) return true;
        return false;
      },
    });
    // 起屏写点：busyFor 首写即真值（清单种子先于 start 落簿形态——零事件零计数）
    tui.start();
    expect(terminal.progress).toEqual([true]);
    // 登记簿翻闲（远端收场经 SSE 入簿）——repaint 写点重估即翻
    registry.set('sess-remote', false);
    tui.repaint('sess-remote');
    expect(terminal.progress).toEqual([true, false]);
    // 计数停拨证明：聚焦 agent_start 计 +1 但 busyFor false 仍闲——两形态分源执法
    tui.handle({ type: 'agent_start' });
    expect(terminal.progress).toEqual([true, false]);
    tui.stop();
    await flush();
  });

  it('title 三写点：起屏缀短 id（focusIdFor 活取）+ repaint 换聚焦换装 + stop 回基线', async () => {
    const terminal = chromeTerminal();
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      title: 'Berry 1.0.0',
      focusIdFor: () => 'session-abcd1234',
    });
    // 起屏：聚焦在案即缀短 id（slice(0,8) 非聚焦摘要行同款——D4 起屏一次同解析先例）
    tui.start();
    expect(terminal.titles).toEqual(['Berry 1.0.0 · session-']);
    // repaint（显式键）：换聚焦换装
    tui.repaint('another-99zz');
    expect(terminal.titles).toEqual(['Berry 1.0.0 · session-', 'Berry 1.0.0 · another-']);
    // stop：复原写点①——title 回基线 + 进度清零（强制写位不去重）
    tui.stop();
    expect(terminal.titles).toEqual(['Berry 1.0.0 · session-', 'Berry 1.0.0 · another-', 'Berry 1.0.0']);
    expect(terminal.progress).toEqual([false]);
    await flush();
  });

  it('title 缺席 = 零标题管理档：setTitle 零调用，进度态照常', async () => {
    const terminal = chromeTerminal();
    const tui = createTuiChannel({
      host: strictHost,
      commands: emptyCommands,
      terminal,
      focusIdFor: () => 's-anything',
    });
    tui.start();
    tui.handle({ type: 'agent_start' });
    tui.stop();
    expect(terminal.titles).toEqual([]); // 零标题管理——title 键缺席不写 OSC 0
    expect(terminal.progress).toEqual([true, false]); // 进度态独立于标题档
    await flush();
  });
});

/* ---------------- /history 全屏回看器（增强 8，技术栈篇 §4.1） ----------------
 * TuiAltScreen 副屏生命周期锁：进屏写（?1049h）/收屏写（?1049l）/渲染管线
 * 单源（与主屏 renderHistoryInto 同构建器）/ask 强制收起/副屏键面补丁/注册
 * 门槛（history 注入在场才注册）/未知命令三档（/help 在册才指引——本增强的
 * 涟漪勘正）。捕获式终端 send() 走生产 onInput 链（输入路由锁同款）。 */

/** 路由式记账注册表：真实收纳 register 的命令定义、dispatch 按 name 路由到
 * handler——/history 的通道注册腿可被真实触发（makeCommands 的 register 是
 * no-op，驱动不了回看器）；list/lookup 与收纳面一致（三档文案断言依据） */
function makeRoutingRegistry() {
  const defs: { name: string; description: string; handler: (args: string) => void }[] = [];
  const registry = {
    register: (def: { name: string; description: string; handler: (args: string) => void }) => {
      defs.push(def);
      return () => undefined;
    },
    list: () => defs.map((d) => ({ name: d.name, description: d.description, handler: d.handler })),
    lookup: (name: string) => defs.find((d) => d.name === name),
    dispatch: async (text: string): Promise<'ok' | 'unknown'> => {
      const name = text.slice(1).split(' ')[0];
      const def = defs.find((d) => d.name === name);
      if (def === undefined) return 'unknown';
      def.handler('');
      return 'ok';
    },
    parse: (t: string) => (t.startsWith('/') ? { name: t.slice(1), args: '' } : null),
    onChange: () => () => undefined,
  };
  return { registry: registry as unknown as CommandRegistry, defs };
}

describe('/history 全屏回看器（增强 8——副屏生命周期与渲染单源）', () => {
  it('/history 进副屏：?1049h 写出 + 全量历史正文与条数提示行上屏', async () => {
    const terminal = new CaptureTerminal();
    const { host } = makeHost();
    const { registry } = makeRoutingRegistry();
    const history = () => [userHistory('第一问'), assistantMessage('第一答正文'), userHistory('第二问')];
    const tui = createTuiChannel({ host, commands: registry, terminal, history });
    tui.start();
    await flush();
    await type(terminal, '/history');
    terminal.send('\r');
    await flush(200); // 命令派发 + 副屏首帧渲染
    const all = terminal.frames.join('');
    expect(all).toContain('\x1b[?1049h'); // 进副屏缓冲（修前零 TuiAltScreen 消费）
    expect(all).toContain('第一答正文'); // 历史正文进副屏（渲染单源：assistant Markdown 腿）
    expect(all).toContain('3 条'); // 提示行条数披露
    // q 收起：退屏写 + 主屏复起（后续帧不再重复历史正文 = 副屏已收）
    const mark = terminal.frames.length;
    terminal.send('q');
    await flush(200);
    expect(terminal.frames.slice(mark).join('')).toContain('\x1b[?1049l');
    tui.stop();
  });

  it('副屏不受主屏滚动帽：maxMessageLines 2 时 5 条历史回看全量可见', async () => {
    const terminal = new CaptureTerminal();
    const { host } = makeHost();
    const { registry } = makeRoutingRegistry();
    const history = () => [
      userHistory('行零'),
      userHistory('行一'),
      userHistory('行二'),
      userHistory('行三'),
      userHistory('行四'),
    ];
    const tui = createTuiChannel({ host, commands: registry, terminal, history, maxMessageLines: 2 });
    tui.start();
    await flush();
    await type(terminal, '/history');
    terminal.send('\r');
    await flush(200);
    const all = terminal.frames.join('');
    expect(all).toContain('行零'); // 最旧条在副屏可见（主屏帽只治主屏树内存——快照档全量）
    expect(all).toContain('5 条');
    tui.stop();
  });

  it('q 收起保树：停屏期入树事件返回即见（不走 repaint 清树重画投影）', async () => {
    const terminal = new CaptureTerminal();
    const { host } = makeHost();
    const { registry } = makeRoutingRegistry();
    const history = () => [userHistory('投影内既有')];
    const tui = createTuiChannel({ host, commands: registry, terminal, history });
    tui.start();
    await flush();
    await type(terminal, '/history');
    terminal.send('\r');
    await flush(200);
    // 停屏期事件进主屏组件树（requestRender 停屏短路、树照长）
    tui.handle({ type: 'message_end', message: assistantMessage('停屏期到达') });
    const mark = terminal.frames.length;
    terminal.send('q');
    await flush(200);
    const after = terminal.frames.slice(mark).join('');
    expect(after).toContain('\x1b[?1049l'); // 副屏收场
    expect(after).toContain('停屏期到达'); // 修前红位：repaint 收场会清树重画静态投影、丢瞬时行
    tui.stop();
  });

  it('鼠标模式配对字节（刀 6 设备态复原族）：开屏启用族/收屏复原族成对在场', async () => {
    const terminal = new CaptureTerminal();
    const { host } = makeHost();
    const { registry } = makeRoutingRegistry();
    const history = () => [userHistory('配对探针')];
    const tui = createTuiChannel({ host, commands: registry, terminal, history });
    tui.start();
    await flush();
    await type(terminal, '/history');
    terminal.send('\r');
    await flush(200);
    // 开屏启用族（镜像 tui-alt-screen.js start 写）：?1049h 进屏 + ?7l 自动换行关 +
    // ?1000h 鼠标追踪族首写（1000/1002/1003/1004/1006 一串写——拖选即复制的设备态）
    const openMark = terminal.frames.length;
    const opened = terminal.frames.join('');
    expect(opened).toContain('\x1b[?1049h');
    expect(opened).toContain('\x1b[?7l');
    expect(opened).toContain('\x1b[?1000h');
    terminal.send('q');
    await flush(200);
    // 收屏复原族（镜像 stop 写序列——viewerExitRestore 硬退腿同族字节）：鼠标五写
    // 逆序关（?1006l 首字节）+ ?7h 回绕复原 + ?1049l 退屏
    const closed = terminal.frames.slice(openMark).join('');
    expect(closed).toContain('\x1b[?1006l');
    expect(closed).toContain('\x1b[?7h');
    expect(closed).toContain('\x1b[?1049l');
    tui.stop();
  });

  it('投递回执行（刀 1 投递通道可观测）：steer 档瞬时行在场 / agent_end 清行 / followUp 档零回执行', async () => {
    const terminal = new CaptureTerminal();
    // host.submit 档位可编排（makeHost 是 undefined 档——本测要真通道值）
    let channel: DeliverChannel | undefined;
    const host: ChannelHost = {
      submit: () => channel,
      requestQuit: () => {},
      interrupt: () => {},
    };
    const { registry } = makeRoutingRegistry();
    const tui = createTuiChannel({ host, commands: registry, terminal, history: () => [] });
    tui.start();
    await flush();
    // steer 档：run 在飞期插话 → 活动面板首行「❯ …（已排队，本轮结束注入）」
    //（修前：submit 返回 void 无回执行——插话清空输入框后屏上零反馈）
    channel = 'steer';
    const submitMark = terminal.frames.length;
    await type(terminal, '先把手头的跑完');
    terminal.send('\r');
    await flush(200);
    // CaptureTerminal 帧是增量写——mark 起切片 join 看本段输出全集（鼠标配对测同法）
    const queuedOut = terminal.frames.slice(submitMark).join('');
    expect(queuedOut).toContain('已排队，本轮结束注入');
    expect(queuedOut).toContain('先把手头的跑完');
    // 清除事件驱动（骨架篇 §4.1）：本 run 终态 agent_end 先到 → 回执行随活动面板清组
    const clearMark = terminal.frames.length;
    tui.handle({ type: 'agent_end', status: 'completed', messages: [] });
    await flush(100);
    const settledOut = terminal.frames.slice(clearMark).join('');
    expect(settledOut).not.toContain('已排队');
    // followUp 档零回执行（run 即将开场——正文流自证，回执行反而噪声）
    channel = 'followUp';
    const openMark = terminal.frames.length;
    await type(terminal, '闲时新开一轮');
    terminal.send('\r');
    await flush(200);
    const openedOut = terminal.frames.slice(openMark).join('');
    expect(openedOut).not.toContain('已排队');
    tui.stop();
  });

  it('Esc 收起同 q（裸 Esc 形态）', async () => {
    const terminal = new CaptureTerminal();
    const { host } = makeHost();
    const { registry } = makeRoutingRegistry();
    const tui = createTuiChannel({ host, commands: registry, terminal, history: () => [] });
    tui.start();
    await flush();
    await type(terminal, '/history');
    terminal.send('\r');
    await flush(200);
    const mark = terminal.frames.length;
    terminal.send('\x1b'); // 裸 Esc（CSI 兼容形态由 matchesKey 兜住）
    await flush(200);
    expect(terminal.frames.slice(mark).join('')).toContain('\x1b[?1049l');
    tui.stop();
  });

  it('副屏键面补丁：Ctrl+C 打断不关副屏、Ctrl+D 先收副屏再 requestQuit', async () => {
    const terminal = new CaptureTerminal();
    const { log, host } = makeHost();
    const { registry } = makeRoutingRegistry();
    const tui = createTuiChannel({ host, commands: registry, terminal, history: () => [] });
    tui.start();
    await flush();
    await type(terminal, '/history');
    terminal.send('\r');
    await flush(200);
    // Ctrl+C：打断在飞 run，回看器保持（注意力不夺走）
    const markC = terminal.frames.length;
    terminal.send('\x03');
    await flush(200);
    expect(log).toEqual(['interrupt']);
    expect(terminal.frames.slice(markC).join('')).not.toContain('\x1b[?1049l');
    // Ctrl+D：先收副屏（1049l 在场）再走宿主退出路
    terminal.send('\x04');
    await flush(200);
    expect(log).toEqual(['interrupt', 'requestQuit']);
    expect(terminal.frames.slice(markC).join('')).toContain('\x1b[?1049l');
    tui.stop();
  });

  it('ask 强制收起：confirm 入口先收副屏再入队（提问行复起后可见）', async () => {
    const terminal = new CaptureTerminal();
    const { host } = makeHost();
    const { registry } = makeRoutingRegistry();
    const tui = createTuiChannel({ host, commands: registry, terminal, history: () => [] });
    tui.start();
    await flush();
    await type(terminal, '/history');
    terminal.send('\r');
    await flush(200);
    const mark = terminal.frames.length;
    // confirm 在 UiBackend 是可选面——通道实现恒提供（非空断言：本用例标的即它）
    const answer = tui.ui().confirm!('是否继续');
    await flush(200);
    const after = terminal.frames.slice(mark).join('');
    expect(after).toContain('\x1b[?1049l'); // ask 到达即收副屏（注意力优先级 ask > 回看）
    expect(after).toContain('是否继续'); // 保树复起：提问行随后入屏
    // 应答收场（防悬空 promise）
    await type(terminal, 'y');
    terminal.send('\r');
    await flush(200);
    await expect(answer).resolves.toBe(true);
    tui.stop();
  });

  it('换防 stop 先收副屏：channel.stop() 时 1049l 在场', async () => {
    const terminal = new CaptureTerminal();
    const { host } = makeHost();
    const { registry } = makeRoutingRegistry();
    const tui = createTuiChannel({ host, commands: registry, terminal, history: () => [] });
    tui.start();
    await flush();
    await type(terminal, '/history');
    terminal.send('\r');
    await flush(200);
    const mark = terminal.frames.length;
    tui.stop();
    await flush(200);
    expect(terminal.frames.slice(mark).join('')).toContain('\x1b[?1049l'); // 停屏编舞先收副屏
  });

  it('注册门槛：history 注入缺席 = /history 不注册（不虚报）', async () => {
    const terminal = new CaptureTerminal();
    const { host } = makeHost();
    const { registry, defs } = makeRoutingRegistry();
    const tui = createTuiChannel({ host, commands: registry, terminal }); // 无 history
    tui.start();
    await flush();
    expect(defs.map((d) => d.name)).not.toContain('history'); // TUI-8 同律：能力在场才注册
    tui.stop();
  });

  it('未知命令三档：非空表且无 /help = 诚实列未知（不虚指清单）', async () => {
    const terminal = new CaptureTerminal();
    const { host } = makeHost();
    const { registry } = makeRoutingRegistry();
    // history 在场 → /history 注册 → 表非空；lookup('help') = undefined（第三档）
    const tui = createTuiChannel({ host, commands: registry, terminal, history: () => [] });
    tui.start();
    await flush();
    await type(terminal, '/nope');
    terminal.send('\r');
    await flush(200);
    const all = terminal.frames.join('');
    expect(all).toContain('✖ 未知命令：/nope'); // 诚实列未知
    expect(all).not.toContain('/help 查看清单'); // 不虚指不存在的命令（增强 8 涟漪勘正）
    tui.stop();
  });
});
