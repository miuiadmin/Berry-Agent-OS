/**
 * 输入解码器单元测试（十一律第 7 条）：kitty/legacy 双轨 + IME 组字态机 +
 * 严格粘贴 + lone-ESC 判定窗 + 换防吞在途 + 协议探测。
 */
import { describe, expect, it } from 'vitest';
import { InputDecoder } from './input.js';
import type { InputEvent, KeyboardProtocol } from './types.js';

/** 可变假钟（now() 恒读闭包 t——settle 判定窗计时注入） */
function makeClock(start = 1000): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

/** 喂串并取回事件（常用短路） */
function feed(decoder: InputDecoder, chunk: string): InputEvent[] {
  decoder.feed(chunk);
  return decoder.take();
}

describe('legacy 轨：功能键与控制码', () => {
  it('箭头/Home/End/F 键（CSI 与 SS3 两形）', () => {
    const d = new InputDecoder();
    expect(feed(d, '\x1b[A')).toEqual([
      { kind: 'key', key: 'up', mods: { ctrl: false, alt: false, shift: false, meta: false } },
    ]);
    expect(feed(d, '\x1b[B')[0]).toMatchObject({ kind: 'key', key: 'down' });
    expect(feed(d, '\x1b[C')[0]).toMatchObject({ kind: 'key', key: 'right' });
    expect(feed(d, '\x1b[D')[0]).toMatchObject({ kind: 'key', key: 'left' });
    expect(feed(d, '\x1bOA')[0]).toMatchObject({ kind: 'key', key: 'up' }); // SS3 形
    expect(feed(d, '\x1b[H')[0]).toMatchObject({ kind: 'key', key: 'home' });
    expect(feed(d, '\x1b[F')[0]).toMatchObject({ kind: 'key', key: 'end' });
    expect(feed(d, '\x1bOP')[0]).toMatchObject({ kind: 'key', key: 'f1' });
    expect(feed(d, '\x1b[15~')[0]).toMatchObject({ kind: 'key', key: 'f5' }); // TILDE 表
    expect(feed(d, '\x1b[3~')[0]).toMatchObject({ kind: 'key', key: 'delete' });
    expect(feed(d, '\x1b[5~')[0]).toMatchObject({ kind: 'key', key: 'pageup' });
  });

  it('Enter/Tab/Backspace/shift+tab 与 Ctrl 组合', () => {
    const d = new InputDecoder();
    expect(feed(d, '\r')[0]).toMatchObject({ kind: 'key', key: 'enter' });
    expect(feed(d, '\n')[0]).toMatchObject({ kind: 'key', key: 'enter' });
    expect(feed(d, '\t')[0]).toMatchObject({ kind: 'key', key: 'tab' });
    expect(feed(d, '\x7f')[0]).toMatchObject({ kind: 'key', key: 'backspace' });
    expect(feed(d, '\x1b[Z')[0]).toMatchObject({ kind: 'key', key: 'tab', mods: { shift: true } });
    expect(feed(d, '\x03')[0]).toMatchObject({ kind: 'key', key: 'c', mods: { ctrl: true } });
    expect(feed(d, '\x04')[0]).toMatchObject({ kind: 'key', key: 'd', mods: { ctrl: true } });
    expect(feed(d, '\x00')[0]).toMatchObject({ kind: 'key', key: 'space', mods: { ctrl: true } });
    expect(feed(d, '\x1c')[0]).toMatchObject({ kind: 'key', key: '\\', mods: { ctrl: true } });
  });

  it('修饰功能键：Ctrl+Right = CSI 1;5C', () => {
    const d = new InputDecoder();
    expect(feed(d, '\x1b[1;5C')[0]).toMatchObject({
      kind: 'key',
      key: 'right',
      mods: { ctrl: true },
    });
  });

  it('alt 编码：ESC 前缀 + ESC ESC', () => {
    const d = new InputDecoder();
    expect(feed(d, '\x1bx')[0]).toMatchObject({ kind: 'key', key: 'x', mods: { alt: true } });
    expect(feed(d, '\x1b\x1b')[0]).toMatchObject({ kind: 'key', key: 'escape', mods: { alt: true } });
  });

  it('可打印文本：游程合并单事件、跨 chunk 各自成事件', () => {
    const d = new InputDecoder();
    expect(feed(d, 'abc')).toEqual([{ kind: 'text', text: 'abc' }]);
    expect(feed(d, 'x')).toEqual([{ kind: 'text', text: 'x' }]);
    // UTF-8 多字节整对入游程（代理对不撕裂）
    expect(feed(d, '中文')).toEqual([{ kind: 'text', text: '中文' }]);
    // 文本后随控制码：先 text 后 key（游程先行冲刷）
    const evs = feed(d, 'hi\r');
    expect(evs[0]).toEqual({ kind: 'text', text: 'hi' });
    expect(evs[1]).toMatchObject({ kind: 'key', key: 'enter' });
  });
});

