/**
 * L5 app — `berry` 主命令（TUI 对话，产品主入口）。
 *
 * 组合根装配 → TUI 通道起屏（历史投影渲染 + 输入接管）→ 事件流接线（front
 * 转接表 → 聚焦驱动）→ 等退出请求（Ctrl+D / /quit）→ 优雅退出序列
 * （骨架篇 §1.3：abort → run 结算 → 停屏 → flush → 关库 → ctx 回卷）。
 *
 * S1 前台宿主 façade：TUI 恒接 runtime.front（chat 件构造产物，无驱动时
 * no-op 形）——submit/requestQuit/addDisplay/settle 四路全经它路由，本文件
 * 不再持有驱动引用。可卸语义（应用面第一纵切）：chat 对话应用件被 overlay
 * 禁用时注册表空——**壳照启**：命令面/应用管理/审批完好，输入静默 + 提示行
 * 示明无对话循环（对话是应用不是内核，命题 §3.5）。
 */

import { createTuiChannel } from '../channels/tui.js';
import { projectedToAgentMessages } from '../chat/index.js';
import { createRuntime } from './assembly.js';
import type { RuntimeOptions } from './assembly.js';
import type { PathsService } from './composition.js';
import { installExitSignals } from './signals.js';
import { isDaemonAlive, readDaemonState } from './daemon-state.js';
import { VERSION_WITH_CODENAME as VERSION } from './version.js';
import { existsSync } from 'node:fs';
import { dbPath } from './paths.js';

/**
 * 判活 daemon 是否持有**本工作区**近史会话（daemon 刀二·P3 触达面②判据）。
 *
 * tui 起屏横幅分流用：boot 续接撞 heldElsewhere 拒开落到无聚焦态时，先判
 * 本函数再报「未装载」——两因指引完全不同（held 给 attach/submit 改道指引，
 * 未装载才是装配问题）。判据 = daemon.json 判活 + recentSessions 近史行 cwd
 * 匹配本工作区且 id ∈ heldSessions（域过滤差异不追——横幅是 UX 指引非会话
 * 仲裁；近史 50 覆盖持有面：daemon 持有的必是活账，活账必在近史头部）。
 * 导出仅为单测（进程内判据纯函数——读盘与判活在内）。
 */
export function daemonHoldsWorkspaceSession(
  workspaceRoot: string | undefined,
  recentRows: readonly { readonly cwd: string | null; readonly id: string }[],
): boolean {
  if (workspaceRoot === undefined) return false;
  const state = readDaemonState();
  if (state === undefined || !isDaemonAlive(state)) return false;
  return recentRows.some((row) => row.cwd === workspaceRoot && state.heldSessions.includes(row.id));
}

/**
 * TUI 主流程（阻塞至用户退出）。
 * @param options 组合根选项透传（测试注入 streamFn/dbPath 用）
 * @returns 进程退出码（正常退出恒 0——用户离开不是错误）
 */
