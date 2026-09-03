/**
 * L5 app — 内核最小 shell（第八十五批批 C，骨架篇 boot 序的兜底交互面）。
 *
 * 桌面不可用形态（`--no-desktop` 显式 / 两连崩熔断回锁）下的行式 REPL：直接
 * stdio 行读（node:readline），**零桌面引擎依赖**（本文件不 import 本仓任何
 * 模块——引擎崩坏场景的结构性前提：兜底面不能依赖被兜底的东西）。
 *
 * 命令面五件：/apps（清单）/start <id>（进应用视图——promise 在应用视图结束
 * 时结算）/shutdown（双确认后经宿主注入的单源编舞恒杀全家收场——批 D 接线）/
 * /exit（退出）/ /desktop（重试桌面起屏——成功清熔断账并交出 REPL）。
 *
 * 依赖全注入（deps）——宿主入口（desktop-main）组合 runtime 动词与换防编舞，
 * 本文件只管行读与对话循环，可独立测试。
 */

import * as readline from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

/** 内核 shell 依赖束（宿主注入——本文件零仓内 import） */
export interface KernelShellDeps {
  /** 输入流（缺省 process.stdin） */
  readonly input?: Readable;
  /** 输出流（缺省 process.stdout） */
  readonly output?: Writable;
  /** 开场横幅（熔断态含原因与 --no-desktop 提示——文案由宿主组合） */
  readonly banner?: string;
  /** /apps 清单投影（id + 人读名） */
  readonly listApps: () => readonly { readonly id: string; readonly label: string }[];
  /**
   * /start：进应用视图。promise 在应用视图结束（Esc 出视图/退出进程）时结算
   * ——REPL 在此期间挂起（rl.pause 防抢 stdin）。ok:false = 进入拒因（壳转述）。
   */
  readonly startApp: (appId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * /desktop：重试桌面起屏（宿主新建壳 start；成功侧效应含清熔断账——在宿主）。
   * ok:false + error = 起屏失败（继续计数，REPL 继续）。
   */
  readonly retryDesktop: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 请求退出（exit/shutdown 两动词共用——宿主接优雅退出序列） */
  readonly requestExit: () => void;
  /**
   * /shutdown 双确认执行钩子（批 D：宿主接 host-power 单源编舞——与桌面
   * /shutdown、CLI berry shutdown 一实现三入口）。缺省不传 = 回落 requestExit
   * （批 C 行为）。确认语由宿主注入（shutdownConfirmText——恒杀全家单源文案）。
   */
  readonly requestShutdown?: () => void;
  /** /shutdown 双确认第一击文案（缺省 = 批 C 旧文；宿主注入恒杀全家单源语） */
  readonly shutdownConfirmText?: string;
  /**
   * 宿主退出信号（宿主 front.quit 聚合 promise）：结算时关行读器结束 REPL
   * （返回 'exit'）——防应用视图内退出（Ctrl+D / 信号）后 REPL 挂起行读悬死进程。
   * 缺省不传 = 无此保护（纯测试形态）。
   */
  readonly hostQuit?: Promise<unknown>;
}

/** REPL 终态（desktop-takeover = 桌面重试成功，宿主转入等桌面退出路） */
export type KernelShellOutcome = 'exit' | 'shutdown' | 'desktop-takeover';

/** 提示符（内核面自明——桌面崩坏时的兜底语境） */
const PROMPT = 'kernel> ';

/**
 * 行式 REPL 主循环（阻塞至 /exit / /shutdown 双确认 / /desktop 成功接管）。
 * Ctrl+D（EOF）= /exit；未知命令给提示不退出；/shutdown 双确认（连打两次，
 * 中途他词解除武装）。
 */
export async function runKernelShell(deps: KernelShellDeps): Promise<KernelShellOutcome> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const write = (line: string): void => {
    output.write(`${line}\n`);
  };
  if (deps.banner !== undefined) write(deps.banner);
  const rl = readline.createInterface({ input, output, prompt: PROMPT });
  // EOF 竞速腿（Ctrl+D = close 事件）：close 时挂起的 question 依 Node 版本可能
  // 悬而不决——显式 close promise 参赛，EOF 确定性视同 /exit
  let closedSignalled = false;
  const closed = new Promise<null>((resolve) => {
    rl.on('close', () => {
      closedSignalled = true;
      resolve(null);
    });
  });
  // 宿主退出信号腿：front.quit 结算时关行读器（close 腿先胜 → quitSignalled 裁决）
  let quitSignalled = false;
  if (deps.hostQuit !== undefined) {
    void deps.hostQuit.then(() => {
      quitSignalled = true;
      rl.close();
    });
  }
  /** /shutdown 武装旗标（双确认第一击置位，他词/空行解除） */
  let shutdownArmed = false;
  try {
    for (;;) {
      // close 已落（如 /start 在飞期间宿主退出信号关行读器）：不再发下一问——
      // 对已关接口 question 会炸 ERR_USE_AFTER_CLOSE，直接走退出裁决
      if (closedSignalled || quitSignalled) {
        deps.requestExit();
        return 'exit';
      }
      // question(PROMPT) 自带提示输出（写入 prompt 后等待一行；close 先胜 = null）
      const line = await Promise.race([rl.question(PROMPT), closed]);
      // close 两因：宿主退出信号（quitSignalled）或 Ctrl+D EOF——都视同 /exit
      if (line === null || quitSignalled) {
        deps.requestExit();
        return 'exit';
      }
      const text = line.trim();
      if (text === '') continue;
      // /shutdown 双确认：第一击武装（确认语 = 宿主注入单源恒杀全家文案），
      // 第二击执行（requestShutdown 单源编舞——缺省回落 requestExit）；其余词解除
      if (text === '/shutdown') {
        if (!shutdownArmed) {
          shutdownArmed = true;
          write(deps.shutdownConfirmText ?? '确认关停？再输一次 /shutdown 执行（其他命令取消）');
          continue;
        }
        if (deps.requestShutdown !== undefined) deps.requestShutdown();
        else deps.requestExit();
        return 'shutdown';
      }
      shutdownArmed = false;
      if (text === '/exit') {
        deps.requestExit();
        return 'exit';
      }
      if (text === '/apps') {
        const apps = deps.listApps();
        if (apps.length === 0) {
          write('无应用（组合树空——/apps 装机面或 --no-apps 安全模式）');
        } else {
          for (const app of apps) write(`  ${app.id} — ${app.label}`);
        }
        continue;
      }
      if (text === '/start' || text.startsWith('/start ')) {
        const appId = text.slice('/start'.length).trim();
        if (appId === '') {
          write('用法：/start <应用id>（清单见 /apps）');
          continue;
        }
        // 挂起行读防抢 stdin（应用视图接管终端）；视图结束后续读
        rl.pause();
        try {
          const result = await deps.startApp(appId);
          if (!result.ok) write(`进入失败：${result.error}`);
        } catch (err) {
          write(`进入异常：${err instanceof Error ? err.message : String(err)}`);
        } finally {
          // 行读器已被关（宿主退出信号在视图在飞期间先到）时不 resume——
          // 已关接口上 resume 会炸 ERR_USE_AFTER_CLOSE，收口交给循环顶裁决
          if (!closedSignalled) rl.resume();
        }
        continue;
      }
      if (text === '/desktop') {
        write('重试桌面起屏…');
        try {
          const result = await deps.retryDesktop();
          if (result.ok) {
            write('桌面已接管——kernel shell 退位。');
            return 'desktop-takeover';
          }
          write(`桌面起屏失败（继续计数）：${'error' in result ? result.error : '未知原因'}`);
        } catch (err) {
          write(`桌面重试异常：${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      write(`未知命令：${text.split(' ')[0]}（认 /apps /start <id> /shutdown /exit /desktop）`);
    }
  } finally {
    rl.close();
  }
}
