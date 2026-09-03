/**
 * app — 桌面主入口组合测试（第八十五批批 C，契约篇 §6.11 + 骨架篇 boot 序）。
 *
 * 全栈组合（mock 只停在模型/终端边界）：真 runtime（faux provider，:memory: 库）
 * + 两栈各自注入假终端——首启桌面 → Enter 进应用（引擎交出 + pi-tui 起屏）→
 * Esc 回桌面（pi-tui 保屏停 + 引擎复位全量重绘）→ /exit 退出码 0。
 * 另锁 boot 序三形态：--no-desktop 显式内核 shell / 起屏失败计数回锁 /
 * 熔断回锁后 /desktop 重试成功清账接管。
 *
 * 批 D 增面（第八十五批批 D）：顶栏状态聚合器全链（凭证探针 → 警示槽 →
 * /guide 同源引导文案 = describeProviderFailure 两消费面）+ /shutdown
 * confirm 原语 → in-process 单源编舞自退全链。
 */
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { desktopMain, type DesktopMainOptions } from './desktop-main.js';
import { DEFAULT_MODEL } from './assembly.js';
import { fauxProvider } from '../llm/index.js';
import { bootFailuresPath, clearBootFailures, currentPackageVersion } from './desktop-boot.js';
import { dataDir } from './paths.js';
import type { TerminalIO } from '../desktop/index.js';
import type { TuiChannelOptions } from '../channels/tui.js';

/* ---------------- 测试替身 ---------------- */

/** 桌面引擎侧假终端（desktop-shell.test 同款收窄版） */
class FakeDesktopIO implements TerminalIO {
  readonly written: string[] = [];
  raw = false;
  paused = false;
  private handler: ((chunk: string) => void) | null = null;
  constructor(
    readonly columns = 80,
    readonly rows = 24,
    /** 写出钩子（缺省无操作——失败注入用例抛错模拟起屏失败） */
    private readonly onWrite?: (data: string) => void,
  ) {}
  write(data: string): void {
    this.onWrite?.(data);
    this.written.push(data);
  }
  setRawMode(enabled: boolean): void {
    this.raw = enabled;
  }
  isRaw(): boolean {
    return this.raw;
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  onInput(handler: ((chunk: string) => void) | null): void {
    this.handler = handler;
  }
  onResize(): void {}
  push(chunk: string): void {
    this.handler?.(chunk);
  }
  get output(): string {
    return this.written.join('');
  }
}

/** pi-tui 侧假终端（Terminal 面——start/stop 生命周期 + 输入回调收发） */
class FakeTuiTerminal implements NonNullable<TuiChannelOptions['terminal']> {
  readonly writes: string[] = [];
  started = false;
  stopped = false;
  private inputHandler?: (data: string) => void;
  get columns(): number {
    return 80;
  }
  get rows(): number {
    return 24;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  start(onInput: (data: string) => void): void {
    this.started = true;
    this.stopped = false;
    this.inputHandler = onInput;
  }
  stop(): void {
    this.stopped = true;
    this.started = false;
    this.inputHandler = undefined;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  /** 测试驱动：键入（只在起屏态可达——停屏后输入丢） */
  send(data: string): void {
    this.inputHandler?.(data);
  }
  get output(): string {
    return this.writes.join('');
  }
}

/** 真时序等待（desktop-main 不注时序——帧/判定窗走真定时器，小步等齐） */
const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询等待断言面前置：满套并行负载下 createRuntime/boot 可远超固定 tick 量级
 * （本文件 13:18 满套红实录——boot 45ms 常态但并行 worker 挤兑时超 50ms 窗），
 * 固定等待假红；轮询小步到就绪，5s 帽兜底（真死锁仍会红，不吞缺陷）。
 */
async function waitForCond(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error('等待超时（desktop-main 组合测试前置未就绪）');
    await tick(20);
  }
}

/** 累积读器：每调 drain 新数据并并进累积串（裸 read() 只见增量——轮询断言不丢历史） */
function makeReader(output: PassThrough): () => string {
  let all = '';
  return () => {
    output.setEncoding('utf8');
    let chunk: string | null = output.read();
    while (chunk !== null) {
      all += chunk;
      chunk = output.read();
    }
    return all;
  };
}

/** faux 模型层（组合根全栈纪律：mock 只停在模型层） */
const faux = () => fauxProvider({ provider: 'faux-ledger', models: [{ id: 'm1' }] });

/* ---------------- 数据目录钉扎（防污染真 ~/.berry——G1 教训） ---------------- */

let globalDataDirPrev: string | undefined;
beforeAll(() => {
  globalDataDirPrev = process.env['APP_DATA_DIR'];
  process.env['APP_DATA_DIR'] = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'desktop-main-data-')));
});
afterAll(() => {
  if (globalDataDirPrev === undefined) delete process.env['APP_DATA_DIR'];
  else process.env['APP_DATA_DIR'] = globalDataDirPrev;
});

