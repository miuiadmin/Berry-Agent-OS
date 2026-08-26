/**
 * L5 app — 信号与致命异常编舞（骨架篇 §1.3 钉死序列的进程面装配）。
 *
 * 表（规范原文）：
 * - SIGINT 首次 → 优雅退出（入口转 onGracefulQuit = requestQuit；退出码 0）；
 * - SIGINT 二次 → 立即 exit(130)——不等优雅序列，撕裂尾由下次启动恢复协议截断；
 * - SIGTERM / SIGHUP → 视同 SIGINT 首次；正常路径完成退出码 143 / 129；
 * - uncaughtException / unhandledRejection → 不吞：记日志 + 尽力 flush + exit(1)。
 *
 * 优雅序列的本体（abort → closer → flush → session_shutdown → ctx 回卷）在
 * 组合根 shutdown()；本模块只负责「信号 → 退出请求」的转译与退出码记账，
 * 两个命令入口（tui-main / run-main）共用。
 */

/** 信号面抽象（缺省 process——测试注入假面收账，不真退进程） */
export interface SignalSurface {
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  exit(code: number): never;
}

/** 致命异常种类（Node 两个全局钩子的名字——记日志用） */
export type FatalKind = 'uncaughtException' | 'unhandledRejection';

/** 优雅退出请求种类（S6 形态④信号分种类）：SIGINT 可分档（多驱动 interrupt）；
 * SIGTERM/SIGHUP 是进程管理器要求退出——恒全序列 requestQuit，不可「不退 OS」 */
export type GracefulQuitKind = 'interrupt' | 'terminate';

/** 安装参数（全部可注入——两个入口仅 onGracefulQuit/onFatal 不同） */
export interface ExitSignalsOptions {
  /**
   * 优雅退出请求（首次 SIGINT/SIGTERM/SIGHUP——接会话驱动 requestQuit）。
   * kind：'interrupt' = SIGINT（入口可分档投 front.interrupt）；'terminate' =
   * SIGTERM/SIGHUP（恒 requestQuit 全序列，退出码 143/129 记账不变）
   */
  readonly onGracefulQuit: (kind: GracefulQuitKind) => void;
  /** 致命异常处理（记日志 + 尽力 flush；本模块限时等待后必 exit(1)） */
  readonly onFatal: (error: unknown, kind: FatalKind) => void | Promise<void>;
  /** 信号面（缺省 process） */
  readonly surface?: SignalSurface;
  /** 致命路径等待 onFatal 落盘的上限（毫秒，缺省 1000——best-effort 不是无限等） */
  readonly fatalTimeoutMs?: number;
}

/** 安装产物（入口持有：退出码记账 + 急停旗标了结口 + 卸载） */
export interface ExitSignalsHandle {
  /**
   * 优雅路退出码（0 / SIGTERM 143 / SIGHUP 129）——入口在自身正常退出码为 0 时
   * 采用它（SIGINT 首次 = 0：用户中断不是错误，规范钉死）
   */
  readonly exitCode: number;
  /**
   * 急停旗标了结口（S6 形态⑥）：旗标语义 = 「在身的未了结退出请求」——interrupt
   * 路的请求随被打断 run 结算而了结（入口在 front.interrupt() 返回的 settle
   * promise 了结时调本口复位旗标）；了结后下次 SIGINT 又是首次语义，run 未结算
   * 窗口内二次 SIGINT 才 130 硬退（「连续两次」的真语义）。terminate 路进程本就
   * 走退出序列，复位无意义不涉及。
   */
  acknowledgeQuitRequest(): void;
  /** 卸载全部监听（入口 finally 里调——正常收尾后不再响应信号编舞） */
  dispose(): void;
}

/** 全局 process 的信号面（缺省值；显式委托收窄类型——process.on 的宽签名不直接适配） */
const PROCESS_SURFACE: SignalSurface = {
  on: (event, listener) => process.on(event, listener as (...args: unknown[]) => void),
  removeListener: (event, listener) => process.removeListener(event, listener as (...args: unknown[]) => void),
  exit: (code) => process.exit(code),
};

