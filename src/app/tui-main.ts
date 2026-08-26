/**
 * L5 app — `berry` 主命令（TUI 对话，产品主入口）。
 *
 * 组合根装配 → TUI 通道起屏（历史投影渲染 + 输入接管）→ 事件流接线（front
 * 转接表 → 聚焦驱动）→ 等退出请求（Ctrl+D / /quit）→ 优雅退出序列
 * （骨架篇 §1.3：abort → run 结算 → 停屏 → flush → 关库 → ctx 回卷）。
 *
 * S1 前台宿主 façade：TUI 恒接 runtime.front（chat 件构造产物，无驱动时
 * no-op 形）——submit/requestQuit/addDisplay/settle 四路全经它路由，本文件
 * 不再持有驱动引用。可卸语义（应用面第一纵切）：chat 对话应用件被 overlay
 * 禁用时注册表空——**壳照启**：命令面/插件管理/审批完好，输入静默 + 提示行
 * 示明无对话循环（对话是应用不是内核，命题 §3.5）。
 */

import { createTuiChannel } from '../channels/tui.js';
import { projectedToAgentMessages } from '../chat/index.js';
import { createBerryRuntime } from './assembly.js';
import type { RuntimeOptions } from './assembly.js';
import { installExitSignals } from './signals.js';
import { VERSION } from './version.js';

/**
 * TUI 主流程（阻塞至用户退出）。
 * @param options 组合根选项透传（测试注入 streamFn/dbPath/terminal 用）
 * @returns 进程退出码（正常退出恒 0——用户离开不是错误）
 */
export async function tuiMain(options: RuntimeOptions = {}): Promise<number> {
  // 数据目录建档已收编 createBerryRuntime ③（三入口共用单点）——此处不再早调
  const runtime = await createBerryRuntime({
    ...options,
    interactive: true,
    // TUI 启动策略（技术栈篇 §5 拍板）：缺省续接本工作区最新会话
    resumeSession: options.resumeSession ?? true,
  });
  // 前台宿主（S1）：恒在——submit/addDisplay/settle 按前台聚焦路由，后续 open
  // 的新驱动自动接管输入与展示（/new 换新 TUI 零重接）；quit 聚合 promise
  // 无驱动时由 requestQuit 直接 resolve（壳照启可退）
  const front = runtime.front;

  // TUI 通道（历史投影经注入回调拉取——通道不依赖 session；无会话时空历史）。
  // runtime.session 是活取值（/new 热切换后指向新会话），不能解构快照
  const tui = createTuiChannel({
    host: front,
    commands: runtime.channels.commands,
    rendererFor: (role) => runtime.channels.rendererFor(role),
    title: `Berry ${VERSION}`,
    history: () => projectedToAgentMessages(runtime.session?.deriveMessages() ?? []),
  });
  runtime.ui.attach(tui.ui());
  // 事件流接线：front 转接表 → 当前聚焦驱动（durable 半边装配期已接；后续
  // open 的新驱动经转接表自动获得此展示消费者——多驱动切换不断流）
  front.addDisplay((event) => tui.handle(event));
  // 可卸提示：无对话循环时示明现状（命令面仍可用——/plugins 可查、/reload 可试）
  if (runtime.conversation === undefined) {
    runtime.ui.notify(
      '对话应用未装载（builtin:chat 被禁用或 persist:false）——输入不会得到应答；/plugins 查看装配，/quit 退出。',
    );
  }

  // 信号编舞（骨架篇 §1.3 全表）：SIGINT 首次/二次、SIGTERM 143、SIGHUP 129、
  // uncaught/unhandled 不吞 exit(1)——两入口共用；优雅路本体走 front 退出信号
  const signals = installExitSignals({
    onGracefulQuit: () => front.requestQuit(),
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
    // 等待退出请求（Ctrl+D / Ctrl+C / /quit / 信号——多路同汇 front.requestQuit）
    await front.quit;
    await front.settle();
  } finally {
    signals.dispose();
    tui.stop();
    await runtime.shutdown();
  }
  // SIGINT 首次优雅完成 = 0（用户中断不是错误）；SIGTERM/SIGHUP 采纳记账码
  return signals.exitCode;
}
