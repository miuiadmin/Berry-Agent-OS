/**
 * L5 app — 子代理结算通知器（骨架篇 §6.4 落码面，subagent 纵切三；S1 键控重写）。
 *
 * 结算回调（service opts.onSettle）→ 两件事，顺序固定：
 * ① **结算折叠**：子 usage 并入**归属会话**一条 `llm/usage`（会话篇 §1.1 计量
 *    事件）——`priority: 'background'` 恒定（子代理消耗即后台计量道，不问前台/
 *    后台形态；闸门当日聚合全局按 time 过滤）；`callId = execution.id`
 *    （in-process = 子会话 id，天然幂等身份）。
 * ② **三通道通知**：仅 background 委派（前台父正 await result——再注入即重复）；
 *    经注册表条目路由投递（S1：归属 = ownerSessionId 显式键 ?? 调用链——
 *    in-process 子工厂结算回调运行于父 tool call 链内，链=父会话）。退役条目
 *    照投——驱动已 abort，deliver 自动降 inject（只留审计不开 run）。
 *
 * 无条件纪律（§6.4 钉死）：token 耗尽/取消/失败恰恰是子没机会 report 的场景——
 * 任何终态都投递（失败族正文载 diagnostic）。
 */

import type { SubagentSettlement } from '../contracts/subagent.js';
import type { UserMessage } from '../contracts/llm.js';
import type { DriverEntry } from '../chat/index.js';
import { chainSessionId } from '../context/chain.js';

/** 通知正文 output/diagnostic 摘录上限（字符）——通知是唤醒线索非产物载体 */
const EXCERPT_LIMIT = 4000;

/** 摘录（超限截断加尾标记；正文语义损失显式化） */
function excerpt(text: string): string {
  return text.length <= EXCERPT_LIMIT ? text : `${text.slice(0, EXCERPT_LIMIT)}…[截断]`;
}

/**
 * 构造通知正文（人读单条短文——label/终态/用量 + 产物或诊断摘录）。
 * 独立导出供测试直接断言文案结构（不断言模型生成内容）。
 */
export function formatSettlementNotice(settlement: SubagentSettlement): string {
  const { request, result } = settlement;
  const label = request.label ?? (request.prompt.length > 40 ? `${request.prompt.slice(0, 40)}…` : request.prompt);
  const tokens = result.usage !== undefined ? `，${result.usage.totalTokens} tokens` : '';
  const body = result.stopReason === 'completed' ? excerpt(result.output) : excerpt(result.diagnostic ?? '');
  return `子代理「${label}」已${result.stopReason === 'completed' ? '完成' : '结算'}（${result.stopReason}${tokens}）：\n${body}`;
}

/** 通知器构造选项 */
export interface SubagentNotifierOptions {
  /**
   * 注册表条目解析闭包（S1 键控——assembly 接线传 registry.entries.get 绑定）：
   * 按归属会话 id 直查条目（含退役保留者——迟到结算折进原会话账，不随前台聚焦错投）。
   * 结算只发生在 run 运行期，无对话循环即无委派即无结算，查无条目为结构性
   * 不可达的防御位（chat 件未装载/诊断装配——折叠与投递两腿独立跳过）
   */
  readonly resolveEntry: (sessionId: string) => DriverEntry | undefined;
  /** 子模型标识（llm/usage 计量事件的 model 腿——结算契约不带模型名，装配层注入） */
  readonly model: string;
}

/**
 * 创建结算通知器（装配 ④d 的 onSettle 接线体）。
 *
 * @returns 可直接作 service opts.onSettle 的回调（service 侧已做违约隔离——
 *   此处 append/deliver 抛错由 fireOnSettle 捕获记账，不炸结算链）
 */
export function createSubagentNotifier(opts: SubagentNotifierOptions): (settlement: SubagentSettlement) => void {
  return (settlement) => {
    // 归属会话解析（CR-13）：显式 ownerSessionId 优先，缺省走调用链（in-process
    // 子工厂的结算回调在父 tool call 链内执行——chainSessionId = 父会话）
    const sessionId = settlement.request.ownerSessionId ?? chainSessionId();
    const entry = sessionId !== undefined ? opts.resolveEntry(sessionId) : undefined;
    // ① 结算折叠（entry 缺席 = persist:false 诊断面/会话未开，无处落账即跳过）
    if (entry !== undefined && settlement.result.usage !== undefined) {
      const usage = settlement.result.usage;
      entry.session.append('llm/usage', {
        callId: settlement.execution.id,
        model: opts.model,
        priority: 'background',
        usage: { input: usage.input, output: usage.output },
      });
    }
    // ② 三通道通知：前台不通知（父正 await result）；归属未解析出（无链无键）
    // 不投——无处可投。退役条目照投（driver 已 abort——deliver 自动降 inject，
    // 只留审计记录不开 run）
    if (!settlement.request.background || entry === undefined) return;
    const message: UserMessage = {
      role: 'user',
      content: formatSettlementNotice(settlement),
      timestamp: Date.now(),
      source: 'subagent-settled',
    };
    entry.driver.deliver(message, { backgroundWake: true });
  };
}
