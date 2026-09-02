/**
 * L3 webui — pending 审批登记簿（契约篇 §6.8 刀三：web 应答面单一写漏斗）。
 *
 * 数据源三路合一，全部收敛进本簿（无旁路写点）：
 * - **asked 镜像**（ctx 'session/event' 总线 → approval/asked）：幂等注册
 *   （ask 落账先于 waterfall 派发——同步序保证 claim 时条目恒在场，本路是
 *   主路径）；
 * - **claim 自注册**（answerer 时点）：行重载后新簿空册、镜像已过——缺槽
 *   自注册补位（enriched 载荷自带 summary/归属）；
 * - **decided 镜像**（approval/decided）：标已决并**保留**条目（GET 过滤已决
 *   不吐；decide 端点凭已决旗回 superseded——race settle → markDecided 之间
 *   是纯同步块〔persistAllowlist 无 await〕，HTTP decide 无插入窗，竞窗闭合）。
 *
 * 应答回流 = claim 竞速注入（spec 刀三条）：answerer 在 TUI 原语之外与 web
 * 卡片竞速，先胜者即裁决；败腿 promise 丢弃性结算。行回卷（/reload）卫生：
 * **未决条目不结算**——未决 claim promise 仍是竞速在途腿，resolve 任何值都
 * 会抢答污染竞速；悬置无害（行回卷后 decide/镜像均不可达，竞速由 TUI 腿
 * 收敛，promise 随竞速结算自然回收）。
 *
 * 撤销面（遗漏大扫 20260902-b #2 修死，第六十一批）：claim 可携带撤销信号
 * （answerer 的 per-request controller——run abort 与竞速败腿收束汇入同一
 * 面）。abort 时本簿以 'cancel' 结算该腿（daemon 形态 web-only 腿的唯一
 * 打断收场路）并**同步标 decided='cancel' 镜像**——他端迟答走 decide 的
 * superseded 回执，不误收已撤销审批；任何结算路径（decide / decided 镜像 /
 * 行回卷 settleAll / abort 自身）摘监听——迟到 abort 恒 no-op。
 */

import type { SessionEvent } from '../contracts/events.js';
import type { WebuiApprovalDecision, WebuiApprovalDetail, WebuiPendingApproval } from './types.js';

/** registry 在册条目（公开条目 + 内部结算面——可变富化/标决） */
interface RegistryEntry {
  /** 审批 id（卡片键） */
  approvalId: string;
  /** 归属会话（镜像信封 sessionId；根路审批/claim 缺槽缺省 undefined 档） */
  sessionId?: string;
  /** 目标动作摘要 */
  summary: string;
  /** 请求方/理由 */
  reason?: string;
  /** 「始终允许」草案（在场 = 三态按钮） */
  suggestedEntry?: { tool: string; pattern: string };
  /** 归属标签 */
  ownership?: { appId?: string; sessionId: string };
  /** 出队优先级（'background' 时卡面注记） */
  priority?: string;
  /** 已决旗（undefined = 未决；镜像标决/decide 落决/abort 收场——值域 durable 五值） */
  decided?: string;
  /** claim promise 的 resolve 针（claim 时挂、结算后置弃；undefined = 未 claim 或已结算；值域并 'cancel'——signal 透传的宿主动作结算） */
  resolver?: (decision: WebuiApprovalDecision | 'cancel') => void;
  /** 撤销监听摘针（claim 带 signal 时挂；任何结算路径〔decide/decided 镜像/settleAll/abort 自身〕置弃——迟到 abort no-op） */
  detachAbort?: () => void;
}

/** 在册条目软帽（超帽清最旧**已决**条目——未决条目绝不逐出） */
const MAX_ENTRIES = 100;

/**
 * 建 pending 审批登记簿（webui 行 apply 期构造，随行生命周期——boot 起新簿
 * 空册，行回卷整体废弃）。
 */
