/**
 * L5 app — `berry` 主命令（TUI 对话，产品主入口）。
 *
 * 组合根装配 → TUI 通道起屏（历史投影渲染 + 输入接管）→ 事件流接线（driver
 * emit 扇出接 tui.handle）→ 等退出请求（Ctrl+D / /quit）→ 优雅退出序列
 * （骨架篇 §1.3：abort → run 结算 → 停屏 → flush → 关库 → ctx 回卷）。
 *
 * 可卸语义（应用面第一纵切）：chat 对话应用件被 overlay 禁用时驱动为
 * undefined——**壳照启**：命令面/插件管理/审批完好，占位宿主只供退出信号，
 * 输入静默 + 提示行示明无对话循环（对话是应用不是内核，命题 §3.5）。
 */

import { createTuiChannel } from '../channels/tui.js';
import { projectedToAgentMessages } from '../chat/index.js';
import { createBerryRuntime } from './assembly.js';
import type { RuntimeOptions } from './assembly.js';
import type { ChannelHost } from '../channels/types.js';
import { installExitSignals } from './signals.js';
import { ensureDataDir } from './paths.js';
import { VERSION } from './version.js';

/**
 * TUI 主流程（阻塞至用户退出）。
 * @param options 组合根选项透传（测试注入 streamFn/dbPath/terminal 用）
 * @returns 进程退出码（正常退出恒 0——用户离开不是错误）
 */
export async function tuiMain(options: RuntimeOptions = {}): Promise<number> {
  ensureDataDir();
  const runtime = await createBerryRuntime({
    ...options,
    interactive: true,
    // TUI 启动策略（技术栈篇 §5 拍板）：缺省续接本工作区最新会话
    resumeSession: options.resumeSession ?? true,
  });
  const conversation = runtime.conversation;

  // chat 件未装载（overlay 禁用/诊断装配）——壳照启：占位宿主自带退出 promise，
  // submit 静默（提示行已示明无对话循环），settle/display 两腿自然缺席
  let stubQuitResolve!: () => void;
  const stubQuit = new Promise<void>((resolve) => {
    stubQuitResolve = resolve;
  });
  const host: ChannelHost = conversation ?? {
    submit: () => undefined,
    requestQuit: () => stubQuitResolve(),
  };
  const quitSignal: Promise<void> = conversation ? conversation.quit : stubQuit;

  // TUI 通道（历史投影经注入回调拉取——通道不依赖 session；无会话时空历史）。
  // runtime.session 是活取值（/new 热切换后指向新会话），不能解构快照
  const tui = createTuiChannel({
    host,
    commands: runtime.channels.commands,
    rendererFor: (role) => runtime.channels.rendererFor(role),
    title: `Berry ${VERSION}`,
    history: () => projectedToAgentMessages(runtime.session?.deriveMessages() ?? []),
  });
  runtime.ui.attach(tui.ui());
  // 事件流接线：driver 的 emit 扇出加 TUI 展示半边（durable 半边装配期已接）
  conversation?.addDisplay((event) => tui.handle(event));
  // 可卸提示：无对话循环时示明现状（命令面仍可用——/plugins 可查、/reload 可试）
  if (conversation === undefined) {
    runtime.ui.notify(
      '对话应用未装载（builtin:chat 被禁用或 persist:false）——输入不会得到应答；/plugins 查看装配，/quit 退出。',
    );
  }

  // 信号编舞（骨架篇 §1.3 全表）：SIGINT 首次/二次、SIGTERM 143、SIGHUP 129、
  // uncaught/unhandled 不吞 exit(1)——两入口共用；优雅路本体走 host 退出信号
  const signals = installExitSignals({
    onGracefulQuit: () => host.requestQuit(),
    onFatal: async (error, kind) => {
      runtime.ctx.logger.error(`致命异常（${kind}），尽力落盘后退出`, {
        kind,
        error: error instanceof Error ? error.stack : String(error),
      });
      await runtime.persistence?.flush().catch(() => undefined);
    },
  });

  tui.start();
  try {
    // 等待退出请求（Ctrl+D / Ctrl+C / /quit / 信号——多路同汇 requestQuit）
    await quitSignal;
    await conversation?.settle();
  } finally {
    signals.dispose();
    tui.stop();
    await runtime.shutdown();
  }
  // SIGINT 首次优雅完成 = 0（用户中断不是错误）；SIGTERM/SIGHUP 采纳记账码
  return signals.exitCode;
}
