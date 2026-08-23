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
  const runtime = createBerryRuntime({ ...options, interactive: false });
  // SIGINT：优雅 abort 当前 run（一次性的信号——resolve 后 run 即终再走关停）
  const onInterrupt = () => runtime.conversation.requestQuit();
  process.once('SIGINT', onInterrupt);

  let code: number;
  try {
    const result = await runtime.conversation.submitOnce(message);
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
    process.removeListener('SIGINT', onInterrupt);
    await runtime.shutdown();
  }
  return code;
}
