/**
 * 文本解码决策树 + 宿主码页探测器（骨架篇 §7.5/§7.6，2026-08-27 P1-3——
 * 挖矿 B11 缺口④双侧收口；住 context 的理由：tools/exec/skills/app 四消费
 * 面的既有公共依赖底座就是 context，决策树零新拓扑边）。
 *
 * 决策树四级（两半边同一棵树——spawn 半边 OEM 标签、read 半边 ACP 标签）：
 * ① BOM 判定（UTF-8/UTF-16LE/UTF-16BE → 剥 BOM 按对应解码）；
 * ② 严格 UTF-8（fatal 全量通过——GBK/ANSI 内容几乎不可能整段通过 UTF-8
 *    校验，纯 ASCII 天然并入此支两读同文无歧义）；
 * ③ 本地码页严格试解码（标签由调用方注入，命中即转码）；
 * ④ 终段：有损解码（调用方各定——read 半边抛 FS_DECODE_UNDECIDABLE、
 *    spawn 半边收有损文本 + 标注；本函数只负责给出最好努力文本与终判）。
 *
 * 非静默纪律：③④命中时 encoding 标注随结果携带（调用方负责 in-band/
 * details 双面标注）——「标注的转码」不是「静默错猜」。
 *
 * 码页探测器（仅 win32）：reg query 单发读注册表 NLS 码页号（ACP=文件内容
 * 面 / OEMCP=控制台输出面），十进制号 → ICU 标签静态映射表；进程内单次
 * 探测缓存（成功失败都缓存——探测器自身故障极罕见，重探徒增开销）。
 * 非 Windows 平台恒 { null, null }（③天然跳过）。ICU 不支持的标签（含
 * small-icu 自编译构建）视同未命中——标签支持面以 Node 官方 full-icu 为准。
 */

import { spawn } from 'node:child_process';

/** 解码终判：调用方据 method 分派（lossy = read 半边的不可判定信号） */
export interface DecodedText {
  /** 终态文本（④ 有损 = 含 U+FFFD 替换符的最好努力文本） */
  readonly text: string;
  /** 终判编码标注：'utf-8' | 'utf-16le' | 'utf-16be' | '<本地标签>' | '<标签>-lossy' */
  readonly encoding: string;
  /** 判定路径（'bom' | 'utf8' | 'local' | 'lossy'——lossy 即 read 半边的不可判定） */
  readonly method: 'bom' | 'utf8' | 'local' | 'lossy';
  /** 判定过程描述（错误消息用：hex 前缀 + 头部修剪量 + 各步结果） */
  readonly diagnostics: string;
}

/** decodeText 选项 */
export interface DecodeTextOptions {
  /**
   * 本地码页 ICU 标签（③试解码用；null/缺省 = 跳过③直接落④）。
   * 调用方注入各自半边的值：spawn 半边 OEM（chcp 语义）、read 半边 ACP。
   */
  readonly localLabel?: string | null;
  /** 显式标签（read encoding 逃生参数）——给出即跳过①②③直接 strict 解码，失败照落④有损 */
  readonly explicitLabel?: string;
}

/** 缓存的标签支持性（TextDecoder 构造抛 RangeError 的标签 → false，③视同未命中） */
const labelSupported = new Map<string, boolean>();

/** 探一个 ICU 标签是否可用（构造即验，缓存结论） */
function isLabelSupported(label: string): boolean {
  const cached = labelSupported.get(label);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new TextDecoder(label);
    ok = true;
  } catch {
    ok = false;
  }
  labelSupported.set(label, ok);
  return ok;
}

