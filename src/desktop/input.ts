/**
 * 输入解码器（十一律第 7 条 IME 一等公民 + kitty/legacy 双轨）。
 *
 * 把终端 stdin 字节流解析成结构化输入事件（key/text/ime/paste），一台状态机
 * 两种轨制同吃：
 * - **legacy 轨**：C0 控制码（Ctrl+字母 = 0x01-0x1a）、CSI/SS3 功能键
 *   （`\x1b[A` 箭头、`\x1b[1;5C` Ctrl+Right、`\x1b[3~` Delete、`\x1b[15~` F5…）、
 *   `ESC` 前缀 = alt（`\x1bx`）、`CSI Z` = shift+tab。
 * - **kitty 轨**：`CSI unicode-key-code[:交替键] ; 修饰[:事件型] ; 文本码点 u`
 *   全形解析（kitty 键盘协议规范）；探测应答（`CSI ? flags u`）与 DA1
 *   （`CSI ? …c`）拦截上抛协议落定，绝不误当按键。
 * - **IME 组字态**（CSI u 形态）：key 0 纯文本事件 = OS/IME 组装文本（kitty 规范
 *   原文「终端拿不到键信息时键号必须用 0」）。增量流识别 = 前缀增长检测：新文本
 *   严格扩展挂起预编辑 → 组字中事件（**不派发给焦面**——key/text 消费者永远看
 *   不到，组字中间态绝不落正文）；否则 → 提交事件（主流终端只送提交：首达即
 *   立即交付，零延迟——「组字延迟」反课的正解）。任意按键到达时若预编辑仍
 *   挂起 → 先冲刷为提交（流式预编辑终端的安全网，不双发）。
 * - **legacy 形态 IME**：主流终端组字期间不送任何字节（终端自绘预编辑），提交
 *   以纯 UTF-8 到达——本解码器把它整段作为 text 事件交付（不撕裂、不误判为
 *   按键序列、不被 ESC 判定窗扣住）。带内无标记，诚实不发明启发式。
 * - **bracketed paste**：`\x1b[200~ … \x1b[201~` 整段识别整段交付（内容不逐键
 *   解析——「严格处理」）。
 * - **lone-ESC 判定窗**：ESC 为 chunk 末字节时挂起等续；窗内（escapeWindowMs，
 *   缺省 30ms）无续字节（settle）→ 判 Esc 键。kitty disambiguate 轨下 Esc 键
 *   以 `CSI 27u` 到达，此窗只剩 legacy 轨兜底职责。
 * - **换防吞在途**（契约篇 §6.11）：`discardPending()` 丢弃解析中途的一切在途
 *   转义/粘贴/预编辑状态——换防瞬间 stdin 在途序列不漏进新栈。
 */
import type { InputEvent, KeyEvent, KeyModifiers, KeyboardProtocol } from './types.js';

/** 无修饰键的常量（mods 解码基准） */
const NO_MODS: KeyModifiers = { ctrl: false, alt: false, shift: false, meta: false };

/** CSI ~ 数字键名表（kitty 规范 legacy 功能键编码） */
const TILDE_KEYS: Record<number, string> = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
  11: 'f1',
  12: 'f2',
  13: 'f3',
  14: 'f4',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12',
  29: 'menu',
};

/** kitty CSI u 私用区功能键名表（kitty 规范 Functional key definitions） */
const KITTY_PUA_KEYS: Record<number, string> = {
  57417: 'left',
  57418: 'right',
  57419: 'up',
  57420: 'down',
  57421: 'pageup',
  57422: 'pagedown',
  57423: 'home',
  57424: 'end',
  57425: 'insert',
  57426: 'delete',
};

/** CSI/SS3 字母终点键名表（A 上/B 下/C 右/D 左/H Home/F End/P-S F1-F4） */
const LETTER_KEYS: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  E: 'begin',
  H: 'home',
  F: 'end',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
};

