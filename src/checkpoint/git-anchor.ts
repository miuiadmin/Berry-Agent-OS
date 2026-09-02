/**
 * L3 checkpoint — git/range 交付链 Output 锚（会话篇 §5.3 git 锚条款，
 * 2026-09-01 第六十一批；[两篇读码](../../设计文档/04-试验/交付链与生命周期两篇读码-2026-09.md) G-1）。
 *
 * 交付链三段 Intent·Process·Output 的 Commit 端：首变更工具执行前探测
 * head+dirty（与快照捕获同锚点——凡能 commit 的工具必过 effect!=='read' 门，
 * pre-mutation await 语义防「bash 首刀即 commit」竞态），RunSettled 复探，
 * 头动或 dirty 变化才落 `git/range` durable 事件（无产出不记）。
 *
 * 纯编排件：git 探测闭包组合根注入（browser spawn 闭包同款——本模块不见
 * child_process）；键 = 路由会话（git 是工作区全局事实，子代理提交天然并入
 * 父 run 区间——交付单元 = 驱动 run）。
 */

/** 单时点 git 状态（head 短哈希 + 脏文件计数） */
export interface GitProbeState {
  readonly head: string;
  readonly dirtyCount: number;
}

/** 区间增量（before..after 的 commit 数 + 变更文件清单——files 调用侧截帽） */
export interface GitProbeDelta {
  readonly commits: number;
  readonly files: readonly string[];
}

/**
 * git 探测面（组合根注入；undefined 结果 = 非 git 仓 / 无 git 可执行——
 * 诚实缺席，调用侧静默 no-op）。方法均为只读探测。
 */
export interface GitProbeFace {
  state(cwd: string): Promise<GitProbeState | undefined>;
  delta(cwd: string, before: string, after: string): Promise<GitProbeDelta | undefined>;
}

/** 件内路由键与落账面（ctx.faces 窄化——不 import app/chat 实现） */
export interface GitAnchorDeps {
  /** 路由会话 id（routed() 语义——交付单元键） */
  readonly routedSessionId: () => string | undefined;
  /** durable 落账（appendEvent 路由纪律由调用侧 ctx.sessions 承担） */
  readonly appendEvent: (type: string, data: unknown) => unknown;
  /** canonical 工作区根（探测 cwd——禁 env 猜） */
  readonly workspaceRoot: () => string | undefined;
  /** git 探测闭包（缺省 undefined = 无 git 观察面——整锚静默 no-op） */
  readonly probe: GitProbeFace | undefined;
  /** 诊断日志（warn/debug——探测失败不静默吞） */
  readonly logger: Pick<import('../contracts/app.js').AppLogger, 'debug' | 'warn'>;
}

/** 会话键的锚状态：首探测产物，或 'no-git'（本会话免后续探测） */
type AnchorState = { readonly before: GitProbeState } | { readonly noGit: true };

/** files 清单截帽（64KiB 纪律——与 source_refs 50 帽同族） */
const FILES_CAP = 50;

/**
 * 构造 git/range 追踪器。生命周期与快照旗同拍：onFirstMutation（首变更工具
 * 前，await 语义）→ onRunSettled（驱动 run 结算，fire-and-forget）。
 */
export function createGitAnchorTracker(deps: GitAnchorDeps): {
  /** 首变更工具前探测（await——headBefore 必须先于工具执行落定） */
  onFirstMutation(): Promise<void>;
  /** run 结算复探 + 落账（fire-and-forget——不阻结算链） */
  onRunSettled(sessionId: string): void;
} {
  /** 路由会话 → 锚状态（run 级去重——同 run 多身份/多工具只探测一次） */
  const anchors = new Map<string, AnchorState>();

  const onFirstMutation = async (): Promise<void> => {
    const sessionId = deps.routedSessionId();
    if (sessionId === undefined) return; // 无路由落点（非注册表语境）——无交付单元可记账
    if (anchors.has(sessionId)) return; // 本 run 已探测（去重）
    if (deps.probe === undefined) {
      anchors.set(sessionId, { noGit: true }); // 装配无 git 观察面——本 run 免议
      return;
    }
    const root = deps.workspaceRoot();
    if (root === undefined) {
      anchors.set(sessionId, { noGit: true });
      return;
    }
    try {
      const before = await deps.probe.state(root);
      if (before === undefined) {
        anchors.set(sessionId, { noGit: true }); // 非 git 仓 / git 缺席——诚实缺席
        deps.logger.debug('git 锚：工作区非 git 仓或 git 不可用（本 run 免锚）');
        return;
      }
      anchors.set(sessionId, { before });
    } catch (err) {
      // 探测异常 = 免锚不阻工具（安全网纪律同款——锚是观察面不是策略）
      anchors.set(sessionId, { noGit: true });
      deps.logger.warn('git 锚首探测异常（免锚照常）', { error: String(err) });
    }
  };

  const onRunSettled = (sessionId: string): void => {
    const anchor = anchors.get(sessionId);
    anchors.delete(sessionId); // 结算即消费（无论落账与否——run 级生命周期）
    if (anchor === undefined || 'noGit' in anchor) return;
    // routed 匹配门（§5.3 v1 诚实边界）：appendEvent 无目标会话参数是 S1 刻意
    // 形态——后台会话结算时路由可能指向前台，错账防护宁缺毋错投
    if (deps.routedSessionId() !== sessionId) {
      deps.logger.debug('git 锚：结算会话与路由会话不一致（后台结算，锚缺席——宁缺毋错投）', {
        settled: sessionId,
      });
      return;
    }
    const probe = deps.probe;
    const root = deps.workspaceRoot();
    if (probe === undefined || root === undefined) return; // 防御（首探测过则必在）
    const { before } = anchor;
    void (async () => {
      try {
        const after = await probe.state(root);
        if (after === undefined) return; // 仓中途消失（.git 被删）——免落
        const headMoved = after.head !== before.head;
        const dirtyMoved = after.dirtyCount !== before.dirtyCount;
        if (!headMoved && !dirtyMoved) return; // 无产出不记（§5.3）
        let delta: GitProbeDelta | undefined;
        if (headMoved) {
          delta = await probe.delta(root, before.head, after.head);
        }
        deps.appendEvent('git/range', {
          before: before.head,
          after: after.head,
          commits: delta?.commits ?? 0,
          files: (delta?.files ?? []).slice(0, FILES_CAP),
          dirtyBefore: before.dirtyCount,
          dirtyAfter: after.dirtyCount,
        });
        deps.logger.debug('git 锚落账', {
          sessionId,
          before: before.head,
          after: after.head,
          commits: delta?.commits ?? 0,
        });
      } catch (err) {
        deps.logger.warn('git 锚结算复探异常（免落账）', { error: String(err) });
      }
    })();
  };

  return { onFirstMutation, onRunSettled };
}
