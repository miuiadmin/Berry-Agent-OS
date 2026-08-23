/**
 * L5 app — convertToLlm 默认实现（骨架篇 §2.3 关口：AgentMessage[] → Message[]）。
 *
 * 内核不含策略：loop 只在 LLM 调用边界调一次本函数。默认策略三行——
 * ① 标准三角色零转换透传（与 pi-ai 消息同构，骨架篇 §5.4 超集兼容子集）；
 * ② 自定义角色走注册时的 toLlm 定义（registerMessageRole 的转换钩）；
 * ③ 未注册转换或 toLlm 返回 null 的角色过滤丢弃（「模型不可见」也是策略）。
 * 永不 throw——转换失败即静默剔除该条（违约响亮化归装配期角色注册面）。
 */

import type { Message } from '../contracts/llm.js';
import type { AgentMessage } from '../agent/messages.js';
import { getMessageRoleDefinition, isStandardMessage } from '../agent/messages.js';

/**
 * 默认 LLM 边界转换（app 装配层注入 loop 的 convertToLlm）。
 * @param messages 会话转录（AgentMessage 级全量）
 * @returns 模型可见消息序列（标准角色引用直通，无拷贝）
 */
export function defaultConvertToLlm(messages: readonly AgentMessage[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    // 正向守卫窄化：真分支 = 标准三角色（直通），假分支 = CustomMessage（走定义）
    if (isStandardMessage(message)) {
      out.push(message);
      continue;
    }
    const definition = getMessageRoleDefinition(message.role);
    const converted = definition?.toLlm?.(message) ?? null;
    if (converted === null) continue; // 无转换定义 / 显式丢弃 → 模型不可见
    out.push(...(Array.isArray(converted) ? converted : [converted]));
  }
  return out;
}
