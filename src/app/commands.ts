/**
 * L5 app — 内置命令与技能命令注册（组合根把宿主能力挂进通道命令面）。
 *
 * M1 内置五件：/help（命令清单）、/quit（优雅退出）、/new（开新会话——TUI 启动
 * 续接策略的另一面，技术栈篇 §5）、/skills（技能清单）、/skill:<名>（显式激活
 * ——§4.5(b) 包装格式作为普通 user 消息提交，loop 开跑）。
 * 应用管理命令族（2026-08-23 /reload 纵切；**D2 装机两态扩族 2026-08-27**）：
 * /apps（清单 + 仓库态差集）、/apps-install（仓库态）、/apps-mount、
 * /apps-unmount（挂载动词对偶）、/apps-toggle、/apps-update、
 * /apps-uninstall、/reload——全部是 ctx.apps 服务与组合根 reload 的薄壳
 * （对账逻辑不进壳面，§1.5）；热应用链：写行动词（mount/unmount/toggle）与
 * update 链 /reload，install 仓库态零行不链（契约篇 §6.1 两态）。
 * 技能命令按装配期快照逐个注册（skill refresh 仅在装配期跑一次，M1 无动态面）。
 */

import type { Disposer } from '../context/types.js';
import type { CommandRegistry } from '../channels/commands.js';
import type { UiService } from '../channels/types.js';
import { describeError } from '../contracts/errors.js';
import { formatSkillInvocation } from '../skills/index.js';
import type { SkillDiagnostic, SkillsService } from '../skills/index.js';
import type { AppsService, UninstallExecReport, UninstallReport } from './apps.js';
import type { AllowlistStore } from './allowlist-store.js';
import type { ReloadResult } from './assembly.js';
import type { AppStatusRow } from './composition.js';

/** 诊断 → 通知文本行（2026-08-23 生态读码补钉 ref-3：「没生效」必须有可见出口） */
function formatDiagnostics(diagnostics: readonly SkillDiagnostic[]): string {
  return diagnostics
    .map((d) => `  [${d.type}] ${d.code}：${d.message}${d.path && d.path !== d.code ? `（${d.path}）` : ''}`)
    .join('\n');
}

/** 应用状态行 → 人读文本（failed/skipped 附原因——「没生效」必须可见，同 ref-3；
 * source = 行来源（builtin/npm/git/local，契约篇 §3.4 list 现场推导）一并呈现 */
function formatAppRow(row: AppStatusRow): string {
  // 来源段缺省省略（推导不出 = 来源未知，不占行宽）
  const source = row.source !== undefined ? ` · ${row.source}` : '';
  switch (row.status) {
    case 'activated':
      // applyMs 打点（B2 P5，刀〇a）：启动开销随清单可见——慢件一眼定位，阈值调校供数
      return `  ✓ ${row.id}（${row.name ?? '未具名'}${source}${row.applyMs !== undefined ? ` · apply ${row.applyMs}ms` : ''}）`;
    case 'failed':
      return `  ✖ ${row.id}${source}：${row.code} ${row.message ?? ''}`;
    case 'skipped':
      return `  · ${row.id}${source}（跳过：${row.reason}）`;
    case 'installed-unmounted':
      // D2 仓库态差集行（契约篇 §6.1 可见性）：装了没挂必须可见——装机面断头路
      // = 不可用面，呈现挂载指引（词与 mount 动词对齐）
      return `  ◇ ${row.id}${source}（已装未挂——/apps-mount ${row.id} --apps <应用id> 生效）`;
    default:
      // planned = 装载前视角（boot 前 / 服务刚建）——正常 TUI 里看不到，防御呈现
      return `  ○ ${row.id}${source}（planned——尚未装载）`;
  }
}

/**
 * /reload 三面结果统一通知（queued / error / payload——组合根 reload 语义直译，
 * 壳只转述不解释；error 面附「原组合仍在运行」——预检后装的设计保证，见 §1.3 落码形态）。
 * payload.app 在场 = 单区重载（D3 per-app reload）——文案带目标应用与卸词集警示。
 */
