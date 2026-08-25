/**
 * L5 app — 项目指令文件四层发现（骨架篇 §7.3 `instructions` 具名段，2026-08-26
 * 尾刀落码）。
 *
 * 四层全量拼接（通用在前、项目殿后）：~/.berry/AGENTS.md → ~/.agents/AGENTS.md
 * → ~/.claude/CLAUDE.md → 工作区根指令文件。指令文件是行为约束——模型须每轮
 * 在場，故整体常驻进系统提示词（与技能渐进披露相反的产品语义，规范显式声明）。
 *
 * 分层纪律（拓扑）：纯函数住 app（与 agents-md 同层），装配接线在组合根 ⑦
 * prompts 段注册位——不新开 ctx 服务名。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 单文件硬顶（字节）——会话事件护栏同量级；超限截断带标注 + warn 诊断 */
const MAX_INSTRUCTION_BYTES = 64 * 1024;

/** 指令发现位置（一层一目录；files 同层候选前者优先——first-wins 单层至多取一） */
export interface InstructionLocation {
  /** 候选文件所在目录（绝对路径） */
  readonly dir: string;
  /** 同层候选文件名（前者优先——防 symlink 双读：CLAUDE.md→AGENTS.md 形态只读一份） */
  readonly files: readonly string[];
  /** 来源层级（诊断归因用） */
  readonly source: 'user' | 'project';
}

/** 发现产物的一段（一个文件的内容——已按护栏截断） */
export interface InstructionSection {
  /** 源文件绝对路径（入段来源标注行用——审计面可核对哪层说了什么） */
  readonly filePath: string;
  /** 文件内容（超 64KiB 已截断并附截断标注） */
  readonly content: string;
}

/** 发现诊断（warning 形态——截断等异常不炸装配） */
export interface InstructionDiagnostic {
  /** 诊断消息（含文件路径归因） */
  readonly message: string;
}

/** 默认发现位置选项（测试注入用） */
export interface DefaultInstructionLocationsOptions {
  /** 主目录覆盖（缺省 os.homedir()） */
  readonly homeDir?: string;
}

/**
 * 指令文件默认发现位置（骨架篇 §7.3 四层——拼接序通用在前、项目殿后）：
 * ① ~/.berry/AGENTS.md（Berry 用户层）② ~/.agents/AGENTS.md（agents.md 跨工具
 * 标准层）③ ~/.claude/CLAUDE.md（CC 生态兼容层——第三处生态直通）④ 工作区根
 * 指令文件（AGENTS.md 优先、否则 CLAUDE.md）。
 */
export function defaultInstructionLocations(
  workspace: string,
  opts?: DefaultInstructionLocationsOptions,
): InstructionLocation[] {
  const home = opts?.homeDir ?? homedir();
  return [
    { dir: join(home, '.berry'), files: ['AGENTS.md'], source: 'user' },
    { dir: join(home, '.agents'), files: ['AGENTS.md'], source: 'user' },
    { dir: join(home, '.claude'), files: ['CLAUDE.md'], source: 'user' },
    { dir: workspace, files: ['AGENTS.md', 'CLAUDE.md'], source: 'project' },
  ];
}

/**
 * 逐层发现并读取指令文件。
 * - 候选缺失（ENOENT）= 常态静默试后备名，全缺 = 本层零段零诊断；
 * - 同层候选 first-wins：前一文件在场即不读后备（单层至多一文件）；
 * - 单文件超 64KiB 截断 + 诊断（内容仍入段，附截断标注）；
 * - 读取失败（权限等非缺失异常）= 诊断后仍试后备候选，不炸装配。
 */
export function discoverInstructions(locations: readonly InstructionLocation[]): {
  sections: InstructionSection[];
  diagnostics: InstructionDiagnostic[];
} {
  const sections: InstructionSection[] = [];
  const diagnostics: InstructionDiagnostic[] = [];
  for (const location of locations) {
    for (const file of location.files) {
      const filePath = join(location.dir, file);
      let raw: Buffer;
      try {
        raw = readFileSync(filePath);
      } catch (err) {
        // ENOENT = 候选缺失（静默试后备名）；其余（权限/是目录等）= 诊断后仍试后备
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        diagnostics.push({
          message: `${filePath}：读取失败（${err instanceof Error ? err.message : String(err)}）——跳过该候选`,
        });
        continue;
      }
      if (raw.length > MAX_INSTRUCTION_BYTES) {
        // 截断以字节为界（utf8 尾字节可能劈开多字节字符——替换符收尾可接受）
        const content = `${raw.subarray(0, MAX_INSTRUCTION_BYTES).toString('utf8')}\n\n[已截断：文件超 ${MAX_INSTRUCTION_BYTES / 1024}KiB 上限]`;
        sections.push({ filePath, content });
        diagnostics.push({
          message: `${filePath}：超 ${MAX_INSTRUCTION_BYTES / 1024}KiB 上限——已截断入段（${location.source} 层）`,
        });
      } else {
        sections.push({ filePath, content: raw.toString('utf8') });
      }
      break; // first-wins：本层已取到文件，不再试后备名
    }
  }
  return { sections, diagnostics };
}

/**
 * 渲染 instructions 段全文：每层一段，来源标注行（路径归因）+ 原文。
 * 无任何文件 → 空串（段在系统提示词拼装时被 filter 掉）。
 */
export function renderInstructions(sections: readonly InstructionSection[]): string {
  return sections.map((section) => `# 指令来源：${section.filePath}\n${section.content.trim()}`).join('\n\n');
}
