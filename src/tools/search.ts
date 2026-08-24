/**
 * L2 tools — 检索族工具（find / grep——Ring 1 七件套检索两件，契约篇 §5.1 枚举；
 * 设计依据 = [出厂全家桶与下限差距] §2.2 拍板 a「Ring 1 七件套补齐」）。
 *
 * 设计要点：
 * - 纯 TS 首发：node:fs 遍历 + `ignore` 包 gitignore 语义 + 手写 glob→RegExp
 *   （`*` 段内 / `**` 跨任意层目录 / `?` 单字符）——零新依赖零新概念（ripgrep
 *   外部二进制已被技术栈篇 §2「native 依赖唯一宿主 persist」纪律否决；性能
 *   大库场景挂账观察）；glob 匹配器不引第三方包同理； * - 遍历语义：尊重逐目录 .gitignore（嵌套规则按所在目录前缀化——与
 *   skills/discovery 同语义；两个消费者暂各自实现，第三个消费者出现再议共享，
 *   架构优雅定律），常量剪枝 node_modules / .git；不跟随符号链（防环；
 *   symlink 文件同样不进结果——Dirent.isFile 对符号链返回 false）；
 * - 护栏复用 read 工具口径：单文件扫描截断 maxScanBytes（缺省 256 KiB）、
 *   输出条数上限 maxResults（缺省 200，达限早停）、二进制文件（前 8 KiB 含
 *   NUL 字节）跳过并计数；
 * - 只读族天然免批（effect: 'read'，第十一批 #4 元数据拍板）；不登记观察态
 *   （与 ls 同判：检索是扫描不是精读，CAS 的「观察」只锚 read 工具——
 *   grep 命中行不构成对文件的完整内容观察）；
 * - 参数语法错（正则编译失败 / glob 非法）复用 TOOL_ARGUMENTS_INVALID，
 *   不新增错误码（错误码注册表零膨胀）。
 */

import { open, readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import ignore from 'ignore';
import { Type } from 'typebox';
import { AppError, TOOL_ARGUMENTS_INVALID } from '../contracts/errors.js';
import type { AgentToolResult, ToolDefinition } from '../contracts/tools.js';

/** 检索族选项（app 装配层注入；与 FsToolsOptions 同风格） */
export interface SearchToolsOptions {
  /** 工作区锚点（相对路径 resolve 基准；缺省 process.cwd()） */
  workspace?: () => string;
  /** 单文件扫描截断上限字节（缺省 256 KiB，与 read 的 maxReadBytes 同口径） */
  maxScanBytes?: number;
  /** 输出条数上限（缺省 200——find 的路径条数 / grep 的命中文件数或行数；达限早停） */
  maxResults?: number;
}

/** 检索族产物：find + grep 两件工具定义 */
export interface SearchTools {
  tools: ToolDefinition[];
}

/** gitignore 匹配器类型（ignore 包工厂返回值——与 skills/discovery 同款） */
type IgnoreMatcher = ReturnType<typeof ignore>;

/** 常量剪枝表：无论 .gitignore 写没写都跳过的目录名（依赖目录与 git 元数据） */
const PRUNE_DIRS = new Set(['node_modules', '.git']);

/** 平台路径分隔符归一为 /（glob 与 gitignore 模式语义都在 posix 路径上） */
function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/**
 * glob 模式编译为「相对根路径」匹配 RegExp。
 *
 * 语法（最小词汇面，出厂清单 §2.2；无字符类/花括号展开——够用即止防面膨胀）：
 * - `**` 独占一段 = 任意层目录（含零层），如 src 下任意深度（src 斜杠双星）、
 *   任意深度的 .ts 文件（双星 斜杠 星.ts）、中段双星（a … b 之间任意层）；
 * - `*`  = 段内任意字符（不跨 `/`）；
 * - `?`  = 段内单个字符；
 * - 其余字符字面匹配。
 *
 * @throws AppError(TOOL_ARGUMENTS_INVALID) 段内混嵌 `**`（如 `a**b`）——语义不明拒绝
 */
export function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split('/');
  let source = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue; // noUncheckedIndexedAccess 收窄（split 产物实际不会缺）
    const isLast = i === segments.length - 1;
    if (seg === '**') {
      // 尾段 `a/**` = a 下任意深度任意路径；非尾段 = 任意层目录前缀（含零层）
      source += isLast ? '[^/]*(?:/[^/]+)*' : '(?:[^/]+/)*';
      continue;
    }
    // 段内编译：`*`/`?` 通配，其余字面转义；段中出现 `**` 片段（非整段）即非法
    let segRe = '';
    for (let j = 0; j < seg.length; j++) {
      const ch = seg[j] as string; // split 产物索引安全（长度内取值）
      if (ch === '*' && seg[j + 1] === '*') {
        throw new AppError(
          TOOL_ARGUMENTS_INVALID,
          `[TOOL_ARGUMENTS_INVALID] glob 模式非法：\`**\` 须独占一段（收到 ${JSON.stringify(seg)}）`,
        );
      }
      if (ch === '*') segRe += '[^/]*';
      else if (ch === '?') segRe += '[^/]';
      else segRe += ch.replace(/[\\^$.+()[\]{}|]/g, '\\$&');
    }
    source += segRe + (isLast ? '' : '/');
  }
  return new RegExp(`^${source}$`);
}

