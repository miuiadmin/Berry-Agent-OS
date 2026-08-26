/**
 * L3 safety — 跨会话 allowlist 匹配引擎（骨架篇 §8.4 粘性第 3 条 + 第二十四批
 * 题1a「v1 覆盖面」的纯函数半边）。
 *
 * 定位：advisory 免问面——条目只影响「问不问」，不折算执行权（fence / 可写根 /
 * carve-out deny 面 / 执行段照走）；deny 永远最高（内核篇 §2.5），本面没有 deny
 * 词汇。条目落用户配置层（`<数据目录>/allowlist.json`——storage/命令面/装配接线
 * 随兄弟 MCP 批收口后的接线批落地；本文件先定形状与判定语义）。
 *
 * 三族匹配器（拍板：两族先行 + 其余整名）：
 * - fs 族（write / edit）：条目 pattern = 路径前缀（相对则锚 workspace）——
 *   本次调用**全部**写目标都落在前缀内才命中（多路径 all-or-nothing，保守）；
 * - bash 族：条目 pattern = 命令词干（≤2 词：命令 [子命令]）——剥壳语义全集
 *   见 matchesCommandStem（环境变量前缀剥除 / shell 包装穿透一层 / 管道与命令
 *   串接即不可判定 / 任何 flag 即不可判定——v1 无「已知 flag 白名单」，白名单
 *   随接线批以真实命令谱定稿；git -C/-c/--git-dir/--work-tree 换仓走私被
 *   「flag 即 miss」自然覆盖）；
 * - 其余工具族：工具名整匹配（pattern 字段忽略，留位后续扩族）。
 *
 * TTL：条目可带 expiresAt（Unix 毫秒）——过期 = 未命中（回落 ask），缺省 = 用户
 * 显式选择永久。
 */

import { basename, resolve as resolvePath, sep } from 'node:path';
import { canonicalPath } from './roots.js';

/** fs 写路径工具族（与 gate.extractWritePaths 认知的写意图工具同源；导出供守门行判定收窄共用——§8.4 增补 2 落码形态③） */
export const FS_WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);

/** allowlist 条目（用户配置层 JSON 的行形状） */
export interface AllowlistEntry {
  /** 工具名（宿主面统一词汇——'write' / 'edit' / 'bash' / 其余工具名；provider/别名不进条目） */
  readonly tool: string;
  /** 按工具族分派的模式：fs=路径前缀 / bash=命令词干 / 其余=忽略 */
  readonly pattern: string;
  /** 过期时间（Unix 毫秒）；缺省 = 永久（用户显式选择） */
  readonly expiresAt?: number;
}

/** 匹配输入（调用方组装——engine 不读工具参数结构，保持纯函数） */
export interface AllowlistInput {
  /** 工具名 */
  readonly tool: string;
  /** fs 族：本次调用全部写目标的 canonical 绝对路径（gate.extractWritePaths 产物） */
  readonly writePaths?: readonly string[];
  /** bash 族：命令原文（args.command） */
  readonly bashCommand?: string;
  /** 工作区根（相对 pattern 的锚点） */
  readonly workspace?: string;
}

/** 命中结果（条目序号供 gate/decision reason=allowlist:<index> 标注来源） */
export interface AllowlistMatch {
  readonly index: number;
  readonly entry: AllowlistEntry;
}

/**
 * 判定入口：首个命中的条目（序即优先级）；无命中返回 undefined。
 * 保守原则：任何不可判定（管道/串接/引号/flag/条目形状非法）都返回未命中——
 * 照问照审，不做假静态分析。
 */
export function matchAllowlist(
  entries: readonly AllowlistEntry[],
  input: AllowlistInput,
  now: number,
): AllowlistMatch | undefined {
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.tool !== input.tool) continue;
    // TTL：过期 = 未命中（回落 ask；过期条目由 /allowlist 枚举面提示清理）
    if (entry.expiresAt !== undefined && now >= entry.expiresAt) continue;
    if (FS_WRITE_TOOLS.has(entry.tool)) {
      if (fsPrefixHit(entry.pattern, input)) return { index, entry };
    } else if (entry.tool === 'bash') {
      const command = input.bashCommand ?? '';
      if (command.trim().length > 0 && matchesCommandStem(entry.pattern, command)) {
        return { index, entry };
      }
    } else {
      // 整名族：工具名相等即命中（TTL 已过）
      return { index, entry };
    }
  }
  return undefined;
}

