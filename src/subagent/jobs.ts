/**
 * subagent 模块 — Job 注册表实现（运行时骨架篇 §6.2 落码注记，2026-08-24 纵切一）。
 *
 * Job = 后台任务/一次性后台委派的进程内登记项（地基篇词汇「任务」）：
 * - 状态机 `running →（可选 stopping）→ 唯一终态 completed/killed/failed`，first-wis
 *   结算（首个落定的终态胜出，后续 settle 仅 debug 留痕）；
 * - done promise 永不 reject（executor 侧异常一律转 failed 终态——run 糖内建该适配）；
 * - kind 词汇显式注册（内置 'subagent'/'process' 种子；插件自定义经 registerKind）；
 * - 进程内词汇不持久（会话篇 §5「fork 不继承」）——重启即消，跨会话可见性走结算副作用。
 *
 * 与 context 的关系：注册表经 ctx.provide('jobs') 挂具名服务；自身生命周期挂
 * 作用域 effect——作用域 dispose 触发全量 cancel + 尽力排空（fire-and-forget 兜底，
 * 宿主关停序应在 persistence.close 前显式 await drain()，见 app/assembly.ts）。
 */
import { randomUUID } from 'node:crypto';
import {
  AppError,
  CONTEXT_DISPOSED,
  JOB_CONCURRENCY_LIMIT,
  JOB_KIND_DUPLICATE,
  JOB_KIND_UNKNOWN,
  JOB_NOT_FOUND,
  JOB_OWNER_MISMATCH,
  describeError,
} from '../contracts/errors.js';
import type {
  JobController,
  JobCreateOptions,
  JobHandle,
  JobSettleDetail,
  JobStatus,
  JobTerminal,
  JobView,
  JobsServiceFace,
} from '../contracts/jobs.js';
import type { ContextScope } from '../context/types.js';
import type { Logger } from '../context/logger.js';

/** 注册表内部条目（活状态唯一持有处；对外只经视图 getter 暴露） */
interface JobEntry {
  readonly id: string;
  readonly kind: string;
  readonly label: string | undefined;
  readonly ownerSessionId: string | undefined;
  /** 当前状态（终态后恒定——first-wins 由 settledDetail 是否已填判） */
  status: JobStatus;
  /** 结算明细（undefined = 未结算；填入即冻结，后续 settle 不再生效） */
  settledDetail: Readonly<{ terminal: JobTerminal } & JobSettleDetail> | undefined;
  /** 取消控制器：cancel 请求即 abort，executor 观察 signal 落 killed 或提前收工 */
  readonly controller: AbortController;
  /** 结算 promise 的 resolve 半（只在 first-wins settle 时调一次） */
  readonly doneResolve: (terminal: JobTerminal) => void;
  /** done promise（永不 reject——对外经 handle.done 暴露） */
  readonly done: Promise<JobTerminal>;
}

/** 是否已是终态（first-wins 判据 = settledDetail 已填） */
function isTerminal(status: JobStatus): status is JobTerminal {
  return status === 'completed' || status === 'killed' || status === 'failed';
}

/** 条目 → 只读视图（status/settled 为 getter——视图随条目活状态走，非死快照） */
function viewOf(entry: JobEntry): JobView {
  return {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    ownerSessionId: entry.ownerSessionId,
    get status() {
      return entry.status;
    },
    get settled() {
      return entry.settledDetail;
    },
  };
}

/** 内置 kind 种子（骨架篇 §6.2）：subagent = 子代理委派，process = 外部进程托管 */
const BUILTIN_KINDS: readonly string[] = ['subagent', 'process'];

/**
 * per-owner running 态并发帽（契约篇 §1.6 资源护栏族 #12，2026-08-27 刀〇b）：
 * 帽在 createEntry 单点执法罩住一切 kind（subagent 委派/exec 后台/第三方 kind
 * 同受）；undefined owner = operator 直控面同规共桶（单一规则无特权分支）。
 * 帽限并发不限总量——drain 语义不变（排空后可再造）。常驻 job 是否计帽挂
 * exec 后台刀裁决（kind='process' 词汇已埋未落码）。
 */
