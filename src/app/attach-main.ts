/**
 * L5 app — `berry attach` 主命令（TUI 装配半边，契约篇 §6.8 刀二）。
 *
 * attach 是纯客户端：零 createRuntime/零本地库/零本地装载——本文件只做
 * 「拿 attach-client 的 HTTP/SSE 半边 + createTuiChannel 全栈复用」的接线：
 *   起序 = daemon.json 取 port → token 只读 → 真握手（GET /api/sessions
 *   200）→ 会话选择（cwd 匹配的 active 最新者）→ 历史预拉 → TUI 起屏 →
 *   SSE 接线（display 族聚焦渲染/摘要行、session 族审批驱动、notify/status
 *   直落）→ 等退出。
 *
 * v1 边界（规范钉死）：无斜杠命令面（命令注册表空——/输入原样投递）；无会话
 * 切换 UI（单聚焦）；Ctrl+C = 打断聚焦 run（POST interrupt）、Ctrl+D = 仅退
 * attach（不动 daemon）；cordon 披露 = submit 503 诚实错误行 + health
 * degraded 起屏横幅；审批卡 = confirm 双段式（y/n + 草案在场追问 always），
 * decided 镜像到 → per-ask signal 收场（竞速败腿自动收）。
 */

import { randomUUID } from 'node:crypto';
import { createTuiChannel, createCommandRegistry } from '../channels/index.js';
import type { TuiChannel } from '../channels/index.js';
import { projectedToAgentMessages } from '../chat/index.js';
import type { AgentEvent } from '../agent/events.js';
import type { AgentMessage } from '../contracts/messages.js';
import type { WebuiPendingApproval, WebuiSessionSummary, WebuiSseEnvelope } from '../webui/index.js';
import {
  decideApproval,
  fetchDaemonHealth,
  fetchMessages,
  fetchWorkspaceFiles,
  fetchWorkspaceSymbols,
  interruptSession,
  listApprovals,
  listSessions,
  readAttachToken,
  resolveAttachTarget,
  startAttachStream,
  submitText,
  type AttachStreamHandle,
} from './attach-client.js';
import { daemonTokenPath } from './daemon-state.js';
import { installExitSignals } from './signals.js';
import { appendCrashRecord } from './crash-log.js';
import { dataDir } from './paths.js';
import { VERSION } from './version.js';

/** attach 主选项（--port 覆盖 + 测试注入面） */
export interface AttachMainOptions {
  /** --port 覆盖（压过 daemon.json 记录值——诊断面用法） */
  readonly port?: number;
  /** 数据目录根（缺省 ~/.berry；测试注入） */
  readonly dataRoot?: string;
  /** 会话匹配锚（缺省 process.cwd()；测试注入） */
  readonly cwd?: string;
}

/** 审批应答器依赖面（应答政策单点可测——复盘 #51 提取；三消费点同闭包） */
export interface ApprovalAnswererDeps {
  /** 通道 confirm 面（attach 接 tui.ui().confirm；cancelAsks 收场 = false） */
  confirm(message: string, opts?: { signal?: AbortSignal }): Promise<boolean | undefined>;
  /** 通知行（attach 接 notifyUi——收尾期静音） */
  notify(message: string, level?: 'info' | 'warn' | 'error'): void;
  /** 应答投递（attach 接 decideApproval(port, token, …)） */
  decide(
    approvalId: string,
    decision: 'approve' | 'reject' | 'always',
  ): Promise<{ status: number; accepted?: boolean; reason?: string } | undefined>;
  /** 退出收尾判读（attach 接 quitting 旗——Ctrl+D 后在身卡不投 decide） */
  isQuitting(): boolean;
}

/**
 * 审批卡应答器（pickAttachSession 同款先例：入口文件的可测子件）。
 *
 * 应答政策三条：① y/n → decide approve/reject（草案在场且 y 追问一次 always）；
 * ② decided 镜像先到（他腿已决）→ abort 在身提问、confirm 收场后静默不投；
 * ③ **Ctrl+D 收尾（quitting）→ 在身卡不投 decide**——cancelAsks 把 confirm 收场
 * 为 false 是撤销语义非拒绝语义，投 reject 会让 daemon 侧账本落一条用户从未
 * 做出的决定（复盘 #51 blocker：违背文件头「Ctrl+D = 仅退 attach 不动
 * daemon」边界）；卡留 daemon 侧待决，重连/他腿应答/armed 超时自然收场。
 */