export async function tuiMain(options: RuntimeOptions = {}): Promise<number> {
  // 首启判定（技术栈篇 §8.5 第 4 件，第五十一批）：boot 前库文件不存在
  //（options.dbPath 注入 / APP_DB_PATH / APP_DATA_DIR 覆盖全感知；:memory:
  // 恒非首启）——boot 后欢迎块用。不阻塞首启即用（第六批一句话判据不破）
  const effectiveDbPath = options.dbPath ?? dbPath();
  const firstBoot = effectiveDbPath !== ':memory:' && !existsSync(effectiveDbPath);
  // 数据目录建档已收编 createRuntime ③（三入口共用单点）——此处不再早调
  const runtime = await createRuntime({
    ...options,
    interactive: true,
    // 进程形态（刀三）：goal 件 boot 降级判据——TUI 是交互入口照常降级
    processKind: 'tui',
    // TUI 启动策略（技术栈篇 §5 拍板）：缺省续接本工作区最新会话
    resumeSession: options.resumeSession ?? true,
  });
  // 前台宿主（S1）：恒在——submit/addDisplay/settle 按前台聚焦路由，后续 open
  // 的新驱动自动接管输入与展示（/new 换新 TUI 零重接）；quit 聚合 promise
  // 无驱动时由 requestQuit 直接 resolve（壳照启可退）
  const front = runtime.front;

  // TUI 通道（历史投影经注入回调拉取——通道不依赖 session；无会话时空历史）。
  // runtime.session 是活取值（/new 热切换后指向新会话），不能解构快照
  const tui = createTuiChannel({
    host: front,
    commands: runtime.channels.commands,
    rendererFor: (role) => runtime.channels.rendererFor(role),
    // 渲染器异常诊断（隔离案一第一刀 #1）：坏渲染器回落内置形态 + 根 logger 留痕
    // （含角色归因与栈）——事件流与历史渲染两路径的进程退出级穿透（P15/P16）由此闭合
    onRendererError: (err, role) =>
      runtime.ctx.logger.error(`渲染器异常已隔离（角色 ${role}，已回落内置形态）`, {
        error: err instanceof Error ? err.stack : String(err),
      }),
    title: `Berry ${VERSION}`,
    // M4 补全接线（2026-08-27 第三十三批）：工作区根传通道武装 autocomplete（命令
    // 名/参数/@ 文件三合一补全）；canonical 根自 ctx.paths 取（通道不读 env 猜
    // cwd）。persist:false 等无 paths 服务面 = 不武装（补全是辅助面非硬依赖）
    workspace: runtime.ctx.tryGet<PathsService>('paths')?.workspaceRoot(),
    // 刀 B @-mention 符号段（channels 批）：documentSymbol face 活取值闭包恒
    // 接入——lsp 行 apply 期挂真身、回卷摘除（runtime.symbolsFor 读晚绑
    // holder，缺席 = undefined → 补全退化为委托腿，保 /reload 活语义——
    // 不按 lsp 装载时点分支接线）
    symbolsFor: (path) => runtime.symbolsFor(path),
    // S6 形态⑦提示行两态：起屏时点已有多会话条目（resume 多开）= 多驱动文案
    // （运行中 /app new 后不重绘——提示行是辅助面，分档语义恒由 front.interrupt 承载）
    quitHint:
      [...runtime.drivers.entries.values()].filter((e) => !e.retired).length >= 2
        ? 'Ctrl+C 打断 / Ctrl+D·/quit 退出'
        : undefined,
    // S3 按会话键取历史：undefined = 当前聚焦（起屏路——boot 路 focus 通知早于
    // 订阅，初始渲染由 start 走此语义）；repaint 重画显式带键
    history: (sessionId) => {
      const id = sessionId ?? front.focus.sessionId;
      const entry = id === undefined ? undefined : runtime.drivers.entries.get(id);
      return projectedToAgentMessages(entry?.session.deriveMessages() ?? []);
    },
    // S3 条目运行态（切入在飞会话的占位槽/状态行判据；退役条目 isRunning 恒 false → idle）
    entryStatus: (sessionId) => {
      const entry = runtime.drivers.entries.get(sessionId);
      return entry === undefined ? undefined : entry.driver.isRunning ? 'running' : 'idle';
    },
    // D4 theme 渲染轻件（契约篇 §5.4 theme 条款）：会话键 → 该应用 accent 字面量。
    // 读源权威 = 条目 appId 活视图（与 sessions app 列构造同源——存量 NULL 会话
    // 按投影入 chat 域，两源分歧以条目为准）→ 清单注册表（boot 静态，/reload 不
    // 重算）；无清单命中 / 无 accent → undefined = 零色合法缺省。undefined 入参 =
    // 当前聚焦（起屏路——与 history 同款可选参形态）
    themeFor: (sessionId) => {
      const id = sessionId ?? front.focus.sessionId;
      const entry = id === undefined ? undefined : runtime.drivers.entries.get(id);
      return entry === undefined ? undefined : runtime.apps.get(entry.appId)?.theme?.accent;
    },
  });
  runtime.ui.attach(tui.ui());
  // 首启欢迎（§8.5 第 4 件）：活体层 notify 不落库——只在第一次出现，非首启
  // 零噪音；内容骨架与 /guide 同源（命令/文档/配置指路三件）
  if (firstBoot) {
    runtime.ui.notify(
      `欢迎使用 Berry ${VERSION}——跑 AI 应用的操作系统。\n` +
        '· 首启即用：直接说需求即可（默认进入 coder 代码智能体应用；/app chat 换纯对话）\n' +
        '· /help 看全部命令 · /guide 快速上手参考\n' +
        '· 模型配置：APP_MODEL 环境变量覆盖缺省模型；凭证与数据目录见 docs/使用指南',
    );
  }
  // S3 信封分流（宿主壳 = 信封拆开点，channels 不见信封概念）：聚焦者走全渲染、
  // 非聚焦者（后台活条目 + 退役条目迟到事件）走摘要行——互不绞屏的执法接线
  front.addDisplay((envelope) => {
    if (envelope.sessionId === front.focus.sessionId) {
      tui.handle(envelope.event);
    } else {
      tui.handleActivity(envelope.sessionId, envelope.event);
    }
  });
  // S3 focus 变化重画（三写点通知：open 新开 / open 幂等命中 / switchTo——同值
  // 零通知）：清屏 + 目标会话历史重画 + 在飞占位槽按 entryStatus 续流
  const disposeFocusSubscription = runtime.drivers.onFocusChange((sessionId) => tui.repaint(sessionId));
  // 可卸提示：无对话循环时示明现状（命令面仍可用——/apps 可查、/reload 可试）；
  // 三因分流（daemon 刀二·P3 触达面②新增第一因）：resume 撞 daemon 持有 /
  // chat 件被禁 / 默认应用解析无果（组装批兜底态——open 防御降级）
  if (runtime.conversation === undefined) {
    // 先判 held：活 daemon 持有本工作区会话 → boot 续接被 heldElsewhere 拒开
    // 落到无聚焦态（判据函数见 daemonHoldsWorkspaceSession 注释）
    const workspaceRoot = runtime.ctx.tryGet<PathsService>('paths')?.workspaceRoot();
    const heldHere = daemonHoldsWorkspaceSession(workspaceRoot, runtime.persistence?.store.recentSessions(50) ?? []);
    if (heldHere) {
      // P3 触达面②（契约篇 §6.8）：横幅 + 指引 + 落新会话继续（不拒启——进程
      // 内 TUI 仍可用，只是原会话改道）；指引与触达面①（run --tick）同款
      runtime.ui.notify(
        '最新会话正被 daemon 持有（heldSessions 租约）——本进程拒开防双写者，已另开新会话继续。' +
          '接上原会话：`berry attach`，或经 `POST /api/sessions/:id/submit` 投递。',
        { level: 'warn' },
      );
      const opened = runtime.newSession();
      if (opened === undefined) {
        // 落新会话也失败（chat 件未装载/persist:false）——退回可卸提示真相
        runtime.ui.notify(
          '对话应用未装载或默认应用不可用（builtin:chat 被禁用 / 默认应用组件缺场 / persist:false）——输入不会得到应答；dump-config 查看装配，/quit 退出。',
        );
      }
    } else {
      runtime.ui.notify(
        '对话应用未装载或默认应用不可用（builtin:chat 被禁用 / 默认应用组件缺场 / persist:false）——输入不会得到应答；dump-config 查看装配，/quit 退出。',
      );
    }
  }

  // 信号编舞（骨架篇 §1.3 全表 + S6 形态④信号分种类）：SIGINT 首次经
  // front.interrupt 分档（多驱动 = 打断聚焦 run 不退 OS、单驱动 = requestQuit
  // 全序列）/ 二次 130 / SIGTERM·SIGHUP 恒 requestQuit（143/129 记账不变）/
  // uncaught/unhandled 不吞 exit(1)——两入口共用
  const signals = installExitSignals({
    onGracefulQuit: (kind) => {
      if (kind === 'interrupt') {
        // S6 形态⑥：interrupt 请求随被打断 run 结算而了结——了结时清急停旗标
        // （run 未结算窗口内二次 SIGINT 才 130 硬退）；terminate 路自带退出序列
        void front
          .interrupt()
          .catch(() => undefined)
          .then(() => signals.acknowledgeQuitRequest());
      } else {
        front.requestQuit();
      }
    },
    onFatal: async (error, kind) => {
      runtime.ctx.logger.error(`致命异常（${kind}），尽力落盘后退出`, {
        kind,
        error: error instanceof Error ? error.stack : String(error),
      });
      await runtime.persistence?.flush().catch(() => undefined);
    },
  });

  tui.start();
  try {
    // 等待退出请求（Ctrl+D / Ctrl+C / /quit / 信号——多路同汇 front.requestQuit；
    // S3 退出扇出：requestQuit 已 abort 全部活驱动，settle 等各 run 收尾即回）
    await front.quit;
    // interrupt 小刀退出兜底：quit 后 settle 前——收场无 run 属主的 ask（服务
    // 路）与任何漏网（run 属主 ask 已经 per-ask signal 撤销收场），防 settle
    // 等 runPromise 挂死致 flush 不达（write-behind 缓冲丢失）
    tui.cancelAsks();
    await front.settle();
  } finally {
    signals.dispose();
    disposeFocusSubscription(); // S3 focus 订阅注销（壳生命周期，非应用锚）
    tui.stop();
    await runtime.shutdown();
  }
  // SIGINT 首次优雅完成 = 0（用户中断不是错误）；SIGTERM/SIGHUP 采纳记账码
  return signals.exitCode;
}