/** fs 族判定：全部写目标落在条目前缀内（前缀到路径分隔边界——/app 不匹配 /apple） */
function fsPrefixHit(pattern: string, input: AllowlistInput): boolean {
  if (typeof pattern !== 'string' || pattern.length === 0) return false;
  const paths = input.writePaths ?? [];
  if (paths.length === 0) return false; // 无写意图不归本族（整名语义由他族条目表达）
  let prefix: string;
  try {
    // 相对 pattern 锚 workspace；canonical 化与 fence/根推导同源
    prefix = canonicalPath(resolvePath(input.workspace ?? process.cwd(), pattern));
  } catch {
    return false; // pattern 不可解析 = 条目无效 = 不命中
  }
  return paths.every((p) => p === prefix || p.startsWith(prefix + sep));
}

/** 不可判定字符集：管道 / 串接 / 重定向 / 命令替换 / 换行——任一出现即照问 */
const INDETERMINATE = /[|;&<>$(`)\n]/;
/** 引号字符（剥离 shell 包装引号后仍残留即视为不可判定） */
const QUOTES = /["'`]/;
/** shell 包装器名（穿透一层取内层命令） */
const WRAPPERS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
/** 包装器选项中含 c（-c / -lc / -ec——payload 在下一个词） */
const WRAPPER_C_OPTION = /^-[a-z]*c[a-z]*$/;

/**
 * 剥壳取主命令词干（≤2 词：命令 [子命令]）——「始终允许」bash 草案生成器
 * （骨架篇 §8.4 增补 2 落码形态①：与 matchesCommandStem 同源同实现——
 * 剥壳全集共享，判定的保守原则在此同样生效）。
 * 不可判定（管道/串接/重定向/命令替换/换行/残留引号/flag——全局无害三件除外）
 * 返回 undefined：剥不出干净词干即无草案，「始终允许」选项不呈现。
 */
export function commandStem(command: string): string | undefined {
  // 剥壳：环境变量前缀赋值 + shell 包装穿透一层
  let tokens = command.trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(tokens[0]!)) {
    tokens = tokens.slice(1);
  }
  if (tokens.length === 0) return undefined;
  const head = basename(tokens[0]!);
  if (WRAPPERS.has(head)) {
    // 找 -c 类选项后的 payload 词（选项序列之后的第一个非选项词）
    let i = 1;
    let sawC = false;
    while (i < tokens.length && tokens[i]!.startsWith('-') && WRAPPER_C_OPTION.test(tokens[i]!)) {
      sawC = true;
      i += 1;
    }
    if (sawC && i < tokens.length) {
      // payload = 选项后全部剩余词拼接（引号内空格已被分词拆散——拼接还原后再剥引号）
      let payload = tokens.slice(i).join(' ');
      // 剥整段包裹引号；引号内含空白则重新分词（只此一层，不递归）
      if (
        payload.length >= 2 &&
        ((payload.startsWith("'") && payload.endsWith("'")) || (payload.startsWith('"') && payload.endsWith('"')))
      ) {
        payload = payload.slice(1, -1);
      }
      tokens = payload.split(/\s+/).filter(Boolean);
    }
  }
  if (tokens.length === 0) return undefined;

  // 不可判定：命令全文任一危险字符 / 残留引号 → 无词干（草案不生成）
  const peeled = tokens.join(' ');
  if (INDETERMINATE.test(peeled) || QUOTES.test(peeled)) return undefined;

  // 剩余参数保守判定：flag 即无词干（--help/-h/--version 三件无害除外）
  const rest = tokens.slice(1);
  for (const arg of rest) {
    if (arg.startsWith('-') && arg !== '--help' && arg !== '-h' && arg !== '--version') return undefined;
  }

  // 词干 = 主命令 [子命令]（≤2 词；子命令存在且非 flag 才纳入）
  const cmd = basename(tokens[0]!);
  const sub = tokens[1];
  return sub !== undefined && !sub.startsWith('-') ? `${cmd} ${sub}` : cmd;
}

/**
 * bash 族判定（骨架篇 §8.4 增补 3「剥壳语义全集」的 v1 落码）：
 * 剥壳与不可判定全权委托 commandStem（同源同实现——「始终允许」草案生成
 * 与本判定共用同一套剥壳全集，双实现漂移结构性不可能）；本函数只做
 * pattern（≤2 词）对词干的**逐词前缀对齐**——pattern 单词（如 `git`）
 * 匹配「该命令 + 任意非 flag 形参」（`git status` 命中 `git` 条目），
 * 双词条目（`git push`）要求词干恰好两词且逐词相等。
 */
function matchesCommandStem(pattern: string, command: string): boolean {
  // pattern 解析：≤2 词（命令 [子命令]）；超长/空 = 条目无效
  const patternTokens = pattern.trim().split(/\s+/).filter(Boolean);
  if (patternTokens.length === 0 || patternTokens.length > 2) return false;

  const stem = commandStem(command);
  if (stem === undefined) return false; // 剥不出干净词干（不可判定）即 miss

  const stemTokens = stem.split(' ');
  if (patternTokens.length > stemTokens.length) return false;
  return patternTokens.every((token, i) => token === stemTokens[i]);
}
