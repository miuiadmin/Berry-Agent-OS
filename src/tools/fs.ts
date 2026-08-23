/**
 * L2 tools — fs 工具族（M1 首批：read / write / edit / ls；grep/find/bash 随后续模块）。
 *
 * 三道防线的关系（骨架篇 §7.5）：
 * - fence（containment）：写/删目标必须在可写根内——经 writableRoots provider
 *   注入（safety 模块的推导函数，与 Seatbelt profile 同源；safety 未落成前
 *   默认 = workspace + 系统临时目录）。进程内 canonicalize-then-contain，
 *   防误操作护栏而非 security boundary；
 * - 观察态 CAS（observed.ts）：未读拒改 + 版本守卫——「你写的是否基于最新观察」；
 * - 补丁定位（apply-patch.ts）：context 行锚点匹配——「你改的位置是否还在」。
 *
 * edit 的两阶段编排：先对补丁全部操作做「解析 + fence + CAS + 定位」校验并
 * 计算目标内容，全部通过后才逐文件写入——语义错误（定位失败/未读/CAS 冲突）
 * 全部前置暴露，非原子窗口（骨架篇声明：跨文件顺序应用、无回滚）只剩物理
 * 写失败一种。
 */

import { basename, dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { Type } from 'typebox';
import { AppError, FS_NOT_FOUND, FS_OUTSIDE_WRITABLE_ROOTS, FS_PATCH_FAILED } from '../contracts/errors.js';
import type { AgentToolResult, ToolDefinition } from '../contracts/tools.js';
import { addLinesToContent, applyUpdateLines, parseApplyPatch } from './apply-patch.js';
import type { PatchOperation } from './apply-patch.js';
import { ObservedFiles, resolveWriteIntent, requireObservedForEdit, statVersion } from './observed.js';

/** fs 工具族选项（app 装配层注入；全部可换） */
export interface FsToolsOptions {
  /**
   * 可写根 provider（fence 数据源；返回绝对路径列表）。
   * safety 模块落成后由其推导（workspace + /tmp + tmpdir，与沙箱 profile 同源）；
   * 缺省 = workspace() + tmpdir()（M1 过渡默认）。
   */
  writableRoots?: () => string[];
  /** 工作区锚点（相对路径 resolve 基准；缺省 process.cwd()） */
  workspace?: () => string;
  /** read 截断上限字节（缺省 256 KiB；超大文件截断提示，全文走 spill 策略插件） */
  maxReadBytes?: number;
}

/** fs 工具族产物：工具定义 + 共享观察表（装配层可借它做诊断/测试断言） */
export interface FsTools {
  tools: ToolDefinition[];
  /** 观察态登记表（read/write/edit 共享；键 = resolve 后绝对路径） */
  observed: ObservedFiles;
}

/** 纯文本结果的快捷构造 */
function textResult(text: string, details?: Record<string, unknown>): AgentToolResult {
  return { content: [{ type: 'text', text }], ...(details ? { details } : {}) };
}

/**
 * canonical 化绝对路径：存在的路径走 realpath（解析符号链）；
 * 不存在的路径回退到最近存在的祖先做 realpath 再拼回尾部段——
 * 保证 fence 比较双方都是「真实位置」，符号链逃逸（可写根内 symlink 指向根外）
 * 会在 contain 检查处暴露。
 */
async function canonicalize(abs: string): Promise<string> {
  try {
    return await realpath(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs; // 到达文件系统根
    const canonicalParent = await canonicalize(parent);
    return join(canonicalParent, basename(abs));
  }
}

/** child 是否位于 root 内（相等或隔分隔符的前缀，防 /root 与 /root-evil 误判） */
function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root + sep);
}

