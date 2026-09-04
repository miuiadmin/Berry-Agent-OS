/**
 * L5 app — `berry` 无参主入口（桌面首启形态，第八十五批批 C；tui-main 的
 * 桌面版宿主壳——骨架篇 boot 序 + 契约篇 §6.11 换防编舞的宿主侧单源）。
 *
 * boot 序（骨架篇）：无参 → 熔断判据先行 → 未熔断起桌面（失败计数，两连崩
 * 熔断）→ 熔断/`--no-desktop` 回锁内核最小 shell（零引擎依赖兜底面）。
 *
 * 双栈换防（契约 §6.11）：单进程两渲染栈——桌面引擎（备屏 1049）/ pi-tui
 * （主屏）。桌面→应用：引擎 suspend 三件套 → pi-tui 起屏；应用→桌面：
 * pi-tui `stop({preserveScreen:true})` → 引擎 resume 全量首帧。Esc 回桌面经
 * 通道 escapeHook 路由（桌面态走桌面服务 face；内核 shell 态走内核收场）。
 *
 * 应用视图的通道接线（banners/信封分流/focus 重画/信号编舞）与 tui-main 同
 * 源——首次进应用时惰性装配（桌面态下 pi-tui 不在场，横幅随首屏补发）。
 */

import { createTuiChannel, type TuiChannel, type TuiChannelOptions } from '../channels/tui.js';
import { projectedToAgentMessages } from '../chat/index.js';
import { createRuntime } from './assembly.js';
import type { RuntimeOptions } from './assembly.js';
import type { PathsService } from './composition.js';
import { installExitSignals } from './signals.js';
import { appendCrashRecord } from './crash-log.js';
import { VERSION_WITH_CODENAME as VERSION } from './version.js';
import { dataDir } from './paths.js';
import { QUICK_START_ENTRY } from './guide-text.js';
import {
  createDesktopShell,
  type DesktopShell,
  type DesktopAdminFace,
  type DesktopSessionEntry,
  type DesktopSessionsFace,
} from './desktop-shell.js';
import type { DesktopAppEntry, DesktopService, DesktopStatusService } from './desktop-service.js';
import type { AssistantService } from './assistant-app.js';
import { STORE_APP_ID, type StoreService } from './store-app.js';
import { deriveMessages } from '../session/index.js';
import { createDesktopStatusAggregator, type DesktopCredentialIssue } from './desktop-status.js';
import { runPowerAction, POWER_KILL_FAMILY_TEXT, type PowerResult } from './host-power.js';
import { formatReloadResult, formatUninstallExec, formatUninstallReport } from './commands.js';
import { describeProviderFailure } from '../llm/index.js';
import type { JobsServiceFace } from '../contracts/jobs.js';
import { runKernelShell } from './kernel-shell.js';
import {
  DESKTOP_BOOT_FAILURES_FILE,
  clearBootFailures,
  isBootBreakerTripped,
  readBootFailures,
  recordBootFailure,
} from './desktop-boot.js';
import { resolveDefaultApp } from './app-registry.js';
import { daemonHoldsWorkspaceSession, isFirstBoot } from './tui-main.js';
import type { TerminalIO } from '../desktop/index.js';
import type { Readable, Writable } from 'node:stream';

/** 桌面主入口选项（RuntimeOptions + 桌面形态面） */
export interface DesktopMainOptions extends RuntimeOptions {
  /** --no-desktop：跳过桌面直进内核最小 shell（显式兜底入口；--no-apps 正交） */
  readonly noDesktop?: boolean;
  /** 桌面引擎终端 IO 注入（组合根全栈测试缝——mock 停在终端边界） */
  readonly desktopIo?: TerminalIO;
  /** pi-tui 终端注入（同上——两栈各自注入面；类型经通道选项面引渡不裸导 pi-tui） */
  readonly tuiTerminal?: TuiChannelOptions['terminal'];
  /** 内核 shell 行读 stdio 注入（同上——缺省 process stdio；测试不抢真 stdin） */
  readonly kernelInput?: Readable;
  readonly kernelOutput?: Writable;
}

/**
 * 桌面主流程（阻塞至用户退出）。
 * @param options 组合根选项透传 + 桌面形态面
 * @returns 进程退出码（正常退出恒 0——用户离开不是错误）
 */
