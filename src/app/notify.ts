/**
 * L5 app — 子代理结算通知器（骨架篇 §6.4 落码面，subagent 纵切三）。
 *
 * 结算回调（service opts.onSettle）→ 两件事，顺序固定：
 * ① **结算折叠**：子 usage 并入当前会话一条 `llm/usage`（会话篇 §1.1 计量事件）——
 *    `priority: 'background'` 恒定（子代理消耗即后台计量道，不问前台/后台形态；
 *    闸门当日聚合全局按 time 过滤，/new 切换后折进当前会话记账仍正确）；
 *    `callId = execution.id`（in-process = 子会话 id，天然幂等身份）。
 * ② **三通道通知**：仅 background 委派（前台父正 await result——再注入即重复）；
 *    owner 路由键匹配当前会话（或缺省无主）才投——构造 `source:'subagent-settled'`
 *    的 UserMessage 经 driver.deliver 投递（backgroundWake 计入自激预算，通道由
 *    父当前状态选定：闲→followUp / 忙→steer / 拆卸中或超预算→inject）。
 *
 * 无条件纪律（§6.4 钉死）：token 耗尽/取消/失败恰恰是子没机会 report 的场景——
 * 任何终态都投递（失败族正文载 diagnostic）。
 */

import type { SubagentSettlement } from '../contracts/subagent.js';
import type { UserMessage } from '../contracts/llm.js';
import type { Session } from '../session/session.js';
import type { ConversationDriver } from '../chat/index.js';

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
   * 会话驱动活取值（三通道投递面——chat 对话应用件的活句柄）。结算只发生在
   * run 运行期，无对话循环即无委派即无结算，undefined 为结构性不可达的防御位
   * （chat 件未装载/诊断装配时防御性跳过投递——结算折叠独立，不受影响）
   */
  readonly getDriver: () => ConversationDriver | undefined;
  /** 当前会话活引用（/new 热切换后读到新会话——闭包不随切换重造） */
  readonly getSession: () => Session | undefined;
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
    const session = opts.getSession();
    // ① 结算折叠（无会话 = persist:false 诊断面，无处落账即跳过）
    if (session !== undefined && settlement.result.usage !== undefined) {
      const usage = settlement.result.usage;
      session.append('llm/usage', {
        callId: settlement.execution.id,
        model: opts.model,
        priority: 'background',
        usage: { input: usage.input, output: usage.output },
      });
    }
    // ② 三通道通知：前台不通知（父正 await result）；owner 路由键不匹配（/new 已
    // 切走）即丢弃——通知只投给仍持有该子的会话；驱动缺失（chat 件未装载的防御
    // 位）同样跳过投递
    const driver = opts.getDriver();
    if (!settlement.request.background || session === undefined || driver === undefined) return;
    const owner = settlement.request.ownerSessionId;
    if (owner !== undefined && owner !== session.header.sessionId) return;
    const message: UserMessage = {
      role: 'user',
      content: formatSettlementNotice(settlement),
      timestamp: Date.now(),
      source: 'subagent-settled',
    };
    driver.deliver(message, { backgroundWake: true });
  };
}