describe('lone-ESC 判定窗', () => {
  it('悬置零事件；判定窗内续到 CSI → 功能键（跨 chunk 迟续路径）', () => {
    const clock = makeClock();
    const decoder = new InputDecoder({ now: clock.now, escapeWindowMs: 30 });
    decoder.feed('\x1b'); // chunk 末尾悬置
    expect(decoder.hasPendingEscape).toBe(true);
    expect(decoder.take()).toEqual([]); // 未裁决零事件
    // 迟续：窗内 '[' 'A' 到达 → up
    decoder.feed('[A');
    expect(decoder.take()[0]).toMatchObject({ kind: 'key', key: 'up' });
    expect(decoder.hasPendingEscape).toBe(false);
  });

  it('真 lone-ESC：窗未到 settle 零事件；窗到点出 Esc 键', () => {
    const clock = makeClock();
    const decoder = new InputDecoder({ now: clock.now, escapeWindowMs: 30 });
    decoder.feed('\x1b');
    clock.set(1010); // 窗内
    decoder.settle();
    expect(decoder.take()).toEqual([]);
    decoder.feed('\x1b'); // 再悬置
    clock.set(1040); // 窗到点
    decoder.settle();
    expect(decoder.take()[0]).toMatchObject({ kind: 'key', key: 'escape' });
    expect(decoder.hasPendingEscape).toBe(false);
  });
});

describe('kitty 轨：CSI u 全形', () => {
  it('普通键/修饰键/事件型/PUA 功能键/语义键号', () => {
    const d = new InputDecoder();
    expect(feed(d, '\x1b[97u')[0]).toMatchObject({ kind: 'key', key: 'a' });
    expect(feed(d, '\x1b[97;5u')[0]).toMatchObject({ kind: 'key', key: 'a', mods: { ctrl: true } });
    expect(feed(d, '\x1b[97;2u')[0]).toMatchObject({ kind: 'key', key: 'a', mods: { shift: true } });
    // 交替键子域（97:65）忽略；事件型子域（1:3 release / 1:2 repeat / 缺省 press）
    expect(feed(d, '\x1b[97:65;2u')[0]).toMatchObject({ kind: 'key', key: 'a', mods: { shift: true } });
    expect(feed(d, '\x1b[97;1:3u')[0]).toMatchObject({ kind: 'key', key: 'a', eventType: 'release' });
    expect(feed(d, '\x1b[97;1:2u')[0]).toMatchObject({ kind: 'key', key: 'a', eventType: 'repeat' });
    const press = feed(d, '\x1b[97u')[0] as { eventType?: unknown };
    expect(press.eventType).toBeUndefined();
    // PUA 功能键
    expect(feed(d, '\x1b[57417u')[0]).toMatchObject({ kind: 'key', key: 'left' });
    expect(feed(d, '\x1b[57424u')[0]).toMatchObject({ kind: 'key', key: 'end' });
    // 语义键号
    expect(feed(d, '\x1b[27u')[0]).toMatchObject({ kind: 'key', key: 'escape' });
    expect(feed(d, '\x1b[13u')[0]).toMatchObject({ kind: 'key', key: 'enter' });
    expect(feed(d, '\x1b[127u')[0]).toMatchObject({ kind: 'key', key: 'backspace' });
  });

  it('文本子域：与键符一致 → text 事件；shift 大写文本照常 text', () => {
    const d = new InputDecoder();
    expect(feed(d, '\x1b[97;;97u')).toEqual([{ kind: 'text', text: 'a' }]);
    // shift+a 文本 'A'：toLowerCase 后与键符一致 → text
    expect(feed(d, '\x1b[97;2;65u')).toEqual([{ kind: 'text', text: 'A' }]);
  });
});

describe('IME 组字态机', () => {
  it('主流单发提交：CSI 0 立即交付零延迟（不进组字态）', () => {
    const clock = makeClock();
    const d = new InputDecoder({ now: clock.now });
    expect(feed(d, '\x1b[0;;20013u')).toEqual([{ kind: 'ime', composing: false, text: '中' }]);
    expect(d.composing).toBe(false);
    // 跟随窗外再来一发（非前缀链）→ 仍是独立提交
    clock.set(5000);
    expect(feed(d, '\x1b[0;;20320u')).toEqual([{ kind: 'ime', composing: false, text: '你' }]);
  });

  it('跟随窗前缀链 → 回溯开组字 session（流式预编辑终端形态）', () => {
    const clock = makeClock();
    const d = new InputDecoder({ now: clock.now });
    // 首发被当提交交付（流式首块漏判边界——设计在案）
    expect(feed(d, '\x1b[0;;110u')).toEqual([{ kind: 'ime', composing: false, text: 'n' }]);
    // 窗内第二发构成前缀链 → 回溯开 session，本发转组字中（不派发焦面键）
    clock.set(1050);
    expect(feed(d, '\x1b[0;;110:105u')).toEqual([{ kind: 'ime', composing: true, text: 'ni' }]);
    expect(d.composing).toBe(true);
    expect(d.pendingPreedit).toBe('ni');
    // 增量增长续组字
    clock.set(1080);
    expect(feed(d, '\x1b[0;;110:105:104:97:111u')[0]).toEqual({
      kind: 'ime',
      composing: true,
      text: 'nihao',
    });
    // 非扩展 → 冲刷提交收口
    clock.set(1110);
    const evs = feed(d, '\x1b[0;;20320:22909u');
    expect(evs[0]).toEqual({ kind: 'ime', composing: false, text: '你好' });
    expect(d.composing).toBe(false);
  });

  it('组字被按键打断 → 先冲刷提交再出键（不双发不丢字）', () => {
    const clock = makeClock();
    const d = new InputDecoder({ now: clock.now });
    expect(feed(d, '\x1b[0;;110u')).toEqual([{ kind: 'ime', composing: false, text: 'n' }]);
    clock.set(1050);
    expect(feed(d, '\x1b[0;;110:105u')).toEqual([{ kind: 'ime', composing: true, text: 'ni' }]);
    expect(d.composing).toBe(true);
    const evs = feed(d, '\x1b[A'); // 上箭头打断
    expect(evs[0]).toEqual({ kind: 'ime', composing: false, text: 'ni' });
    expect(evs[1]).toMatchObject({ kind: 'key', key: 'up' });
  });

  it('legacy 形态：纯 UTF-8 提交按 text 整段交付（不误判不撕裂）', () => {
    const d = new InputDecoder();
    expect(feed(d, '你好世界')).toEqual([{ kind: 'text', text: '你好世界' }]);
  });
});

