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
 *
 * 写串行链（S2 骨架篇 §7.5②，2026-08-26）：全部写路径（write 全段 / edit 两
 * 阶段全段）经 per-canonical-path 模块级链互斥——多驱动/子代理并发写同一物理
 * 文件时，后到写者的 stat→CAS 在前驱落盘后才跑，观察指纹必然过期而被拒，不
 * 再有「两写者都通过 CAS、后写覆盖先写」的静默丢失。链与实例无关（物理路径
 * 全局唯一），详见 serializeWrites 注记。
 */

import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { Type } from 'typebox';
import {
  AppError,
  FS_DECODE_NON_UTF8,
  FS_DECODE_UNDECIDABLE,
  FS_NOT_FOUND,
  FS_OUTSIDE_WRITABLE_ROOTS,
  FS_PATCH_FAILED,
  FS_WRITE_TARGET_DRIFTED,
  TOOL_ARGUMENTS_INVALID,
} from '../contracts/errors.js';
import type { AgentToolResult, ToolDefinition } from '../contracts/tools.js';
import { decodeText, peekLocalCodepageLabels, resolveLocalCodepageLabels } from '../context/index.js';
import type { DecodedText } from '../context/index.js';
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
  /** read 截断上限字节（缺省 256 KiB；超大文件截断提示，全文走 spill 策略应用） */
  maxReadBytes?: number;
  /** read 图片分支文件上限字节（缺省 5 MiB；超限 isError 结果面拒绝不截断——
   * base64 截断 = 损坏图片无意义，fail-loud 指路压缩/裁剪后重读） */
  maxImageBytes?: number;
}

/**
 * 图片扩展名 → MIME 类型（read 多模态分支识别表，契约篇 §5.1 Ring 1 条
 * 2026-08-26 尾刀增量）。按扩展名识别而非魔数嗅探：工具语义是「读给模型看」，
 * 伪图片文件由模型侧自然暴露，不为它加嗅探器（新概念判据不足）。
 */
const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ['.png']: 'image/png',
  ['.jpg']: 'image/jpeg',
  ['.jpeg']: 'image/jpeg',
  ['.gif']: 'image/gif',
  ['.webp']: 'image/webp',
};

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
 *
 * 导出消费方（2026-09-01 遗漏大扫 20260901-c #5）：checkpoint restore——
 * manifest 路径定写串行链键须与工具写同键同源（链键 = canonical 物理路径，
 * 各写者自行 canonicalize 会在拼写差异上漏互斥）。
 */
