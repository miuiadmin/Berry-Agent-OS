/**
 * L5 app — `berry` 主命令（TUI 对话，产品主入口）。
 *
 * 组合根装配 → TUI 通道起屏（历史投影渲染 + 输入接管）→ 事件流接线（driver
 * emit 扇出接 tui.handle）→ 等退出请求（Ctrl+D / /quit）→ 优雅退出序列
 * （骨架篇 §1.3：abort → run 结算 → 停屏 → flush → 关库 → ctx 回卷）。
 */

import { createTuiChannel } from '../channels/tui.js';
import { projectedToAgentMessages } from './durable.js';
import { createBerryRuntime } from './assembly.js';
import type { RuntimeOptions } from './assembly.js';
import { ensureDataDir } from './paths.js';
import { VERSION } from './version.js';

/**
 * TUI 主流程（阻塞至用户退出）。
 * @param options 组合根选项透传（测试注入 streamFn/dbPath/terminal 用）
 * @returns 进程退出码（正常退出恒 0——用户离开不是错误）
 */
export async function tuiMain(options: RuntimeOptions = {}): Promise<number> {
  ensureDataDir();
  const runtime = createBerryRuntime({ ...options, interactive: true });
  const { conversation, session } = runtime;

  // TUI 通道（历史投影经注入回调拉取——通道不依赖 session；无会话时空历史）
  const tui = createTuiChannel({
    host: conversation,
    commands: runtime.channels.commands,
    rendererFor: (role) => runtime.channels.rendererFor(role),
    title: `Berry ${VERSION}`,
    history: () => projectedToAgentMessages(session?.deriveMessages() ?? []),
  });
  runtime.ui.attach(tui.ui());
  // 事件流接线：driver 的 emit 扇出加 TUI 展示半边（durable 半边装配期已接）
  conversation.addDisplay((event) => tui.handle(event));

  // SIGINT（外部中断：kill -INT / 非 raw 终端 Ctrl+C）走同一退出编舞——
  // requestQuit 先 abort 在跑的 run 再 resolve，后续 settle/flush 关库一个不少
  // （独立重读轮 #16 复核补钉：此前该分支只在 run-main 落地，TUI 主入口
  // 外部 SIGINT 走 Node 默认硬死、teardown 序列整体跳过）
  const onInterrupt = () => conversation.requestQuit();
  process.once('SIGINT', onInterrupt);

  tui.start();
  try {
    // 等待退出请求（Ctrl+D / Ctrl+C / /quit / SIGINT——四路同汇 requestQuit）
    await conversation.quit;
    await conversation.settle();
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    tui.stop();
    await runtime.shutdown();
  }
  return 0;
}
