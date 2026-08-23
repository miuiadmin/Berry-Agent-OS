/**
 * L5 app — 内置命令与技能命令注册（组合根把宿主能力挂进通道命令面）。
 *
 * M1 内置四件：/help（命令清单）、/quit（优雅退出）、/skills（技能清单）、
 * /skill:<名>（显式激活——§4.5(b) 包装格式作为普通 user 消息提交，loop 开跑）。
 * 技能命令按装配期快照逐个注册（skill refresh 仅在装配期跑一次，M1 无动态面）。
 */

import type { Disposer } from '../context/types.js';
import type { CommandRegistry } from '../channels/commands.js';
import type { UiService } from '../channels/types.js';
import { formatSkillInvocation } from '../skills/index.js';
import type { SkillsService } from '../skills/index.js';

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
      name: 'skills',
      description: '可用技能清单',
      handler: () => {
        const list = skills.list();
        if (list.length === 0) {
          ui.notify('无可用技能（发现位置见 dump-config）');
          return;
        }
        const lines = list.map((skill) => `  /skill:${skill.name} — ${skill.description}`);
        ui.notify(`可用技能：\n${lines.join('\n')}`);
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
