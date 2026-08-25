/**
 * L5 app — 声明式子代理 `agents/*.md` 解析与发现（契约篇 §4.4 声明式子代理段，
 * 2026-08-26 尾刀落码）。
 *
 * 「文档式轻应用」第一步（第十七批拍板 18 提前 v1）：一个 .md 文件 = 一个具名
 * 子代理——frontmatter name/description/tools/model + 正文即系统提示，CC
 * `.claude/agents/*.md` 同形（继 skills 之后第二大可复用资源，跨库目录直通）。
 *
 * 分层纪律（拓扑）：yaml 裸导入白名单只有 app/skills——**解析层住 app**，
 * provider 机器住 subagent 模块（收本文件产的纯数据 def，零 yaml）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SubagentStart } from '../contracts/subagent.js';

/** 声明式子代理定义（解析产物——纯数据，subagent 侧 provider 工厂消费） */
export interface AgentMdDefinition {
  /** 子代理名（frontmatter name 缺省回落文件基名；须与基名一致——同名纪律） */
  readonly name: string;
  /** 人读描述（必填——披露段清单行 = 模型选择依据） */
  readonly description: string;
  /** 工具 include 名单（可选——与请求 toolFilter 交集执法） */
  readonly tools?: readonly string[];
  /** 子模型覆盖（可选——SubagentStart.model 直传工厂） */
  readonly model?: string;
  /** 正文 = 该子代理的系统提示（声明式 agent 的实体） */
  readonly systemPrompt: string;
  /** 源文件绝对路径（诊断归因） */
  readonly filePath: string;
}

/** 解析诊断（warning 形态——坏文件跳过不炸装配，skills package-missing 同款） */
export interface AgentMdDiagnostic {
  /** 诊断消息（含文件路径归因） */
  readonly message: string;
}

/** frontmatter 可选字段的宽松形状（YAML parse 后手工收形） */
interface AgentFrontmatter {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
}

/**
 * 拆 frontmatter 与正文（与 skills/skill-md 同款宽容语义：无 `---` 开头或未
 * 闭合 = 无 frontmatter 整文为正文，交由 description 必填校验兜底拒绝）。
 */
function splitFrontmatter(content: string): { frontmatter: AgentFrontmatter; body: string } {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---')) return { frontmatter: {}, body: normalized };
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) return { frontmatter: {}, body: normalized };
  const yamlText = normalized.slice(4, endIndex); // 跳过开头 '---\n'
  const body = normalized.slice(endIndex + 4).trim(); // 跳过收尾 '\n---'
  return { frontmatter: (parseYaml(yamlText) ?? {}) as AgentFrontmatter, body };
}

/**
 * 解析一份 agents/*.md 内容为子代理定义。
 * 诊断语义（坏文件跳过不炸装配）：
 * - YAML 坏 / description 缺失或非字符串 / 正文空 → 返回 null + 诊断；
 * - frontmatter name 提供但与文件基名不符 → 诊断（同名纪律——防文件名与注册名漂移）；
 * - tools 非字符串数组 / model 非字符串 → 诊断（字段忽略）。
 *
 * @param content 文件全文
 * @param filePath 源文件绝对路径（name 回落 + 诊断归因）
 */
export function parseAgentMd(
  content: string,
  filePath: string,
): {
  definition: AgentMdDefinition | null;
  diagnostics: AgentMdDiagnostic[];
} {
  const diagnostics: AgentMdDiagnostic[] = [];
  const fileStem = basename(filePath, '.md');

  let split: ReturnType<typeof splitFrontmatter>;
  try {
    split = splitFrontmatter(content);
  } catch (err) {
    return {
      definition: null,
      diagnostics: [
        { message: `${filePath}：frontmatter YAML 解析失败：${err instanceof Error ? err.message : String(err)}` },
      ],
    };
  }

  // name：缺省回落文件基名；提供时须一致（skills 同名纪律同构）
  const frontName = typeof split.frontmatter.name === 'string' ? split.frontmatter.name : undefined;
  const name = frontName ?? fileStem;
  if (frontName !== undefined && frontName !== fileStem) {
    diagnostics.push({
      message: `${filePath}：frontmatter name "${frontName}" 与文件基名 "${fileStem}" 不同名（以 frontmatter 为准注册——建议改名对齐）`,
    });
  }

  // description：唯一硬门槛（披露段清单行没有描述 = 模型不可选用）
  const description = split.frontmatter.description;
  if (typeof description !== 'string' || description.trim() === '') {
    return {
      definition: null,
      diagnostics: [{ message: `${filePath}：description 必填（非空字符串）——跳过该声明式子代理` }],
    };
  }

  // 正文 = 系统提示（实体不可空）
  if (split.body.trim() === '') {
    return {
      definition: null,
      diagnostics: [{ message: `${filePath}：正文为空（正文即系统提示）——跳过该声明式子代理` }],
    };
  }

  // tools：字符串数组（否则忽略 + 诊断）
  let tools: readonly string[] | undefined;
  if (split.frontmatter.tools !== undefined) {
    if (Array.isArray(split.frontmatter.tools) && split.frontmatter.tools.every((t) => typeof t === 'string')) {
      tools = split.frontmatter.tools as string[];
    } else {
      diagnostics.push({ message: `${filePath}：tools 须为字符串数组——字段忽略` });
    }
  }

  // model：字符串（否则忽略 + 诊断）
  let model: string | undefined;
  if (split.frontmatter.model !== undefined) {
    if (typeof split.frontmatter.model === 'string') {
      model = split.frontmatter.model;
    } else {
      diagnostics.push({ message: `${filePath}：model 须为字符串——字段忽略` });
    }
  }

  return {
    definition: {
      name,
      description,
      ...(tools !== undefined ? { tools } : {}),
      ...(model !== undefined ? { model } : {}),
      systemPrompt: split.body,
      filePath,
    },
    diagnostics,
  };
}