/** 解码器构造选项 */
export interface InputDecoderOptions {
  /** 时钟注入（缺省 Date.now——lone-ESC 判定窗计时） */
  now?: () => number;
  /** lone-ESC 判定窗（ms；缺省 30） */
  escapeWindowMs?: number;
  /** 协议探测落定回调（kitty 应答 / DA1 先到无 kitty 应答） */
  onProtocol?: (protocol: KeyboardProtocol) => void;
}

/** 粘贴态防护帽：超帽强制冲刷（恶意/畸形流不锁死解码器——4 MiB） */
const PASTE_CAP = 4 * 1024 * 1024;
/** bracketed paste 终界（包裹尾——6 字节 \x1b[201~） */
const PASTE_END = '\x1b[201~';

/**
 * rest 尾部可悬置量（遗漏大扫 20260903 desktop D1-1）：终界 PASTE_END 的最长
 * 真前缀后缀长（0-5）。pty 写缓冲分块（典型 4-16KiB）可能把 6 字节终界劈成
 * 两半——上 chunk 尾部恰是终界前缀时不能并入粘贴体（并入后下 chunk 永不匹配
 * 完整终界 → 解码器滞留 paste 态，此后键盘输入全被吞进 pasteBuf 零事件），
 * 须悬置到实例字段待下 chunk 拼回再搜。
 */
function pasteMarkerPrefixLen(rest: string): number {
  const max = Math.min(PASTE_END.length - 1, rest.length);
  for (let k = max; k > 0; k--) {
    if (rest.endsWith(PASTE_END.slice(0, k))) return k;
  }
  return 0;
}
/** CSI 参数缓冲防护帽（超帽丢弃本序列回地面态——畸形流防御） */
const CSI_CAP = 64;

/**
 * 状态机输入解码器。feed 进 chunk、take 排空事件；settle 在判定窗到点时由引擎
 * 调用（lone-ESC 裁决）；discardPending 换防吞在途。
 */
export class InputDecoder {
  /** 事件积压队列（take 排空后换新数组——feed 不回调，避免重入） */
  private queue: InputEvent[] = [];
  /** 解析态：ground 地面 / esc 转义挂起 / csi 参数积攒 / ss3 / paste 粘贴体 */
  private mode: 'ground' | 'esc' | 'csi' | 'ss3' | 'paste' = 'ground';
  /** CSI 参数积攒缓冲（含私用标记 ?/> 与参数字节） */
  private csiBuf = '';
  /** CSI 超帽毒化旗标：序列已判畸形——吞到终点字节整序丢弃（残段不漏成文本） */
  private csiPoisoned = false;
  /** 粘贴体积攒缓冲 */
  private pasteBuf = '';
  /**
   * 跨 chunk 终界悬置尾（≤5 字节，遗漏大扫 20260903 desktop D1-1）：上 chunk
   * 末尾可能是终界 \x1b[201~ 的真前缀——悬置于此，下 chunk 先拼回再搜。生命
   * 周期：paste 态未命中路径置位；终界命中 / 防护帽冲刷 / discardPending 清。
   */
  private pendingPasteTail = '';
  /** 地面态可打印文本游程积攒（连续可打印合并单事件——打字/提交不撕裂） */
  private textRun = '';
  /** lone-ESC 挂起时刻（null = 无挂起） */
  private escPendingAt: number | null = null;
  /** IME 挂起预编辑（组字中间态；null = 无组字） */
  private preedit: string | null = null;
  /** 上一发 CSI 0 文本事件（跟随窗回溯判据——流式预编辑终端的组字态开session锚） */
  private lastCsi0: { text: string; at: number } | null = null;
  /** kitty 协议已应答旗标（DA1 到达时裁 legacy/kitty） */
  private kittyAnswered = false;
  /** 协议落定已上报旗标（事件只发一次） */
  private protocolReported = false;
  private readonly now: () => number;
  private readonly escapeWindowMs: number;
  private readonly onProtocol?: (protocol: KeyboardProtocol) => void;

  constructor(opts: InputDecoderOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.escapeWindowMs = opts.escapeWindowMs ?? 30;
    this.onProtocol = opts.onProtocol;
  }

  /** 组字中旗标（焦面查询面——true 时预编辑在途） */
  get composing(): boolean {
    return this.preedit !== null;
  }