/** 单行 gitignore 模式前缀化（注释/空行丢弃；`!` 否定与 `\!`/`\#` 转义保留——与 skills/discovery 同语义） */
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

/**
 * 读取 dir 下 .gitignore 并把模式按所在目录前缀化挂上匹配器
 * （嵌套 .gitignore 的规则只作用于其所在目录子树）。文件不存在/读失败静默跳过。
 */
async function addIgnoreRules(matcher: IgnoreMatcher, dir: string, rootDir: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(join(dir, '.gitignore'), 'utf8');
  } catch {
    return; // 无 .gitignore 或读失败（权限等）——本目录无额外规则
  }
  const prefix = toPosix(relative(rootDir, dir));
  const prefixed = prefix ? `${prefix}/` : '';
  const patterns = content
    .split(/\r?\n/)
    .map((line) => prefixIgnorePattern(line, prefixed))
    .filter((line): line is string => line !== null);
  if (patterns.length > 0) matcher.add(patterns);
}

/** 遍历产物：rel = 相对遍历根的 posix 路径 */
interface WalkedFile {
  rel: string;
  abs: string;
}

/**
 * gitignore-aware 递归遍历：枚举 root 子树全部普通文件（yield 顺序 = 目录序 ×
 * 名称字典序，结果确定）。消费者 break 即早停（generator 自然终止）。
 *
 * 剪枝：PRUNE_DIRS 常量表 + 祖先链上所有 .gitignore 规则（逐目录前缀化挂载，
 * 进入时读取）；符号链目录不跟随（Dirent.isDirectory 对符号链返回 false，防环）。
 */
async function* walkFiles(root: string): AsyncGenerator<WalkedFile> {
  const matcher = ignore();
  const stack: string[] = [root]; // DFS 显式栈（目录序确定）
  while (stack.length > 0) {
    const dir = stack.pop()!;
    await addIgnoreRules(matcher, dir, root);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 目录读失败（权限/竞态消失）——跳过本目录继续其余子树
    }
    // 倒序入栈 + pop 取首 → 保持名称字典序访问
    const sorted = [...entries].sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of sorted) {
      if (entry.isDirectory()) {
        if (PRUNE_DIRS.has(entry.name)) continue;
        // 根目录层 relative 为空串——不得拼出前导 /（ignore 包要求纯相对路径）
        const dirPrefix = toPosix(relative(root, dir));
        const rel = dirPrefix ? `${dirPrefix}/${entry.name}` : entry.name;
        // 目录双测（带/不带尾斜杠）：兼容 `dir/` 与 `dir` 两种规则写法
        if (matcher.ignores(rel) || matcher.ignores(`${rel}/`)) continue;
        stack.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        const rel = toPosix(relative(root, join(dir, entry.name)));
        if (matcher.ignores(rel)) continue;
        yield { rel, abs: join(dir, entry.name) };
      }
    }
  }
}

/** 纯文本结果的快捷构造（与 fs.ts 同款私有小函数，不跨文件抽共享） */
function textResult(text: string, details?: Record<string, unknown>): AgentToolResult {
  return { content: [{ type: 'text', text }], ...(details ? { details } : {}) };
}

