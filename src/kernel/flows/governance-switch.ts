/**
 * 治理路由统一枢纽（架构升级 16.0 §4 + §9 P3）。
 *
 * 把 15.0 A(权限 Gate) / B(产出 Review+Escalate) / C(evolution 离线审计) / D(brain Command)
 * 四套治理的「何时出场 / 谁出场」收敛到板上 BoardMessage.type 单一 switch。新增一种协作 = 加一个
 * type 分支，不再动四套 IPC 通道（§3.3 收敛证明）。
 *
 * 4 种治理出场姿态（§4.1）按 type 路由：
 *   - tool_request         → ①权限专员 Gate（L1 规则自放 / L2 brain judge / L3 用户确认）
 *   - report               → ②产出审核专员 Review（approve/modify/reject）
 *   - ask(to=brain)        → ③brain Escalate（接求救 / 介入 / 回退用户）
 *   - command(from=brain) → ③brain Command（板上已纠偏，被@agent honor）
 * 其余 type 无治理硬动作（brain 异步看板，§4.2「看所有≠挡所有」）：
 *   - ask(to=peer) → 板内求助（不惊动治理硬闸）
 *   - tell / delegate → 纯发言 / 派工（brain 看板可见可纠偏）
 *   - tool_result → 事实（结果不再过闸，§4.4）
 *
 * 与 15.0 收敛映射（§3.3）：A→①、B→②③、C→④(离线观察非出场姿态)、D→③。
 *
 * 本模块是 P3 的核心契约：所有治理动作经 routeGovernance 一处 switch 派发，替代 15.0 散落在
 * permission.acquire / superior.review / checkpoint.evaluate / brain.command 四套 IPC 主路径
 * 的 if 判别。routeGovernance 是纯路由（无副作用），供调用方据返回的 route 执行对应治理服务。
 * P3-S2+ 把各 flow 触发入口迁到经此 switch（增量迁移，保留旧路径至 P5 退役）。
 */

import type { BoardMessage } from '../../contracts/board-message.js';

/** 治理路由结果：一条 BoardMessage 该走哪个治理机制（§4.1 四姿态 + none） */
export type GovernanceRoute =
  /** →①权限专员 Gate：单个工具调用在 scope 内安不安全 */
  | { kind: 'gate'; toolName: string; input: Record<string, unknown> }
  /** →②产出审核专员 Review：单份 report/handoff 是否合格 */
  | { kind: 'review'; summary: string; status: 'done' | 'partial' | 'blocked' | 'cant_split' }
  /** →③brain Escalate：ask(@brain) 升级求助（agent 拿不准时介入） */
  | { kind: 'escalate'; question: string }
  /** ask(@peer) 板内求助：不惊动治理硬闸，只进 brain 看板（§4.4） */
  | { kind: 'peer_help'; question: string }
  /** →③brain Command：板上纠偏（redirect/stop/inspect/dispatch，被@agent honor） */
  | { kind: 'command'; intent: 'redirect' | 'stop' | 'inspect' | 'dispatch' }
  /** 无治理硬动作：tell/delegate/tool_result（brain 异步看板） */
  | { kind: 'none'; reason: string };

/**
 * 治理路由单一入口（§4 + §9 P3）：按 BoardMessage.type 决定走哪个治理机制。
 *
 * 纯函数（无副作用）——返回 route，调用方据此执行对应治理服务（permissionCoordinator /
 * superior-review / checkpoint / brain-command）。behaviour-parity：同 type 同 route，
 * 是 P3 把 4 套 IPC flow 收敛到一处 switch 的契约基础。
 *
 * @param message 板上信封（7 type 之一）
 * @returns 治理路由（gate/review/escalate/peer_help/command/none）
 */
export function routeGovernance(message: BoardMessage): GovernanceRoute {
  switch (message.type) {
    case 'tool_request':
      // →①权限专员 Gate（撞闸同步阻塞，§4.2）
      return { kind: 'gate', toolName: message.toolName, input: message.input };
    case 'report':
      // →②产出审核专员 Review（必经，§4.4：用户看到的产出永远经②背书）
      return { kind: 'review', summary: message.summary, status: message.status };
    case 'ask':
      // 判别 = to 字段（§4.4）：@brain 升级 Escalate；@peer 板内求助不惊动治理硬闸
      return message.to === 'brain'
        ? { kind: 'escalate', question: message.question }
        : { kind: 'peer_help', question: message.question };
    case 'command':
      // →③brain Command（板上已纠偏；被@agent 下一轮 honor，§4.2.2 动作3）
      return { kind: 'command', intent: message.intent };
    case 'tell':
      // 板上发言：纯讨论，brain 异步看板（§4.2 看板不阻塞）
      return { kind: 'none', reason: '板上发言（brain 异步看板，无治理硬动作）' };
    case 'delegate':
      // 派工：leader 自主派+brain 事后纠（§5.2.1），无治理硬动作
      return { kind: 'none', reason: '派工（leader 自主，brain 看板可见可纠偏）' };
    case 'tool_result':
      // 工具结果：事实非动作，不再过任何闸（§4.4）
      return { kind: 'none', reason: '工具结果（事实，不再过闸）' };
  }
}
