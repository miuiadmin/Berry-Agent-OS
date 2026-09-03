/**
 * app — 内核最小 shell 测试（第八十五批批 C，骨架篇 boot 序兜底交互面）。
 *
 * 测法 = PassThrough 流对（mock 停在 stdio 边界）：五动词对话面 / 双确认 /
 * 交接次序执法（交出方三件套先行——startApp/retryDesktop 在飞期间 input 零
 * data 监听）/ 静默退位（接管成功不写污染文案）/ 宿主退出信号结算挂起的
 * question / 零仓依赖静态声明（兜底面不 import 被兜底的东西——文本面执法）。
 */
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runKernelShell, type KernelShellDeps } from './kernel-shell.js';

/* ---------------- 测试替身 ---------------- */

/** stdio 替身对 + 喂行工具（回车即一行——readline 行协议） */
function makeStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  /** 喂一行（含换行符）并等 REPL 消费再武装下一问（readline 对无问在场的行
   * 会丢弃——逐行推进避免行早到掉包） */
  const sendLine = async (line: string): Promise<void> => {
    input.write(`${line}\n`);
    await new Promise((resolve) => setImmediate(resolve));
  };
  /** 收到的全部输出（banner/提示/回执） */
  const readAll = (): string => {
    output.setEncoding('utf8');
    const chunks: string[] = [];
    let chunk: string | null = output.read();
    while (chunk !== null) {
      chunks.push(chunk);
      chunk = output.read();
    }
    return chunks.join('');
  };
  return { input, output, sendLine, readAll };
}

/** deps 桩（动词 mock 记账——各用例按需覆写行为） */
function makeDeps(
  streams: ReturnType<typeof makeStreams>,
  overrides: Partial<KernelShellDeps> = {},
): KernelShellDeps & { exitCalls: number[]; started: string[]; desktopRetries: string[] } {
  const exitCalls: number[] = [];
  const started: string[] = [];
  const desktopRetries: string[] = [];
  const deps: KernelShellDeps = {
    input: streams.input,
    output: streams.output,
    listApps: () => [
      { id: 'chat', label: '对话' },
      { id: 'berrycode', label: '代码' },
    ],
    startApp: async (appId) => {
      started.push(appId);
      return { ok: true };
    },
    retryDesktop: async () => {
      desktopRetries.push('attempt');
      return { ok: false, error: '渲染栈崩坏' };
    },
    requestExit: () => {
      exitCalls.push(exitCalls.length);
    },
    ...overrides,
  };
  return Object.assign(deps, { exitCalls, started, desktopRetries });
}

/* ---------------- 动词面 ---------------- */