/** 当前盘上指纹（size:mtimeMs）；文件不存在返回 undefined */
async function currentVersion(abs: string): Promise<string | undefined> {
  try {
    const s = await stat(abs);
    return statVersion(s.size, s.mtimeMs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err; // EACCES 等真实 I/O 错误照常上抛（工具失败）
  }
}

/**
 * 组装 fs 工具族（read / write / edit / ls）。
 * 观察表由本函数创建并在族内共享——「读过的文件」是工具族级状态。
 */
export function createFsTools(opts: FsToolsOptions = {}): FsTools {
  const workspace = opts.workspace ?? (() => process.cwd());
  const writableRoots = opts.writableRoots ?? (() => [workspace(), tmpdir()]); // M1 过渡默认；safety 落成后换其推导
  const maxReadBytes = opts.maxReadBytes ?? 256 * 1024;
  const observed = new ObservedFiles();

  /** 用户给出的路径 → 绝对路径（相对路径锚 workspace） */
  const resolveTarget = (p: string): string => (isAbsolute(p) ? resolvePath(p) : resolvePath(workspace(), p));

  /**
   * 写路径 fence：canonical 化后必须在某个可写根内（根同样 canonical 化）。
   * 只拦写/删（骨架篇 §7.5：读任意位置允许——coding 场景读系统文件是常态）。
   */
  const assertWritable = async (abs: string): Promise<string> => {
    const canonical = await canonicalize(abs);
    for (const root of writableRoots()) {
      const canonicalRoot = await canonicalize(resolvePath(root));
      if (isInside(canonical, canonicalRoot)) return canonical;
    }
    throw new AppError(
      FS_OUTSIDE_WRITABLE_ROOTS,
      `[FS_OUTSIDE_WRITABLE_ROOTS] 目标不在可写根内：${abs}（可写根：${writableRoots().join('、')}）`,
    );
  };

  /* ---------------- read：观察登记的唯一天然入口 ---------------- */
  const readTool: ToolDefinition = {
    name: 'read',
    effect: 'read',
    description:
      '读取文本文件内容。读取即登记观察态：后续 write/edit 需基于本观察（版本不符会被拒绝）。文件不存在时返回错误，但同样登记「不存在」观察（之后 write 即合法创建）。',
    parameters: Type.Object({
      path: Type.String({ description: '文件路径（相对路径锚工作区根）' }),
    }),
    execute: async (args) => {
      const abs = resolveTarget(args.path as string);
      const version = await currentVersion(abs);
      if (version === undefined) {
        // 不存在 = 错误结果 + 登记 absent 观察（调用失败但观察语义成立：模型看过「这里没有文件」）
        observed.observeAbsent(abs);
        throw new AppError(FS_NOT_FOUND, `[FS_NOT_FOUND] 文件不存在：${abs}`);
      }
      const raw = await readFile(abs, 'utf8');
      const truncated = Buffer.byteLength(raw, 'utf8') > maxReadBytes;
      const content = truncated ? Buffer.from(raw, 'utf8').subarray(0, maxReadBytes).toString('utf8') : raw;
      observed.observePresent(abs, version);
      return textResult(
        truncated ? `${content}\n…（已截断至 ${maxReadBytes} 字节，完整内容请分段读取或走外溢策略）` : content,
        { path: abs, bytes: Buffer.byteLength(raw, 'utf8'), truncated },
      );
    },
  };

  /* ---------------- write：按观察态分派 create/replace ---------------- */
  const writeTool: ToolDefinition = {
    name: 'write',
    effect: 'write',
    description:
      '写文件（整体替换内容）。运行时按观察态自动分派：文件从未读过且已存在 → 拒绝（先 read）；读过 → 仅当读取后未被修改才允许替换（版本守卫）。写入成功后即更新观察。',
    parameters: Type.Object({
      path: Type.String({ description: '目标文件路径（相对路径锚工作区根）' }),
      content: Type.String({ description: '完整文件内容（整体替换，非追加）' }),
    }),
    execute: async (args) => {
      const abs = resolveTarget(args.path as string);
      await assertWritable(abs);
      const current = await currentVersion(abs);
      // CAS 分派：未读→create-if-absent；absent 观察→create；present 观察→版本守卫
      const intent = resolveWriteIntent(observed.get(abs), current === undefined ? undefined : { version: current });
      await writeFile(abs, args.content as string, 'utf8');
      // 写后回填观察：刚写入的内容即最新事实版本（立即 stat 防 mtime 精度假冲突）
      const after = await currentVersion(abs);
      if (after !== undefined) observed.observePresent(abs, after);
      return textResult(
        `已写入 ${abs}（${intent.kind === 'create-if-absent' ? '新建' : '替换'}，${Buffer.byteLength(args.content as string, 'utf8')} 字节）`,
        {
          path: abs,
          kind: intent.kind,
          bytes: Buffer.byteLength(args.content as string, 'utf8'),
        },
      );
    },
  };

  /* ---------------- edit：apply_patch 补丁（两阶段：全检后写） ---------------- */
  const editTool: ToolDefinition = {
    name: 'edit',
    effect: 'write',
    description:
      '按 apply_patch 补丁格式编辑文件（支持一次补丁改多个文件：Update File / Add File / Delete File）。Update/Delete 的目标必须先 read 过；全部校验通过后才落盘（跨文件顺序应用，非原子）。',
    parameters: Type.Object({
      patch: Type.String({
        description:
          'apply_patch 格式补丁文本，形如：\n*** Begin Patch\n*** Update File: path\n context\n-old\n+new\n*** Add File: new.txt\n+content\n*** Delete File: old.txt\n*** End Patch',
      }),
    }),
    execute: async (args) => {
      const ops = parseApplyPatch(args.patch as string);
      /** 阶段一产物：通过全部校验、目标内容已就绪的待应用操作 */
      const planned: Array<{ op: PatchOperation; abs: string; content?: string }> = [];
      for (const op of ops) {
        const abs = resolveTarget(op.path);
        await assertWritable(abs); // fence：每个涉及文件单独过（防补丁夹带根外目标）
        const current = await currentVersion(abs);
        const currentRef = current === undefined ? undefined : { version: current };
        if (op.kind === 'update') {
          // 编辑守卫：必须已读（present）且指纹一致；内容在阶段一就计算（定位失败前置暴露）
          requireObservedForEdit(observed.get(abs), currentRef);
          const source = await readFile(abs, 'utf8');
          planned.push({ op, abs, content: applyUpdateLines(abs, source, op.lines) });
        } else if (op.kind === 'add') {
          if (currentRef !== undefined) {
            throw new AppError(
              FS_PATCH_FAILED,
              `[FS_PATCH_FAILED] *** Add File: ${abs} 目标已存在——修改已有文件请用 Update File`,
            );
          }
          planned.push({ op, abs, content: addLinesToContent(op.lines) });
        } else {
          // 删除守卫与 edit 同款：删它之前必须读过它（知道删的是什么）
          requireObservedForEdit(observed.get(abs), currentRef);
          planned.push({ op, abs });
        }
      }
      /* 阶段二：顺序应用（无回滚——语义错误已在阶段一全部暴露，此处只剩物理写失败） */
      const summary: string[] = [];
      for (const item of planned) {
        if (item.op.kind === 'delete') {
          await rm(item.abs);
          summary.push(`deleted ${item.op.path}`);
          continue;
        }
        await writeFile(item.abs, item.content!, 'utf8');
        const after = await currentVersion(item.abs);
        if (after !== undefined) observed.observePresent(item.abs, after);
        summary.push(`${item.op.kind === 'add' ? 'added' : 'updated'} ${item.op.path}`);
      }
      return textResult(`补丁已应用（${summary.length} 个操作）：\n${summary.join('\n')}`, {
        operations: summary,
      });
    },
  };

  /* ---------------- ls：目录列举（不登记观察——不构成内容观察） ---------------- */
  const lsTool: ToolDefinition = {
    name: 'ls',
    effect: 'read',
    description: '列出目录内容（名称 + 类型）。缺省列工作区根。',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: '目录路径（缺省工作区根）' })),
    }),
    execute: async (args) => {
      const abs = resolveTarget((args.path as string | undefined) ?? '.');
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new AppError(FS_NOT_FOUND, `[FS_NOT_FOUND] 目录不存在：${abs}`);
        }
        throw err;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return textResult(lines.length > 0 ? lines.join('\n') : '（空目录）', { path: abs, count: entries.length });
    },
  };

  return { tools: [readTool, writeTool, editTool, lsTool], observed };
}
