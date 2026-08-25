/**
 * L3 skills — 本地文件系统发现（契约篇 §4.4）。
 *
 * 扫描规则（随 pi）：
 * - 目录含 SKILL.md 即为技能根，加载后不再递归其子目录（SKILL.md 被
 *   gitignore 的目录不算技能根，继续向下递归找）；
 * - 否则递归子目录（点开头条目与 node_modules 跳过）；
 * - 尊重 .gitignore（根与逐目录生效，模式按所在目录前缀化）；
 * - symlink 跟随（stat 目标判型；断链跳过）；同真实路径去重发生在服务层。
 *
 * 优先级由调用方给定的位置顺序表达（project > user > package），
 * 同名 first-wins 合并在服务层（registry.ts）。目录信任不在本模块——
 * project 位置仅在受信时由调用方（app 装配层）注入。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import ignore from 'ignore';
import { parseSkillMd } from './skill-md.js';
import type { Dirent } from 'node:fs';
import type { Skill, SkillDiagnostic, SkillLocation, SkillSourceLevel, SkillsProvider } from './types.js';

/** gitignore 匹配器类型（ignore 包工厂返回值） */
type IgnoreMatcher = ReturnType<typeof ignore>;

/** 平台路径分隔符归一为 /（gitignore 模式语义在 posix 路径上） */
function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * 判定目录条目真实形态（file / directory）。symlink 跟随目标 stat
 * （断链或 stat 失败按不存在处理——不诊断不断流，跳过即可）。
 */
function entryKind(fullPath: string, entry: Dirent): 'file' | 'directory' | undefined {
  if (entry.isSymbolicLink()) {
    try {
      const stats = statSync(fullPath);
      return stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : undefined;
    } catch {
      return undefined;
    }
  }
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  return undefined;
}

/**
 * 读取 dir 下 .gitignore 并把模式按所在目录前缀化后挂上匹配器
 * （嵌套 .gitignore 的模式只作用于其所在目录子树）。文件不存在/读失败静默跳过。
 */
function addIgnoreRules(matcher: IgnoreMatcher, dir: string, rootDir: string): void {
  const relativeDir = relative(rootDir, dir);
  const prefix = relativeDir ? `${toPosix(relativeDir)}/` : '';

  const ignorePath = join(dir, '.gitignore');
  if (!existsSync(ignorePath)) return;
  let content: string;
  try {
    content = readFileSync(ignorePath, 'utf-8');
  } catch {
    return;
  }
  const patterns = content
    .split(/\r?\n/)
    .map((line) => prefixIgnorePattern(line, prefix))
    .filter((line): line is string => Boolean(line));
  if (patterns.length > 0) matcher.add(patterns);
}

/** 单行 gitignore 模式前缀化（注释/空行丢弃；`!` 否定与 `\!`/`\#` 转义保留） */
function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#') && !trimmed.startsWith('\\#')) return null;

  let pattern = line;
  let negated = false;
  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('\\!')) {
    pattern = pattern.slice(1);
  }
  // 锚定根的模式去掉前导 / 后再前缀化（相对本目录）
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

/** 读单个 SKILL.md 文件并解析（读失败 → read-failed 诊断） */
function loadSkillFile(
  filePath: string,
  source: SkillSourceLevel,
): { skill: Skill | null; diagnostics: SkillDiagnostic[] } {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      skill: null,
      diagnostics: [
        {
          type: 'warning',
          code: 'read-failed',
          message: `SKILL.md 读取失败：${err instanceof Error ? err.message : String(err)}`,
          path: filePath,
        },
      ],
    };
  }
  return parseSkillMd(raw, filePath, source);
}

/** 扫描结果（skills 按发现顺序；同名优先级裁决在服务层） */
interface ScanResult {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

/**
 * 递归扫描单个目录（内部入口：rootDir 维持 gitignore 相对化锚点）。
 * 条目按名排序保证发现顺序确定性。
 */
function scanDir(dir: string, source: SkillSourceLevel, matcher: IgnoreMatcher, rootDir: string): ScanResult {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    diagnostics.push({
      type: 'warning',
      code: 'list-failed',
      message: `目录列举失败：${err instanceof Error ? err.message : String(err)}`,
      path: dir,
    });
    return { skills, diagnostics };
  }

  // 读取本目录 .gitignore（嵌套模式仅作用于本子树）
  addIgnoreRules(matcher, dir, rootDir);

  // 第一遍：本目录直接含 SKILL.md → 即为技能根（加载即止，不递归）
  const skillMd = entries.find((entry) => entry.name === 'SKILL.md');
  if (skillMd) {
    const fullPath = join(dir, 'SKILL.md');
    const isFile = entryKind(fullPath, skillMd) === 'file';
    const ignored = isFile && matcher.ignores(toPosix(relative(rootDir, fullPath)));
    if (isFile && !ignored) {
      const loaded = loadSkillFile(fullPath, source);
      if (loaded.skill) skills.push(loaded.skill);
      diagnostics.push(...loaded.diagnostics);
      // 技能根：无论加载成败都不再递归（子目录内容属于技能资源，不是子技能）
      return { skills, diagnostics };
    }
    // SKILL.md 缺失/非文件/被忽略 → 该目录不是技能根，落入第二遍递归
  }

  // 第二遍：递归子目录继续找技能根（点开头与 node_modules 跳过）
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const fullPath = join(dir, entry.name);
    const kind = entryKind(fullPath, entry);
    if (kind !== 'directory') continue; // M1 只认目录形态技能（pi 的散 .md 根文件扩展不采用）