export function createApprovalAnswerer(deps: ApprovalAnswererDeps): {
  /** 审批卡入身（已在身幂等跳过——清单重拉/镜像竞窗） */
  ask(approval: WebuiPendingApproval): void;
  /** decided 镜像收场：摘卡 + abort 在身提问 */
  settle(approvalId: string): void;
  /** approvals 清单 → 增量建卡（已决条目服务端过滤，此处只见未决） */
  sync(approvals: readonly WebuiPendingApproval[]): void;
} {
  /** 在身卡：approvalId → abort 控制器（decided 镜像竞速收场用） */
  const openAsks = new Map<string, AbortController>();

  const ask = (approval: WebuiPendingApproval): void => {
    if (openAsks.has(approval.approvalId)) return; // 已在身（清单重拉/镜像竞窗）
    const controller = new AbortController();
    openAsks.set(approval.approvalId, controller);
    void (async () => {
      const lines = [`审批请求：${approval.summary || '（无摘要）'}`];
      if (approval.reason !== undefined) lines.push(`理由：${approval.reason}`);
      if (approval.ownership?.appId !== undefined) lines.push(`来源应用：${approval.ownership.appId}`);
      const allow = (await deps.confirm(lines.join('\n'), { signal: controller.signal })) ?? false;
      if (controller.signal.aborted) return; // decided 镜像先到（竞速败腿）——静默收场
      // Ctrl+D 收尾守卫（复盘 #51）：cancelAsks 的 confirm false 收场 = 撤销非
      // 拒绝——quitting 后不投 decide，卡留 daemon 侧待决
      if (deps.isQuitting()) return;
      openAsks.delete(approval.approvalId);
      let decision: 'approve' | 'reject' | 'always' = allow ? 'approve' : 'reject';
      if (allow && approval.suggestedEntry !== undefined) {
        // 草案在场且已 approve：追问一次是否始终允许（y = always 落 daemon 侧 allowlist）
        const always = (await deps.confirm(`记住此决定（始终允许 ${approval.suggestedEntry.tool}）？`, {})) ?? false;
        if (always) decision = 'always';
      }
      const res = await deps.decide(approval.approvalId, decision);
      if (res !== undefined && res.status === 200 && res.accepted === false) {
        deps.notify(`审批已被其他应答面抢先处理（${res.reason ?? '已决'}）`);
      } else if (res === undefined || res.status !== 200) {
        deps.notify('应答投递失败（连接失败）——重连后待办卡恢复可重答', 'warn');
      }
    })();
  };

  const settle = (approvalId: string): void => {
    const controller = openAsks.get(approvalId);
    if (controller === undefined) return;
    openAsks.delete(approvalId);
    controller.abort();
  };

  const sync = (approvals: readonly WebuiPendingApproval[]): void => {
    for (const approval of approvals) ask(approval);
  };

  return { ask, settle, sync };
}

/**
 * 会话选择律（契约篇 §6.8 attach 形态）：active 会话中 cwd 匹配 attach 工作
 * 区者优先、无匹配取最新 active（recency = updatedAt ?? createdAt，清单行
 * 直出）。
 * @returns 聚焦目标（无 active 会话 = undefined——调用方走「无活会话」指引）
 */
export function pickAttachSession(
  sessions: readonly WebuiSessionSummary[],
  cwd: string,
): WebuiSessionSummary | undefined {
  const active = sessions.filter((session) => session.active);
  if (active.length === 0) return undefined;
  const recency = (session: WebuiSessionSummary): number => session.updatedAt ?? session.createdAt ?? 0;
  const local = active.filter((session) => session.cwd === cwd);
  const pool = local.length > 0 ? local : active;
  return [...pool].sort((a, b) => recency(b) - recency(a))[0];
}