function notifyReloadResult(ui: UiService, result: ReloadResult): void {
  if (result.queued === true) {
    // 刀 2 排队语义：run 进行中不拒——结算后自动执行，结果另行通知
    ui.notify('run 进行中——重载已排队，本次 run 结束后自动执行');
    return;
  }
  if (result.error !== undefined) {
    ui.notify(`重载失败：${result.error}\n（原组合仍在运行——修正 overlay 后再试）`);
    return;
  }
  const payload = result.payload;
  if (payload === undefined) return; // 三面互斥完备，此处不可达——类型收窄守卫
  const scope = payload.app !== undefined ? `应用 ${payload.app} 单区` : '组合';
  const parts = [`${scope}激活 ${payload.activated.length}`];
  // 失败行点名（id 级）——与 boot 期拒启清单同信息量；跳过行通常多（禁用面）不点名
  if (payload.failed.length > 0) parts.push(`失败 ${payload.failed.length}（${payload.failed.join('、')}）`);
  parts.push(`跳过 ${payload.skipped.length}`);
  // 卸词集警示（D3 契约篇 §5.1 块尾）：重装即回、改名即旧词永失——差集如实点名
  if (payload.droppedEvents !== undefined && payload.droppedEvents.length > 0) {
    parts.push(`警示：事件词消失 ${payload.droppedEvents.join('、')}（重装即回；改名即旧词永失）`);
  }
  ui.notify(`已重载：${parts.join('，')}`);
}

/** 字节数 → 人读体积（KiB/MiB 两档——inspect 报告的数据域体积行） */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * 位置参数 + `--key value` 旗标解析（/apps-mount 面的轻量 argv 面）：空白切
 * 词，`--key` 后随 token 即值（无值旗标收 true 占位——本面未用，防御呈现），
 * 其余按序进 positionals。值含空白走引号由 shell/通道层处理，壳面拿到即已分词。
 */
function parseFlagArgs(args: string): {
  positionals: string[];
  flags: Record<string, string>;
  /** 重复旗标收集面（第三十六批 --apps 多值）：旗标名 → 历次值清单（重复出现才入册；单次旗标仍在 flags） */
  multiFlags: Record<string, string[]>;
} {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const multiFlags: Record<string, string[]> = {};
  const seen: Record<string, number> = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith('--') && token.length > 2) {
      const key = token.slice(2);
      const value = tokens[i + 1];
      if (value !== undefined && !value.startsWith('--')) {
        seen[key] = (seen[key] ?? 0) + 1;
        if (seen[key] === 1) flags[key] = value;
        else (multiFlags[key] ??= []).push(value);
        i += 1;
      } else {
        flags[key] = 'true'; // 无值旗标——本面未用，防御占位
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags, multiFlags };
}

/** inspect 报告 → 人读文本（契约篇 §3.4 第二刀：execute 前的级联警示承载面——
 * 词表三档 / 受影响会话逐词点名 / 挂载行全集全量呈现，人看过才裁决；D2 键域
 * = 装机 id） */
function formatUninstallReport(report: UninstallReport): string {
  const lines: string[] = [
    `卸载检视 ${report.id}（${report.source} 源）：`,
    `  引用：${report.appRef}`,
    `  装机物：${report.installPath}`,
  ];
  if (report.mountedRows.length > 0) {
    lines.push(`  挂载行（execute 将同批删）：${report.mountedRows.join('、')}`);
  }
  lines.push(
    `  数据域：${report.dataRoots.join('、')}${report.dataBytes !== undefined ? `（约 ${formatBytes(report.dataBytes)}）` : '（无）'}`,
  );
  if (report.events.origin === 'live' || report.events.origin === 'ledger') {
    lines.push(
      report.events.names.length > 0
        ? `  自定义事件词（${report.events.origin} 档）：${report.events.names.join('、')}`
        : `  自定义事件词（${report.events.origin} 档）：无`,
    );
  } else {
    lines.push(`  ⚠ 自定义事件词：无法枚举——${report.events.note ?? '原因未知'}`);
  }
  if (report.affectedSessions !== undefined) {
    const entries = Object.entries(report.affectedSessions).filter(([, n]) => n > 0);
    lines.push(
      entries.length > 0
        ? `  ⚠ 受影响会话：${entries.map(([word, n]) => `${word} ×${n}`).join('、')}`
        : '  受影响会话：无',
    );
  }
  for (const warning of report.warnings) lines.push(`  ⚠ ${warning}`);
  lines.push('确认执行：/apps-uninstall <装机id> --confirm [--purge-data]（默认保留数据域）');
  return lines.join('\n');
}

