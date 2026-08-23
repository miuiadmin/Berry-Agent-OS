/**
 * L3 skills — SKILL.md 解析与校验（契约篇 §4.2，agentskills.io 标准）。
 *
 * frontmatter 字段：name（≤64、小写连字符与数字、须与父目录同名）、
 * description（≤1024 必填）、disable-model-invocation（可选 CC 扩展）。
 * 未知字段容忍——metadata 是规范认可的客户端扩展槽，不私造校验。
 *
 * 宽容度语义（随 pi）：name/description 校验不过发 warning 诊断但技能
 * 仍加载；仅 description 缺失/为空才整体拒绝——清单里没有描述的技能
 * 对模型无意义。纯函数模块，不触文件系统（读盘在 discovery.ts）。
 */

import { basename, dirname } from 'node:path';
import { parse } from 'yaml';
import type { Skill, SkillDiagnostic, SkillSourceLevel } from './types.js';

/** name 长度上限（agentskills.io 标准） */
const MAX_NAME_LENGTH = 64;
/** description 长度上限（agentskills.io 标准） */
const MAX_DESCRIPTION_LENGTH = 1024;

/** frontmatter 可识别字段（未知字段容忍不报错） */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  'disable-model-invocation'?: boolean;
  [key: string]: unknown;
}

/**
 * 拆 frontmatter 与正文。无 `---` 开头或未闭合 → 无 frontmatter、整文为正文
 * （随 pi：宽容处理，交由 description 必填校验兜底拒绝）。
 * YAML 非法时 `parse` 抛错——调用方（parseSkillMd）负责转诊断。
 */
export function splitFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  // 行尾归一（CRLF/CR → LF），frontmatter 定界与 body 截取都在归一化文本上进行
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---')) return { frontmatter: {}, body: normalized };
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) return { frontmatter: {}, body: normalized };
  const yamlText = normalized.slice(4, endIndex); // 跳过开头 '---\n'
  const body = normalized.slice(endIndex + 4).trim(); // 跳过收尾 '\n---'
  return { frontmatter: (parse(yamlText) ?? {}) as SkillFrontmatter, body };
}

/**
 * name 校验（§4.2 四条）：≤64、`^[a-z0-9-]+$`、首尾与连续连字符禁止、
 * 须与父目录同名。返回错误信息数组（空 = 通过）。
 */
export function validateSkillName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];
  if (name !== parentDirName) errors.push(`name "${name}" 与父目录 "${parentDirName}" 不同名（标准要求同名）`);
  if (name.length > MAX_NAME_LENGTH) errors.push(`name 超长（${name.length} > ${MAX_NAME_LENGTH}）`);
  if (!/^[a-z0-9-]+$/.test(name)) errors.push('name 含非法字符（仅许小写字母/数字/连字符）');
  if (name.startsWith('-') || name.endsWith('-')) errors.push('name 首尾不得为连字符');
  if (name.includes('--')) errors.push('name 不得含连续连字符');
  return errors;
}

/** description 校验（§4.2）：必填非空字符串、≤1024。返回错误信息数组（空 = 通过） */
export function validateSkillDescription(description: unknown): string[] {
  const errors: string[] = [];
  if (typeof description !== 'string' || description.trim() === '') {
    errors.push('description 必填（非空字符串）');
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description 超长（${description.length} > ${MAX_DESCRIPTION_LENGTH}）`);
  }
  return errors;
}

/**
 * 解析一段 SKILL.md 内容为技能。诊断语义：
 * - 坏 YAML → parse-failed + 整体拒绝；
 * - name/description 校验不过 → invalid-metadata 警告但技能仍加载；
 * - description 缺失/为空 → 唯一的整体拒绝条件（skill 为 null）。
 */
export function parseSkillMd(
  content: string,
  filePath: string,
  source: SkillSourceLevel,
): { skill: Skill | null; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];

  let split: ReturnType<typeof splitFrontmatter>;
  try {
    split = splitFrontmatter(content);
  } catch (err) {
    diagnostics.push({
      type: 'warning',
      code: 'parse-failed',
      message: `frontmatter YAML 解析失败：${err instanceof Error ? err.message : String(err)}`,
      path: filePath,
    });
    return { skill: null, diagnostics };
  }

  const baseDir = dirname(filePath);
  const parentDirName = basename(baseDir);

  // description：唯一硬门槛（清单行没有描述 = 对模型不可见可选用）
  const description = split.frontmatter.description;
  const hasDescription = typeof description === 'string' && description.trim() !== '';
  for (const error of validateSkillDescription(description)) {
    diagnostics.push({ type: 'warning', code: 'invalid-metadata', message: error, path: filePath });
  }

  // name：frontmatter 缺省回落父目录名（回落值天然满足同名要求）
  const frontmatterName = typeof split.frontmatter.name === 'string' ? split.frontmatter.name : undefined;
  const name = frontmatterName || parentDirName;
  for (const error of validateSkillName(name, parentDirName)) {
    diagnostics.push({ type: 'warning', code: 'invalid-metadata', message: error, path: filePath });
  }

  if (!hasDescription) return { skill: null, diagnostics };

  return {
    skill: {
      name,
      description,
      content: split.body,
      filePath,
      baseDir,
      source,
      disableModelInvocation: split.frontmatter['disable-model-invocation'] === true,
    },
    diagnostics,
  };
}

/**
 * §4.5(b) 显式激活包装：技能全文包为具名 skill 块注入对话（`/skill:name args`
 * 的 args 作为追加指令拼在块后）。提示文案随 pi/agentskills 惯例用英文
 * （模型面文本，非用户面 UI 文案）。
 */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.content}\n</skill>`;
  return additionalInstructions ? `${block}\n\n${additionalInstructions}` : block;
}