/** 每用例后清熔断账（起屏失败计数不跨用例串味） */
afterEach(() => {
  clearBootFailures(dataDir());
});

/** 临时工作区（桌面开 berrycode 会话用——独立目录防串） */
function freshWorkspace(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'desktop-main-ws-')));
}

/** 标准选项（faux 模型 + 两栈假终端） */
function baseOptions(desktopIo: FakeDesktopIO, tuiTerminal: FakeTuiTerminal): DesktopMainOptions {
  return {
    dbPath: ':memory:',
    workspace: freshWorkspace(),
    providers: [faux().provider],
    desktopIo,
    tuiTerminal,
  };
}

/* ---------------- 首启换防全链 ---------------- */

describe('desktopMain：首启桌面 → 进应用 → Esc 回桌面 → /exit（换防编舞全链）', () => {
  it('两栈对向换防对称：1049h 两次进屏 + 1049l 交出 + 回桌面后桌面帧再现', async () => {
    const desktopIo = new FakeDesktopIO();
    const tuiTerminal = new FakeTuiTerminal();
    const done = desktopMain(baseOptions(desktopIo, tuiTerminal));
    // 首启桌面：备屏进 + 首帧（品牌行 + 默认应用行）——轮询等帧（固定窗负载下假红）
    await waitForCond(() => desktopIo.output.includes('代码（berrycode）〔默认〕'));
    expect(desktopIo.output).toContain('\x1b[?1049h');
    expect(desktopIo.output).toContain('Berry 桌面');
    expect(desktopIo.raw).toBe(true);

    // Enter（空输入）打开首行应用 = 默认应用 berrycode：引擎交出（1049l）
    desktopIo.push('\r');
    await waitForCond(() => desktopIo.output.includes('\x1b[?1049l') && tuiTerminal.output.length > 0);
    expect(tuiTerminal.started).toBe(true); // pi-tui 起屏（对家栈）

    // Esc 回桌面：pi-tui 停屏（保画面）+ 引擎复位（1049h 二次进 + 全量重绘）
    tuiTerminal.send('\x1b');
    // pi-tui lone-ESC 判定窗 + 复位帧——轮询至停屏 + 二次进屏都在场
    await waitForCond(() => tuiTerminal.stopped && desktopIo.output.split('\x1b[?1049h').length - 1 >= 2);
    const enterCount = desktopIo.output.split('\x1b[?1049h').length - 1;
    expect(enterCount).toBeGreaterThanOrEqual(2); // resume 二次进屏
    const afterBack = desktopIo.written.length;
    expect(desktopIo.output).toContain('Berry 桌面');

    // /exit 退出：退出码 0 + 两栈终退（raw 复原）
    for (const ch of '/exit') desktopIo.push(ch);
    desktopIo.push('\r');
    const code = await done;
    expect(code).toBe(0);
    expect(desktopIo.raw).toBe(false);
    expect(desktopIo.output.length).toBeGreaterThanOrEqual(afterBack);
  }, 20_000);

  it('内核态应用视图收场：--no-desktop 起 /start 进应用 → Esc 出视图回 REPL', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const tuiTerminal = new FakeTuiTerminal();
    const done = desktopMain({
      dbPath: ':memory:',
      workspace: freshWorkspace(),
      providers: [faux().provider],
      noDesktop: true,
      kernelInput: input,
      kernelOutput: output,
      tuiTerminal,
    });
    const sendLine = async (line: string): Promise<void> => {
      input.write(`${line}\n`);
      await tick(30);
    };
    const read = makeReader(output);
    await waitForCond(() => read().includes('--no-desktop 显式形态'));
    expect(read()).toContain('/apps'); // 命令面披露在场
    await sendLine('/apps');
    expect(read()).toContain('berrycode'); // 清单投影在场
    // /start 默认应用：进应用视图（pi-tui 起屏），REPL 行读挂起
    await sendLine('/start berrycode');
    await waitForCond(() => tuiTerminal.started);
    // Esc 出视图回内核 REPL（escapeHook 内核腿：停屏 + 收场等待者）
    tuiTerminal.send('\x1b');
    await waitForCond(() => tuiTerminal.stopped);
    // REPL 已回（下一行命令可达）
    await sendLine('/exit');
    const code = await done;
    expect(code).toBe(0);
  }, 20_000);
});

