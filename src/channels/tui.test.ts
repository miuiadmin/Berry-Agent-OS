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
      history: (sessionId) => (sessionId !== undefined ? (histories.get(sessionId) ?? []) : []),
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
    expect(afterRepaint).toContain('● 工作中'); // 状态行按 entryStatus 设定
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
    expect(focused).toContain(`${CYAN} ●`); // ● 指示符着聚焦 accent
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
    expect(all).toContain(' ● 工作中'); // 素文本照常
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
      submit: (text: string) => log.push(`submit:${text}`),
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
