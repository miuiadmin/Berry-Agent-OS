/**
 * L5 app — 内置命令与技能命令注册（组合根把宿主能力挂进通道命令面）。
 *
 * M1 内置五件：/help（命令清单）、/quit（优雅退出）、/new（开新会话——TUI 启动
 * 续接策略的另一面，技术栈篇 §5）、/skills（技能清单）、/skill:<名>（显式激活
 * ——§4.5(b) 包装格式作为普通 user 消息提交，loop 开跑）。
 * 技能命令按装配期快照逐个注册（skill refresh 仅在装配期跑一次，M1 无动态面）。
 */

import type { Disposer } from '../context/types.js';
import type { CommandRegistry } from '../channels/commands.js';
import type { UiService } from '../channels/types.js';
import { formatSkillInvocation } from '../skills/index.js';
import type { SkillDiagnostic, SkillsService } from '../skills/index.js';

/** 诊断 → 通知文本行（2026-08-23 生态读码补钉 ref-3：「没生效」必须有可见出口） */
function formatDiagnostics(diagnostics: readonly SkillDiagnostic[]): string {
  return diagnostics
    .map((d) => `  [${d.type}] ${d.code}：${d.message}${d.path && d.path !== d.code ? `（${d.path}）` : ''}`)
    .join('\n');
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