/** execute 回执 → 人读文本（四段执行事实的壳面转述；outcome 三态如实呈现） */
function formatUninstallExec(report: UninstallExecReport): string {
  if (report.outcome === 'no-op') {
    return `无动作 ${report.id}：账本无记录且无可推导残迹（已卸载过或从未安装）`;
  }
  const head =
    report.outcome === 'residual'
      ? `残迹收尾 ${report.id}（账本无记录——pre-D2 遗产装机或上次卸载的段间残迹已清理）`
      : `已卸载 ${report.id}（${report.source} 源 · 数据域${report.dataAction === 'purge' ? '已清除' : '保留'}）`;
  const lines = [head];
  const installFace = report.installRemoved === 'removed' ? '装机物已删' : '无装机物（local 源账本已清）';
  lines.push(`  ${installFace}`);
  if (report.mountedRows.length > 0) lines.push(`  挂载行已删：${report.mountedRows.join('、')}`);
  if (report.dataRemoved) lines.push('  数据域已清除');
  if (report.restoresDefault === true) lines.push('  官方默认层同 id 行已回露出（恢复出厂态）');
  return lines.join('\n');
}

/** 内置命令注册入参（全部是组合根持有的既有件，无新概念） */
export interface BuiltinCommandsOptions {
  /** 通道命令注册表（ctx.channels.commands 直通） */
  readonly commands: CommandRegistry;
  /** UI 聚合器（命令回显走通知——命令无时间线事件，不进 durable） */
  readonly ui: UiService;
  /** 技能服务（/skills 清单与 /skill:<名> 激活的取数面） */
  readonly skills: SkillsService;
  /** 退出请求（接会话驱动的 requestQuit——优雅退出序列的入口） */
  readonly quit: () => void;
  /** 普通消息提交（技能激活文本走这条——与用户手打同路径） */
  readonly submit: (text: string) => void;
  /** 开新会话（/new——组合根热切换；无持久层/run 进行中返回 undefined） */
  readonly newSession: () => { header: { sessionId: string } } | undefined;
  /**
   * 多会话前台面（/app——S3：清单/切换/开新驻留；组合根闭包绑 chat 件注册表）。
   * list 只列活条目（退役只给计数——清单看活路，停摆看账本）；switchTo 是
   * registry 程序面直通（零准入拒）；open 语义含聚焦（开完即切到新会话）。
   */
  readonly apps: {
    /** 活条目清单（开启序）+ 停摆条目计数 */
    list(): {
      readonly active: ReadonlyArray<{
        readonly sessionId: string;
        readonly running: boolean;
        readonly focused: boolean;
      }>;
      readonly retiredCount: number;
    };
    /** 切前台（switchTo 程序面直通——退役/查无 false） */
    switchTo(sessionId: string): boolean;
    /** 开新驱动不退役旧的（registry.open 直调；无持久层 undefined） */
    open(): { readonly sessionId: string } | undefined;
    /**
     * 在册应用全量清单（D1-d 死防御支）：缺场应用也在册——/app <id> 的应用
     * 寻址门（在册即路由 enter，缺场由 enter 精确报「组件缺场」；与 available
     * 分工：裸清单尾部披露只列可进入的可用面）
     */
    registered(): ReadonlyArray<{ readonly id: string; readonly label: string }>;
    /**
     * 在册可用应用（第三纵切进入面）：组件齐备的在册清单（缺场应用不披露——
     * 应用级隔离的清单面镜像），/app 裸清单尾部披露用
     */
    available(): ReadonlyArray<{ readonly id: string; readonly label: string }>;
    /**
     * 应用进入（第三纵切）：开新会话域 + 聚焦（open({app}) 一条龙——会话打标/
     * agent 装配默认位/审批预设随 open 生效）。ok:false + error = 未知 id /
     * 组件缺场隔离 / 无持久层——命令壳只格式化
     */
    enter(
      appId: string,
    ): { readonly ok: true; readonly sessionId: string } | { readonly ok: false; readonly error: string };
  };
  /** 跨会话 allowlist 存储（/allowlist 枚举与撤销面——接线批 Commit B） */
  readonly allowlist: AllowlistStore;
  /** 应用管理服务（/apps 清单与 install/toggle/update——对账逻辑全在服务，壳只转述） */
  readonly appsService: AppsService;
  /** 组合树重载（/reload 主体——组合根闭包；装配动作不进壳面） */
  readonly reload: (app?: string) => Promise<ReloadResult>;
  /** 用量面板取数（/usage——投影本体在 usage.ts，组合根闭包绑库连接；壳只转述） */
  readonly usage: () => string;
}