/**
 * attach 主流程（阻塞至用户退出）。
 * @returns 进程退出码（0 = 正常退出 / 1 = 前置失败〔无 daemon、握手失败、
 *   token 缺失、无活会话〕——错误行 + 指引后即返）
 */
export async function attachMain(options: AttachMainOptions = {}): Promise<number> {
  const dataRoot = options.dataRoot ?? dataDir();
  const cwd = options.cwd ?? process.cwd();
  const err = (text: string): void => {
    process.stderr.write(`${text}\n`);
  };

  /* ---- ① 目标解析 + ② token 只读 + ③ 真握手（三道前置，响亮失败） ---- */
  const target = resolveAttachTarget(dataRoot, options.port);
  if (target === undefined) {
    err('daemon 未运行（无 daemon.json）——先 `berry daemon start`，或 `berry --standalone` 单开进程内形态。');
    return 1;
  }
  const token = readAttachToken(dataRoot);
  if (token === undefined) {
    err(
      `token 文件缺失或为空（${daemonTokenPath(dataRoot)}）——` + '`berry daemon stop` 后 `berry daemon start` 重签发。',
    );
    return 1;
  }
  const handshake = await listSessions(target.port, token);
  if (handshake === undefined || handshake.status !== 200 || handshake.sessions === undefined) {
    // undefined = 连不上（daemon 判死/stale 文件）；401 = token 不符（轮换竞窗）
    const cause =
      handshake === undefined
        ? '连接失败'
        : `HTTP ${handshake.status}${handshake.status === 401 ? '（token 不符）' : ''}`;
    err(
      `与 daemon 真握手失败（127.0.0.1:${target.port}，${cause}）——` +
        '`berry daemon start` 拉起，`berry daemon doctor` 诊断。',
    );
    return 1;
  }

  /* ---- ④ 会话选择（cwd 匹配的 active 最新者；无匹配最新 active） ---- */
  const focus = pickAttachSession(handshake.sessions, cwd);
  if (focus === undefined) {
    err('daemon 无活会话可聚焦——在 daemon 侧开新会话（Web/submit）后重试 attach。');
    return 1;
  }
  const focusId = focus.id;
  const port = target.port;

  /* ---- ⑤ health 起屏横幅数据源（degraded = cordon 披露） ---- */
  const health = await fetchDaemonHealth(port);

  /* ---- 共享状态（TUI 闭包数据源——SSE/重拉两路写点） ---- */
  /** 历史缓存（history 闭包数据源——远程预拉/重拉整代换，repaint 重画读缓存） */
  let historyCache: readonly AgentMessage[] = [];
  /** 条目运行态（display agent_start/end 驱动——状态行/占位槽判据） */
  const runningBySession = new Map<string, boolean>();
  /** 会话 accent 表（清单拉取刷新——themeFor 数据源） */
  const accentBySession = new Map<string, string | undefined>();
  /** 退出旗（收尾期静音断线/迟到通知） */
  let quitting = false;

  /** 退出请求（多路汇流：Ctrl+D / requestQuit / SIGTERM / token 失效） */
  let quitResolve!: () => void;
  const quitPromise = new Promise<void>((resolve) => {
    quitResolve = resolve;
  });

  /* ---- TUI 通道（全栈复用；命令注册表空 = v1 无斜杠命令面） ---- */
  const tui: TuiChannel = createTuiChannel({
    host: {
      submit(text: string): void {
        // 投递即忘：应答经 SSE display 族回流；requestId 生成在客户端
        //（重试语义归服务端 LRU 去重——协议正确性层刀一件④）
        const requestId = randomUUID();
        void submitText(port, token, focusId, text, requestId).then((res): void => {
          if (quitting) return;
          if (res === undefined) {
            tui.ui().notify(`投递失败：无法连接 daemon（127.0.0.1:${port}）`, { level: 'warn' });
          } else if (res.status === 503) {
            // cordon 披露（spec 钉死形态）：503 诚实错误行
            tui.ui().notify('daemon 降级（cordon）拒收 submit——写面保护中，稍后再试', { level: 'warn' });
          } else if (res.status === 404) {
            tui.ui().notify('目标会话已关闭（404）——重开 attach 换聚焦', { level: 'warn' });
          } else if (res.deduplicated === true) {
            tui.ui().notify('重复投递已忽略（requestId 去重）');
          }
        });
      },
      requestQuit(): void {
        quitResolve(); // 仅退 attach——daemon 与在飞 run 不动（spec v1 边界）
      },
      interrupt(): void {
        void interruptSession(port, token, focusId).then((res) => {
          if (!quitting && res !== undefined && res.status !== 200) {
            tui.ui().notify('无在飞 run 可打断');
          }
        });
      },
    },
    commands: createCommandRegistry(),
    title: `Berry attach ${VERSION}`,
    // 单聚焦形态文案：Ctrl+C 打断聚焦 run、Ctrl+D 退 attach（不退 daemon）
    quitHint: 'Ctrl+C 打断 / Ctrl+D 退出 attach',
    workspace: cwd,
    // 刀二 filesFor 注入键：@ 文件段远程路由（真源在 daemon 工作区——不吃
    // attach 本地 cwd 漂移）；face undefined = 无弹层（不回本地 fd 发现序）
    filesFor: (prefix) => fetchWorkspaceFiles(port, token, prefix),
    symbolsFor: (path) => fetchWorkspaceSymbols(port, token, path),
    // 缓存闭包（通道 start/repaint 同步拉——远程预拉后整代换缓存）
    history: () => historyCache,
    entryStatus: (sessionId) => (runningBySession.get(sessionId) === true ? 'running' : 'idle'),
    themeFor: (sessionId) => accentBySession.get(sessionId ?? focusId),
  });

  /** 通知行便捷面（收尾期静音） */
  const notifyUi = (message: string, level?: 'info' | 'warn' | 'error'): void => {
    if (quitting) return;
    tui.ui().notify(message, level === undefined ? undefined : { level });
  };

  /* ---- 审批卡（应答器政策单点——createApprovalAnswerer；decided 镜像 → per-ask signal 收场） ---- */
  const answerer = createApprovalAnswerer({
    confirm: (message, opts) => tui.ui().confirm?.(message, opts) ?? Promise.resolve(undefined),
    notify: notifyUi,
    decide: (approvalId, decision) => decideApproval(port, token, approvalId, decision),
    isQuitting: () => quitting,
  });
  /** decided 镜像收场（应答器转发） */
  const settleApproval = answerer.settle;
  /** approvals 清单 → 增量建卡（应答器转发） */
  const syncApprovals = answerer.sync;

  /* ---- 重拉三发（连接即拉 + 重连恒重拉：投影 + 会话清单 + approvals） ---- */
  const repull = async (): Promise<void> => {
    const [messagesRes, sessionsRes, approvalsRes] = await Promise.all([
      fetchMessages(port, token, focusId),
      listSessions(port, token),
      listApprovals(port, token),
    ]);
    if (messagesRes !== undefined && messagesRes.status === 200 && messagesRes.messages !== undefined) {
      historyCache = projectedToAgentMessages(messagesRes.messages as Parameters<typeof projectedToAgentMessages>[0]);
      tui.repaint(focusId); // 清屏重画（repaint 经 history 闭包读缓存）
    }
    if (sessionsRes !== undefined && sessionsRes.status === 200 && sessionsRes.sessions !== undefined) {
      for (const session of sessionsRes.sessions) accentBySession.set(session.id, session.accent);
    }
    if (approvalsRes !== undefined && approvalsRes.status === 200 && approvalsRes.approvals !== undefined) {
      syncApprovals(approvalsRes.approvals);
    }
  };

  /* ---- SSE 信封四族分派 ---- */
  const onEnvelope = (envelope: WebuiSseEnvelope): void => {
    switch (envelope.kind) {
      case 'display': {
        const event = envelope.payload as AgentEvent;
        // 运行态追踪（agent_start/end——状态行/占位槽数据源）
        if (event.type === 'agent_start') runningBySession.set(envelope.sessionId!, true);
        else if (event.type === 'agent_end') runningBySession.set(envelope.sessionId!, false);
        // 聚焦者全渲染、其余摘要行（S3 信封分流同律——attach 侧壳）
        if (envelope.sessionId === focusId) tui.handle(event);
        else tui.handleActivity(envelope.sessionId!, event);
        break;
      }
      case 'session': {
        // session 镜像族 = 审批驱动（投影重拉只发生在连接/重连——增量渲染由
        // display 族承担，repaint 与流式渲染互不打架）
        const bus = envelope.payload as { event?: { type?: unknown; data?: { approvalId?: unknown } } } | undefined;
        const event = bus?.event;
        if (event === undefined || typeof event.type !== 'string') return;
        if (event.type === 'approval/asked') {
          // asked 载荷瘦（approvalId+summary）——富字段（草案/归属）走清单重拉
          void listApprovals(port, token).then((res) => {
            if (res !== undefined && res.status === 200 && res.approvals !== undefined) syncApprovals(res.approvals);
          });
        } else if (event.type === 'approval/decided' && typeof event.data?.approvalId === 'string') {
          settleApproval(event.data.approvalId);
        }
        break;
      }
      case 'notify': {
        const payload = envelope.payload as { message?: unknown; level?: unknown } | undefined;
        if (typeof payload?.message === 'string') {
          const level = payload.level === 'warn' || payload.level === 'error' ? payload.level : undefined;
          notifyUi(payload.message, level);
        }
        break;
      }
      case 'status': {
        const payload = envelope.payload as { status?: unknown } | undefined;
        if (typeof payload?.status === 'string') tui.ui().setStatus(payload.status);
        break;
      }
    }
  };

  /* ---- SSE 流（指数退避重连 + 重连恒重拉） ---- */
  let connectedOnce = false;
  const stream: AttachStreamHandle = startAttachStream({
    port,
    token,
    onEnvelope,
    onConnected: () => {
      if (connectedOnce) notifyUi('已重连——重拉投影与待办');
      connectedOnce = true;
      void repull();
    },
    onDisconnected: () => {
      if (connectedOnce && !quitting) notifyUi('与 daemon 断线——重连中……', 'warn');
    },
    onAuthFailure: () => {
      notifyUi('token 不符（401）——daemon 重签发后重试（berry daemon stop → start）', 'error');
      quitResolve();
    },
  });

  /* ---- 信号编舞（attach 分档：SIGINT = 打断聚焦 run〔不退〕、terminate = 退 attach） ---- */
  const signals = installExitSignals({
    onGracefulQuit: (kind) => {
      if (kind === 'interrupt') {
        // 分档同单驱动 TUI：打断在飞 run、不退 attach——请求随打断应答了结
        void interruptSession(port, token, focusId)
          .catch(() => undefined)
          .then(() => signals.acknowledgeQuitRequest());
      } else {
        quitResolve(); // SIGTERM/SIGHUP：退 attach（143/129 记账由 signals.exitCode）
      }
    },
    onFatal: (error, kind) => {
      // 纯客户端无本地 durable 面——无需 flush；但崩溃证据仍落 crash.log（基建大扫
      // #52：终端关即蒸发的 stderr 不是可清算的证据——attach 崩溃同样有盘上第一手）
      appendCrashRecord({ kind, entry: 'attach', error });
    },
  });

  /* ---- 起屏（横幅两行 + 历史预拉已在流首连路上） ---- */
  tui
    .ui()
    .notify(
      `已接上 daemon（127.0.0.1:${port}）——聚焦会话 ${focusId}` +
        (focus.cwd === cwd ? '' : '（本工作区无匹配，取最新活会话）') +
        '；Ctrl+D 退出 attach。',
    );
  if (health?.degraded !== undefined) {
    notifyUi(`daemon 降级中（${health.degraded}）——写面保护，submit 可能被拒收`, 'warn');
  }
  tui.start();
  try {
    await quitPromise;
  } finally {
    // 收尾：停流 → 收场在身提问 → 卸信号 → 停屏（序同 tuiMain 律，无库可关）
    quitting = true;
    stream.close();
    tui.cancelAsks();
    signals.dispose();
    tui.stop();
  }
  // SIGINT 首次优雅完成 = 0；SIGTERM/SIGHUP 采纳记账码（143/129）
  return signals.exitCode;
}
