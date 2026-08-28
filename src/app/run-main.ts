/**
 * L5 app — `berry run "<message>"` 单次执行（headless：无 TUI、无审批应答者）。
 *
 * 一轮对话 → stdout 输出最后 assistant 文本。退出码：正常 0 / run 失败 1 /
 * 用法错 2。SIGINT 走优雅 abort（requestQuit——run 即终，事件日志留完整痕迹）。
 */

import type { RunResult } from '../agent/loop.js';
import type { AssistantMessage } from '../contracts/llm.js';
import { createBerryRuntime } from './assembly.js';
import type { RuntimeOptions } from './assembly.js';
import { installExitSignals } from './signals.js';

/** 取 run 内最后一条 assistant 消息的文本（text 块拼接；无则 undefined） */
function lastAssistantText(result: RunResult): string | undefined {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const message = result.messages[i]!;
    if (message.role === 'assistant') {
      const text = (message as AssistantMessage).content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      return text || undefined;
    }
  }
  return undefined;
}

/**
 * 单次执行主流程。
 * @param message 用户消息全文
 * @param options 组合根选项透传（测试注入 streamFn/dbPath 用）
 * @returns 进程退出码
 */
export async function runOnceMain(message: string, options: RuntimeOptions = {}): Promise<number> {
  const runtime = await createBerryRuntime({ ...options, interactive: false });
  // 可卸语义（应用面第一纵切）：chat 件未装载即无对话循环——run 语义性失败
  //（退出码 1 + stderr 示明；/apps 面向用户提示查装配）
  if (runtime.conversation === undefined) {
    process.stderr.write(
      '对话应用未装载（builtin:chat 被禁用或 persist:false）——run 无对话循环可执行；/apps 查看装配。\n',
    );
    await runtime.shutdown();
    return 1;
  }
  const conversation = runtime.conversation;
  // 信号编舞（骨架篇 §1.3 全表，与 TUI 入口共用；S6 形态④注记：run 入口恒单驱动
  // ——两 kind 同走 requestQuit 全序列，无分档面）：SIGINT 首次优雅 abort 当前
  // run（事件日志留完整痕迹）/ 二次立即 130 / SIGTERM 143 / SIGHUP 129 /
  // uncaught/unhandled 不吞 exit(1)
  const signals = installExitSignals({
    onGracefulQuit: () => conversation.requestQuit(),
    onFatal: async (error, kind) => {
      runtime.ctx.logger.error(`致命异常（${kind}），尽力落盘后退出`, {
        kind,
        error: error instanceof Error ? error.stack : String(error),
      });
      await runtime.persistence?.flush().catch(() => undefined);
    },
  });

  let code: number;
  try {
    const result = await conversation.submitOnce(message);
    if (!result) {
      // 防御：quit 已触发时 submitOnce 转队列返回 undefined——按中断处理
      process.stderr.write('已中断\n');
      code = 0;
    } else if (result.status === 'failed') {
      process.stderr.write(`${result.errorMessage ?? '执行失败'}\n`);
      code = 1;
    } else {
      const text = lastAssistantText(result);
      if (text !== undefined) process.stdout.write(`${text}\n`);
      code = 0;
    }
  } finally {
    signals.dispose();
    await runtime.shutdown();
  }
  // 优雅路退出码：SIGINT 首次 = 0；SIGTERM/SIGHUP 采纳记账码（仅覆盖 0——
  // run 自身失败码 1 优先于信号记账）
  return code === 0 ? signals.exitCode : code;
}