  /** 挂起预编辑全文（无则 null——预编辑渲染面取用） */
  get pendingPreedit(): string | null {
    return this.preedit;
  }

  /** lone-ESC 挂起中（引擎据此装判定窗定时器） */
  get hasPendingEscape(): boolean {
    return this.escPendingAt !== null;
  }

  /** 喂入一个 stdin chunk（字符串已按 UTF-8 解码完成） */
  feed(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      const cp = chunk.codePointAt(i)!;
      switch (this.mode) {
        case 'ground': {
          if (cp === 0x1b) {
            this.flushTextRun();
            this.mode = 'esc';
            i++;
            continue;
          }
          if (cp < 0x20 || cp === 0x7f) {
            this.flushTextRun();
            this.dispatchControl(cp);
            i++;
            continue;
          }
          // 可打印：游程积攒（代理对整对入游程）
          this.textRun += String.fromCodePoint(cp);
          i += cp > 0xffff ? 2 : 1;
          continue;
        }
        case 'esc': {
          if (cp === 0x5b) {
            // '[' —— CSI 序列起
            this.mode = 'csi';
            this.csiBuf = '';
            i++;
            continue;
          }
          if (cp === 0x4f) {
            // 'O' —— SS3 序列起
            this.mode = 'ss3';
            i++;
            continue;
          }
          if (cp === 0x1b) {
            // ESC ESC = alt+Escape（kitty legacy 表：alt+Escape 两字节 1b 1b）
            this.escPendingAt = null;
            this.emitKey('escape', { ...NO_MODS, alt: true });
            this.mode = 'ground';
            i++;
            continue;
          }
          // ESC + 可打印 = legacy alt 编码（如 \x1bx → alt+x）；控制码罕见——吞
          this.escPendingAt = null;
          if (cp >= 0x20 && cp !== 0x7f) {
            const ch = String.fromCodePoint(cp);
            this.emitKey(ch, { ...NO_MODS, alt: true });
            i += cp > 0xffff ? 2 : 1;
          } else {
            i++;
          }
          this.mode = 'ground';
          continue;
        }
        case 'csi': {
          if (cp >= 0x40 && cp <= 0x7e) {
            // 终点字节到——整序派发（毒化序列整序丢弃）
            if (!this.csiPoisoned) this.dispatchCsi(this.csiBuf, String.fromCodePoint(cp));
            this.csiBuf = '';
            this.csiPoisoned = false;
            // dispatchTilde 200 可能已转粘贴态——不覆写（粘贴体接管后续字节）
            if (this.mode === 'csi') this.mode = 'ground';
            this.escPendingAt = null;
            i++;
            continue;
          }
          this.csiBuf += String.fromCodePoint(cp);
          i += cp > 0xffff ? 2 : 1;
          if (this.csiBuf.length > CSI_CAP) {
            // 畸形超帽：毒化标记（继续吞参数到终点字节——不锁死、不误发文本）
            this.csiPoisoned = true;
            this.csiBuf = '';
          }
          continue;
        }
        case 'ss3': {
          // SS3 单字母终点（A/B/C/D/H/F/P/Q/R/S）
          const key = LETTER_KEYS[String.fromCodePoint(cp)];
          this.escPendingAt = null;
          if (key) this.emitKey(key, { ...NO_MODS });
          this.mode = 'ground';
          i++;
          continue;
        }
        case 'paste': {
          // 粘贴体：找包裹尾 PASTE_END——整段交付，体内容不逐键解析。
          // 跨 chunk 终界拼接（遗漏大扫 20260903 desktop D1-1）：上 chunk 尾部
          // 的终界真前缀悬置在 pendingPasteTail——先拼回再搜；命中时推进量须
          // 还账悬置字节（那 tail.length 个字节来自上 chunk，本 chunk 未消费）
          const tail = this.pendingPasteTail;
          this.pendingPasteTail = '';
          const rest = tail + chunk.slice(i);
          const end = rest.indexOf(PASTE_END);
          if (end < 0) {
            // 未命中：头部（确定不可能参与终界）并入体积攒；尾部真前缀悬置
            const hold = pasteMarkerPrefixLen(rest);
            this.pasteBuf += rest.slice(0, rest.length - hold);
            this.pendingPasteTail = rest.slice(rest.length - hold);
            i = chunk.length; // 本 chunk 全量消化（并入或悬置——无剩可解）
            this.enforcePasteCap();
          } else {
            this.pasteBuf += rest.slice(0, end);
            const text = this.pasteBuf;
            this.pasteBuf = '';
            this.mode = 'ground';
            this.escPendingAt = null;
            // 终界长 6 > 悬置上限 5 ⇒ 推进量恒 ≥1（无死循环）；且 end+6 ≤
            // rest.length 保证不越过本 chunk 末尾
            i += end + PASTE_END.length - tail.length;
            if (text.length > 0) this.queue.push({ kind: 'paste', text });
          }
          continue;
        }
      }
    }
    // chunk 尽：地面态文本游程冲刷（每 chunk 一个 text 事件——跨 chunk 不滞留；
    // esc/csi/paste 态下 textRun 必为空，冲刷为无操作）
    this.flushTextRun();
    // esc 态挂起无续 → 记 lone-ESC 判定窗起点（首帧记时）
    if (this.mode === 'esc' && this.escPendingAt === null) {
      this.escPendingAt = this.now();
    }
  }

  /** 判定窗裁决（引擎在窗到点调用）：仍挂起 → 判 Esc 键 */
  settle(): void {
    if (this.mode === 'esc' && this.escPendingAt !== null) {
      if (this.now() - this.escPendingAt >= this.escapeWindowMs) {
        this.escPendingAt = null;
        this.mode = 'ground';
        this.emitKey('escape', { ...NO_MODS });
      }
    }
  }

  /**
   * 换防吞在途（契约篇 §6.11）：丢弃解析中途的转义/粘贴/预编辑/文本游程——
   * 换防瞬间 stdin 在途序列一窗全丢，不漏进新栈。
   */
  discardPending(): void {
    this.mode = 'ground';
    this.csiBuf = '';
    this.csiPoisoned = false;
    this.pasteBuf = '';
    this.pendingPasteTail = '';
    this.textRun = '';
    this.escPendingAt = null;
    this.preedit = null;
  }

  /** 排空事件队列（引擎 emit 的取货口） */
  take(): InputEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** 游程冲刷：地面态连续可打印合并成一个 text 事件（提交/打字不撕裂） */
  private flushTextRun(): void {
    if (this.textRun.length > 0) {
      this.queue.push({ kind: 'text', text: this.textRun });
      this.textRun = '';
    }
  }

  /** 按键派发（预编辑挂起时先冲刷为提交——流式组字安全网） */
  private emitKey(key: string, mods: KeyModifiers, eventType?: KeyEvent['eventType']): void {
    this.flushImeOnInterrupt();
    this.queue.push({ kind: 'key', key, mods, ...(eventType ? { eventType } : {}) });
  }

  /** 预编辑被非组字事件打断 → 冲刷为提交（终端漏发显式提交时的兜底） */
  private flushImeOnInterrupt(): void {
    if (this.preedit !== null) {
      const text = this.preedit;
      this.preedit = null;
      this.queue.push({ kind: 'ime', composing: false, text });
    }
  }

  /** C0 控制码 → 键事件（kitty legacy ctrl 映射表：a-z=0x01-0x1a 等） */
  private dispatchControl(cp: number): void {
    if (cp === 0x0d || cp === 0x0a) {
      this.emitKey('enter', { ...NO_MODS });
      return;
    }
    if (cp === 0x09) {
      this.emitKey('tab', { ...NO_MODS });
      return;
    }
    if (cp === 0x7f) {
      this.emitKey('backspace', { ...NO_MODS });
      return;
    }
    if (cp === 0x00) {
      this.emitKey('space', { ...NO_MODS, ctrl: true });
      return;
    }
    if (cp >= 0x01 && cp <= 0x1a) {
      // ctrl+字母：0x01=a … 0x1a=z（0x08=h/0x09=i/0x0d=m 由上优先拦走）
      this.emitKey(String.fromCharCode(cp + 96), { ...NO_MODS, ctrl: true });
      return;
    }
    if (cp >= 0x1c && cp <= 0x1f) {
      // ctrl+标点（kitty 表：\ ] ^ _）
      this.emitKey(String.fromCharCode(cp + 64), { ...NO_MODS, ctrl: true });
      return;
    }
    // 其余 C0（0x1b 已在状态机先行）：吞
  }

  /** CSI 整序派发（params 含私用标记；final 为终点字节） */
  private dispatchCsi(params: string, final: string): void {
    // 私用标记 '?' 开头 = 终端应答（探测/DA1）——协议面处理，绝不误当按键
    if (params.startsWith('?')) {
      if (final === 'u') {
        this.kittyAnswered = true;
        if (!this.protocolReported) {
          this.protocolReported = true;
          this.onProtocol?.('kitty');
        }
      } else if (final === 'c') {
        // DA1 应答：kitty 应答从未到 → legacy 落定
        if (!this.protocolReported) {
          this.protocolReported = true;
          this.onProtocol?.(this.kittyAnswered ? 'kitty' : 'legacy');
        }
      }
      return; // 其余私用应答（CPR 等）吞
    }
    if (final === 'u') {
      this.dispatchKittyKey(params);
      return;
    }
    if (final === '~') {
      this.dispatchTilde(params);
      return;
    }
    if (final === 'Z') {
      this.emitKey('tab', { ...NO_MODS, shift: true });
      return;
    }
    if (final === 'R') {
      return; // 光标位置报告应答形状——吞（引擎从不请求，防串扰误键）
    }
    if (final === 'I' || final === 'O') {
      return; // 焦点进出通知——吞（v1 不消费）
    }
    const letterKey = LETTER_KEYS[final];
    if (letterKey) {
      // CSI A/B/C/D/H/F/P-S（`CSI 1;mods C` 修饰形同表）
      const parts = params.split(';');
      this.emitKey(letterKey, decodeMods(parts[1]));
      return;
    }
    // 未知序列：吞（fail-silent——协议噪音吸收，不出垃圾文本）
  }

  /** CSI number[;mods] ~ 功能键派发（200/201 粘贴包裹由 paste 态接管） */
  private dispatchTilde(params: string): void {
    const parts = params.split(';');
    const n = Number(parts[0]);
    if (parts[0] === '200') {
      // bracketed paste 开始：转粘贴体积攒态
      this.mode = 'paste';
      this.pasteBuf = '';
      return;
    }
    if (parts[0] === '201') {
      return; // 裸包裹尾（无开始）——吞
    }
    const key = TILDE_KEYS[n];
    if (key) this.emitKey(key, decodeMods(parts[1]));
  }

  /**
   * kitty CSI u 全形派发：
   * `CSI key[:交替键] ; 修饰[:事件型] ; 文本码点 u`
   */
  private dispatchKittyKey(params: string): void {
    const fields = params.split(';');
    const keyParts = (fields[0] ?? '').split(':');
    const keyCode = Number(keyParts[0]);
    if (!Number.isFinite(keyCode)) return;
    // 修饰子域：值 = 1+位域；冒号后缀 = 事件型（1 press 缺省/2 repeat/3 release）
    const modParts = (fields[1] ?? '').split(':');
    const mods = decodeMods(modParts[0]);
    const evTypeNum = modParts.length > 1 ? Number(modParts[1]) : 1;
    const eventType = evTypeNum === 2 ? 'repeat' : evTypeNum === 3 ? 'release' : undefined;
    // 文本子域：冒号分隔码点列表
    const text = (fields[2] ?? '')
      .split(':')
      .filter((s) => s.length > 0)
      .map((s) => String.fromCodePoint(Number(s)))
      .join('');

    // IME/文本优先裁决：key 0 纯文本事件（终端拿不到键信息 = OS/IME 组装）
    if (keyCode === 0 && text.length > 0) {
      this.dispatchImeText(text);
      return;
    }
    const keyName = this.kittyKeyName(keyCode);
    if (keyName === undefined) {
      // 未知键号：带文本则按提交交付，否则吞
      if (text.length > 0) this.dispatchImeText(text);
      return;
    }
    if (text.length > 0) {
      // 文本字段在场：与键符一致（大小写不敏感）= 普通打字 → text 事件；
      // 不一致 = 死键/组合变换文本 → IME 提交路径
      const plain = text.length === 1 && text.toLowerCase() === keyName.toLowerCase();
      if (plain) {
        this.flushImeOnInterrupt();
        this.queue.push({ kind: 'text', text });
        return;
      }
      this.dispatchImeText(text);
      return;
    }
    this.emitKey(keyName, mods, eventType);
  }

  /** kitty 键号 → 规范键名（功能键表 + 可打印码点直映） */
  private kittyKeyName(keyCode: number): string | undefined {
    if (keyCode === 27) return 'escape';
    if (keyCode === 13) return 'enter';
    if (keyCode === 9) return 'tab';
    if (keyCode === 127) return 'backspace';
    const pua = KITTY_PUA_KEYS[keyCode];
    if (pua) return pua;
    if (keyCode >= 0x20 && keyCode <= 0x10ffff) {
      const ch = String.fromCodePoint(keyCode);
      if (ch >= ' ') return ch; // 可打印（无 shift 修饰原形——kitty 恒小写规范）
    }
    return undefined;
  }

  /**
   * IME 文本事件裁决（组字态机）：
   * - 组字 session 在途：新文本严格扩展挂起预编辑 → 组字中（**不派发给焦面**，
   *   仅供预编辑渲染）；不扩展 → 冲刷为提交。
   * - 无 session：主流终端 CSI 0 只送单发提交 → **立即交付零延迟**。跟随窗内
   *   再来一发且与前发构成前缀链 → 判流式预编辑终端：回溯开 session（前发已
   *   交付不可撤——流式首块漏判是本设计的已知边界，注释在案），本发转组字中。
   */
  private dispatchImeText(text: string): void {
    if (this.preedit !== null && text.length > this.preedit.length && text.startsWith(this.preedit)) {
      this.preedit = text;
      this.queue.push({ kind: 'ime', composing: true, text });
      return;
    }
    // 无 session：跟随窗内前缀链 → 流式预编辑终端，回溯开 session
    const last = this.lastCsi0;
    if (
      this.preedit === null &&
      last !== null &&
      this.now() - last.at <= this.imeFollowWindowMs &&
      (text.startsWith(last.text) || last.text.startsWith(text)) &&
      text !== last.text
    ) {
      this.preedit = text;
      this.queue.push({ kind: 'ime', composing: true, text });
      this.lastCsi0 = { text, at: this.now() };
      return;
    }
    this.preedit = null;
    this.lastCsi0 = { text, at: this.now() };
    this.queue.push({ kind: 'ime', composing: false, text });
  }

  /** IME 跟随窗（ms）：两发 CSI 0 在窗内构成前缀链 = 流式预编辑（kitty 单发提交不受影响） */
  private readonly imeFollowWindowMs = 100;

  /** 粘贴体防护帽：超帽强制冲刷并回地面（畸形流不锁死键盘） */
  private enforcePasteCap(): void {
    if (this.pasteBuf.length > PASTE_CAP) {
      const text = this.pasteBuf;
      this.pasteBuf = '';
      this.pendingPasteTail = ''; // 悬置尾同弃（已回地面态——半截终界无意义）
      this.mode = 'ground';
      if (text.length > 0) this.queue.push({ kind: 'paste', text });
    }
  }
}

/** kitty 修饰参数（值 = 1+位域）→ KeyModifiers（shift 1/alt 2/ctrl 4/super8+hyper16+meta32 → meta） */
function decodeMods(param: string | undefined): KeyModifiers {
  const v = Number(param ?? '1') - 1;
  if (!Number.isFinite(v) || v <= 0) return { ...NO_MODS };
  return {
    shift: (v & 0b1) !== 0,
    alt: (v & 0b10) !== 0,
    ctrl: (v & 0b100) !== 0,
    meta: (v & 0b111000) !== 0,
  };
}
