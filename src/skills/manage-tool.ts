/**
 * skill_manage 工具（契约篇 §7.1 第 3 条 skill_manage 工具形态，2026-09-03
 * 提示词工程与自进化批规范先行）——技能写入的**受校验便捷形态**。
 *
 * 与 write 工具的关系 = 同一 fence 内的校验加速道：写面恒 project 层
 * （`<workspace>/.agents/skills/<名>/SKILL.md`，⊆ write 可写面——fence 铁律
 * 「用户级目录不在模型可写根」不变；B5 第十一轮遗漏大扫 20260904-b 修死后
 * 铁律由注入的 assertWritable 断言结构性执行——修前「⊆ 可写面」只是头注
 * 宣称，read-only 档直写照穿），只加三件 write 不给的：
 * 结构校验（模型免猜 frontmatter 格式）、写后即时刷新（免人工 /reload）、
 * provenance 结构位（记忆晋升桥 §9.1 第 2 项的写入面）。
 *
 * 三动作：list（清单 + 来源层 + 溯源）/ create（新建，同名任一层已存在 =
 * 响亮拒不覆写）/ patch（正文段单点 find-replace，仅 project 层可改）。
 * 恒 effect:'write'（审批对全族同律）；写成功后经 onChange 回调触发
 * skills.refresh() + 系统提示词重物化（组合根接线——skills_change 事件路同款）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  /**
   * 写面 fence 同律断言（B5——第十一轮遗漏大扫 20260904-b，骨架篇 §7.5 宿主
   * 直写件同律）：写前对目标绝对路径做可写根咨询——write/edit 工具走 tools/fs
   * 管道天然被 fence 拦，本件是宿主直写便捷件不经该管道，铁律由本断言随身
   * 携带（根外抛 `FS_OUTSIDE_WRITABLE_ROOTS` 同码）。组合根以 safety
   * `createRootsProvider({workspace, mode})` 推导源构造注入——与 fs 工具族
   * writableRoots 注入同一 provider（两防线同源不漂移；mode 取值器闭包——
   * 会话档位翻转即时生效，read-only 档空根即拒）。
   */
  readonly assertWritable: (absPath: string) => void;
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
    // 形状 = { memories: [...] }（skill-md parseProvenance 同形——修前渲染序列形
    // 〔`provenance:\n  - id`〕与解析对象形不匹配：真解析器把序列判形状非法丢弃，
    // 溯源字段从未真实往返〔既有测试的 provider 用正则假造对象形遮蔽了这一点〕）
    lines.push('provenance:', '  memories:');
    // id 字符串化转义（遗漏大扫 20260903 skills D3-3）：与 description 同款
    // JSON 字符串——含换行/冒号/引号的 id 原样拼接会注入换行级字段断 YAML
    // （create 回执成功但装载即弃，且坏文件对 skills.get 隐身接通覆写链）
    for (const id of provenance) lines.push(`    - ${JSON.stringify(id)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * 归一化文本中正文区起点（遗漏大扫 20260903 skills D3-2a）：frontmatter 闭合
 * `---` 行之后；无 frontmatter / 未闭合 = 0（整文为正文——边界规则与 skill-md.ts
 * splitFrontmatter 同律）。patch 的查找与替换都限此区间——frontmatter 元数据段
 * 不参与（改元数据 = 重建，不走 patch）。
 */
function bodyStartIndex(text: string): number {
  if (!text.startsWith('---')) return 0;
  const endIndex = text.indexOf('\n---', 3);
  return endIndex === -1 ? 0 : endIndex + 4; // 跳过收尾 '\n---'（其后是正文）
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
  const { skills, projectSkillsDir, assertWritable, onChange } = opts;

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
        // 目录名 = name（§4.2 同名规则——构造保证，validateName 已限字符集无路径穿越面）
        const skillDir = join(projectSkillsDir, req.name);
        const filePath = join(skillDir, 'SKILL.md');
        // 同名拒写（任一层——first-wins 语义下同名新建只会制造 collision 诊断，不如拒在写前）
        const existing = skills.get(req.name);
        if (existing !== undefined) {
          return textResult(
            `技能 ${req.name} 已存在（${existing.source} 层：${existing.filePath}）——不覆写。` +
              '如需改进内容，对项目层技能用 patch；或先由用户删除/改名后重建。',
            true,
          );
        }
        // 盘上判据兜底（遗漏大扫 20260903 skills D3-1）：坏 YAML/缺 description/
        // frontmatter 名不符的盘上文件对注册表 get() 隐身（不入册或以 frontmatter
        // 名入册）——只查在册名会静默覆写毁用户文件且回执成功；盘上在场同样响亮拒
        if (existsSync(filePath)) {
          return textResult(
            `${filePath} 在磁盘上已存在但不在技能注册表（文件可能无法解析或 name 与目录名不符）——不覆写。` +
              '请核对该文件：修复 frontmatter 或删除/改名后重试 create。',
            true,
          );
        }
        const frontmatter = renderFrontmatter(req.name, req.description, req.provenance);
        // 写面 fence 同律（B5）：断言先于 mkdir（filePath ⊆ skillDir——文件在根内
        // 即目录在根内，单点断言双覆盖）；read-only 档空根在此即拒，盘上零痕迹
        assertWritable(filePath);
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
      // 校验域与替换域统一（遗漏大扫 20260903 skills D3-2a）：归一化整文件上校验 +
      // 替换，区间限 frontmatter 闭合 --- 之后——旧实现校验跑解析产物 body、替换跑
      // 原始整文件：find 串同时在 frontmatter 与正文出现时 raw.replace 命中更靠前
      // 的 frontmatter 位（name 被改→孤儿化 / description 命中→断 YAML）；CRLF
      // 文件解析侧已归一而 raw 未归一 → 多行 find 永不命中（合法 patch 误诊拒）。
      // 归一回写 = 本工具写面统一 LF（create 同款输出形态）
      const text = readFileSync(skill.filePath, 'utf-8').replace(/\r\n/g, '\n');
      const start = bodyStartIndex(text);
      const body = text.slice(start);
      // 单点校验：零匹配/多匹配均拒（多点替换的静默歧义不可接受——补上下文重试）
      const first = body.indexOf(req.find);
      if (first === -1) {
        return textResult('find 文本在技能正文中零匹配——核对原文（skill_manage list 后直接 read 该 SKILL.md）。', true);
      }
      if (body.indexOf(req.find, first + 1) !== -1) {
        return textResult('find 文本在正文中多处命中（须恰好一处）——扩大 find 上下文使其唯一。', true);
      }
      // 函数替换形态（遗漏大扫 20260903 skills D3-2b）：replacer 返回值不做
      // $&/$`/$'/$$ 模式展开——技能正文是知识载体，字面 $ 家族不罕见（实测 $`
      // 一次即把 frontmatter+正文前缀整段复制进替换点）；frontmatter 段原样保留。
      // （replaceText 先行捕获：闭包内属性访问失窄化——string|undefined 不匹配
      // replacer 签名）
      const replaceText = req.replace;
      const next = text.slice(0, start) + body.replace(req.find, () => replaceText);
      if (next === text) {
        return textResult('替换后内容与原文相同（find 与 replace 一致？）——未写入。', true);
      }
      // 写面 fence 同律（B5）：直写便捷件不经 tools/fs 管道，可写根铁律随身——
      // read-only 档空根即拒（原文件不动）
      assertWritable(skill.filePath);
      writeFileSync(skill.filePath, next, 'utf-8');
      onChange();
      return textResult(`技能 ${req.name} 已更新并生效（${skill.filePath}）。`);
    },
  };
}