    const relPath = `${toPosix(relative(rootDir, fullPath))}/`;
    if (matcher.ignores(relPath)) continue;

    const sub = scanDir(fullPath, source, matcher, rootDir);
    skills.push(...sub.skills);
    diagnostics.push(...sub.diagnostics);
  }

  return { skills, diagnostics };
}

/** 扫描一个发现位置（目录不存在 → 空产物零诊断：缺目录是常态非异常） */
export function scanSkillLocation(location: SkillLocation): ScanResult {
  if (!existsSync(location.dir)) return { skills: [], diagnostics: [] };
  return scanDir(location.dir, location.source, ignore(), location.dir);
}

/** 本地 FS provider 选项 */
export interface LocalSkillsProviderOptions {
  /** 发现位置列表（顺序即优先级：project > user > package 由调用方排好） */
  readonly locations: readonly SkillLocation[];
}

/**
 * 默认本地 FS provider（骨架篇 §9.2「本地文件系统为默认 provider」）。
 * list() 每次现扫——服务 refresh 即全量重载，无缓存层。
 */
export function createLocalSkillsProvider(opts: LocalSkillsProviderOptions): SkillsProvider {
  return {
    id: 'local-fs',
    list() {
      const skills: Skill[] = [];
      const diagnostics: SkillDiagnostic[] = [];
      for (const location of opts.locations) {
        const result = scanSkillLocation(location);
        skills.push(...result.skills);
        diagnostics.push(...result.diagnostics);
      }
      return { skills, diagnostics };
    },
  };
}

/** 包层技能 provider 选项（技能包插件——契约篇 §1.2 named export 第六件） */
export interface PackageSkillsProviderOptions {
  /** 插件声明 name（provider id = `package:<name>`，诊断溯源） */
  readonly pluginName: string;
  /** 插件包根（skills 声明相对路径的解析锚点 = 入口文件所在目录） */
  readonly packageRoot: string;
  /** skills named export 声明的技能目录清单（相对 packageRoot；空数组 = 零技能零诊断） */
  readonly dirs: readonly string[];
}

/**
 * 包层技能 provider（技能包插件工厂，2026-08-26 技能包插件纵切）。
 *
 * 每个声明了 `skills` 的插件行一个实例（组合根经 loadPlugins 注册回调桥接——
 * 拓扑 seam：context 不引 skills 模块）。list() 每次现扫：
 * - 目录存在 → 复用 scanSkillLocation 以 `source: 'package'` 扫描（gitignore
 *   语义、SKILL.md 技能根判定等与 project/user 层同规）；
 * - 目录缺失 → `package-missing` warning 诊断（声明了却缺失是真异常，与
 *   project/user 层「缺目录是常态刻意静默」相反）——不杀行：行主体可用就
 *   不因技能目录缺失回卷，禁用 plugin/skipped（会破「激活行集合 === 非禁用行
 *   − 已发 skipped」运行时不变式）。
 *
 * 优先级：provider 注册序即合并优先序（first-wins 不读 source 字段）——
 * local-fs（装配序 ⑦）先注册、插件行（装配序 ⑨）后注册，包内技能恒居最低层。
 */
export function createPackageSkillsProvider(opts: PackageSkillsProviderOptions): SkillsProvider {
  return {
    id: `package:${opts.pluginName}`,
    list() {
      const skills: Skill[] = [];
      const diagnostics: SkillDiagnostic[] = [];
      for (const dir of opts.dirs) {
        const abs = resolve(opts.packageRoot, dir);
        if (!existsSync(abs)) {
          diagnostics.push({
            type: 'warning',
            code: 'package-missing',
            message: `插件「${opts.pluginName}」声明的技能目录不存在：${dir}`,
            path: abs,
          });
          continue;
        }
        const result = scanSkillLocation({ dir: abs, source: 'package' });
        skills.push(...result.skills);
        diagnostics.push(...result.diagnostics);
      }
      return { skills, diagnostics };
    },
  };
}

/** 默认发现位置选项 */
export interface DefaultSkillLocationsOptions {
  /** 工作区是否受信（project 层仅在受信时注入——防恶意仓库，§4.4 ①） */
  readonly trusted?: boolean;
  /** 主目录覆盖（缺省 os.homedir()；测试注入用） */
  readonly homeDir?: string;
}

/**
 * §4.4 发现位置清单的 M1 落地面（三处；包内约定目录与 resources_discover
 * 钩子属 package 层/插件期，随插件基建落地）：
 * ① workspace/.agents/skills（project 层，需目录信任）；
 * ② ~/.berry/skills（用户全局，无需信任）；
 * ③ ~/.agents/skills 与 ~/.claude/skills（跨库生态复用，user 层）。
 */
export function defaultSkillLocations(workspace: string, opts?: DefaultSkillLocationsOptions): SkillLocation[] {
  const home = opts?.homeDir ?? homedir();
  const locations: SkillLocation[] = [];
  // ① 项目内（最高优先；未受信工作区不扫 project 层）
  if (opts?.trusted) {
    locations.push({ dir: join(workspace, '.agents', 'skills'), source: 'project' });
  }
  // ② 用户全局技能目录
  locations.push({ dir: join(home, '.berry', 'skills'), source: 'user' });
  // ③ 跨库目录（agentskills.io 生态两目录原生扫描）
  locations.push({ dir: join(home, '.agents', 'skills'), source: 'user' });
  locations.push({ dir: join(home, '.claude', 'skills'), source: 'user' });
  return locations;
}
