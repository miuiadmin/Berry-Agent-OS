/**
 * skill_manage 工具（契约篇 §7.1 第 3 条 skill_manage 工具形态，2026-09-03
 * 提示词工程与自进化批规范先行）——技能写入的**受校验便捷形态**。
 *
 * 与 write 工具的关系 = 同一 fence 内的校验加速道：写面恒 project 层
 * （`<workspace>/.agents/skills/<名>/SKILL.md`，⊆ write 可写面——fence 铁律
 * 「用户级目录不在模型可写根」不变），只加三件 write 不给的：
 * 结构校验（模型免猜 frontmatter 格式）、写后即时刷新（免人工 /reload）、
 * provenance 结构位（记忆晋升桥 §9.1 第 2 项的写入面）。
 *
 * 三动作：list（清单 + 来源层 + 溯源）/ create（新建，同名任一层已存在 =
 * 响亮拒不覆写）/ patch（正文段单点 find-replace，仅 project 层可改）。
 * 恒 effect:'write'（审批对全族同律）；写成功后经 onChange 回调触发
 * skills.refresh() + 系统提示词重物化（组合根接线——skills_change 事件路同款）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '../contracts/typebox.js';
import { AppError, TOOL_ARGUMENTS_INVALID } from '../contracts/errors.js';
import type { AgentToolResult, ToolDefinition } from '../contracts/tools.js';
import type { SkillsService } from './types.js';
import { validateSkillDescription } from './skill-md.js';

/** 构造参数（组合根注入：技能服务 + project 层目录 + 写后刷新回调） */
export interface SkillManageToolOptions {
  /** 技能服务（list 取数 / get 解析 patch 目标） */
  readonly skills: SkillsService;
  /** project 层技能目录（`<workspace>/.agents/skills`——写面唯一去处） */
  readonly projectSkillsDir: string;
  /** 写成功后回调（组合根接 skills.refresh + 全条目重物化；本件不持装配知识） */
  readonly onChange: () => void;
}

/** name 校验（§4.2 同源四条——父目录同名一条由本件的「目录名 = name」构造保证） */
function validateName(name: string): string[] {
  const errors: string[] = [];
  if (name.length > 64) errors.push(`name 超长（${name.length} > 64）`);
  if (!/^[a-z0-9-]+$/.test(name)) errors.push('name 含非法字符（仅许小写字母/数字/连字符）');
  if (name.startsWith('-') || name.endsWith('-')) errors.push('name 首尾不得为连字符');
  if (name.includes('--')) errors.push('name 不得含连续连字符');
  return errors;
}