export async function canonicalize(abs: string): Promise<string> {
  try {
    return await realpath(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs; // 到达文件系统根
    const canonicalParent = await canonicalize(parent);
    return join(canonicalParent, basename(abs));
  }
}

/** child 是否位于 root 内（相等或隔分隔符的前缀，防 /root 与 /root-evil 误判；
 * 根为文件系统根 sep（danger-full-access 的全盘根，safety 推导返回 [sep]）时
 * 任意绝对路径皆命中——与 safety/roots isInsideRoot 同款特判（不 cross-import
 * 防 safety→tools 已有反向依赖成环）） */
function isInside(child: string, root: string): boolean {
  const prefix = root === sep ? sep : root + sep;
  return child === root || child.startsWith(prefix);
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

/* ------------------------------------------------------------------ */
/* 写串行链（S2 骨架篇 §7.5②——per-canonical-path 全局写互斥）          */
/* ------------------------------------------------------------------ */

/**
 * per-canonical-path 写串行链尾（**模块级**——跨 createFsTools 实例共享：多驱动
 * 各持一套 fs 族、子代理每子一套，但物理文件系统只有一块；链的粒度是物理路径，
 * 不挂任何注册表/实例，挂实例即漏互斥）。键 = canonical 绝对路径；值 = 最近写
 * 操作的占位 promise（已 settle 的旧值等价于「空闲」，故 map 自清不影响语义）。
 */
const writeChains = new Map<string, Promise<void>>();

/**
 * 写操作互斥段（S2 冷读修死形态——「同步原子段安装占位链尾」，互斥为零-await 安装）：
 *
 * 1. **同步原子段（零 await）**：捕获全部涉及路径的当前链尾 + 将自身**占位**安装
 *    为各路径新链尾（多路径共享同一占位对象——edit/rm 跨文件时的全序锚）；
 * 2. 等待前驱（Promise.all——等待边恒指向安装更早者，图无环，无死锁）；
 * 3. 执行操作本体；
 * 4. settle 占位（无论成败——锁即释放，操作自身的错误原样上抛调用方）+ 值等价
 *    自清（某路径链尾仍是本占位即删键，防 Map 随路径集合无界增长）。
 *
 * 互斥原理：执行期各路径链尾恒为本操作占位——并发到达者在自己的原子段读到的是
 * 「链尾已占」而非「已 settle 的旧值」，必然排在本操作之后。此前的「await 汇合
 * 后回写链尾」形态互斥为零（执行期链尾仍是旧值，并发者读作空闲直接放行）。
 *
 * @param paths 本次操作涉及的 canonical 路径全集（write 单路径；edit 补丁多路径）
 * @param op 操作本体（互斥段内执行；覆盖 stat→CAS→writeFile→观察回填全段）
 */
export async function serializeWrites<T>(paths: readonly string[], op: () => Promise<T>): Promise<T> {
  // 占位 promise：resolver 手持，settle 时机完全归本函数的 finally
  let release!: () => void;
  const placeholder: Promise<void> = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 同步原子段：先捕获前驱、再安装占位——两步之间零 await，并发者不可能插入
  const priors = paths.map((p) => writeChains.get(p) ?? Promise.resolve());
  for (const p of paths) writeChains.set(p, placeholder);
  try {
    await Promise.all(priors);
    return await op();
  } finally {
    release(); // settle 占位：等待者放行（本操作的成败与之无关）
    // 值等价自清：链尾仍指本占位才删（并发者已把自己的占位装上时不动他者）
    for (const p of paths) {
      if (writeChains.get(p) === placeholder) writeChains.delete(p);
    }
  }
}

/**
 * read/edit 前置读共用：原始字节 → 决策树（read 半边 ACP 标签；两段式懒探测，
 * 骨架篇 §7.5——挖矿 B11 缺口④ read 半边）。
 * 干净 UTF-8 零探测开销；仅终判 lossy 时异步探一次码页重解码（非 win32
 * 探测即时空对——lossy 终态不变）。显式标签（read encoding 逃生参数）给出
 * 即由 decodeText 内部跳过本地标签路；标签合法性在守门段前置校验（调用点）。
 */
async function decodeFileText(raw: Buffer, explicitLabel?: string): Promise<DecodedText> {
  const withLabel = (ansi: string | null): DecodedText =>
    decodeText(raw, {
      localLabel: ansi,
      ...(explicitLabel !== undefined ? { explicitLabel } : {}),
    });
  const quick = withLabel(peekLocalCodepageLabels().ansi);
  if (quick.method !== 'lossy') return quick;
  return withLabel((await resolveLocalCodepageLabels()).ansi);
}

/** 终态文本保头截断（至多 maxBytes 字节 UTF-8；截点落在多字节字符中间时
 * 回退到该字符起点——丢一个不完整字符，不产 U+FFFD 乱码尾巴） */
function headUtf8(buf: Buffer, maxBytes: number): string {
  let end = Math.min(buf.length, maxBytes);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * 组装 fs 工具族（read / write / edit / ls）。
 * 观察表由本函数创建并在族内共享——「读过的文件」是工具族级状态。
 */
export function createFsTools(opts: FsToolsOptions = {}): FsTools {
  const workspace = opts.workspace ?? (() => process.cwd());
  const writableRoots = opts.writableRoots ?? (() => [workspace(), tmpdir()]); // M1 过渡默认；safety 落成后换其推导
  const maxReadBytes = opts.maxReadBytes ?? 256 * 1024;
  const maxImageBytes = opts.maxImageBytes ?? 5 * 1024 * 1024;
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

  /**
   * 互斥段内写目标漂移重验（复盘 20260901 S-2 规范先行，骨架篇 §7.5② 竞速
   * 边界注记）：写串行链只互斥宿主写者——不可信共享写者（external 域应用对
   * workspace 持直接 OS 写权）不受链约束，可在链外 canonicalize〔T0〕→ 段内
   * 物理写〔T1〕窗口把任一父组件 swap 成符号链，writeFile/rm 跟随即宿主全权
   * 写出 fence 外（fence 只在链外验过一次，对 T1 的真实落点不再过问）。
   * 修法 = 物理写前重跑 canonicalize 与链外定键值比对，漂移即拒（fail-closed）。
   * 调用形态约束：重验完成后与物理写之间零 await——重验是物理写前的最后一跳，
   * 残窗收敛至 realpath 走查与 open 提交之间的指令级窗（治本 = 父目录 fd 锚定
   * 或 temp+rename，挂账等真实攻击面拉动）。
   *
   * @param abs       用户拼写路径（重跑 canonicalize 的输入——与 T0 定键同源）
   * @param canonical 链外推导定键（T0 值）——比对基准
   */
  const assertTargetStable = async (abs: string, canonical: string): Promise<void> => {
    const nowCanonical = await canonicalize(abs);
    if (nowCanonical !== canonical) {
      throw new AppError(
        FS_WRITE_TARGET_DRIFTED,
        `[FS_WRITE_TARGET_DRIFTED] 写目标在互斥段内漂移：${abs} 现规范化 ${nowCanonical} ≠ 定键 ${canonical}（疑似父组件被符号链交换——拒绝落盘；请重新执行写操作）`,
      );
    }
  };

  /* ---------------- read：观察登记的唯一天然入口 ---------------- */
  const readTool: ToolDefinition = {
    name: 'read',
    effect: 'read',
    description:
      '读取文件内容。文本按解码决策树处理：UTF-8 直读；带 BOM 的 UTF-16 或本地码页文件（如 GBK）转码为 UTF-8 视图并在尾部标注（edit 不适用此类文件，改写用 write 全文替换）；无法判定编码时报错，此时可用 encoding 参数显式指定。图片文件（png/jpg/jpeg/gif/webp）返回 image 内容块（模型可直接看图）。读取即登记观察态：后续 write/edit 需基于本观察（版本不符会被拒绝）。文件不存在时返回错误，但同样登记「不存在」观察（之后 write 即合法创建）。',
    parameters: Type.Object({
      path: Type.String({ description: '文件路径（相对路径锚工作区根）' }),
      encoding: Type.Optional(
        Type.String({
          description:
            '显式编码标签（逃生参数，缺省自动判定）：文件非 UTF-8 且自动判定失败时，用 ICU 标签（如 gbk/big5/shift_jis/utf-16le）直接严格解码；仍失败则报错',
        }),
      ),
    }),
    execute: async (args) => {
      const abs = resolveTarget(args.path as string);
      const version = await currentVersion(abs);
      if (version === undefined) {
        // 不存在 = 错误结果 + 登记 absent 观察（调用失败但观察语义成立：模型看过「这里没有文件」）
        observed.observeAbsent(abs);
        throw new AppError(FS_NOT_FOUND, `[FS_NOT_FOUND] 文件不存在：${abs}`);
      }
      // 图片分支（§5.1 尾刀增量）：按扩展名识别 → image 块（base64 + mimeType）。
      // 不走 maxReadBytes 文本护栏——图片自有界（pipeline 输出护栏「只钳文本」既定；
      // durable 面 image 放不下换文本占位亦是既有防线）。
      const imageMime = IMAGE_MIME_BY_EXT[extname(abs).toLowerCase()];
      if (imageMime !== undefined) {
        const raw = await readFile(abs); // Buffer（不带编码——二进制原样）
        if (raw.byteLength > maxImageBytes) {
          // 超限 = 可预期输入问题（fetch 非 2xx 同款哲学）：isError 结果面拒绝，
          // 模型可自纠正（压缩/裁剪后重读或放弃）；不 throw 不截断
          return {
            content: [
              {
                type: 'text',
                text: `图片过大：${abs}（${raw.byteLength} 字节 > 上限 ${maxImageBytes} 字节）。请压缩或裁剪后重读。`,
              },
            ],
            isError: true,
            details: { path: abs, bytes: raw.byteLength, limit: maxImageBytes, image: true, rejected: 'too-large' },
          };
        }
        observed.observePresent(abs, version);
        return {
          content: [
            { type: 'text', text: `${abs}（图片 ${imageMime}，${raw.byteLength} 字节）` },
            { type: 'image', data: raw.toString('base64'), mimeType: imageMime },
          ],
          details: { path: abs, bytes: raw.byteLength, mimeType: imageMime, image: true },
        };
      }
      // 文本分支：原始字节读入（readFile('utf8') 硬编码退役——编码决策后置，
      // 挖矿 B11 缺口④ read 半边）；显式标签先行守门段校验（非法/不支持 =
      // 参数可修复错误，结构化拒——骨架篇 §7.5 逃生参数形态）
      const explicitEncoding = args.encoding as string | undefined;
      if (explicitEncoding !== undefined) {
        try {
          new TextDecoder(explicitEncoding);
        } catch {
          throw new AppError(
            TOOL_ARGUMENTS_INVALID,
            `[TOOL_ARGUMENTS_INVALID] encoding 不是合法的编码标签：${explicitEncoding}（须为 ICU 标签，如 gbk/big5/shift_jis/utf-16le）`,
          );
        }
      }
      const raw = await readFile(abs); // Buffer（不带编码——二进制原样，解码后置）
      const decoded = await decodeFileText(raw, explicitEncoding);
      if (decoded.method === 'lossy') {
        // 终段不可判定：fail-loud 拒收（绝不静默 mojibake 进上下文）——
        // 指路逃生参数重读；显式标签 strict 失败同码（骨架篇 §7.5）
        throw new AppError(
          FS_DECODE_UNDECIDABLE,
          `[FS_DECODE_UNDECIDABLE] 文件编码无法判定（UTF-8 与本地码页均不匹配）——如确知编码请带 encoding 参数重读（ICU 标签，如 gbk/big5/shift_jis）。判定过程：${decoded.diagnostics}`,
        );
      }
      // 预算锚 = 终态文本 UTF-8 字节（骨架篇 §7.6——解码在先、截断在后）
      const truncated = Buffer.byteLength(decoded.text, 'utf8') > maxReadBytes;
      const content = truncated ? headUtf8(Buffer.from(decoded.text, 'utf8'), maxReadBytes) : decoded.text;
      observed.observePresent(abs, version);
      // 非静默纪律（骨架篇 §7.5）：非 UTF-8 终判（BOM 族直解/本地码页命中）
      // = 转码视图——content 尾部 in-band 标注 + details.encoding 双面（模型
      // 只见 content，标注必须进 content 才可见；write 全文替换 = 显式整档
      // 转码通道，CAS 已守）
      const transcoded = decoded.encoding !== 'utf-8';
      const truncNote = truncated ? `\n…（已截断至 ${maxReadBytes} 字节，完整内容请分段读取或走外溢策略）` : '';
      const tailNote = transcoded
        ? `\n…（本文件为 ${decoded.encoding} 编码，已转码为 UTF-8 视图；edit 不适用于本文件，改写请用 write 全文替换——将按 UTF-8 落盘）`
        : '';
      return textResult(`${content}${truncNote}${tailNote}`, {
        path: abs,
        bytes: Buffer.byteLength(decoded.text, 'utf8'),
        truncated,
        ...(transcoded ? { encoding: decoded.encoding } : {}),
      });
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
      // 键推导先行（S2 §7.5②）：fence 与 canonical 化在链外完成——链键与物理
      // 写目标同为本操作定死的 canonical 路径（writeFile 落 canonical 目标：
      // 写真实位置而非符号链拼写；观察键维持用户拼写 abs——read/write 同拼写
      // 一致，跨拼写别名是既有语义不在本刀扩面）
      const canonical = await assertWritable(abs);
      return serializeWrites([canonical], async () => {
        const current = await currentVersion(canonical);
        // CAS 分派：未读→create-if-absent；absent 观察→create；present 观察→版本守卫
        const intent = resolveWriteIntent(observed.get(abs), current === undefined ? undefined : { version: current });
        // 段内漂移重验（S-2）：重验完成与 writeFile 零 await 相接——swap 窗口收口
        await assertTargetStable(abs, canonical);
        await writeFile(canonical, args.content as string, 'utf8');
        // 写后回填观察：刚写入的内容即最新事实版本（立即 stat 防 mtime 精度假冲突）
        const after = await currentVersion(canonical);
        if (after !== undefined) observed.observePresent(abs, after);
        return textResult(
          `已写入 ${abs}（${intent.kind === 'create-if-absent' ? '新建' : '替换'}，${Buffer.byteLength(args.content as string, 'utf8')} 字节）`,
          {
            path: abs,
            kind: intent.kind,
            bytes: Buffer.byteLength(args.content as string, 'utf8'),
          },
        );
      });
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
      // 键推导先行（S2 §7.5②）：逐 op fence + canonical 化在链外完成——本补丁
      // 涉及的全部 canonical 路径即链键全集（Set 去重；fence 每文件单独过防
      // 补丁夹带根外目标的既有纪律不变）
      const targets = new Map<string, { op: PatchOperation; abs: string }>();
      for (const op of ops) {
        const abs = resolveTarget(op.path);
        const canonical = await assertWritable(abs);
        targets.set(canonical, { op, abs });
      }
      // 两阶段全段入链：阶段一的读-CAS-算内容与阶段二的顺序落盘在同一互斥段内
      //（阶段间窗口的并发写会让「已校验内容」过期——全段互斥才闭合）
      return serializeWrites([...targets.keys()], async () => {
        /** 阶段一产物：通过全部校验、目标内容已就绪的待应用操作 */
        const planned: Array<{ op: PatchOperation; abs: string; canonical: string; content?: string }> = [];
        for (const [canonical, { op, abs }] of targets) {
          const current = await currentVersion(canonical);
          const currentRef = current === undefined ? undefined : { version: current };
          if (op.kind === 'update') {
            // 编辑守卫：必须已读（present）且指纹一致；内容在阶段一就计算（定位失败前置暴露）
            requireObservedForEdit(observed.get(abs), currentRef);
            // 前置读走同一棵决策树（read 半边 ACP 标签；两段式懒探测）——
            // 非 UTF-8 终局一律拒改：BOM 直解/本地码页命中 → FS_DECODE_NON_UTF8、
            // 终段不可判定 → FS_DECODE_UNDECIDABLE（防 mojibake 转码回写毁档；
            // 改写通道 = read 转码视图后 write 全文替换，骨架篇 §7.5）
            const raw = await readFile(canonical); // Buffer——解码决策后置（同 read）
            const decoded = await decodeFileText(raw);
            if (decoded.method !== 'utf8') {
              const code = decoded.method === 'lossy' ? FS_DECODE_UNDECIDABLE : FS_DECODE_NON_UTF8;
              throw new AppError(
                code,
                `[${code}] 文件非 UTF-8 编码（终判 ${decoded.encoding}）——edit 不接受非 UTF-8 文件（防转码回写毁档）；如需改写请 read 后用 write 全文替换（将按 UTF-8 落盘）。判定过程：${decoded.diagnostics}`,
              );
            }
            planned.push({ op, abs, canonical, content: applyUpdateLines(abs, decoded.text, op.lines) });
          } else if (op.kind === 'add') {
            if (currentRef !== undefined) {
              throw new AppError(
                FS_PATCH_FAILED,
                `[FS_PATCH_FAILED] *** Add File: ${abs} 目标已存在——修改已有文件请用 Update File`,
              );
            }
            planned.push({ op, abs, canonical, content: addLinesToContent(op.lines) });
          } else {
            // 删除守卫与 edit 同款：删它之前必须读过它（知道删的是什么）
            requireObservedForEdit(observed.get(abs), currentRef);
            planned.push({ op, abs, canonical });
          }
        }
        /* 阶段二：顺序应用（无回滚——语义错误已在阶段一全部暴露，此处只剩物理写失败；
           写目标/观察回填同 write 工具口径：物理走 canonical，观察键走用户拼写） */
        const summary: string[] = [];
        /** 结构化操作账（post 行消费面——lsp 诊断注入按 op 分 delete/didClose 与写组；
           path 为 canonical 绝对路径与 write 工具 details.path 同口径） */
        const operations: Array<{ op: string; path: string }> = [];
        for (const item of planned) {
          // 段内漂移重验（S-2）：每个物理写（rm/writeFile）前逐项重验——与物理写
          // 零 await 相接，多文件补丁不因前项耗时给后项留窗（write 工具同款）
          await assertTargetStable(item.abs, item.canonical);
          if (item.op.kind === 'delete') {
            await rm(item.canonical);
            summary.push(`deleted ${item.op.path}`);
            operations.push({ op: 'delete', path: item.canonical });
            continue;
          }
          await writeFile(item.canonical, item.content!, 'utf8');
          const after = await currentVersion(item.canonical);
          if (after !== undefined) observed.observePresent(item.abs, after);
          summary.push(`${item.op.kind === 'add' ? 'added' : 'updated'} ${item.op.path}`);
          operations.push({ op: item.op.kind, path: item.canonical });
        }
        return textResult(`补丁已应用（${summary.length} 个操作）：\n${summary.join('\n')}`, {
          operations,
        });
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