/** 严格解码：全量 fatal 通过返回文本，否则 null（不产替换符） */
function strictDecode(bytes: Uint8Array, label: string): string | null {
  if (!isLabelSupported(label)) return null;
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 头部字节 hex（错误消息诊断用——前 16 字节） */
function hexHead(bytes: Uint8Array): string {
  let out = '';
  const n = Math.min(bytes.length, 16);
  for (let i = 0; i < n; i++) out += `${bytes[i]!.toString(16).padStart(2, '0')} `;
  return out.trim();
}

/**
 * 文本解码决策树（纯函数——同步、零副作用、可单测）。
 *
 * 头部容忍·两轮制（冷读 A1 修死，2026-08-27 测试实证再精化）：第一轮对
 * 原样窗口跑整棵树；仅终判 lossy 时才修剪首部 ≤3 个 UTF-8 续字节
 * （0b10xxxxxx）重跑第二轮。为什么不无条件预修剪：GBK 等本地码页的合法
 * 前导字节（0x81-0xBF）与 UTF-8 续字节区间重叠——完整未截断的 GBK 文件
 * 会被误修剪掉前导致③失败（实证：B2 E2 CA D4 → '馐�'）。容忍是丢头
 * 劈开多字节序列的修复尝试，不是预处理；丢头窗口 BOM 失效属接受面。
 */
export function decodeText(bytes: Uint8Array, opts: DecodeTextOptions = {}): DecodedText {
  // 注：不做任何 view 归一化——Buffer/子视图本身就是合法 Uint8Array，TextDecoder
  // 按 byteOffset/byteLength 正确解读；此前曾误用 subarray(byteOffset, …) 把相对
  // 坐标当父缓冲绝对坐标，池化 Buffer（byteOffset≠0）进来的瞬间即截成空视图。
  const first = runTree(bytes, 0, opts);
  if (first.method !== 'lossy') return first;
  // 第二轮：首部 ≤3 续字节修剪后重跑（仍 lossy 则以第二轮终态返回——诊断带修剪量）
  let start = 0;
  while (start < bytes.length && start < 3 && (bytes[start]! & 0xc0) === 0x80) start++;
  if (start === 0) return first;
  return runTree(bytes.subarray(start), start, opts);
}

/** 对单个窗口跑四级树（trimmedCount = 本窗口前已被修剪的续字节数——诊断用） */
function runTree(body: Uint8Array, trimmedCount: number, opts: DecodeTextOptions): DecodedText {
  const trimNote = trimmedCount > 0 ? `；头部修剪 ${trimmedCount} 续字节` : '';
  const diag = `hex 前 ${Math.min(body.length, 16)} 字节：${hexHead(body)}${trimNote}`;

  // 逃生参数路：显式标签直接 strict（失败落④有损——调用方 read 半边抛 UNDECIDABLE）
  if (opts.explicitLabel !== undefined) {
    const strict = strictDecode(body, opts.explicitLabel);
    if (strict !== null)
      return {
        text: strict,
        encoding: opts.explicitLabel,
        method: 'local',
        diagnostics: `显式标签 ${opts.explicitLabel} 严格通过（${diag}）`,
      };
    const { text, label } = lossyDecode(body, opts.explicitLabel);
    return {
      text,
      encoding: `${label}-lossy`,
      method: 'lossy',
      diagnostics: `显式标签 ${opts.explicitLabel} 严格失败（${diag}）`,
    };
  }

  // ① BOM 判定（UTF-16 族 BOM 权威——直接非严格解码；UTF-8 BOM 只剥壳，正文续走②）
  if (body.length >= 2) {
    const b0 = body[0]!;
    const b1 = body[1]!;
    if (b0 === 0xff && b1 === 0xfe) {
      return {
        text: new TextDecoder('utf-16le').decode(body.subarray(2)),
        encoding: 'utf-16le',
        method: 'bom',
        diagnostics: `BOM utf-16le（${diag}）`,
      };
    }
    if (b0 === 0xfe && b1 === 0xff) {
      return {
        text: new TextDecoder('utf-16be').decode(body.subarray(2)),
        encoding: 'utf-16be',
        method: 'bom',
        diagnostics: `BOM utf-16be（${diag}）`,
      };
    }
  }
  const afterBom =
    body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? body.subarray(3) : body;

  // ② 严格 UTF-8
  const asUtf8 = strictDecode(afterBom, 'utf-8');
  if (asUtf8 !== null)
    return { text: asUtf8, encoding: 'utf-8', method: 'utf8', diagnostics: `严格 UTF-8 通过（${diag}）` };

  // ③ 本地码页严格试解码（标签缺席/不支持 = 视同未命中）
  if (opts.localLabel != null && opts.localLabel !== '') {
    const asLocal = strictDecode(afterBom, opts.localLabel);
    if (asLocal !== null)
      return {
        text: asLocal,
        encoding: opts.localLabel,
        method: 'local',
        diagnostics: `本地码页 ${opts.localLabel} 严格通过（${diag}）`,
      };
  }

  // ④ 终段有损（read 半边据此抛 FS_DECODE_UNDECIDABLE；spawn 半边收文本+标注）；
  // 标签不支持（small-icu 形态）退 utf-8 替换符——encoding 随实际所用诚实标注
  const { text, label } = lossyDecode(afterBom, opts.localLabel ?? 'utf-8');
  return {
    text,
    encoding: `${label}-lossy`,
    method: 'lossy',
    diagnostics: `UTF-8 与本地码页（${opts.localLabel ?? '无标签'}）严格解码均败（${diag}）`,
  };
}

/** 有损解码（标签不支持/缺席退 utf-8 替换符；返回实际所用标签供诚实标注） */
function lossyDecode(bytes: Uint8Array, label: string): { text: string; label: string } {
  try {
    return { text: new TextDecoder(label).decode(bytes), label };
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), label: 'utf-8' };
  }
}