/** frontmatter 序列化（provenance 可选——形状已由参数 schema 限定 ≤50 条） */
function renderFrontmatter(name: string, description: string, provenance?: readonly string[]): string {
  const lines = ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`];
  if (provenance !== undefined && provenance.length > 0) {
    lines.push('provenance:');
    for (const id of provenance) lines.push(`  - ${id}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/** 结果文本助手（工具回执统一纯文本面） */
function textResult(content: string, isError = false): AgentToolResult {
  // 成功路径省略 isError（契约：缺省 false = 正常——不显式写 false）
  return isError
    ? { content: [{ type: 'text', text: content }], isError: true }
    : { content: [{ type: 'text', text: content }] };
}

/**
 * 组装 skill_manage 工具（组合根 ⑦ 段全局注册——与 skills 服务同源 Ring 1 基建）。
 */
export function createSkillManageTool(opts: SkillManageToolOptions): ToolDefinition {
  const { skills, projectSkillsDir, onChange } = opts;

  return {
    name: 'skill_manage',
    label: '技能管理',
    effect: 'write',
    description: [
      '管理技能库（SKILL.md）：list 列出全部技能（名称/来源层/描述/溯源）；',
      'create 新建技能到项目层 .agents/skills/<名>/SKILL.md（frontmatter 自动生成——只需给 name/description/content；',
      '可选 provenance.memories 标注源自哪些记忆条目〔记忆晋升时用〕）；',
      'patch 对已有项目层技能的正文做单点查找替换（find 须恰好命中一处）。',
      '写成功后技能立即生效（渐进披露清单自动更新，无需 /reload）。',
      '注意：只能写项目层——用户级/出厂层技能的修改属用户本人操作。',
    ].join(''),
    parameters: Type.Object({
      action: Type.Union([Type.Literal('list'), Type.Literal('create'), Type.Literal('patch')], {
        description: '动作：list 清单 / create 新建 / patch 定点改正文',
      }),
      name: Type.Optional(Type.String({ description: '技能名（create/patch 必填；小写字母/数字/连字符，≤64）' })),
      description: Type.Optional(
        Type.String({ description: '技能描述（create 必填；≤1024——渐进披露清单的一行成本，写清触发条件）' }),
      ),
      content: Type.Optional(
        Type.String({
          description: '技能正文（create 必填——Markdown 指令体；写「做什么/为什么/怎么验」，勿编码模型自身癖性',
        }),
      ),
      provenance: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: 50,
          description: '溯源记忆条目 id 列表（记忆晋升为技能时填写——可选，≤50）',
        }),
      ),
      find: Type.Optional(Type.String({ description: 'patch：要查找的文本（须在正文中恰好出现一次）' })),
      replace: Type.Optional(Type.String({ description: 'patch：替换文本' })),
    }),
    execute: async (args): Promise<AgentToolResult> => {
      const req = args as {
        action: 'list' | 'create' | 'patch';
        name?: string;
        description?: string;
        content?: string;
        provenance?: string[];
        find?: string;
        replace?: string;
      };

      /* ---- list：清单 + 来源层 + 溯源（诊断面只读，含隐藏技能） ---- */
      if (req.action === 'list') {
        const list = skills.list();
        if (list.length === 0) return textResult('技能库为空。create 动作可新建第一个技能。');
        const sourceLabels: Record<string, string> = { project: '项目层', user: '用户层', package: '出厂层' };
        const lines = list.map((skill) => {
          const hidden = skill.disableModelInvocation ? '（隐藏——仅显式 /skill: 调用）' : '';
          const prov =
            skill.provenance !== undefined && skill.provenance.memories.length > 0
              ? `（溯源 ${skill.provenance.memories.length} 条记忆）`
              : '';
          return `- ${skill.name} [${sourceLabels[skill.source] ?? skill.source}]${hidden}${prov}：${skill.description}`;
        });
        return textResult(`技能库（${list.length} 个）：\n${lines.join('\n')}`);
      }

      /* ---- 公共前置：name 必填 + 字符集校验 ---- */
      if (req.name === undefined || req.name === '') {
        throw new AppError(TOOL_ARGUMENTS_INVALID, 'skill_manage：create/patch 动作必填 name');
      }
      const nameErrors = validateName(req.name);
      if (nameErrors.length > 0) {
        throw new AppError(TOOL_ARGUMENTS_INVALID, `skill_manage：name 校验不过——${nameErrors.join('；')}`);
      }

      /* ---- create：写 project 层 SKILL.md（同名任一层已存在 = 拒） ---- */
      if (req.action === 'create') {
        if (req.description === undefined || req.description === '') {
          throw new AppError(TOOL_ARGUMENTS_INVALID, 'skill_manage：create 动作必填 description');
        }
        const descErrors = validateSkillDescription(req.description);
        if (descErrors.length > 0) {
          throw new AppError(TOOL_ARGUMENTS_INVALID, `skill_manage：description 校验不过——${descErrors.join('；')}`);
        }
        if (req.content === undefined || req.content.trim() === '') {
          throw new AppError(TOOL_ARGUMENTS_INVALID, 'skill_manage：create 动作必填 content（非空正文）');
        }
        // 同名拒写（任一层——first-wins 语义下同名新建只会制造 collision 诊断，不如拒在写前）
        const existing = skills.get(req.name);
        if (existing !== undefined) {
          return textResult(
            `技能 ${req.name} 已存在（${existing.source} 层：${existing.filePath}）——不覆写。` +
              '如需改进内容，对项目层技能用 patch；或先由用户删除/改名后重建。',
            true,
          );
        }
        // 目录名 = name（§4.2 同名规则——构造保证，validateName 已限字符集无路径穿越面）
        const skillDir = join(projectSkillsDir, req.name);
        const filePath = join(skillDir, 'SKILL.md');
        const frontmatter = renderFrontmatter(req.name, req.description, req.provenance);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(filePath, `${frontmatter}${req.content}\n`, 'utf-8');
        onChange();
        return textResult(
          `技能 ${req.name} 已创建并生效（${filePath}）。渐进披露清单已更新——后续会话按 description 自动可用。`,
        );
      }

      /* ---- patch：正文段单点 find-replace（仅 project 层） ---- */
      const skill = skills.get(req.name);
      if (skill === undefined) {
        return textResult(`技能 ${req.name} 不存在——skill_manage list 可查全部技能名。`, true);
      }
      if (skill.source !== 'project') {
        return textResult(
          `技能 ${req.name} 属${skill.source === 'user' ? '用户' : '出厂'}层（${skill.filePath}）——模型只可改项目层技能；` +
            '该技能的修改请由用户本人编辑文件。',
          true,
        );
      }
      if (req.find === undefined || req.find === '') {
        throw new AppError(TOOL_ARGUMENTS_INVALID, 'skill_manage：patch 动作必填 find');
      }
      if (req.replace === undefined) {
        throw new AppError(
          TOOL_ARGUMENTS_INVALID,
          'skill_manage：patch 动作必填 replace（替换为空串 = 删除该段，合法）',
        );
      }
      // 单点校验：零匹配/多匹配均拒（多点替换的静默歧义不可接受——补上下文重试）
      const first = skill.content.indexOf(req.find);
      if (first === -1) {
        return textResult('find 文本在技能正文中零匹配——核对原文（skill_manage list 后直接 read 该 SKILL.md）。', true);
      }
      if (skill.content.indexOf(req.find, first + 1) !== -1) {
        return textResult('find 文本在正文中多处命中（须恰好一处）——扩大 find 上下文使其唯一。', true);
      }
      // 原文件 = frontmatter + 正文；frontmatter 原样保留（改元数据 = 重建，不走 patch）
      const raw = readFileSync(skill.filePath, 'utf-8');
      const next = raw.replace(req.find, req.replace);
      if (next === raw) {
        return textResult('替换后内容与原文相同（find 与 replace 一致？）——未写入。', true);
      }
      writeFileSync(skill.filePath, next, 'utf-8');
      onChange();
      return textResult(`技能 ${req.name} 已更新并生效（${skill.filePath}）。`);
    },
  };
}
