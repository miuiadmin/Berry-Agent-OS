/**
 * L5 app — 内置命令与技能命令注册（组合根把宿主能力挂进通道命令面）。
 *
 * M1 内置五件：/help（命令清单）、/quit（优雅退出）、/new（开新会话——TUI 启动
 * 续接策略的另一面，技术栈篇 §5）、/skills（技能清单）、/skill:<名>（显式激活
 * ——§4.5(b) 包装格式作为普通 user 消息提交，loop 开跑）。
 * M2 插件管理五件（2026-08-23 /reload 纵切，技术栈篇 §5 插件管理命令面）：
 * /plugins（清单）、/plugin-install、/plugin-toggle、/plugin-update、/reload——
 * 全部是 ctx.plugins 服务与组合根 reload 的薄壳（对账逻辑不进壳面，§1.5），
 * install/update 后自动链 /reload（对账与组合正交——壳负责把两步串起来）。
 * 技能命令按装配期快照逐个注册（skill refresh 仅在装配期跑一次，M1 无动态面）。
 */

import type { Disposer } from '../context/types.js';
import type { CommandRegistry } from '../channels/commands.js';
import type { UiService } from '../channels/types.js';
import { describeError } from '../contracts/errors.js';
import { formatSkillInvocation } from '../skills/index.js';
import type { SkillDiagnostic, SkillsService } from '../skills/index.js';
import type { PluginsService } from './plugins.js';
import type { AllowlistStore } from './allowlist-store.js';
import type { ReloadResult } from './assembly.js';
import type { PluginStatusRow } from './composition.js';

/** 诊断 → 通知文本行（2026-08-23 生态读码补钉 ref-3：「没生效」必须有可见出口） */
function formatDiagnostics(diagnostics: readonly SkillDiagnostic[]): string {
  return diagnostics
    .map((d) => `  [${d.type}] ${d.code}：${d.message}${d.path && d.path !== d.code ? `（${d.path}）` : ''}`)
    .join('\n');
}

/** 插件状态行 → 人读文本（failed/skipped 附原因——「没生效」必须可见，同 ref-3） */
function formatPluginRow(row: PluginStatusRow): string {
  switch (row.status) {
    case 'activated':
      // applyMs 打点（B2 P5，刀〇a）：启动开销随清单可见——慢件一眼定位，阈值调校供数
      return `  ✓ ${row.id}（${row.name ?? '未具名'}${row.applyMs !== undefined ? ` · apply ${row.applyMs}ms` : ''}）`;
    case 'failed':
      return `  ✖ ${row.id}：${row.code} ${row.message ?? ''}`;
    case 'skipped':
      return `  · ${row.id}（跳过：${row.reason}）`;
    default:
      // planned = 装载前视角（boot 前 / 服务刚建）——正常 TUI 里看不到，防御呈现
      return `  ○ ${row.id}（planned——尚未装载）`;
  }
}

/**
 * /reload 三面结果统一通知（busy / error / payload——组合根 reload 语义直译，
 * 壳只转述不解释；error 面附「原组合仍在运行」——预检后装的设计保证，见 §1.3 落码形态）。
 */
function notifyReloadResult(ui: UiService, result: ReloadResult): void {
  if (result.busy === true) {
    ui.notify('现在不能重载（run 进行中），稍后再试');
    return;
  }
  if (result.error !== undefined) {
    ui.notify(`重载失败：${result.error}\n（原组合仍在运行——修正 overlay 后再试）`);
    return;
  }
  const payload = result.payload;
  if (payload === undefined) return; // 三面互斥完备，此处不可达——类型收窄守卫
  const parts = [`激活 ${payload.activated.length}`];
  // 失败行点名（id 级）——与 boot 期拒启清单同信息量；跳过行通常多（禁用面）不点名
  if (payload.failed.length > 0) parts.push(`失败 ${payload.failed.length}（${payload.failed.join('、')}）`);
  parts.push(`跳过 ${payload.skipped.length}`);
  ui.notify(`组合已重载：${parts.join('，')}`);
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
  /** 跨会话 allowlist 存储（/allowlist 枚举与撤销面——接线批 Commit B） */
  readonly allowlist: AllowlistStore;
  /** 插件管理服务（/plugins 清单与 install/toggle/update——对账逻辑全在服务，壳只转述） */
  readonly plugins: PluginsService;
  /** 组合树重载（/reload 主体——组合根闭包；装配动作不进壳面） */
  readonly reload: () => Promise<ReloadResult>;
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

  /* ---- M2 插件管理五件（/reload 纵切）——全部是 ctx.plugins 与组合根 reload 的薄壳 ---- */

  disposers.push(
    commands.register({
      name: 'plugins',
      description: '插件清单（组合树行 + 装载状态）',
      handler: () => {
        const rows = opts.plugins.list();
        if (rows.length === 0) {
          ui.notify('组合树无插件行（默认层为空）——/plugin-install <ref> 装入第一件');
          return;
        }
        const lines = rows.map(formatPluginRow);
        ui.notify(
          `插件清单：\n${lines.join('\n')}\n（/plugin-install 装入 · /plugin-toggle 翻转 · /plugin-update 更新 · /reload 重载）`,
        );
      },
    }),
    commands.register({
      name: 'plugin-install',
      description: '装机 <npm 包名|git URL|本地路径> [git ref] 并重载',
      handler: async (args) => {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const ref = tokens[0];
        if (ref === undefined) {
          ui.notify('用法：/plugin-install <npm 包名 | git URL | 本地路径> [git ref]');
          return;
        }
        const gitRef = tokens[1];
        // 服务失败（PLUGIN_INSTALL_FAILED 等）向上抛——通道壳兜底为通知，不崩界面
        const report = await opts.plugins.install(ref, gitRef !== undefined ? { gitRef } : undefined);
        ui.notify(`${report.id} 已装入（${report.source} 源）：${report.message}`);
        // 对账与组合正交——install 只写 overlay，壳链 /reload 才热应用（§1.5 表尾）
        notifyReloadResult(ui, await opts.reload());
      },
    }),
    commands.register({
      name: 'plugin-toggle',
      description: '翻转插件禁用状态 <id> 并重载',
      handler: async (args) => {
        const id = args.trim().split(/\s+/)[0];
        if (!id) {
          ui.notify('用法：/plugin-toggle <id>（id 见 /plugins）');
          return;
        }
        const disabled = opts.plugins.toggle(id); // 未知 id / fixed 行 → 抛，壳兜底
        ui.notify(`${id} 已${disabled ? '禁用' : '启用'}——重载生效中`);
        notifyReloadResult(ui, await opts.reload()); // 禁用翻转同样要对账→热应用两步
      },
    }),
    commands.register({
      name: 'plugin-update',
      description: '按源更新插件 <id> 并重载',
      handler: async (args) => {
        const id = args.trim().split(/\s+/)[0];
        if (!id) {
          ui.notify('用法：/plugin-update <id>（id 见 /plugins）');
          return;
        }
        const report = await opts.plugins.update(id); // npm 重装 / git 重克隆 / local no-op
        ui.notify(`${report.id} 更新完成（${report.source} 源）：${report.message}`);
        // 磁上已是新码——与 install 同理链 /reload 才可见（local no-op 也无害：等价一次 /reload）
        notifyReloadResult(ui, await opts.reload());
      },
    }),
    commands.register({
      name: 'reload',
      description: '重载组合树（overlay / 插件代码改动后生效）',
      handler: async () => {
        notifyReloadResult(ui, await opts.reload());
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