describe('kernel-shell：动词面', () => {
  it('/apps 清单投影 + 未知命令提示不退出 + 空行忽略', async () => {
    const streams = makeStreams();
    const deps = makeDeps(streams);
    const done = runKernelShell({ ...deps, banner: '横幅' });
    await streams.sendLine('/apps');
    await streams.sendLine('裸词');
    await streams.sendLine(''); // 空行——无回执无退出
    await streams.sendLine('/exit');
    await expect(done).resolves.toBe('exit');
    const out = streams.readAll();
    expect(out).toContain('横幅');
    expect(out).toContain('chat — 对话');
    expect(out).toContain('berrycode — 代码');
    expect(out).toContain('未知命令：裸词');
    expect(out).toContain('kernel> '); // 行读提示符在屏
    expect(deps.exitCalls.length).toBe(1);
  });

  it('空清单形态：装机指引文案（--no-apps / 空组合树不是死屏）', async () => {
    const streams = makeStreams();
    const deps = makeDeps(streams, { listApps: () => [] });
    const done = runKernelShell(deps);
    await streams.sendLine('/apps');
    await streams.sendLine('/exit');
    await expect(done).resolves.toBe('exit');
    expect(streams.readAll()).toContain('无应用');
  });

  it('/start <id>：交出方三件套先行（startApp 在飞期间 input 零 data 监听）；拒因转述；缺参用法（遗漏大扫 20260903 conc D1-2 修死）', async () => {
    const streams = makeStreams();
    const started: string[] = []; // override 自记账（缺省记账被覆写）
    const listenersInFlight: number[] = []; // startApp 在飞期采样 input 的 data 监听数
    const deps = makeDeps(streams, {
      startApp: async (appId) => {
        started.push(appId);
        // 序执法采样：进入在飞期间行读面必须已交出（rl.close 拆 data 监听 +
        // 停流全三件；修前只 pause——监听仍在，接收方 resume 即双消费，视图
        // 期按键泄漏进 REPL 编辑线）
        listenersInFlight.push(streams.input.listenerCount('data'));
        return appId === 'chat' ? { ok: true } : { ok: false, error: '组件缺场' };
      },
    });
    const done = runKernelShell(deps);
    await streams.sendLine('/start chat');
    // startApp 结算后重武装行读面（新建接口非 resume 旧面——REPL 续读下一行）
    await new Promise((resolve) => setImmediate(resolve));
    await streams.sendLine('/start ghost');
    await new Promise((resolve) => setImmediate(resolve));
    await streams.sendLine('/start');
    await new Promise((resolve) => setImmediate(resolve));
    await streams.sendLine('/exit');
    await expect(done).resolves.toBe('exit');
    const out = streams.readAll();
    expect(started).toEqual(['chat', 'ghost']);
    // 两次真进入的飞行窗口内监听数恰零（修前 pause 留监听 ≥1——红；拒因/缺参不进窗口）
    expect(listenersInFlight).toEqual([0, 0]);
    expect(out).toContain('进入失败：组件缺场');
    expect(out).toContain('用法：/start <应用id>');
  });

  it('/shutdown 双确认：第一击武装 + 中途他词解除 + 第二击执行', async () => {
    const streams = makeStreams();
    const deps = makeDeps(streams);
    const done = runKernelShell(deps);
    await streams.sendLine('/shutdown');
    await new Promise((resolve) => setImmediate(resolve));
    expect(streams.readAll()).toContain('再输一次 /shutdown');
    await streams.sendLine('/apps'); // 他词解除武装
    await streams.sendLine('/shutdown'); // 重新武装（非执行）
    await new Promise((resolve) => setImmediate(resolve));
    await streams.sendLine('/shutdown'); // 连续第二击——执行
    await expect(done).resolves.toBe('shutdown');
    expect(deps.exitCalls.length).toBe(1);
  });

  it('/shutdown 批 D 单源接线：宿主注入 requestShutdown + 恒杀全家确认语（第二击走单源编舞不回落 requestExit）', async () => {
    const streams = makeStreams();
    const shutdownCalls: string[] = [];
    const deps = makeDeps(streams, {
      requestShutdown: () => {
        shutdownCalls.push('shutdown');
      },
      shutdownConfirmText:
        '确认关停？恒杀全家：在飞 run、后台 Job、子进程树全收场（非挂起——真关机，无温柔版）——再输一次 /shutdown 执行（其他命令取消）',
    });
    const done = runKernelShell(deps);
    await streams.sendLine('/shutdown');
    await new Promise((resolve) => setImmediate(resolve));
    const out1 = streams.readAll();
    expect(out1).toContain('恒杀全家：在飞 run、后台 Job、子进程树全收场'); // 宿主注入单源确认语在场
    await streams.sendLine('/shutdown'); // 第二击——走单源编舞
    await expect(done).resolves.toBe('shutdown');
    expect(shutdownCalls).toEqual(['shutdown']); // requestShutdown 触达
    expect(deps.exitCalls.length).toBe(0); // 不再回落 requestExit（编舞自管收口）
  });

  it('/desktop 成功接管：交出方先行（retryDesktop 在飞期间零 data 监听）+ 静默退位——无「桌面已接管」污染文案（遗漏大扫 20260903 conc D1-1/desktop D4-1 修死）', async () => {
    const streams = makeStreams();
    const listenersInFlight: number[] = []; // retryDesktop 在飞期采样
    const deps = makeDeps(streams, {
      retryDesktop: async () => {
        // 序执法采样：桌面引擎起屏**之前**行读面必须已交出（修前 close 后置在
        // finally——停流 + TTY raw 复原砸在已起屏引擎的输入面上，桌面 100%
        // 失聪死锁）
        listenersInFlight.push(streams.input.listenerCount('data'));
        return { ok: true };
      },
    });
    const done = runKernelShell(deps);
    await streams.sendLine('/desktop');
    await expect(done).resolves.toBe('desktop-takeover');
    const out = streams.readAll();
    expect(out).toContain('重试桌面起屏');
    // 静默退位：引擎此时已占 alt-screen，交接成功文案写在备屏首帧之后即视觉
    // 污染且差分永不修复——桌面首帧即回执，shell 一字不写
    expect(out).not.toContain('桌面已接管');
    expect(listenersInFlight).toEqual([0]); // 修前无任何交出（监听 ≥1——红）
    expect(deps.exitCalls.length).toBe(0); // 接管不是退出
  });

  it('/desktop 失败继续 REPL：转述拒因 + 继续计数提示（熔断路径的对话面）', async () => {
    const streams = makeStreams();
    const deps = makeDeps(streams); // 缺省 retryDesktop 恒败
    const done = runKernelShell(deps);
    await streams.sendLine('/desktop');
    await streams.sendLine('/exit');
    await expect(done).resolves.toBe('exit');
    const out = streams.readAll();
    expect(out).toContain('桌面起屏失败（继续计数）：渲染栈崩坏');
    expect(deps.desktopRetries.length).toBe(1);
  });

  it('Ctrl+D（EOF）视同 /exit：结算挂起的 question', async () => {
    const streams = makeStreams();
    const deps = makeDeps(streams);
    const done = runKernelShell(deps);
    streams.input.write('\x04'); // EOF（PassThrough 上 close 流转）
    streams.input.end();
    await expect(done).resolves.toBe('exit');
    expect(deps.exitCalls.length).toBe(1);
  });
});