/** 读文件内容（可读文本形态）；超过 maxBytes 只读前段（截断在输出里注明，不静默） */
async function readCapped(abs: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const st = await stat(abs);
  if (st.size <= maxBytes) {
    return { text: await readFile(abs, 'utf8'), truncated: false };
  }
  // 超限文件不整读（防超大文件占内存）——file handle 只取前 maxBytes 字节
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    await fh.read(buf, 0, maxBytes, 0);
    // 截断可能落在多字节 UTF-8 字符中间——尾部坏字符无害（搜索容错；read 工具同款口径）
    return { text: buf.toString('utf8'), truncated: true };
  } finally {
    await fh.close();
  }
}

/** 单文件正则扫描：返回命中行（1 起行号）与截断/二进制标记 */
async function scanFile(
  abs: string,
  re: RegExp,
  maxScanBytes: number,
): Promise<{ lines: Array<{ no: number; text: string }>; truncated: boolean; binary: boolean }> {
  const { text, truncated } = await readCapped(abs, maxScanBytes);
  // 二进制探测：前 8 KiB 含 NUL 字节视为二进制（ripgrep 同款启发），整文件跳过
  if (text.substring(0, 8192).includes('\0')) {
    return { lines: [], truncated: false, binary: true };
  }
  const lines: Array<{ no: number; text: string }> = [];
  const rawLines = text.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (raw === undefined) continue; // noUncheckedIndexedAccess 收窄（split 产物实际不会缺）
    if (re.test(raw)) {
      // 行内 \r 去；超长行截 500 字符（防单行 minified 文件刷屏）
      const line = raw.replace(/\r$/, '');
      lines.push({ no: i + 1, text: line.length > 500 ? `${line.slice(0, 500)}…（行超长已截断）` : line });
    }
  }
  return { lines, truncated, binary: false };
}

/**
 * 组装检索族工具（find / grep——Ring 1 七件套的检索两件）。
 * 与 fs 工具族同装配点并列注册（子代理 toolFilter 名单机制自动纳管）。
 */