/** 声明式子代理发现位置（§4.4 四处镜像——skills 同构） */
export interface AgentLocation {
  /** 扫描目录（绝对路径） */
  readonly dir: string;
  /** 来源层级（信任判定与诊断归因用） */
  readonly source: 'project' | 'user';
}

/** 默认发现位置选项（测试注入用） */
export interface DefaultAgentLocationsOptions {
  /** 工作区是否受信（project 层仅在受信时注入——防恶意仓库，同 skills ①） */
  readonly trusted?: boolean;
  /** 主目录覆盖（缺省 os.homedir()） */
  readonly homeDir?: string;
}

/**
 * 声明式子代理默认发现位置（契约篇 §4.4 声明式段落码注记①——镜像技能四处）：
 * ① workspace/.agents/agents（project 层，需目录信任——现状缺省放行同 skills）；
 * ② ~/.berry/agents（用户全局）；
 * ③ ~/.agents/agents 与 ~/.claude/agents（跨库直通——CC `.claude/agents/*.md`
 *    生态复用，「继 skills 之后第二大可复用资源」兑现）。
 */
export function defaultAgentLocations(workspace: string, opts?: DefaultAgentLocationsOptions): AgentLocation[] {
  const home = opts?.homeDir ?? homedir();
  const locations: AgentLocation[] = [];
  if (opts?.trusted) {
    locations.push({ dir: join(workspace, '.agents', 'agents'), source: 'project' });
  }
  locations.push({ dir: join(home, '.berry', 'agents'), source: 'user' });
  locations.push({ dir: join(home, '.agents', 'agents'), source: 'user' });
  locations.push({ dir: join(home, '.claude', 'agents'), source: 'user' });
  return locations;
}

/**
 * 扫描发现位置目录下的全部 *.md 为子代理定义。
 * - 目录缺失 = 常态静默（空结果零诊断——用户没写过 agent 文件不是异常）；
 * - 只读目录一层（agents/*.md 是散文件形态——与 skills「每目录一份 SKILL.md」
 *   不同：CC 同形即每文件一个 agent）；
 * - 同名 first-wins 由调用方扫描序表达（返回序 = locations 序，前面的压后面）。
 */
export function discoverAgentMds(locations: readonly AgentLocation[]): {
  definitions: AgentMdDefinition[];
  diagnostics: AgentMdDiagnostic[];
} {
  const definitions: AgentMdDefinition[] = [];
  const diagnostics: AgentMdDiagnostic[] = [];
  const seen = new Set<string>();
  for (const location of locations) {
    let entries: Dirent[];
    try {
      entries = readdirSync(location.dir, { withFileTypes: true });
    } catch {
      continue; // 目录缺失 = 常态静默
    }
    // 目录序稳定化（readdirSync 不保序——按名排序保证同名冲突判定确定性）
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = join(location.dir, entry.name);
      const result = parseAgentMd(readFileSync(filePath, 'utf8'), filePath);
      diagnostics.push(...result.diagnostics);
      if (result.definition === null) continue;
      if (seen.has(result.definition.name)) {
        diagnostics.push({
          message: `${filePath}：与已注册声明式子代理 "${result.definition.name}" 同名——first-wins，后者跳过`,
        });
        continue;
      }
      seen.add(result.definition.name);
      definitions.push(result.definition);
    }
  }
  return { definitions, diagnostics };
}

/**
 * 构造声明式 agent 的请求合并函数（in-process provider 的 mergeRequest 钩子）：
 * 正文写 persona、tools 与请求 toolFilter 交集、model 覆盖。合并只收窄不改宽
 * （能力协商在合并前的原始请求上已过）。
 */
export function mergeRequestForAgentMd(def: AgentMdDefinition): (request: SubagentStart) => SubagentStart {
  return (request) => ({
    ...request,
    persona: def.systemPrompt,
    ...(def.tools !== undefined
      ? {
          // 请求侧未给名单 = 全量 → 用 def.tools；给了 = 交集（两侧白名单同时执法）
          toolFilter:
            request.toolFilter === undefined
              ? def.tools
              : def.tools.filter((tool) => request.toolFilter!.includes(tool)),
        }
      : {}),
    ...(def.model !== undefined ? { model: def.model } : {}),
  });
}