export function createPendingApprovals(): PendingApprovals {
  /** 在册条目表（approvalId → 条目；含已决保留者——list 过滤已决） */
  const entries = new Map<string, RegistryEntry>();

  /** 超帽清理：只逐出已决条目中最旧者（插入序即时间序——Map 迭代序保证） */
  function evictOverflow(): void {
    if (entries.size <= MAX_ENTRIES) return;
    for (const [id, entry] of entries) {
      if (entries.size <= MAX_ENTRIES) break;
      if (entry.decided !== undefined) entries.delete(id);
    }
  }

  /**
   * 结算单点（decide / decided 镜像 / abort 收场三路共用）：标已决 + resolve
   * 悬置腿（值由调用方语境给——decide 是真消费、镜像/abort 是丢弃性防悬）+
   * 摘撤销监听（任何结算路径都使迟到 abort no-op——摘监听不变式）。幂等守卫
   * 在调用方（decided !== undefined 先判）。
   */
  function settleEntry(entry: RegistryEntry, decided: string, value: WebuiApprovalDecision | 'cancel'): void {
    entry.decided = decided;
    const resolve = entry.resolver;
    entry.resolver = undefined;
    const detach = entry.detachAbort;
    entry.detachAbort = undefined;
    detach?.();
    resolve?.(value);
  }

  return {
    /** session 族镜像入列：asked 注册 / decided 标决（幂等——两路重复到达不重写） */
    onMirror(payload: unknown): void {
      const env = payload as { sessionId?: unknown; event?: unknown } | undefined;
      if (env === undefined || typeof env.sessionId !== 'string') return; // 形状不符静默丢（总线契约外载荷）
      const ev = env.event as Partial<SessionEvent> | undefined;
      if (ev === undefined || typeof ev.type !== 'string') return;
      const data = (ev as { data?: unknown }).data as Record<string, unknown> | undefined;
      if (data === undefined || typeof data.approvalId !== 'string') return;
      if (ev.type === 'approval/asked') {
        // 幂等注册：条目已在（claim 先行自注册的缺槽补位竞速）只补缺省键，
        // 不覆盖 claim 已富化的 suggestedEntry/ownership/priority
        const existing = entries.get(data.approvalId);
        if (existing === undefined) {
          entries.set(data.approvalId, {
            approvalId: data.approvalId,
            sessionId: env.sessionId,
            summary: typeof data.summary === 'string' ? data.summary : '',
          });
        } else if (existing.summary === '' && typeof data.summary === 'string') {
          existing.summary = data.summary; // claim 载荷 summary 缺席的补位（防御位）
        }
        return;
      }
      if (ev.type === 'approval/decided') {
        const entry = entries.get(data.approvalId);
        if (entry === undefined) return; // 簿外已决（行重载竞速）——无从标起不计
        if (entry.decided === undefined) {
          // 标已决保留：值域是 durable 五值（含 cancel/unavailable——web 闭集外，
          // 仅作条目状态非应答值）。此刻竞速必已收敛（decided 镜像在 ask 返回前
          // 同步发射）——顺手 resolve 是丢弃性结算，值无人消费仅防悬 await
          const decided = typeof data.decision === 'string' ? data.decision : '';
          settleEntry(entry, decided, decided === 'always' ? 'always' : decided === 'approve' ? 'approve' : 'reject');
        }
        evictOverflow();
        return;
      }
    },

    /** claim（answerer 时点调用）：富化 + 缺槽自注册 + 撤销面挂接；已决/已 claim/未决双 claim = undefined（无 web 腿） */
    claim(
      approvalId: string,
      detail: WebuiApprovalDetail,
      signal?: AbortSignal,
    ): Promise<WebuiApprovalDecision | 'cancel'> | undefined {
      const existing = entries.get(approvalId);
      if (existing === undefined) {
        // 缺槽自注册（行重载后镜像已过——enriched 载荷自带全量归属信息）
        entries.set(approvalId, {
          approvalId,
          sessionId: detail.ownership?.sessionId,
          summary: detail.summary,
          ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
          ...(detail.suggestedEntry !== undefined ? { suggestedEntry: detail.suggestedEntry } : {}),
          ...(detail.ownership !== undefined ? { ownership: detail.ownership } : {}),
          ...(detail.priority !== undefined ? { priority: detail.priority } : {}),
        });
      } else {
        if (existing.decided !== undefined) return undefined; // 已决（TUI 腿已胜）——无 web 腿
        if (existing.resolver !== undefined) return undefined; // 双 claim 防御位（一 ask 恰一 answerer）
        // 富化：镜像注册时只有 summary/sessionId——claim 补 suggestedEntry/ownership/priority
        if (existing.suggestedEntry === undefined && detail.suggestedEntry !== undefined) {
          existing.suggestedEntry = detail.suggestedEntry;
        }
        if (existing.ownership === undefined && detail.ownership !== undefined) existing.ownership = detail.ownership;
        if (existing.priority === undefined && detail.priority !== undefined) existing.priority = detail.priority;
        if (existing.reason === undefined && detail.reason !== undefined) existing.reason = detail.reason;
      }
      const entry = entries.get(approvalId)!;
      // 撤销面挂接（遗漏大扫 20260902-b #2）：signal 已 abort = 竞速败腿收束
      // finally abort 先于本 claim 到达（此刻竞速已决）或 run 早撤——同步结算
      // 'cancel' 防悬；未 abort 挂监听——abort 时以 'cancel' 结算本腿并同步标
      // decided 镜像（daemon web-only 形态的唯一打断收场路；他端迟答 superseded）
      if (signal !== undefined) {
        if (signal.aborted) {
          settleEntry(entry, 'cancel', 'cancel');
          return Promise.resolve('cancel');
        }
        const onAbort = () => settleEntry(entry, 'cancel', 'cancel');
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detachAbort = () => signal.removeEventListener('abort', onAbort);
      }
      // 悬置 promise：decide 端点 resolve 它（web 腿胜）；TUI 腿胜时 decided 镜像丢弃性结算
      let resolve!: (decision: WebuiApprovalDecision | 'cancel') => void;
      const promise = new Promise<WebuiApprovalDecision | 'cancel'>((r) => {
        resolve = r;
      });
      entry.resolver = resolve;
      return promise;
    },

    /** 未决条目单查（decide 端点 always-需-草案 400 校验的取数面；已决同 404 语义由 decide 判） */
    pending(approvalId: string): WebuiPendingApproval | undefined {
      const entry = entries.get(approvalId);
      return entry === undefined || entry.decided !== undefined ? undefined : entry;
    },

    /** GET /api/approvals 清单（已决过滤——卡片恢复/角标面数据源） */
    list(): readonly WebuiPendingApproval[] {
      const out: WebuiPendingApproval[] = [];
      for (const entry of entries.values()) {
        if (entry.decided !== undefined) continue;
        out.push({ ...entry });
      }
      return out;
    },

    /** 未决数按 ownership 域分桶（daemon 刀一帽面数据源——undefined 键 = 宿主桶） */
    pendingCountBy(ownerAppId: string | undefined): number {
      let count = 0;
      for (const entry of entries.values()) {
        if (entry.decided !== undefined) continue;
        if (entry.ownership?.appId === ownerAppId) count += 1;
      }
      return count;
    },

    /** POST decide（值域已由端点闭集校验）：undefined = 槽从未存在（404）；superseded = 已决旗先置 */
    decide(
      approvalId: string,
      decision: WebuiApprovalDecision,
    ): { accepted: true } | { accepted: false; reason: 'superseded' } | undefined {
      const entry = entries.get(approvalId);
      if (entry === undefined) return undefined; // 已决保留使竞窗不存在——本分支只剩「槽从未存在」
      if (entry.decided !== undefined) return { accepted: false, reason: 'superseded' }; // TUI 腿先胜
      settleEntry(entry, decision, decision); // web 腿胜出——resolve 即竞速裁决值（真消费，非丢弃）
      evictOverflow();
      return { accepted: true };
    },

    /** 行回卷卫生：**未决条目不结算**（见模块头——resolve 会抢答污染在途竞速）；已解针条目自然回收。撤销监听同摘（迟到 abort 对已摘簿 no-op） */
    settleAll(): void {
      for (const entry of entries.values()) {
        // 只清结算针引用（decide/镜像均已不可达——防御位：迟到的 resolver 持有者不再可结算）
        entry.resolver = undefined;
        const detach = entry.detachAbort;
        entry.detachAbort = undefined;
        detach?.();
      }
    },
  };
}