/* ------------------------------------------------------------------ */
/* 码页探测器（win32；非 win32 恒空——③天然跳过）                        */
/* ------------------------------------------------------------------ */

/** 宿主系统码页标签对（两半边各取其正主） */
export interface LocalCodepageLabels {
  /** OEM 码页（控制台输出面——spawn 半边取此值；非 win32 = null） */
  readonly oem: string | null;
  /** ANSI 码页（文件内容面——read 半边取此值；非 win32 = null） */
  readonly ansi: string | null;
}

/** Windows 码页号 → ICU 标签映射（whatwg-encoding 支持面内的常用集；
 *  未列号码页 = null（③视同未命中——如西文 OEM 437/850 不在 whatwg 表，
 *  落④有损+标注是诚实形态） */
const CP_TO_LABEL: Readonly<Record<string, string>> = {
  '936': 'gbk',
  '950': 'big5',
  '932': 'shift_jis',
  '949': 'euc-kr',
  '866': 'ibm866',
  '20866': 'koi8-r',
  '21866': 'koi8-u',
  '28591': 'iso-8859-1',
  '28592': 'iso-8859-2',
  '28593': 'iso-8859-3',
  '28594': 'iso-8859-4',
  '28595': 'iso-8859-5',
  '28596': 'iso-8859-6',
  '28597': 'iso-8859-7',
  '28598': 'iso-8859-8',
  '28599': 'iso-8859-9',
  '28605': 'iso-8859-15',
  '65001': 'utf-8',
  // windows-125x 族（1252 西文 ANSI 等）——两到五位数连号全收
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(1250 + i), `windows-${1250 + i}`] as const)),
};

/** 探测结果缓存（单次探测进程内缓存——成功失败都缓存） */
let cachedLabels: LocalCodepageLabels | undefined;
/** 在飞探测 Promise（并发调用合流单发——防 boot 期多读者连发 reg query） */
let probing: Promise<LocalCodepageLabels> | undefined;

/** 同步窥探已缓存的标签（未探测过 = null——调用方「lossy 且未探过」时再走异步重试） */
export function peekLocalCodepageLabels(): LocalCodepageLabels {
  return cachedLabels ?? { oem: null, ansi: null };
}

/** reg query 单值读取（注册表 NLS 码页号；失败 = null） */
function regQueryCodepage(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    // reg query 快于 PowerShell 一个量级且恒在场；windowsHide 统一纪律（骨架篇 §7.6）
    const child = spawn('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', name], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 5_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      // 输出行形如「    ACP    REG_SZ    936」——取末段十进制码页号
      const m = /REG_SZ\s+(\d+)/.exec(out);
      resolve(m !== null ? m[1]! : null);
    });
  });
}

/**
 * 解析宿主系统码页标签（懒探测、进程内缓存、并发合流单发）。
 * 非 win32 即时返回空对（零 spawn）；win32 首调 = 两发 reg query（ACP/OEMCP）。
 * 探测失败值缓存为 null（重探无益——reg 缺席的 Windows 已坏到无关编码）。
 */
export async function resolveLocalCodepageLabels(): Promise<LocalCodepageLabels> {
  if (cachedLabels !== undefined) return cachedLabels;
  if (probing !== undefined) return probing;
  if (process.platform !== 'win32') {
    cachedLabels = { oem: null, ansi: null };
    return cachedLabels;
  }
  probing = (async () => {
    const [ansiCp, oemCp] = await Promise.all([regQueryCodepage('ACP'), regQueryCodepage('OEMCP')]);
    const labels: LocalCodepageLabels = {
      ansi: ansiCp !== null ? (CP_TO_LABEL[ansiCp] ?? null) : null,
      oem: oemCp !== null ? (CP_TO_LABEL[oemCp] ?? null) : null,
    };
    cachedLabels = labels;
    probing = undefined;
    return labels;
  })();
  return probing;
}