export function createSearchTools(opts: SearchToolsOptions = {}): SearchTools {
  const workspace = opts.workspace ?? (() => process.cwd());
  const maxScanBytes = opts.maxScanBytes ?? 256 * 1024;
  const maxResults = opts.maxResults ?? 200;

  /** 用户给出的路径 → 绝对路径（相对路径锚 workspace；与 fs.ts 同语义） */
  const resolveTarget = (p: string): string => (isAbsolute(p) ? resolvePath(p) : resolvePath(workspace(), p));

  /* ---------------- find：glob 模式找文件路径 ---------------- */
  const findTool: ToolDefinition = {
    name: 'find',
    effect: 'read',
    description:
      '按 glob 模式查找文件路径（`*` 匹配段内任意字符、`**` 跨任意层目录、`?` 单字符，如 "**/*.ts"、"src/**"）。遍历尊重 .gitignore（逐目录规则），不进 node_modules 与 .git，不跟随符号链。返回按路径排序的相对路径列表。',
    parameters: Type.Object({
      pattern: Type.String({ description: 'glob 模式（匹配相对遍历根的路径）' }),
      path: Type.Optional(Type.String({ description: '遍历起点目录（缺省工作区根；相对路径锚工作区根）' })),
    }),
    execute: async (args) => {
      const root = resolveTarget((args.path as string | undefined) ?? '.');
      // 模式编译失败（`**` 混嵌等）前置拒绝——参数语法错属调用方可修复
      const re = globToRegExp(args.pattern as string);
      const matches: string[] = [];
      let truncated = false;
      let scanned = 0;
      for await (const file of walkFiles(root)) {
        scanned++;
        if (!re.test(file.rel)) continue;
        if (matches.length >= maxResults) {
          truncated = true;
          break; // 达输出上限早停（遍历剩余子树不再扫）
        }
        matches.push(file.rel);
      }
      matches.sort((a, b) => a.localeCompare(b));
      const body =
        matches.length === 0
          ? '（无匹配文件）'
          : `${matches.join('\n')}${truncated ? `\n…（已达 ${maxResults} 条上限，结果截断——收窄 pattern 或指定更小 path）` : ''}`;
      return textResult(body, { root, matches: matches.length, scanned, truncated });
    },
  };

  /* ---------------- grep：正则扫描内容（两种输出模式） ---------------- */
  const grepTool: ToolDefinition = {
    name: 'grep',
    effect: 'read',
    description:
      '按正则表达式搜索文件内容（JavaScript RegExp 语法）。目标可以是目录（递归遍历，尊重 .gitignore、跳过 node_modules/.git 与二进制文件）或单个文件。output_mode=files_with_matches 返回命中文件路径列表（缺省）；content 返回「路径:行号:命中行」。单文件超 256 KiB 只扫前段。',
    parameters: Type.Object({
      pattern: Type.String({ description: '正则表达式（JavaScript RegExp 语法）' }),
      path: Type.Optional(Type.String({ description: '搜索目标：目录（递归）或文件；缺省工作区根' })),
      output_mode: Type.Optional(
        Type.Union([Type.Literal('files_with_matches'), Type.Literal('content')], {
          description: '输出模式：files_with_matches（命中文件列表，缺省）| content（带行号命中行）',
        }),
      ),
      glob: Type.Optional(
        Type.String({ description: '文件名过滤（glob 语法同 find；只搜名字匹配的文件，如 "**/*.ts"）' }),
      ),
    }),
    execute: async (args) => {
      const target = resolveTarget((args.path as string | undefined) ?? '.');
      const mode = (args.output_mode as 'files_with_matches' | 'content' | undefined) ?? 'files_with_matches';
      // 正则编译失败前置拒绝（参数语法错）；'u' 旗标不设——部分旧式模式含裸量词组
      let re: RegExp;
      try {
        re = new RegExp(args.pattern as string);
      } catch (err) {
        throw new AppError(
          TOOL_ARGUMENTS_INVALID,
          `[TOOL_ARGUMENTS_INVALID] 正则编译失败：${args.pattern as string}（${(err as Error).message}）`,
        );
      }
      // 可选 glob 过滤（相对遍历根匹配——与 find 同一编译器）
      const globRe = args.glob !== undefined ? globToRegExp(args.glob as string) : undefined;

      const files: string[] = []; // files 模式：命中文件路径
      const contentLines: string[] = []; // content 模式：rel:行号:行
      let truncated = false;
      let skippedBinary = 0;
      let skippedOversize = 0;
      let scanned = 0;

      /** 单文件扫描 + 计数入账（达限返回 true 供早停） */
      const consumeFile = async (rel: string, abs: string): Promise<boolean> => {
        scanned++;
        const result = await scanFile(abs, re, maxScanBytes);
        if (result.binary) {
          skippedBinary++;
          return false;
        }
        if (result.truncated) skippedOversize++;
        if (result.lines.length === 0) return false;
        if (mode === 'files_with_matches') {
          if (files.length >= maxResults) return true;
          files.push(rel);
          return files.length >= maxResults;
        }
        for (const line of result.lines) {
          if (contentLines.length >= maxResults) return true;
          contentLines.push(`${rel}:${line.no}:${line.text}`);
        }
        return contentLines.length >= maxResults;
      };

      // 目标形态分派：单文件显式指定 = 用户意图（不做 ignore/glob 过滤）；
      // 目录 = 遍历 + glob 过滤 + gitignore 剪枝
      const st = await stat(target);
      if (st.isFile()) {
        await consumeFile(toPosix(relative(workspace(), target)) || toPosix(target), target);
      } else if (st.isDirectory()) {
        for await (const file of walkFiles(target)) {
          if (globRe !== undefined && !globRe.test(file.rel)) continue;
          if (await consumeFile(file.rel, file.abs)) break; // 达上限早停
        }
      } else {
        throw new AppError(TOOL_ARGUMENTS_INVALID, `[TOOL_ARGUMENTS_INVALID] 非普通文件/目录目标：${target}`);
      }

      const body =
        mode === 'files_with_matches'
          ? files.length === 0
            ? '（无命中文件）'
            : `${files.join('\n')}${truncated ? `\n…（已达 ${maxResults} 个文件上限，结果截断）` : ''}`
          : contentLines.length === 0
            ? '（无命中行）'
            : `${contentLines.join('\n')}${truncated ? `\n…（已达 ${maxResults} 行上限，结果截断）` : ''}`;
      return textResult(body, {
        mode,
        target,
        scanned,
        matched: mode === 'files_with_matches' ? files.length : contentLines.length,
        skippedBinary,
        skippedOversize,
        truncated,
      });
    },
  };

  return { tools: [findTool, grepTool] };
}