const OWNER_CONCURRENCY_LIMIT = 16;

/**
 * 创建 Job 注册表（组合根 provide('jobs') 的那一行所注对象）。
 *
 * @param scope 根作用域——生命周期挂点（dispose 兜底回卷）与 logger 来源
 * @param opts.kindDisposers kind 注销回调表（插件自定义 kind 的注销器；
 *   作用域回卷时逐个调——kind 随注册方插件卸载而消，键 = kind 名）
 */
export function createJobsService(
  scope: ContextScope,
  opts: { kindDisposers?: Map<string, () => void> } = {},
): JobsServiceFace {
  const logger: Logger = scope.logger;
  /** 全量条目表（含已结算——终态条目不删除，仅不可再变；NOT_FOUND 即 id 拼错/未建过） */
  const byId = new Map<string, JobEntry>();
  /**
   * per-owner running 态计数（#12 并发帽的 O(1) 计数面）：键 = ownerSessionId
   * ?? ''（undefined owner = operator 直控面同规共桶）；createEntry 加一、
   * first-wins settle 减一（终态即释放槽位——无 TOCTOU：settle 是唯一写口）。
   */
  const runningByOwner = new Map<string, number>();
  /** 已注册 kind 词汇表（种子内置两枚 + registerKind 增量） */
  const kinds = new Set<string>(BUILTIN_KINDS);
  /** 注册表是否已随作用域回卷（回卷后 create/registerKind 响亮拒绝——stale 护栏同 ctx） */
  let disposed = false;

  /** 活跃断言：作用域回卷后再建 Job/注册 kind = 编程错误（复用 CONTEXT_DISPOSED 码） */
  const assertActive = (): void => {
    if (disposed) {
      throw new AppError(CONTEXT_DISPOSED, 'Job 注册表已随作用域回卷，禁止继续创建/注册');
    }
  };

  /** kind 词汇断言：未注册 kind 创建即响亮拒绝（与事件词汇同纪律，反模式 #4 对偶面） */
  const assertKind = (kind: string): void => {
    if (!kinds.has(kind)) {
      throw new AppError(
        JOB_KIND_UNKNOWN,
        `Job kind 未注册：${kind}（内置 'subagent'/'process'；插件自定义须先 ctx.jobs.registerKind）`,
      );
    }
  };

  /**
   * owner 围栏（骨架篇 §6.2）：带主 Job 从**会话视角**（as.sessionId 已给）访问时，
   * 须与 owner 同 session id，否则 JOB_OWNER_MISMATCH。两个免检通道：
   * - Job 无主（ownerSessionId 缺省 = operator 直控面）；
   * - 调用方未给会话视角（as 缺省 = operator/TUI 面，全可见可杀）。
   */
  const fenceCheck = (entry: JobEntry, as: { sessionId?: string } | undefined): void => {
    if (entry.ownerSessionId === undefined || as?.sessionId === undefined) return;
    if (as.sessionId !== entry.ownerSessionId) {
      throw new AppError(
        JOB_OWNER_MISMATCH,
        `Job ${entry.id} 归属会话 ${entry.ownerSessionId}，会话 ${as.sessionId} 视角无权访问（operator 面请不给 as 直控）`,
      );
    }
  };

  /**
   * 落终态（唯一写口，first-wins）：首调生效——状态置终态 + resolve done +
   * 广播 job_settled；后续调用 no-op 仅 debug 留痕（终态语义归 executor，
   * 注册表不代答——create 面的 settle 与 run 糖的适配都汇到这里）。
   */
  const settleEntry = (entry: JobEntry, terminal: JobTerminal, detail: JobSettleDetail | undefined): void => {
    if (entry.settledDetail !== undefined) {
      logger.debug('Job 已结算，后续 settle 忽略（first-wins）', { id: entry.id, kind: entry.kind, terminal });
      return;
    }
    entry.status = terminal;
    entry.settledDetail = Object.freeze({ terminal, ...(detail ?? {}) });
    entry.doneResolve(terminal);
    // 并发帽槽位释放（#12）：first-wins 唯一写口在此减一（stopping 不减——
    // 取消请求非结算，槽位占用到终态；帽限的是真并发非登记量）
    const ownerKey = entry.ownerSessionId ?? '';
    const remaining = (runningByOwner.get(ownerKey) ?? 0) - 1;
    if (remaining > 0) runningByOwner.set(ownerKey, remaining);
    else runningByOwner.delete(ownerKey);
    logger.debug('Job 结算', { id: entry.id, kind: entry.kind, terminal, ownerSessionId: entry.ownerSessionId });
    // 结算副作用广播（契约篇 §2.2 应用层）：载荷按契约钉死的五段形状，
    // 缺省字段不占位（undefined 键进 JSON 会丢，显式构造保形状干净）
    const payload: Record<string, unknown> = { id: entry.id, kind: entry.kind, terminal };
    if (entry.label !== undefined) payload['label'] = entry.label;
    if (detail?.output !== undefined) payload['output'] = detail.output;
    if (detail?.error !== undefined) payload['error'] = detail.error;
    scope.emit('job_settled', payload);
  };

  /** 请求取消（cancel 的核）：终态幂等 no-op；running→stopping + abort signal。
   * 这是**请求非结算**——终态仍由 executor 经 settle 落（first-wins 保持在 executor 侧） */
  const requestCancel = (entry: JobEntry): void => {
    if (isTerminal(entry.status)) return;
    entry.status = 'stopping';
    entry.controller.abort();
    logger.debug('Job 取消请求（stopping）', { id: entry.id, kind: entry.kind });
  };

  /** 建 Job 条目 + 控制器（run/create 两入口的公共装配段） */
  const createEntry = (opts: JobCreateOptions): JobController => {
    assertActive();
    assertKind(opts.kind);
    // per-owner 并发帽（#12）：createEntry 单点执法罩住 run/create 两入口与一切
    // kind——失控子代理舰队在同一 owner 下即在此拦（16 并发上限，帽限并发
    // 不限总量；结算即释放）。fail-loud 拒绝新条目，存量照跑（drain 不受影响）。
    const ownerKey = opts.ownerSessionId ?? '';
    const running = runningByOwner.get(ownerKey) ?? 0;
    if (running >= OWNER_CONCURRENCY_LIMIT) {
      throw new AppError(
        JOB_CONCURRENCY_LIMIT,
        `owner ${opts.ownerSessionId ?? '(operator 直控面)'} 运行中 Job 已达上限 ${OWNER_CONCURRENCY_LIMIT}` +
          `（帽限并发不限总量：结算即释放槽位；契约篇 §1.6 资源护栏族 #12）`,
      );
    }
    const id = randomUUID();
    let doneResolve!: (terminal: JobTerminal) => void;
    // done 永不 reject：executor 侧异常由 run 糖转 failed 终态，promise 侧只剩 resolve
    const done = new Promise<JobTerminal>((resolve) => {
      doneResolve = resolve;
    });
    const entry: JobEntry = {
      id,
      kind: opts.kind,
      label: opts.label,
      ownerSessionId: opts.ownerSessionId,
      status: 'running',
      settledDetail: undefined,
      controller: new AbortController(),
      doneResolve,
      done,
    };
    byId.set(id, entry);
    runningByOwner.set(ownerKey, running + 1); // 并发帽槽位占用（#12——settle 减一）
    logger.debug('Job 创建', { id, kind: opts.kind, ownerSessionId: opts.ownerSessionId, label: opts.label });
    /** 活句柄：直接处置权（创建方持有，cancel 不走围栏——围栏管的是间接服务面）。
     * 显式带 getter 构造（不可展开 viewOf——spread 会当场求值 getter，句柄状态被冻死） */
    const handle: JobHandle = {
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      ownerSessionId: entry.ownerSessionId,
      get status() {
        return entry.status;
      },
      get settled() {
        return entry.settledDetail;
      },
      get done() {
        return entry.done;
      },
      cancel: () => requestCancel(entry),
    };
    return {
      handle,
      signal: entry.controller.signal,
      settle: (terminal, detail) => settleEntry(entry, terminal, detail),
    };
  };

  /* 生命周期挂点：作用域 dispose → 全量 cancel + 尽力排空。
   * Disposer 是同步面，async drain 无法在此 await——退火为 fire-and-forget 兜底
   * （排空失败仅记日志）；宿主关停序在 persistence.close 前显式 await drain()
   * 是主路径（app/assembly.ts shutdown），此处只兜「宿主忘了/异常路径」。 */
  scope.effect(() => {
    return () => {
      disposed = true;
      void drainAll().catch((err) => {
        logger.error('Job 注册表作用域回卷排空失败（fire-and-forget 兜底路径）', {
          error: err instanceof Error ? err.stack : String(err),
        });
      });
    };
  });

  /** 排空实现：全量（或指定 owner 的）cancel + await 全部结算落定 */
  const drainAll = async (ownerSessionId?: string): Promise<void> => {
    const targets = [...byId.values()].filter(
      (entry) => ownerSessionId === undefined || entry.ownerSessionId === ownerSessionId,
    );
    for (const entry of targets) requestCancel(entry);
    await Promise.all(targets.map((entry) => entry.done));
  };

  /** 服务面（ctx.jobs；骨架篇 §9.2 落码形态） */
  const service: JobsServiceFace = {
    registerKind(kind: string): () => void {
      assertActive();
      if (kinds.has(kind)) {
        throw new AppError(JOB_KIND_DUPLICATE, `Job kind 重复注册：${kind}（内置或已登记 kind 占用，拒绝静默覆盖）`);
      }
      kinds.add(kind);
      const disposer = (): void => {
        // 幂等注销（Map/Set delete 天然幂等）；内置 kind 走不进本分支（重复注册已拒）
        kinds.delete(kind);
        opts.kindDisposers?.delete(kind);
      };
      // 注销器同步登记进调用方传入的表（作用域回卷时由注册表统一收口——见 effect 挂点注释）
      opts.kindDisposers?.set(kind, disposer);
      logger.debug('Job kind 注册', { kind });
      return disposer;
    },

    run(opts: JobCreateOptions, fn: (signal: AbortSignal) => Promise<string | void>): JobHandle {
      const controller = createEntry(opts);
      const { signal } = controller;
      // 糖适配（「done 不 reject」的直译）：resolve→completed（携带 output）/
      // reject→failed（describeError 口径）；signal 已 abort 时一律落 killed
      // （取消意图胜出——cancel 与 fn 结束赛跑，取消先到即 killed）
      void (async () => {
        try {
          const output = await fn(signal);
          controller.settle(signal.aborted ? 'killed' : 'completed', output !== undefined ? { output } : undefined);
        } catch (err) {
          controller.settle(signal.aborted ? 'killed' : 'failed', { error: describeError(err) });
        }
      })();
      return controller.handle;
    },

    create: (opts: JobCreateOptions): JobController => createEntry(opts),

    get: (id: string, as?: { sessionId?: string }): JobView | undefined => {
      const entry = byId.get(id);
      if (entry === undefined) return undefined;
      fenceCheck(entry, as);
      return viewOf(entry);
    },

    list: (opts?: { ownerSessionId?: string }): readonly JobView[] => {
      const owner = opts?.ownerSessionId;
      return [...byId.values()]
        .filter((entry) => owner === undefined || entry.ownerSessionId === owner)
        .map((entry) => viewOf(entry));
    },

    cancel: (id: string, as?: { sessionId?: string }): void => {
      const entry = byId.get(id);
      if (entry === undefined) {
        throw new AppError(JOB_NOT_FOUND, `Job 不存在：${id}（已结算条目不删除——id 拼错或未创建过）`);
      }
      fenceCheck(entry, as);
      requestCancel(entry);
    },

    drain: (ownerSessionId?: string): Promise<void> => drainAll(ownerSessionId),
  };

  return service;
}