export async function desktopMain(options: DesktopMainOptions = {}): Promise<number> {
  const { noDesktop, desktopIo, tuiTerminal, kernelInput, kernelOutput, ...runtimeOptions } = options;
  // 首启判定（与 tui-main 同源）：boot 前库文件不存在——首屏欢迎块用
  const firstBoot = isFirstBoot(runtimeOptions.dbPath);
  const runtime = await createRuntime({
    ...runtimeOptions,
    interactive: true,
    processKind: 'tui',
    resumeSession: runtimeOptions.resumeSession ?? true,
  });
  const front = runtime.front;

  /* ---------------- 换防状态（宿主壳单源持有的两栈簿记） ---------------- */
  /** 桌面壳（undefined = 未起/已终退/熔断回锁） */
  let shell: DesktopShell | undefined;
  /** 桌面在屏（含挂起在应用视图——引擎挂起但桌面仍是「当前形态」；退出序列按它收口） */
  let desktopActive = false;
  /** pi-tui 通道（首次进应用时惰性创建，跨换防复用同一实例——组件树保连续） */
  let tui: TuiChannel | undefined;
  /** pi-tui 在屏旗标（stop 后复起走 screenStarted 路径——退出序列只停在屏者） */
  let tuiOnScreen = false;
  /** focus 重画订阅注销器（ensureTui 装配时挂） */
  let disposeFocusSubscription: (() => void) | undefined;
  /** 内核 shell 态的应用视图收场 resolve（Esc 出视图时调用；undefined = 无在等者） */
  let appViewDone: (() => void) | undefined;

  /** 桌面服务 holder（Ring 1 desktop 行 provide；熔断回锁期行仍在装载——服务面可达） */
  const desktopService = runtime.ctx.tryGet<DesktopService>('desktop');
  /** 顶栏状态服务 holder（Ring 1 desktop 行批 D 起同 provide——骨架篇 §1.2） */
  const statusService = runtime.ctx.tryGet<DesktopStatusService>('desktop-status');

  /* ---------------- 顶栏状态聚合器（批 D，骨架篇 §1.2——行 provide 的 holder 挂真身） ---------------- */
  /** 凭证警示 holder（boot 期探针异步落值——聚合器活读，探不到 ≠ 配置好） */
  const credential: { issue: DesktopCredentialIssue | undefined } = { issue: undefined };
  const aggregator = createDesktopStatusAggregator({
    timing: {
      now: Date.now,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancelSchedule: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    sources: {
      // 后台运行数 = ctx.jobs 活跃 Job 数（事件驱动面既有活体——running/stopping 计）
      activeJobs: () => {
        const jobs = runtime.ctx.tryGet<JobsServiceFace>('jobs');
        return (jobs?.list() ?? []).filter((job) => job.status === 'running' || job.status === 'stopping').length;
      },
      // 已装应用数 = 装机对账面同源计数（appsService.list——禁第二真相源）
      installedApps: () => runtime.appsService.list().length,
      // 凭证警示 = 探针落值面（首启引导闭环）
      credentialIssue: () => credential.issue,
    },
  });
  statusService?.attach(aggregator);
  // 凭证探针（boot 后一次异步）：缺省模型 provider 的 checkAuth——undefined = 未
  // 配置即亮警示；文案与 berry run stderr 同源（describeProviderFailure 同一函数
  // 两消费面，禁抄第二份）。探针失败不阻塞（警示缺席的诚实边界：探不到 ≠ 配置好）
  void (async () => {
    try {
      const provider = runtime.model.split('/')[0] ?? '';
      if (provider !== '') {
        const check = await runtime.llm.checkAuth(provider);
        if (check === undefined || check === null) {
          credential.issue = {
            provider,
            guidance:
              describeProviderFailure(`Provider is not configured: ${provider}`) ??
              `模型 provider「${provider}」未配置凭证。`,
          };
        }
      }
    } catch {
      // 探针异常吞掉（探不到 = 不亮警示——引导闭环的另一腿 /guide 恒可达）
    }
    aggregator.sampleOnce(); // 落值后即时采样（值变即通知——顶栏即刻亮警示槽）
  })();

  /* ---------------- 关停/重启编舞（批 D，骨架篇 §1.3——host-power 单源的桌面腿） ---------------- */
  /** 一实现两入口的「入口一」：桌面 confirm 原语已过二次确认 → 单源编舞放行 */
  const requestPower = (action: 'shutdown' | 'reboot'): Promise<PowerResult> =>
    runPowerAction(action, {
      confirmed: true, // UI 确认在前（壳内 confirm 视图）——CLI 腿的 --yes 对位
      form: 'in-process', // 桌面动词收的是本进程：selfExit 走 front.requestQuit
      deps: {
        selfExit: () => {
          front.requestQuit(); // 优雅退出序列全序在下方 finally——零新编舞
        },
      },
    });

  /* ---------------- 管理面薄壳（批 D——AppsService〔admin 工具族同源实现〕的桌面投影） ---------------- */
  /** 管理动作错误 → 单行提示（AppsService 抛 AppError 的桌面回执面） */
  const adminError = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const adminFace: DesktopAdminFace = {
    /** 配置：JSON patch 解析（非对象/非 JSON 诚实拒）→ configure 写入 + 回执 */
    async configure(id, patchJson) {
      let patch: Record<string, unknown>;
      try {
        const value = JSON.parse(patchJson) as unknown;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return '配置 patch 须是 JSON 对象（如 {"key":"value"}）';
        }
        patch = value as Record<string, unknown>;
      } catch {
        return '配置 patch 不是合法 JSON——未执行';
      }
      try {
        const report = await runtime.appsService.configure(id, patch);
        return {
          title: `已配置 ${report.id}`,
          lines: [
            `  ${report.message}`,
            `  写入键：${report.appliedKeys.join('、')}`,
            `  合并后配置：${JSON.stringify(report.config)}`,
            report.ring1RestartRequired
              ? '  Ring 1 行——写盘后须重启进程生效（服务面提示）'
              : '  /reload 后生效（配置面不自动链重载）',
          ],
        };
      } catch (err) {
        return `配置失败：${adminError(err)}`;
      }
    },
    /** 卸载第一段：检视（inspect 不执行）——回执带确认段（Enter 才进第二段） */
    async uninstallInspect(id) {
      try {
        const report = await runtime.appsService.uninstall(id, { mode: 'inspect' });
        return {
          title: `卸载检视 ${report.id}`,
          lines: formatUninstallReport(report).split('\n'),
          confirm: {
            label: '确认卸载（保留数据域）',
            run: () => adminFace.uninstallExecute(id, 'keep'), // 桌面腿恒 keep；purge 走 /apps-uninstall 命令面
          },
        };
      } catch (err) {
        return `卸载检视失败：${adminError(err)}`;
      }
    },
    /** 卸载第二段：执行 + 组合重载（回执与命令面同 formatter） */
    async uninstallExecute(id, dataAction) {
      try {
        const exec = await runtime.appsService.uninstall(id, { mode: 'execute', dataAction });
        const reload = await runtime.reload();
        return {
          title: `卸载完成 ${exec.id}`,
          lines: [...formatUninstallExec(exec).split('\n'), formatReloadResult(reload)],
        };
      } catch (err) {
        return `卸载执行失败：${adminError(err)}`;
      }
    },
    /** 卸挂载 + 目标区重载（单区 reload 判据与命令面同律：恰一目标才单区） */
    async unmount(rowId) {
      try {
        const report = await runtime.appsService.unmount(rowId);
        const reload = await runtime.reload(report.apps.length === 1 ? report.apps[0] : undefined);
        return {
          title: `已卸挂载 ${report.id}`,
          lines: [`  ${report.message}`, ...report.warnings.map((w) => `  ⚠ ${w}`), formatReloadResult(reload)],
        };
      } catch (err) {
        return `卸挂载失败：${adminError(err)}`;
      }
    },
    /** 挂载 + 目标区重载（apps 目标必填——壳 prompt 视图补参） */
    async mount(installId, apps) {
      if (apps.length === 0) {
        return '挂载目标必填：输入挂载到哪个应用（应用 id，逗号分隔多个 = 共享件）';
      }
      try {
        const report = await runtime.appsService.mount(installId, { apps });
        const reload = await runtime.reload(report.apps.length === 1 ? report.apps[0] : undefined);
        return {
          title: `已挂载 ${report.id}`,
          lines: [
            `  ${report.message}`,
            `  挂载目标：apps ${report.apps.join('、')}（${report.source} 源）`,
            formatReloadResult(reload),
          ],
        };
      } catch (err) {
        return `挂载失败：${adminError(err)}`;
      }
    },
  };

  /* ---------------- 应用清单投影（装载面单一真相源的只读投影） ---------------- */
  const listApps = (): DesktopAppEntry[] => {
    const rows = runtime.appsService.list();
    const sourceById = new Map(rows.map((row) => [row.id, row.source]));
    const defaultId = resolveDefaultApp(runtime.apps, runtime.appGaps)?.id;
    const entries: DesktopAppEntry[] = [];
    // 在册清单（官方 + 已并入的第三方）：缺场应用照列但不可进入（与 /app 可用面同律）
    for (const manifest of runtime.apps.values()) {
      const missing = runtime.appGaps.get(manifest.id);
      const source = sourceById.get(manifest.id);
      entries.push({
        id: manifest.id,
        label: manifest.label,
        group: source === 'npm' || source === 'git' || source === 'local' ? 'thirdparty' : 'official',
        openable: missing === undefined,
        isDefault: manifest.id === defaultId,
        ...(missing === undefined ? {} : { note: `组件缺场（${missing.join('、')}）` }),
        // 商店行分流（批 F）：Enter 进桌面商店视图而非 enterApp（清单行是入口皮）
        ...(manifest.id === STORE_APP_ID ? { desktopView: 'store' as const } : {}),
      });
    }
    // 仓库态（已装未挂载）行：只读披露——装机面不是断头路（/apps 同款指引语义）
    for (const row of rows) {
      if (row.status === 'installed-unmounted' && !runtime.apps.has(row.id)) {
        entries.push({
          id: row.id,
          label: row.name ?? row.id,
          group: 'thirdparty',
          openable: false,
          note: '已装未挂载——/apps-mount 挂载后生效',
        });
      }
    }
    return entries;
  };

  /* ---------------- 会话切换器面（批 F，骨架篇 §1.2 line 80 五件面的宿主真身） ---------------- */
  // 动词全部单源走既有运行时面：list/preview 两源合并投影（webui sessionsFor 同
  // 律）、search 走 session-search 窄面（session_fts 真跑）、close 走
  // registry.retire、openNew 走 runtime.enterApp（默认应用）、resume 走
  // registry.open({resume})。desktop-main 本地闭包直引用（非 ctx 服务——切换器
  // 是桌面壳私有面）。

  /** 投影消息取文本（content 两形态：纯串/块数组取 text 块——呈现专用小 helper） */
  const projectionText = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (typeof block === 'object' && block !== null && 'text' in block) {
          const text = (block as { readonly text?: unknown }).text;
          if (typeof text === 'string') parts.push(text);
        }
      }
      return parts.join(' ');
    }
    return '';
  };

  /** 呈现截断（一行宽纪律——预览行不撑爆终端） */
  const clip = (text: string, max = 72): string => {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length <= max ? one : `${one.slice(0, max)}…`;
  };

  /** 末活动时刻人读串（确定性格式——不随 locale 漂移） */
  const formatTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

  /** 应用域键 → 人读标签（清单 label 单源；未装载应用回落域键原值） */
  const appLabel = (appId: string): string => runtime.apps.get(appId)?.label ?? appId;

  /** 会话标题（首条用户消息摘要——空会话 '(空会话)'；投影单源 deriveMessages） */
  const sessionTitle = (events: Parameters<typeof deriveMessages>[0]): string => {
    for (const message of deriveMessages(events)) {
      if (message.type === 'user') {
        const text = clip(projectionText(message.content));
        return text === '' ? '(空会话)' : text;
      }
    }
    return '(空会话)';
  };

  /**
   * 两源合并清单（webui sessionsFor 同律）：注册表条目（活/退役——内存真相）∪
   * store 近史 50（存档会话——write-behind 迟滞无害，活条目必在注册表）。
   * 按末活动降序；active = 在册未退役；current = 前台聚焦位。
   */
  const sessionsFace: DesktopSessionsFace = {
    list() {
      const recent = runtime.persistence ? runtime.persistence.store.recentSessions(50) : [];
      const seen = new Set<string>();
      const result: DesktopSessionEntry[] = [];
      // 腿一：注册表条目（含退役保留者——已闭可读不可写如实呈现）
      for (const entry of runtime.drivers.entries.values()) {
        const id = entry.session.header.sessionId;
        seen.add(id);
        const row = recent.find((r) => r.id === id);
        const updatedAt = entry.session.events.at(-1)?.time ?? row?.lastEventAt ?? undefined;
        result.push({
          id,
          appId: entry.appId,
          label: appLabel(entry.appId),
          title: sessionTitle(entry.session.events),
          updatedAt: updatedAt === undefined ? undefined : formatTime(updatedAt),
          active: !entry.retired,
          current: runtime.drivers.focus.sessionId === id,
        });
      }
      // 腿二：store 近史行（注册表未见的存档会话——本进程未开过的历史）
      for (const row of recent) {
        if (seen.has(row.id)) continue;
        result.push({
          id: row.id,
          appId: row.app ?? 'chat',
          label: appLabel(row.app ?? 'chat'),
          title: row.lastEventAt === null ? '(空会话·存档)' : '(存档会话)',
          updatedAt: row.lastEventAt === null ? undefined : formatTime(row.lastEventAt),
          active: false,
          current: false,
        });
      }
      // 末活动降序（无时刻者沉底——空会话垫后）
      result.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      return result;
    },
    /** 预览（首末消息——deriveMessages 单源；存档腿走 loadSession 纯读派生） */
    preview(id) {
      const entry = runtime.drivers.entries.get(id);
      const events =
        entry === undefined ? (runtime.persistence?.loadSession(id)?.events ?? undefined) : entry.session.events;
      if (events === undefined) return undefined;
      const texts = deriveMessages(events)
        .filter((m) => m.type === 'user' || m.type === 'assistant')
        .map((m) => clip(projectionText(m.content)));
      if (texts.length === 0) return { first: '（无消息）', last: '（无消息）' };
      return { first: texts[0]!, last: texts.at(-1)! };
    },
    /** 全文搜索（session-search 窄面 → session_fts 命中集过滤清单；面缺席诚实拒） */
    search(query) {
      const face = runtime.ctx.tryGet<{
        search(query: string, limit?: number): readonly { readonly sessionId: string }[];
      }>('session-search');
      if (face === undefined) {
        return { ok: false, error: '全文检索面不在场（memory 行未装载或被禁用）——清单浏览照常可用' };
      }
      try {
        const hits = face.search(query, 50);
        const rank = new Map(hits.map((hit, index) => [hit.sessionId, index]));
        const entries = sessionsFace
          .list()
          .filter((entry) => rank.has(entry.id))
          .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
        return { ok: true, entries };
      } catch (err) {
        return { ok: false, error: `检索失败：${err instanceof Error ? err.message : String(err)}` };
      }
    },
    /** 关闭（registry.retire——运行中/不在册/已闭各拒；不动 focus） */
    close(id) {
      const result = runtime.drivers.retire(id);
      if (result) return { ok: true };
      const entry = runtime.drivers.entries.get(id);
      if (entry === undefined) {
        return { ok: false, error: '会话不在本进程册上（存档态——本就未在跑，无需关闭）' };
      }
      if (entry.retired) return { ok: false, error: '会话已关闭（只读态）' };
      return { ok: false, error: '会话运行中——打断（Ctrl+C）后再关闭' };
    },
    /** 开新（默认应用域 enterApp 单源路由——与清单 Enter 同一条龙） */
    openNew() {
      const target = resolveDefaultApp(runtime.apps, runtime.appGaps);
      if (target === undefined) {
        return { ok: false, error: '默认应用不可用（组件缺场/被禁用）——dump-config 查看装配' };
      }
      return runtime.enterApp(target.id);
    },
    /** 续接（registry.open({resume:id})——活条目幂等切前台；进程内已闭诚实拒） */
    resume(id) {
      const entry = runtime.drivers.entries.get(id);
      if (entry !== undefined && entry.retired) {
        return { ok: false, error: '已闭会话（本进程内只读）——重启进程后经近史清单正常续接' };
      }
      const opened = runtime.drivers.open({ resume: id });
      if (opened === undefined) {
        return { ok: false, error: '续接失败（无持久层或会话不存在）' };
      }
      return { ok: true, sessionId: opened.session.header.sessionId };
    },
  };

  /* ---------------- 应用视图（pi-tui 通道）装配：首次进应用时惰性一次 ---------------- */
  /** 应用视图 Esc 路由（通道 escapeHook——桌面态回桌面/内核态回内核 shell） */
  const escapeFromAppView = (): boolean => {
    if (desktopActive) {
      // 桌面态：换防回桌面（服务路由到壳 face；序在壳内单源——先还屏再复位引擎）
      const result = shell === undefined ? { ok: false as const, error: '桌面壳不在场' } : shell.backToDesktop();
      return result.ok;
    }
    // 内核 shell 态：出应用视图回内核 REPL（停屏 + 收场等待者）
    if (appViewDone !== undefined) {
      if (tuiOnScreen) {
        tui?.stop();
        tuiOnScreen = false;
      }
      const done = appViewDone;
      appViewDone = undefined;
      done();
      return true;
    }
    return false;
  };

  /** pi-tui 通道创建 + 接线（与 tui-main 同源接线面；横幅随首屏补发） */
  const ensureTui = (): TuiChannel => {
    if (tui !== undefined) return tui;
    tui = createTuiChannel({
      host: front,
      commands: runtime.channels.commands,
      rendererFor: (role) => runtime.channels.rendererFor(role),
      onRendererError: (err, role) =>
        runtime.ctx.logger.error(`渲染器异常已隔离（角色 ${role}，已回落内置形态）`, {
          error: err instanceof Error ? err.stack : String(err),
        }),
      title: `Berry ${VERSION}`,
      workspace: runtime.ctx.tryGet<PathsService>('paths')?.workspaceRoot(),
      symbolsFor: (path) => runtime.symbolsFor(path),
      quitHint:
        [...runtime.drivers.entries.values()].filter((e) => !e.retired).length >= 2
          ? 'Ctrl+C 打断 / Ctrl+D·/quit 退出'
          : undefined,
      // 批 C 换防：应用视图态 Esc 回桌面/内核 shell（返回 true = 消费不进编辑器）
      escapeHook: () => escapeFromAppView(),
      history: (sessionId) => {
        const id = sessionId ?? front.focus.sessionId;
        const entry = id === undefined ? undefined : runtime.drivers.entries.get(id);
        return projectedToAgentMessages(entry?.session.deriveMessages() ?? []);
      },
      entryStatus: (sessionId) => {
        const entry = runtime.drivers.entries.get(sessionId);
        return entry === undefined ? undefined : entry.driver.isRunning ? 'running' : 'idle';
      },
      themeFor: (sessionId) => {
        const id = sessionId ?? front.focus.sessionId;
        const entry = id === undefined ? undefined : runtime.drivers.entries.get(id);
        return entry === undefined ? undefined : runtime.apps.get(entry.appId)?.theme?.accent;
      },
      // 增强 7 起屏聚焦一次同解析（刀 5 补键，与 tui-main 同源接线）：桌面 Enter
      // 先开驱动后建通道——focus 通知早于 ensureTui 订阅（错过 repaint 写点），
      // 首绘 title 缀短 id / 回看器提示行短 id 由宿主闭包活取（D4「起屏一次同
      // 解析」先例同款——undefined = 当前聚焦）
      focusIdFor: () => front.focus.sessionId,
      // todo 折叠查询面（增强 4，刀 5 补键——与 tui-main/webui SPA 呈现同源）：
      // 桌面进应用的会话与直进 TUI 同一呈现面，缺此键则 todo 面板在桌面形态
      // 永不渲染。键 = trackedSessionId；起屏/首 run 期 undefined = 当前聚焦
      // 由本闭包解析（两腿单源 runtime.todoFor：活条目内存真相 ∪ 已闭 store
      // 兜底 + goal 段锚活取——通道不 import chat 模块，结构类型注入）
      todoFor: (sessionId) => {
        const id = sessionId ?? front.focus.sessionId;
        return id === undefined ? undefined : runtime.todoFor(id);
      },
      ...(tuiTerminal === undefined ? {} : { terminal: tuiTerminal }),
    });
    runtime.ui.attach(tui.ui());
    // 横幅族（与 tui-main 同源）：attach 后 notify 才可达——随应用视图首屏补发
    if (runtime.bootDegraded.length > 0) {
      runtime.ui.notify(
        `启动横幅：${runtime.bootDegraded.length} 行第三方应用失败已隔离跳过（平台照常启动）。\n` +
          runtime.bootDegraded.map((row) => `  - [${row.code}] ${row.id}：${row.message}`).join('\n') +
          `\n  诊断文件见 boot-failures.json（数据目录内）`,
        { level: 'warn' },
      );
    }
    if (firstBoot) {
      runtime.ui.notify(
        `欢迎使用 Berry ${VERSION}——跑 AI 应用的操作系统。\n` +
          `· 首启即用：${QUICK_START_ENTRY}\n` +
          '· /help 看全部命令 · /guide 快速上手参考\n' +
          '· 模型配置：APP_MODEL 环境变量覆盖缺省模型；凭证与数据目录见 docs/使用指南',
      );
    }
    const ephemeralAuth = runtime.webuiEphemeralAuth();
    if (ephemeralAuth !== undefined) {
      runtime.ui.notify(
        `Web 通道已开（${ephemeralAuth.host}:${ephemeralAuth.port}）——鉴权一次性 token（仅本次进程）：\n` +
          `${ephemeralAuth.token}\n` +
          '浏览器打开后经 /api/auth 换 cookie，或请求头 Authorization: Bearer <token>',
      );
    }
    // S3 信封分流 + focus 重画（与 tui-main 同款接线；通道闭包持 tui 活引用）
    const channel = tui;
    front.addDisplay((envelope) => {
      if (envelope.sessionId === front.focus.sessionId) {
        channel.handle(envelope.event);
      } else {
        channel.handleActivity(envelope.sessionId, envelope.event);
      }
    });
    disposeFocusSubscription = runtime.drivers.onFocusChange((sessionId) => channel.repaint(sessionId));
    // 可卸提示（与 tui-main 同源三因分流）：无对话循环时示明现状
    if (runtime.conversation === undefined) {
      const workspaceRoot = runtime.ctx.tryGet<PathsService>('paths')?.workspaceRoot();
      const heldHere = daemonHoldsWorkspaceSession(workspaceRoot, runtime.persistence?.store.recentSessions(50) ?? []);
      if (heldHere) {
        runtime.ui.notify(
          '最新会话正被 daemon 持有（heldSessions 租约）——本进程拒开防双写者，已另开新会话继续。' +
            '接上原会话：`berry attach`，或经 `POST /api/sessions/:id/submit` 投递。',
          { level: 'warn' },
        );
        if (runtime.newSession() === undefined) {
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
    return tui;
  };

  /* ---------------- 换防两动词（壳 deps——序的执法面） ---------------- */
  /** 进应用视图（引擎 suspend 之后由壳调用）：pi-tui 起屏（复起不重画历史） */
  const enterAppView = (): void => {
    const channel = ensureTui();
    channel.start();
    tuiOnScreen = true;
  };

  /** 出应用视图（引擎 resume 之前由壳调用）：pi-tui 停屏保画面（桌面在其下重绘） */
  const leaveAppView = (): void => {
    tui?.stop({ preserveScreen: true });
    tuiOnScreen = false;
  };

  /* ---------------- 桌面壳工厂（boot 起屏与 /desktop 重试共用） ---------------- */
  const makeShell = (): DesktopShell =>
    createDesktopShell({
      ...(desktopIo === undefined ? {} : { io: desktopIo }),
      listApps,
      enterApp: (appId) => runtime.enterApp(appId),
      enterAppView,
      leaveAppView,
      requestExit: () => {
        front.requestQuit();
      },
      ...(desktopService === undefined ? {} : { service: desktopService }),
      ...(statusService === undefined ? {} : { status: statusService }),
      requestPower, // 恒杀全家动词（批 D——host-power 单源编舞的桌面入口）
      admin: adminFace, // 管理面薄壳（批 D——AppsService 同源投影）
      // 系统助手服务面（批 E 默认应答者）：getter 活取——行被 overlay 禁用 +
      // /apps-toggle 后 tryGet 即时 undefined，无前缀文本回落帮助文案
      // （carve-out 第四条），不随 boot 时点固化
      assistant: () => runtime.ctx.tryGet<AssistantService>('assistant'),
      // 商店服务面（批 F）：getter 活取同律——store 行被禁用时 /store 与清单行
      // Enter 诚实拒（Ring 2 真·可卸的核心循环不破语义）
      store: () => runtime.ctx.tryGet<StoreService>('store'),
      // 会话切换器面（批 F 五件面真身——本地闭包直引用，非 ctx 服务）
      sessions: sessionsFace,
    });

  /* ---------------- 内核 shell deps（兜底面的动词接线） ---------------- */
  /** /start：进应用（runtime enterApp 单源）→ 应用视图，Esc 出视图/进程退出时结算 */
  const kernelStartApp = async (appId: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    const entered = runtime.enterApp(appId);
    if (!entered.ok) return entered;
    const channel = ensureTui();
    channel.start();
    tuiOnScreen = true;
    // 等待应用视图收场：Esc（escapeFromAppView）或进程退出（front.quit）先到先得
    await Promise.race([
      new Promise<void>((resolve) => {
        appViewDone = resolve;
      }),
      front.quit.then(() => undefined),
    ]);
    appViewDone = undefined;
    return { ok: true };
  };

  /** /desktop：重试桌面起屏——成功清熔断账（用户裁决盖过机器判死）并接管 */
  const retryDesktop = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (desktopActive) return { ok: true };
    const candidate = makeShell();
    try {
      candidate.start();
    } catch (err) {
      const ledger = recordBootFailure(dataDir(), { warn: (message) => runtime.ctx.logger.warn(message) });
      return {
        ok: false,
        error: `第 ${ledger.count} 次失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    shell = candidate;
    desktopActive = true;
    clearBootFailures(dataDir());
    return { ok: true };
  };

  const kernelShellDeps = {
    // stdio 注入面（缺省 process stdio——测试注 PassThrough 不抢真 stdin）
    ...(kernelInput === undefined ? {} : { input: kernelInput }),
    ...(kernelOutput === undefined ? {} : { output: kernelOutput }),
    listApps: () => listApps().map((entry) => ({ id: entry.id, label: entry.label })),
    startApp: kernelStartApp,
    retryDesktop,
    requestExit: () => {
      front.requestQuit();
    },
    // /shutdown 双确认第二击（批 D）：恒杀全家单源编舞（与桌面 /shutdown、CLI
    // berry shutdown 同一 runPowerAction）+ 单源确认语（首击文案）
    requestShutdown: () => {
      void requestPower('shutdown');
    },
    shutdownConfirmText: `确认关停？${POWER_KILL_FAMILY_TEXT}——再输一次 /shutdown 执行（其他命令取消）`,
    // 宿主退出信号（front.quit）：REPL 行读挂起时被结算（rl.close）——防进程悬死
    hostQuit: front.quit,
  };

  /* ---------------- 信号编舞（与 tui-main 同源） ---------------- */
  const signals = installExitSignals({
    onGracefulQuit: (kind) => {
      if (kind === 'interrupt') {
        void front
          .interrupt()
          .catch(() => undefined)
          .then(() => signals.acknowledgeQuitRequest());
      } else {
        front.requestQuit();
      }
    },
    onFatal: async (error, kind) => {
      appendCrashRecord({ kind, entry: 'desktop', error });
      runtime.ctx.logger.error(`致命异常（${kind}），尽力落盘后退出`, {
        kind,
        error: error instanceof Error ? error.stack : String(error),
      });
      await runtime.persistence?.flush().catch(() => undefined);
    },
  });

  try {
    /* ---- boot 序（骨架篇）：--no-desktop 显式优先 → 熔断判据 → 桌面起屏 ---- */
    if (noDesktop) {
      // 显式跳过桌面：直进内核 shell（显式用户意图不作熔断判读；--no-apps 正交）
      await runKernelShell({
        ...kernelShellDeps,
        banner: '内核最小 shell（--no-desktop 显式形态）——命令：/apps /start <id> /shutdown /exit /desktop',
      });
    } else if (isBootBreakerTripped(dataDir(), { warn: (message) => runtime.ctx.logger.warn(message) })) {
      // 熔断回锁：两连崩保护——桌面起屏不再自动尝试，动词交还用户
      const ledger = readBootFailures(dataDir());
      await runKernelShell({
        ...kernelShellDeps,
        banner: [
          '桌面已连续两次启动失败——已熔断回锁内核最小 shell（保护交互面）。',
          `  失败账本：${DESKTOP_BOOT_FAILURES_FILE}（版本 ${ledger.version}，连续 ${ledger.count} 次）`,
          '  · /desktop 重试桌面（成功清账；升级版本亦清账）',
          '  · /apps 看应用 · /start <id> 直接进应用 · /exit 退出',
          '  · berry --no-desktop 显式跳过桌面直进本面',
        ].join('\n'),
      });
    } else {
      // 常规路：起桌面；起屏失败（同步抛）记熔断账并回锁内核 shell
      shell = makeShell();
      try {
        shell.start();
        desktopActive = true;
      } catch (err) {
        shell = undefined; // 壳 start 失败已内置收口（引擎终退复原终端）——壳弃用
        runtime.ctx.logger.error('桌面起屏失败，回锁内核最小 shell', {
          error: err instanceof Error ? err.stack : String(err),
        });
        const ledger = recordBootFailure(dataDir(), { warn: (message) => runtime.ctx.logger.warn(message) });
        await runKernelShell({
          ...kernelShellDeps,
          banner: [
            `桌面启动失败（第 ${ledger.count} 次）——已回锁内核最小 shell。`,
            `  连续 ${2} 次失败后熔断；/desktop 立即重试（成功清账）。`,
            '  命令：/apps /start <id> /shutdown /exit /desktop',
          ].join('\n'),
        });
      }
    }
    // ---- 退出序列（与 tui-main 同款）：quit 聚合 → 收场提问 → 结算 ----
    // 桌面态：front.quit 由桌面 /exit（requestExit）触发；内核态：REPL 动词触发
    await front.quit;
    tui?.cancelAsks();
    await front.settle();
  } finally {
    signals.dispose();
    disposeFocusSubscription?.();
    // 两栈收口序：先停在屏的 pi-tui（还主屏）再终退桌面壳（引擎挂起态 dispose
    // 跳出屏串——在应用视图退出时不重打 1049l；运行态则正常出屏）
    if (tuiOnScreen) {
      tui?.stop();
      tuiOnScreen = false;
    }
    await shell?.dispose();
    await runtime.shutdown();
  }
  return signals.exitCode;
}