/* ---------------- 批 D：状态面全链 + 首启引导闭环 + /shutdown 全链 ---------------- */

describe('desktopMain：批 D 顶栏状态面 + 首启引导闭环 + /shutdown 全链', () => {
  it('凭证缺失（缺省模型 provider 未注册）：顶栏亮警示槽 → /guide 同源引导文案（describeProviderFailure 两消费面）', async () => {
    const desktopIo = new FakeDesktopIO();
    const tuiTerminal = new FakeTuiTerminal();
    const done = desktopMain({
      ...baseOptions(desktopIo, tuiTerminal),
      model: DEFAULT_MODEL, // anthropic 缺省——faux-only 装配 = provider 未注册即未配置形态
    });
    // 顶栏五槽位行已活（聚合器首拍）
    await waitForCond(() => desktopIo.output.includes('Berry 桌面'));
    expect(desktopIo.output).toContain('CPU '); // 五槽位真值呈现（批 C 占位顶栏退役）
    // boot 期探针异步落值——轮询等警示槽上屏（值变即通知的差分帧）
    await waitForCond(() => desktopIo.output.includes('⚠ 凭证未配置（anthropic）'));
    // /guide：describeProviderFailure 同源文案（与 berry run stderr 同一函数——禁抄第二份）
    for (const ch of '/guide') desktopIo.push(ch);
    desktopIo.push('\r');
    await waitForCond(() => desktopIo.output.includes('首启引导——模型凭证未配置'));
    const out = desktopIo.output;
    expect(out).toContain('模型 provider「anthropic」未配置凭证');
    expect(out).toContain('ANTHROPIC_API_KEY'); // 环境变量指路同源在场
    // Enter 出引导回桌面 → /exit 退（退出码 0——引导不阻塞使用）
    desktopIo.push('\r');
    await tick(30);
    for (const ch of '/exit') desktopIo.push(ch);
    desktopIo.push('\r');
    await expect(done).resolves.toBe(0);
  }, 20_000);

  it('凭证在位（模型 provider 已注册且自足）：零警示槽 + /guide 已配置说明（探针不误报）', async () => {
    const desktopIo = new FakeDesktopIO();
    const tuiTerminal = new FakeTuiTerminal();
    const done = desktopMain({
      ...baseOptions(desktopIo, tuiTerminal),
      model: 'faux-ledger/m1', // faux provider 已注册且 auth 自足——checkAuth 真值
    });
    await waitForCond(() => desktopIo.output.includes('Berry 桌面'));
    await tick(250); // 探针落值窗（boot 后一次异步——给足结算再断言缺席）
    expect(desktopIo.output).not.toContain('凭证未配置'); // 零警示槽
    // /guide 无警示形态：已配置说明 + 指路（引导不只在警示态可达）
    for (const ch of '/guide') desktopIo.push(ch);
    desktopIo.push('\r');
    await waitForCond(() => desktopIo.output.includes('模型凭证已配置'));
    desktopIo.push('\r');
    await tick(30);
    for (const ch of '/exit') desktopIo.push(ch);
    desktopIo.push('\r');
    await expect(done).resolves.toBe(0);
  }, 20_000);

  it('/shutdown 全链：confirm 原语二次确认（单源恒杀语）→ in-process 编舞自退（复用既有优雅退出序列）', async () => {
    const desktopIo = new FakeDesktopIO();
    const tuiTerminal = new FakeTuiTerminal();
    const done = desktopMain(baseOptions(desktopIo, tuiTerminal));
    await waitForCond(() => desktopIo.output.includes('Berry 桌面'));
    for (const ch of '/shutdown') desktopIo.push(ch);
    desktopIo.push('\r');
    // confirm 视图：标题 + 单源恒杀全家确认语（host-power 同源）
    await waitForCond(() => desktopIo.output.includes('确认关停？'));
    expect(desktopIo.output).toContain('恒杀全家');
    expect(desktopIo.output).toContain('在飞 run、后台 Job、子进程树全收场');
    // Enter 确认 → requestPower → in-process selfExit = front.requestQuit → 既有退出序列收口
    desktopIo.push('\r');
    await expect(done).resolves.toBe(0);
  }, 20_000);
});