/* ---------------- 宿主退出信号 ---------------- */

describe('kernel-shell：宿主退出信号（front.quit 聚合腿）', () => {
  it('应用视图内宿主退出：关行读器结束 REPL——requestExit 恰一次', async () => {
    const streams = makeStreams();
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let releaseQuit!: () => void;
    const quitGate = new Promise<void>((resolve) => {
      releaseQuit = resolve;
    });
    const deps = makeDeps(streams, {
      // startApp 挂起至测试放行（模拟用户在应用视图内按 Ctrl+D 触发宿主退出）
      startApp: async () => {
        await startGate;
        return { ok: true };
      },
      hostQuit: quitGate,
    });
    const done = runKernelShell(deps);
    await streams.sendLine('/start chat');
    await new Promise((resolve) => setImmediate(resolve));
    releaseQuit(); // 宿主退出信号先到（应用视图仍在飞）
    await new Promise((resolve) => setImmediate(resolve));
    releaseStart(); // 随后应用视图结算
    await expect(done).resolves.toBe('exit');
    expect(deps.exitCalls.length).toBe(1);
  });

  it('REPL 空闲态宿主退出：同样收口（防行读悬死进程）', async () => {
    const streams = makeStreams();
    const quitGate = Promise.resolve(); // 已结算的退出信号
    const deps = makeDeps(streams, { hostQuit: quitGate });
    const done = runKernelShell(deps);
    await expect(done).resolves.toBe('exit');
    expect(deps.exitCalls.length).toBe(1);
  });
});

/* ---------------- 零仓依赖（结构性前提执法） ---------------- */

describe('kernel-shell：零仓依赖静态声明', () => {
  it('源文件不 import 本仓任何模块（兜底面不依赖被兜底的东西）', () => {
    const source = readFileSync(new URL('./kernel-shell.ts', import.meta.url), 'utf8');
    // 相对导入（../ 或 ./）与根模块别名都不许出现——只准 node: 内建
    const imports = source.match(/^import[\s\S]*?from\s+'[^']+';/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0); // readline/stream 两件在册
    for (const stmt of imports) {
      const spec = stmt.match(/from\s+'([^']+)'/)![1]!;
      expect(spec.startsWith('node:')).toBe(true);
    }
    expect(source).not.toMatch(/from\s+'\.\.?\//); // 无相对路径仓内导入
  });

  it('desktop-boot 熔断件是唯一例外族？——否：kernel-shell 连熔断件都不 import（判据在宿主）', () => {
    // 宿主（desktop-main）组合熔断判据与内核 shell——shell 自身零依赖；此断言
    // 防未来把 isBootBreakerTripped 之类拉进本文件（拉进来 = 兜底面连坐 boot 件）
    const source = readFileSync(new URL('./kernel-shell.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('desktop-boot');
    expect(source).not.toContain('desktop-shell');
    expect(source).not.toContain('../desktop/');
  });
});