/** 登记簿操作面（app.ts 接线 + server.ts 端点消费） */
export interface PendingApprovals {
  /** session 族镜像入列（asked/decided 两词——幂等） */
  readonly onMirror: (payload: unknown) => void;
  /** claim 面（经 deps.approvals.mountClaim 挂进 answerer 竞速——WebuiApprovalClaim 同形；signal = 撤销面透传，abort 时 'cancel' 结算） */
  readonly claim: (
    approvalId: string,
    detail: WebuiApprovalDetail,
    signal?: AbortSignal,
  ) => Promise<WebuiApprovalDecision | 'cancel'> | undefined;
  /** 未决条目单查（undefined = 无未决条目） */
  readonly pending: (approvalId: string) => WebuiPendingApproval | undefined;
  /** 未决清单（GET /api/approvals） */
  readonly list: () => readonly WebuiPendingApproval[];
  /**
   * 未决数按 ownership 域分桶计数（daemon 刀一·per-ownership 帽数据源：
   * ~10/owner 帽满即时收场——answerer ask 时点消费）。ownerAppId undefined =
   * 宿主桶（根路/无域审批的归宿）；与 list() 同判据（未决条目），豁免
   * MAX_ENTRIES 逐出帽外的已决残留
   */
  readonly pendingCountBy: (ownerAppId: string | undefined) => number;
  /** decide（三态回执判别——404 由调用方译） */
  readonly decide: (
    approvalId: string,
    decision: WebuiApprovalDecision,
  ) => { accepted: true } | { accepted: false; reason: 'superseded' } | undefined;
  /** 行回卷卫生（未决不结算——见实现注） */
  readonly settleAll: () => void;
}