/* ---------------- 批 E：系统助手默认应答全链 ---------------- */

/** faux 应答脚本面（pi-ai AssistantMessage/工厂形状——经 setResponses 参数型推导免裸导入；complete.test messageOf 先例） */
type FauxStep = Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0][number];
/** faux 响应工厂签名（步骤联合里的函数肢——显式标注后 lambda 参数才有型） */
type FauxFactoryFn = Extract<FauxStep, (context: never, ...rest: never[]) => unknown>;
/** faux 应答消息面（工厂返回型 Awaited = AssistantMessage） */
type FauxMessage = Awaited<ReturnType<FauxFactoryFn>>;

/** 组装脚本应答（stop 终态纯文本——路 ② 模型应答面；contracts 同构缺 api 元数据故经宽面收口） */
const scriptedAssistantText = (text: string): FauxMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: 'stop',
    timestamp: 1,
  }) as unknown as FauxMessage;

describe('desktopMain：批 E 系统助手默认应答（无前缀文本三路全栈）', () => {
  it('路 ② 模型路：无前缀文本 → assistant 行真装载 → faux complete 单发应答卡上屏', async () => {
    const desktopIo = new FakeDesktopIO();
    const tuiTerminal = new FakeTuiTerminal();
    const ledger = faux();
    const done = desktopMain({
      ...baseOptions(desktopIo, tuiTerminal),
      providers: [ledger.provider], // 换持柄 faux——脚本面与调用账同握
      model: 'faux-ledger/m1', // 凭证在位形态（探针零警示 → 走模型路）
    });
    await waitForCond(() => desktopIo.output.includes('Berry 桌面'));
    // carve-out ③ 纯清单应用全栈物证：桌面清单恰一行（与 berrycode 同形——无浮层无特权位）
    expect(desktopIo.output).toContain('系统助手（assistant）');
    // 脚本一条应答 + 捕获 systemPrompt（内嵌手册进模型面的物证——mock 只停在模型层）
    const seenSystemPrompts: Array<string | undefined> = [];
    const scriptStep: FauxFactoryFn = (context) => {
      seenSystemPrompts.push(context.systemPrompt);
      return scriptedAssistantText('答：桌面输入框无前缀文本即问系统助手。');
    };
    ledger.setResponses([scriptStep]);
    for (const ch of 'how to use') desktopIo.push(ch);
    desktopIo.push('\r');
    await waitForCond(() => desktopIo.output.includes('答：桌面输入框无前缀文本即问系统助手。'));
    const out = desktopIo.output;
    expect(out).toContain('问：how to use'); // 应答卡问句标题
    expect(ledger.state.callCount).toBe(1); // 恰一次模型单发
    expect(seenSystemPrompts[0]).toContain('系统助手'); // 内嵌手册真进系统提示词
    expect(seenSystemPrompts[0]).toContain('不编造'); // 诚实纪律同载
    // Esc 出应答卡回桌面 → /exit 退（退出码 0）
    desktopIo.push('\x1b');
    await tick(50);
    for (const ch of '/exit') desktopIo.push(ch);
    desktopIo.push('\r');
    await expect(done).resolves.toBe(0);
  }, 20_000);

  it('路 ① 凭证缺失：零 LLM 调用直答引导（guidance 同源文案进应答卡）', async () => {
    const desktopIo = new FakeDesktopIO();
    const tuiTerminal = new FakeTuiTerminal();
    const ledger = faux();
    const done = desktopMain({
      ...baseOptions(desktopIo, tuiTerminal),
      providers: [ledger.provider],
      model: DEFAULT_MODEL, // anthropic 未注册 = 未配置形态（批 D 探针同款）
    });
    await waitForCond(() => desktopIo.output.includes('Berry 桌面'));
    // 探针先落值（警示槽在场 = credentialIssue 在场——路 ① 判定输入就绪）
    await waitForCond(() => desktopIo.output.includes('⚠ 凭证未配置（anthropic）'));
    for (const ch of 'how to use') desktopIo.push(ch);
    desktopIo.push('\r');
    await waitForCond(() => desktopIo.output.includes('当前模型凭证未配置——问答无法发起模型调用'));
    const out = desktopIo.output;
    expect(out).toContain('模型 provider「anthropic」未配置凭证'); // describeProviderFailure 同源文案
    expect(out).toContain('ANTHROPIC_API_KEY');
    expect(ledger.state.callCount).toBe(0); // 零 LLM 调用（零配置首启可用的结构性执法点）
    desktopIo.push('\x1b');
    await tick(50);
    for (const ch of '/exit') desktopIo.push(ch);
    desktopIo.push('\r');
    await expect(done).resolves.toBe(0);
  }, 20_000);

  it('路 ③ 诚实回落：应答队列空 → 模型错误终态 → fallback 卡指路 dump-config 与 docs/', async () => {
    const desktopIo = new FakeDesktopIO();
    const tuiTerminal = new FakeTuiTerminal();
    const ledger = faux(); // 零脚本 = faux 空队列错误终态（complete 内置重试后仍败）
    const done = desktopMain({
      ...baseOptions(desktopIo, tuiTerminal),
      providers: [ledger.provider],
      model: 'faux-ledger/m1',
    });
    await waitForCond(() => desktopIo.output.includes('Berry 桌面'));
    await tick(250); // 探针零警示落值窗（凭证在位 → 走模型路）
    for (const ch of 'whatever') desktopIo.push(ch);
    desktopIo.push('\r');
    await waitForCond(() => desktopIo.output.includes('这个问题我暂时答不上来（模型调用未成功）。'));
    const out = desktopIo.output;
    expect(out).toContain('berry dump-config'); // 诊断指路恒在场
    expect(out).toContain('docs/'); // 文档指路恒在场
    desktopIo.push('\x1b');
    await tick(50);
    for (const ch of '/exit') desktopIo.push(ch);
    desktopIo.push('\r');
    await expect(done).resolves.toBe(0);
  }, 20_000);
});