/**
 * 安装信号编舞。返回带 exitCode 记账的句柄——致命/二次中断路径直接经
 * surface.exit 离场（永不返回）；优雅路径由入口自然走完 shutdown 后采纳 exitCode。
 */
export function installExitSignals(opts: ExitSignalsOptions): ExitSignalsHandle {
  const surface = opts.surface ?? PROCESS_SURFACE;
  const fatalTimeoutMs = opts.fatalTimeoutMs ?? 1000;
  /** 优雅退出是否已请求（二次 SIGINT 的判据） */
  let quitRequested = false;
  /** 优雅路退出码（默认 0；SIGTERM/SIGHUP 记 143/129） */
  let recordedExitCode = 0;

  /**
   * 首次信号：转优雅退出请求并记账退出码。
   * @param gracefulExit 优雅路完成的退出码（SIGINT 0 / SIGTERM 143 / SIGHUP 129）
   * @param kind 请求种类（S6 形态④：SIGINT=interrupt 可分档、SIGTERM/SIGHUP=terminate 恒全序列）
   * @param immediateExit 二次按下的立即退出码（仅 SIGINT=130——用户坚持现在走）
   */
  const onSignal = (gracefulExit: number, kind: GracefulQuitKind, immediateExit?: number): void => {
    // SIGINT 二次 = 不等优雅序列；SIGTERM/SIGHUP 重复到达保持幂等
    // （requestQuit 可重入）——规范未钉的部分取保守侧。旗标 = 在身的未了结
    // 退出请求（S6 形态⑥：interrupt 路随 run 结算了结复位——见 acknowledgeQuitRequest）
    if (immediateExit !== undefined && quitRequested) surface.exit(immediateExit);
    quitRequested = true;
    recordedExitCode = gracefulExit;
    opts.onGracefulQuit(kind);
  };

  /** 致命异常：限时等 onFatal（日志 + 尽力 flush）后必 exit(1)——不吞 */
  const onFatalExit = (kind: FatalKind): ((error: unknown) => void) => {
    return (error: unknown): void => {
      // 限时赛跑：onFatal 超 1s（缺省）未落盘也离场——正确性兜底是事件日志
      // 恢复协议，不是进程内自救（规范原话）
      void Promise.race([
        Promise.resolve(opts.onFatal(error, kind)),
        new Promise((resolve) => setTimeout(resolve, fatalTimeoutMs)),
      ]).finally(() => surface.exit(1));
    };
  };

  // SIGINT 首次优雅完成 = 0（用户中断不是错误，规范钉死）；二次 130 立即
  const onInterrupt = () => onSignal(0, 'interrupt', 130);
  const onTerminate = () => onSignal(143, 'terminate');
  const onHangup = () => onSignal(129, 'terminate');
  const onUncaught = onFatalExit('uncaughtException');
  const onUnhandled = onFatalExit('unhandledRejection');

  surface.on('SIGINT', onInterrupt);
  surface.on('SIGTERM', onTerminate);
  surface.on('SIGHUP', onHangup);
  surface.on('uncaughtException', onUncaught);
  surface.on('unhandledRejection', onUnhandled);

  return {
    get exitCode(): number {
      return recordedExitCode;
    },
    // 急停旗标了结（S6 形态⑥：interrupt 路随被打断 run 结算调用——复位后下次
    // SIGINT 又是首次语义；幂等安全，无在身请求时 no-op）
    acknowledgeQuitRequest(): void {
      quitRequested = false;
    },
    dispose(): void {
      surface.removeListener('SIGINT', onInterrupt);
      surface.removeListener('SIGTERM', onTerminate);
      surface.removeListener('SIGHUP', onHangup);
      surface.removeListener('uncaughtException', onUncaught);
      surface.removeListener('unhandledRejection', onUnhandled);
    },
  };
}