describe('协议探测（kitty/legacy 落定）', () => {
  it('CSI ? u 应答 → kitty（一次上报）；应答绝不误当按键', () => {
    const seen: KeyboardProtocol[] = [];
    const d = new InputDecoder({ onProtocol: (p) => seen.push(p) });
    expect(feed(d, '\x1b[?1u')).toEqual([]); // 零键事件
    feed(d, '\x1b[?0u');
    expect(seen).toEqual(['kitty']); // 只上报一次
  });

  it('DA1 先到无 kitty 应答 → legacy', () => {
    const seen: KeyboardProtocol[] = [];
    const d = new InputDecoder({ onProtocol: (p) => seen.push(p) });
    expect(feed(d, '\x1b[?62;1c')).toEqual([]);
    expect(seen).toEqual(['legacy']);
  });

  it('kitty 应答先到、DA1 后到 → kitty 维持', () => {
    const seen: KeyboardProtocol[] = [];
    const d = new InputDecoder({ onProtocol: (p) => seen.push(p) });
    d.feed('\x1b[?1u');
    d.feed('\x1b[?62;1c');
    expect(seen).toEqual(['kitty']);
  });
});

describe('bracketed paste（严格整段）', () => {
  it('单 chunk 整段交付；内容不逐键解析', () => {
    const d = new InputDecoder();
    expect(feed(d, '\x1b[200~hello world\x1b[201~')).toEqual([{ kind: 'paste', text: 'hello world' }]);
    // 体内容含转义形字符：照抄交付，不解析成键
    expect(feed(d, '\x1b[200~\x1b[A\r\x1b[201~')).toEqual([{ kind: 'paste', text: '\x1b[A\r' }]);
  });

  it('跨 chunk 分片拼装', () => {
    const d = new InputDecoder();
    d.feed('\x1b[200~hel');
    expect(d.take()).toEqual([]);
    d.feed('lo\x1b[201~');
    expect(d.take()).toEqual([{ kind: 'paste', text: 'hello' }]);
  });

  it('粘贴体含 CRLF 保持原样（引擎不静默改写内容）', () => {
    const d = new InputDecoder();
    expect(feed(d, '\x1b[200~a\r\nb\x1b[201~')).toEqual([{ kind: 'paste', text: 'a\r\nb' }]);
  });
});

describe('畸形流防御与换防吞在途', () => {
  it('CSI 超帽：丢序列回地面，后续文本正常', () => {
    const d = new InputDecoder();
    const evs = feed(d, '\x1b[' + '1'.repeat(70) + 'u' + 'x');
    expect(evs).toEqual([{ kind: 'text', text: 'x' }]);
  });

  it('未知序列与 CPR/焦点通知吞（不出垃圾文本）', () => {
    const d = new InputDecoder();
    expect(feed(d, '\x1b[99;1R')).toEqual([]);
    expect(feed(d, '\x1b[I')).toEqual([]);
    expect(feed(d, '\x1b[O')).toEqual([]);
    expect(feed(d, '\x1b[99~')).toEqual([]);
  });

  it('discardPending：解析中途一窗全丢，残尾按地面态重解', () => {
    const d = new InputDecoder();
    d.feed('\x1b[97'); // CSI 半截在途
    d.discardPending();
    const evs = feed(d, 'u'); // 残尾字节：不再当序列终点
    expect(evs).toEqual([{ kind: 'text', text: 'u' }]);
  });

  it('粘贴体跨态被换防吞：半截粘贴体不泄漏', () => {
    const d = new InputDecoder();
    d.feed('\x1b[200~sec');
    d.discardPending();
    expect(feed(d, 'ret\x1b[201~')).toEqual([{ kind: 'text', text: 'ret' }]); // 裸尾包吞
  });
});