/* ---------------- boot 序三形态 ---------------- */

describe('desktopMain：boot 序（起屏失败计数 / 熔断回锁 / 重试接管）', () => {
  it('起屏失败：同步上抛计数（第 1 次不熔断）→ 回锁内核 shell 横幅披露', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    // 写出即炸 = 引擎首帧失败形态（ENTER_MODES 写出抛）
    const desktopIo = new FakeDesktopIO(80, 24, () => {
      throw new Error('终端写炸');
    });
    const done = desktopMain({
      dbPath: ':memory:',
      workspace: freshWorkspace(),
      providers: [faux().provider],
      desktopIo,
      kernelInput: input,
      kernelOutput: output,
    });
    const read = makeReader(output);
    await waitForCond(() => read().includes('桌面启动失败（第 1 次）'));
    // 回锁横幅 + 失败账本落盘（count 1——未到熔断阈值）
    expect(JSON.parse(readFileSync(bootFailuresPath(dataDir()), 'utf8'))).toEqual({
      version: currentPackageVersion(),
      count: 1,
    });
    input.write('/exit\n');
    await expect(done).resolves.toBe(0);
  }, 20_000);

  it('熔断回锁：账本 2 次预置 → 熔断横幅 + /desktop 重试成功清账接管 + /exit 退', async () => {
    // 预置两连崩账（版本同当前——熔断判据成立）
    writeFileSync(bootFailuresPath(dataDir()), JSON.stringify({ version: currentPackageVersion(), count: 2 }));
    const input = new PassThrough();
    const output = new PassThrough();
    const desktopIo = new FakeDesktopIO();
    const tuiTerminal = new FakeTuiTerminal();
    const done = desktopMain({
      dbPath: ':memory:',
      workspace: freshWorkspace(),
      providers: [faux().provider],
      desktopIo,
      tuiTerminal,
      kernelInput: input,
      kernelOutput: output,
    });
    const sendLine = async (line: string): Promise<void> => {
      input.write(`${line}\n`);
      await tick(30);
    };
    const read = makeReader(output);
    await waitForCond(() => read().includes('已熔断回锁内核最小 shell'));
    const banner = read();
    expect(banner).toContain('连续 2 次');
    expect(desktopIo.written.length).toBe(0); // 熔断态不起屏（引擎零写出）
    // /desktop 重试：好终端 → 起屏成功 → 接管 + 清账
    await sendLine('/desktop');
    await waitForCond(() => read().includes('桌面已接管') && desktopIo.output.includes('Berry 桌面'));
    expect(JSON.parse(readFileSync(bootFailuresPath(dataDir()), 'utf8'))).toEqual({
      version: currentPackageVersion(),
      count: 0,
    });
    // 接管后桌面 /exit 退出（退出码 0）
    for (const ch of '/exit') desktopIo.push(ch);
    desktopIo.push('\r');
    await expect(done).resolves.toBe(0);
  }, 20_000);
});