/**
 * 注册内置命令 + 技能命令（随 ctx 作用域 LIFO 回卷）。
 * @returns 全部注销器的聚合 Disposer
 */
export function registerBuiltinCommands(opts: BuiltinCommandsOptions): Disposer {
  const disposers: Disposer[] = [];
  const { commands, ui, skills } = opts;

  disposers.push(
    commands.register({
      name: 'help',
      description: '命令清单',
      handler: () => {
        const lines = commands.list().map((cmd) => `  /${cmd.name} — ${cmd.description}`);
        ui.notify(`可用命令：\n${lines.join('\n')}`);
      },
    }),
    commands.register({
      name: 'quit',
      description: '退出（优雅收尾后离开）',
      handler: () => {
        opts.quit();
      },
    }),
    commands.register({
      name: 'new',
      description: '开新会话（当前会话已落库，重启后可续接）',
      handler: () => {
        // run 进行中拒绝：组合根热切换在 run 中返回 undefined（时间线正被引用）
        const fresh = opts.newSession();
        if (fresh) {
          ui.notify(`已开新会话（${fresh.header.sessionId.slice(0, 8)}…），继续对话即落在新会话`);
        } else {
          ui.notify('现在不能开新会话（run 进行中或无持久层），稍后再试');
        }
      },
    }),
    commands.register({
      name: 'app',
      description: '多会话前台：清单 / 切换 <序号|id前缀> / 开新 / 进入应用（/app <应用id> [首条消息]）',
      handler: (args) => {
        const arg = args.trim();
        /* ---- 动词三：/app new = 开新+驻留+聚焦（加而观之）——不退役旧驱动，无 busy 拒 ---- */
        if (arg === 'new') {
          const opened = opts.apps.open();
          if (opened) {
            ui.notify(`已开会话 ${opened.sessionId.slice(0, 8)}…（旧会话驻留后台，/app 随时切回）`);
          } else {
            ui.notify('现在不能开新会话（无持久层），稍后再试');
          }
          return;
        }
        /* ---- 动词〇（第三纵切）：清单 id 精确命中 = 应用进入——优先于会话寻址 ----
         * 应用 id 词汇域与会话 id 前缀不相交（应用 id 无会话 id 字符），先后即
         * 无歧义；寻址门 = **在册**全量（D1-d 死防御支：缺场应用也路由 enter——
         * 精确报「组件缺场」而非误落会话寻址的「无此会话」）。命中即 enter（开
         * 新域+聚焦），尾部 args 作为首条用户消息直接提交（与用户手打同路径——
         * 进入与开跑不打两段） */
        const firstSpace = arg.indexOf(' ');
        const appArg = firstSpace === -1 ? arg : arg.slice(0, firstSpace);
        const firstMessage = firstSpace === -1 ? '' : arg.slice(firstSpace + 1).trim();
        const appHit = opts.apps.registered().find((a) => a.id === appArg);
        if (appHit !== undefined) {
          const entered = opts.apps.enter(appHit.id);
          if (!entered.ok) {
            ui.notify(`进入失败：${entered.error}`);
            return;
          }
          ui.notify(`已进入应用 ${appHit.label}（会话 ${entered.sessionId.slice(0, 8)}…）`);
          if (firstMessage !== '') opts.submit(firstMessage);
          return;
        }
        const { active, retiredCount } = opts.apps.list();
        /* ---- 动词一：裸调 = 活条目清单（●聚焦 / ⧗后台工作中 / ·空闲 + 停摆计数） ---- */
        if (arg === '') {
          if (active.length === 0) {
            ui.notify('无活动会话（对话应用未装载或 persist:false）——输入不会得到应答');
            return;
          }
          const lines = active.map((entry, i) => {
            const badge = entry.focused ? '●聚焦' : entry.running ? '⧗后台工作中' : '·空闲';
            return `  ${i + 1}. ${entry.sessionId.slice(0, 8)} ${badge}`;
          });
          const retiredLine = retiredCount > 0 ? `\n（另有 ${retiredCount} 个已停摆会话——账本可查，清单不列）` : '';
          // 可用应用披露（第三纵切）：缺场应用不披露（应用级隔离的清单面镜像）
          const available = opts.apps.available();
          const appLine =
            available.length > 0
              ? `\n可用应用：${available.map((a) => a.id).join('、')} —— 进入 /app <id> [首条消息]`
              : '';
          ui.notify(
            `活动会话（${active.length}）：\n${lines.join('\n')}${retiredLine}\n切换 /app <序号|id前缀> · 开新 /app new${appLine}`,
          );
          return;
        }
        /* ---- 动词二：切换——双寻址（序号按当次清单，id 前缀是稳定键防序号漂移错切） ---- */
        let target: string | undefined;
        if (/^\d+$/.test(arg)) {
          target = active[Number(arg) - 1]?.sessionId;
          if (target === undefined) {
            ui.notify(`无此序号：${arg}（序号见 /app 清单——条目开合间会漂移，id 前缀更稳）`);
            return;
          }
        } else {
          const hits = active.filter((entry) => entry.sessionId.startsWith(arg));
          if (hits.length === 0) {
            ui.notify(`无此会话：${arg}（/app 查看清单）`);
            return;
          }
          if (hits.length > 1) {
            ui.notify(`歧义前缀：${arg} 命中 ${hits.length} 个会话（多打几位再试）`);
            return;
          }
          target = hits[0]!.sessionId;
        }
        ui.notify(opts.apps.switchTo(target) ? `已切换到 ${target.slice(0, 8)}…` : '切换失败（会话已停摆）');
      },
    }),
    commands.register({
      name: 'usage',
      description: '用量面板：今日/近 7 日 tokens、会话 top、模型分布、goal 预算',
      handler: () => {
        // 投影本体在 usage.ts（组合根闭包绑库连接）——壳只转述；诊断面无持久层
        // 时闭包返回说明文本，同样经通知呈现
        ui.notify(opts.usage());
      },
    }),
    commands.register({
      name: 'allowlist',
      description: '跨会话免问清单：枚举 / 撤销（advisory——只影响问不问，deny 不在此）',
      handler: (args) => {
        // /allowlist rm <序号> 撤销；裸 /allowlist 枚举（过期态如实标注——过期条目
        // 已回落问，提示清理）。写入面（「始终允许」推荐规则）随审批增补二批接。
        const parts = args.trim().split(/\s+/).filter(Boolean);
        if (parts[0] === 'rm' || parts[0] === 'remove') {
          const index = Number(parts[1]);
          if (!Number.isInteger(index) || index < 1) {
            ui.notify('用法：/allowlist rm <序号>（序号见 /allowlist）');
            return;
          }
          ui.notify(opts.allowlist.remove(index - 1) ? `已撤销条目 ${index}` : `无此序号：${index}`);
          return;
        }
        const entries = opts.allowlist.list();
        if (entries.length === 0) {
          ui.notify('allowlist 空（0 条）——条目来源：审批「始终允许」（增补二批接）或手编 <数据目录>/allowlist.json');
          return;
        }
        const now = Date.now();
        const lines = entries.map((entry, i) => {
          const expired = entry.expiresAt !== undefined && now >= entry.expiresAt;
          const ttl =
            entry.expiresAt === undefined
              ? '永久'
              : expired
                ? `⚠ 已过期（回落问——可 rm 清理）`
                : `至 ${new Date(entry.expiresAt).toISOString()}`;
          return `  ${i + 1}. ${entry.tool}  ${entry.pattern || '（整名匹配）'}（${ttl}）`;
        });
        ui.notify(
          `allowlist（${entries.length} 条——免问面，deny 不在此面）：\n${lines.join('\n')}\n撤销：/allowlist rm <序号>`,
        );
      },
    }),
    commands.register({
      name: 'skills',
      description: '可用技能清单',
      handler: () => {
        const list = skills.list();
        const diagnostics = skills.diagnostics();
        if (list.length === 0) {
          // 空清单 + 有诊断 = 发现位置坏了但没人知道——诊断出口必达（ref-3：没生效不静默）
          const hint = diagnostics.length > 0 ? `\n发现诊断：\n${formatDiagnostics(diagnostics)}` : '';
          ui.notify(`无可用技能（发现位置见 dump-config）${hint}`);
          return;
        }
        const lines = list.map((skill) => `  /skill:${skill.name} — ${skill.description}`);
        // 诊断随清单附尾：collision/提供方失败直接可见，不需要翻日志
        const diagLines = diagnostics.length > 0 ? `\n发现诊断：\n${formatDiagnostics(diagnostics)}` : '';
        ui.notify(`可用技能：\n${lines.join('\n')}${diagLines}`);
      },
    }),
  );

  /* ---- 应用管理命令族（/reload 纵切 + D2 装机两态 2026-08-27）——全部是
   * ctx.apps 服务与组合根 reload 的薄壳（对账逻辑不进壳面，§1.5）。热应用
   * 链（D2）：install 仓库态零行无物可热应用 = 不链 reload；mount/unmount 写行
   * 后壳链 /reload（per-app reload 前的过渡形态）；update 换盘上代码，挂载行
   * 活着即链 /reload；toggle 写行同链。 ---- */

  disposers.push(
    commands.register({
      name: 'apps',
      description: '应用一览（组合树行 + 装载状态 + 仓库态差集）',
      handler: () => {
        const rows = opts.appsService.list();
        if (rows.length === 0) {
          ui.notify('无应用（组合树空、仓库态空）——/apps-install <ref> 装入第一件');
          return;
        }
        const lines = rows.map(formatAppRow);
        ui.notify(
          `应用一览：\n${lines.join('\n')}\n（/apps-install 装机 · /apps-mount 挂载 · /apps-unmount 卸挂载 · /apps-uninstall 卸载 · /apps-toggle 翻转 · /apps-update 更新 · /reload 重载）`,
        );
      },
    }),
    commands.register({
      name: 'apps-install',
      description: '装机 <npm 包名|git URL|本地路径> [git ref]（仓库态——挂载才生效）',
      handler: async (args) => {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const ref = tokens[0];
        if (ref === undefined) {
          ui.notify('用法：/apps-install <npm 包名 | git URL | 本地路径> [git ref]');
          return;
        }
        const gitRef = tokens[1];
        // 服务失败（APP_INSTALL_FAILED 等）向上抛——通道壳兜底为通知，不崩界面
        const report = await opts.appsService.install(ref, gitRef !== undefined ? { gitRef } : undefined);
        // D2 仓库态：零行无物可热应用——不链 /reload（install→reload 旧链废止）；
        // 报告 message 已带 mount 指引（装机面不是断头路）
        ui.notify(`${report.id} 已入仓库态（${report.source} 源）：${report.message}`);
      },
    }),
    /* mount（D2 挂载动词，契约篇 §6.1 两态——「应用独立不生效」的生效面；
     * 第三十六批 apps 数组化 + R1 复盘批 carrier 解冻收口三值）：
     * 吃装机推导 id（见 /apps 的 ◇ 行），--apps 必填（可多个 = 共享件——
     * 逗号分隔或重复旗标）；--carrier 显式降格位（三值：缺省不落 sandbox
     * 块 = 闩一装载期推 external 进程墙；main/worker = operator 显式降格；
     * external = 与缺省等价的显式声明）。--row-id = 行 id 显式命名位（同包第
     * 二应用挂载必经）；--config = 行初始配置 JSON（唯显式 main 行可携——
     * 分域行校验面在域侧拒写）。写行后壳链 /reload。 */
    commands.register({
      name: 'apps-mount',
      description:
        '挂载 <装机id> --apps <应用id>[,…] [--carrier main|worker|external] [--row-id <行id>] [--config <json>] 并重载',
      handler: async (args) => {
        const parsed = parseFlagArgs(args);
        const installId = parsed.positionals[0];
        if (installId === undefined) {
          ui.notify(
            "用法：/apps-mount <装机id> --apps <应用id>[,<应用id>…] [--carrier main|worker|external] [--row-id <行id>] [--config '<json>']（装机id 见 /apps ◇ 行；缺省载体 = external 进程墙）",
          );
          return;
        }
        // apps 多值（d36 §3）：逗号分隔 + 重复旗标并存——去空并集（去重/值域执法在服务面）
        const apps: string[] = [];
        for (const value of [parsed.flags['apps'], ...(parsed.multiFlags['apps'] ?? [])]) {
          if (value === undefined || value === 'true') continue;
          for (const part of value.split(',')) {
            const id = part.trim();
            if (id !== '') apps.push(id);
          }
        }
        if (apps.length === 0) {
          ui.notify('挂载目标必填：--apps <应用id>[,<应用id>…]（多值 = 共享件；全局作用域 v1 官方专属）');
          return;
        }
        // carrier 三值校验（服务面值域同款，壳面先给可读报错）
        const carrier = parsed.flags['carrier'];
        if (carrier !== undefined && carrier !== 'main' && carrier !== 'worker' && carrier !== 'external') {
          ui.notify(
            '--carrier 只认 main | worker | external（缺省不落 sandbox 块 = external 进程墙——闩一；main/worker = operator 显式降格）',
          );
          return;
        }
        // config 位 = 可选 JSON 字面（行初始配置——服务面经应用声明 schema 校验）
        let config: Record<string, unknown> | undefined;
        const rawConfig = parsed.flags['config'];
        if (rawConfig !== undefined) {
          try {
            const value = JSON.parse(rawConfig) as unknown;
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
              throw new Error('非对象');
            }
            config = value as Record<string, unknown>;
          } catch (err) {
            ui.notify(`--config 不是合法 JSON 对象：${err instanceof Error ? err.message : String(err)}`);
            return;
          }
        }
        const rowId = parsed.flags['row-id'];
        const report = await opts.appsService.mount(installId, {
          apps,
          ...(carrier !== undefined ? { carrier } : {}),
          ...(config !== undefined ? { config } : {}),
          ...(rowId !== undefined ? { rowId } : {}),
        });
        ui.notify(`已挂载 ${report.id} → apps ${report.apps.join('、')}（${report.source} 源）：${report.message}`);
        // 写行只改组合树文件——壳链 /reload 才热应用（D2 新链：mount→reload）。
        // 单目标收窄（R4 行为小刀）：恰一应用 = 该区行，链单区 reload（分区装载
        // 律同判据）；跨区共享行（多元素）回退全量
        notifyReloadResult(ui, await opts.reload(apps.length === 1 ? apps[0] : undefined));
      },
    }),
    /* unmount（mount 对偶）：吃行 id，删行保码——装机物与数据域不动（处置 =
     * uninstall 的事）；行 config 随行删，重挂回缺省。写行后壳链 /reload。 */
    commands.register({
      name: 'apps-unmount',
      description: '卸挂载 <行id>（删行保码）并重载',
      handler: async (args) => {
        const rowId = args.trim().split(/\s+/)[0];
        if (!rowId) {
          ui.notify('用法：/apps-unmount <行id>（行id 见 /apps；临时停用保配置走 /apps-toggle）');
          return;
        }
        const report = await opts.appsService.unmount(rowId);
        const warnFace = report.warnings.length > 0 ? `\n${report.warnings.map((w) => `  ⚠ ${w}`).join('\n')}` : '';
        ui.notify(`${report.message}${warnFace}`);
        // 单目标收窄同 mount（R4 行为小刀）：被删行恰一目标应用 = 单区 reload；
        // 跨区行/无 apps 键行（纯禁用/替换）回退全量——判据走报告 apps 载荷
        notifyReloadResult(ui, await opts.reload(report.apps.length === 1 ? report.apps[0] : undefined)); // D2 新链：unmount→reload
      },
    }),
    commands.register({
      name: 'apps-toggle',
      description: '翻转应用禁用状态 <行id> 并重载',
      handler: async (args) => {
        const id = args.trim().split(/\s+/)[0];
        if (!id) {
          ui.notify('用法：/apps-toggle <行id>（行id 见 /apps）');
          return;
        }
        const disabled = opts.appsService.toggle(id); // 未知 id / fixed 行 → 抛，壳兜底
        ui.notify(`${id} 已${disabled ? '禁用' : '启用'}——重载生效中`);
        notifyReloadResult(ui, await opts.reload()); // 禁用翻转同样要对账→热应用两步
      },
    }),
    commands.register({
      name: 'apps-update',
      description: '按源更新应用 <装机id> 并重载',
      handler: async (args) => {
        const id = args.trim().split(/\s+/)[0];
        if (!id) {
          ui.notify('用法：/apps-update <装机id>（装机id 见 /apps；两态后仓库态件也可更新）');
          return;
        }
        const report = await opts.appsService.update(id); // npm 重装 / git 重克隆 / local no-op
        ui.notify(`${report.id} 更新完成（${report.source} 源）：${report.message}`);
        // 磁上已是新码——挂载行活着则链 /reload 才可见（local no-op / 未挂载件
        // 无害：等价一次 /reload）
        notifyReloadResult(ui, await opts.reload());
      },
    }),
    /* 卸载 execute 相唯一入口（human-only，契约篇 §3.4 第二刀；连字符族形对齐
     * /apps-install 系——SF-6）：**两段式确认步**（SF-5：「人 execute 前已看」
     * 须是机制非断言）——裸调 = inspect 渲染报告 + 确认指引，不执行；人显式打出
     * 第二条命令（--confirm）才 execute——确认 = 人手打 --confirm 这一动作本身。
     * --purge-data 只裁决确认后的 dataAction（省缺 keep = Docker 卷律），不跳确认。
     * 服务错误（未知装机 id 等）上抛——通道壳兜底为通知，不崩界面。 */
    commands.register({
      name: 'apps-uninstall',
      description: '卸载应用 <装机id>：先检视，--confirm 执行（--purge-data 清数据域）并重载',
      handler: async (args) => {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const id = tokens[0];
        if (id === undefined) {
          ui.notify('用法：/apps-uninstall <装机id> [--confirm] [--purge-data]（装机id 见 /apps；先检视后执行）');
          return;
        }
        const purgeData = tokens.slice(1).includes('--purge-data');
        // 第一段（裸调）：只检视渲染——报告即裁决依据，确认指引在报告尾行
        if (!tokens.slice(1).includes('--confirm')) {
          ui.notify(formatUninstallReport(await opts.appsService.uninstall(id, { mode: 'inspect' })));
          return;
        }
        // 第二段（--confirm）：execute + 回执 + 链 reload（删行只改组合树文件——
        // 壳链 /reload 才热应用，与 mount 同构两步）
        const exec = await opts.appsService.uninstall(id, {
          mode: 'execute',
          dataAction: purgeData ? 'purge' : 'keep',
        });
        ui.notify(formatUninstallExec(exec));
        notifyReloadResult(ui, await opts.reload());
      },
    }),
    commands.register({
      name: 'reload',
      description: '重载组合树（overlay / 应用代码改动后生效；--app <id> 只重载该应用的挂载行）',
      handler: async (args) => {
        // --app 旗标（D3 per-app reload，契约篇 §1.3 动词面）：单区重载目标应用
        // ——换 A 应用第三方挂载行不动 B 运行时。未知/不在册校验在组合根单点
        //（在册清单真源在那里），壳只透传 + 报错转述
        const { flags } = parseFlagArgs(args ?? '');
        notifyReloadResult(ui, await opts.reload(flags['app']));
      },
    }),
  );

  // 技能命令：装配期快照逐个注册（/skill:<名> 剩余参数为附加指令）
  for (const skill of skills.list()) {
    disposers.push(
      commands.register({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: 'skills',
        handler: (args) => {
          const additional = args.trim() || undefined;
          opts.submit(formatSkillInvocation(skill, additional));
        },
      }),
    );
  }

  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const dispose of disposers) dispose();
  };
}
