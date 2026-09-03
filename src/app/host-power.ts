/**
 * L5 app — 关停/重启编舞单源（第八十五批批 D，骨架篇 §1.3）。
 *
 * **恒杀全家**（形态不分叉的统一语义）：真关机——在飞 run、后台 Job、子进程
 * 树全收场非挂起，无温柔档。确认语单源（POWER_KILL_FAMILY_TEXT）供两入口
 * 共用：桌面 UI confirm 原语（desktop-shell）与内核 shell 双输确认
 * （kernel-shell）同文——禁抄文案造第二份。
 *
 * **一实现两入口**：本模块 runPowerAction 是唯一编舞实现——
 * - 入口一（桌面动词）：desktop-shell /shutdown /reboot → 宿主 requestPower
 *   → runPowerAction(form: 'in-process')——UI 确认在前，confirmed 恒 true；
 * - 入口二（CLI 动词）：berry shutdown / berry reboot → powerCliMain →
 *   runPowerAction(form: 'client')——--yes 过确认门，缺 --yes 拒退 2（fail-loud）。
 *
 * 两形态语义：
 * - **client 形态**（CLI）：daemon 侧动作——shutdown 直走 daemonCommandMain
 *   ('stop') 既有信号序（SIGTERM→轮询→SIGKILL→清 daemon.json，幂等含
 *   无 daemon.json/判死残留两早退）；reboot = 先 stop 再 start（无 daemon
 *   = 无可重启对象，诚实退 0）。
 * - **in-process 形态**（桌面）：本进程收口自退——shutdown 经 selfExit
 *   （宿主接 front.requestQuit——复用 desktop-main 既有优雅退出序列全序，
 *   零新编舞）；reboot 先 spawn detached 新实例接力（daemon start 的 spawn
 *   形态同款：node + execArgv 随行 + 自身入口脚本），spawn 失败不退（诚实
 *   回执 spawn-failed，进程照旧活着可重试）。
 *
 * 依赖全注入（探针/信号序/spawn/自退——测试假面；缺省真实现零参接线）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { daemonCommandMain, detectDaemonHandshake } from './daemon.js';
import { DEFAULT_WEBUI_PORT } from '../webui/index.js';

/** 关停/重启动作（/exit 是第三动词——退 UI 回 shell，不属本编舞） */
export type PowerAction = 'shutdown' | 'reboot';

/**
 * 恒杀全家确认语（单源——桌面 confirm 视图 / 内核 shell 双输确认 / CLI 拒因
 * 三消费面同文；骨架篇 §1.3 原文语义）。
 */
export const POWER_KILL_FAMILY_TEXT = '恒杀全家：在飞 run、后台 Job、子进程树全收场（非挂起——真关机，无温柔版）';

/** 编舞依赖注入面（缺省真实现——测试假面缝合计） */
export interface PowerDeps {
  /** daemon 真握手探针（缺省 detectDaemonHandshake——reboot client 形态判定有无 daemon） */
  readonly detectDaemon?: () => Promise<{ port: number } | undefined>;
  /** 停机信号序（缺省 daemonCommandMain('stop')——SIGTERM→轮询→SIGKILL 单源） */
  readonly stopDaemon?: () => Promise<number>;
  /** 起机（缺省 daemonCommandMain('start')——reboot client 形态接力用） */
  readonly startDaemon?: () => Promise<number>;
  /** 重启接力 spawn（缺省 detached 新实例——in-process reboot 用） */
  readonly spawnRelaunch?: () => ChildProcess | undefined;
  /** 本进程自退（缺省空实现——宿主注 front.requestQuit；不在此直调 process.exit：
   * 优雅退出序列全序在 desktop-main 的 finally 里，直接 exit 会跳过归档） */
  readonly selfExit?: () => void;
}

/** 编舞结果（两入口共用消费面——CLI 落退出码/文案，桌面看 outcome 分流回执） */
export interface PowerResult {
  readonly action: PowerAction;
  /** 收场面：refused 未过确认门 / daemon-signalled 信号序已发 / no-daemon 无 daemon（幂等成）/ relaunching 接力已 spawn + 本进程将退 / self-exiting 本进程收口自退中 / spawn-failed 接力 spawn 失败（进程未退） */
  readonly outcome: 'refused' | 'daemon-signalled' | 'no-daemon' | 'relaunching' | 'self-exiting' | 'spawn-failed';
  /** 进程退出码（CLI 面） */
  readonly exitCode: number;
  /** 人读消息（CLI stdout/桌面回执共用单源） */
  readonly message: string;
}

/**
 * 关停/重启编舞唯一实现（一实现两入口的「实现」）。
 *
 * @param action 动作
 * @param opts confirmed = 确认门已过（桌面 UI 确认在前恒 true；CLI --yes）；
 * form = 'client'（CLI 对 daemon）| 'in-process'（桌面对本进程）；deps 注入面
 */
export async function runPowerAction(
  action: PowerAction,
  opts: { confirmed: boolean; form: 'client' | 'in-process'; deps?: PowerDeps },
): Promise<PowerResult> {
  // 确认门：未过即拒（exit 2 = CLI 惯例「用法/前置不满足」；桌面腿不达此——UI 确认在前）
  if (!opts.confirmed) {
    return {
      action,
      outcome: 'refused',
      exitCode: 2,
      message: `未确认——恒杀全家动作须显式确认（CLI 加 --yes）。${POWER_KILL_FAMILY_TEXT}`,
    };
  }
  const deps = opts.deps ?? {};
  const stopDaemon = deps.stopDaemon ?? (() => daemonCommandMain('stop', DEFAULT_WEBUI_PORT));
  const startDaemon = deps.startDaemon ?? (() => daemonCommandMain('start', DEFAULT_WEBUI_PORT));
  const detectDaemon = deps.detectDaemon ?? detectDaemonHandshake;

  if (opts.form === 'client') {
    // CLI 形态：对象是本机 daemon（无 daemon 幂等成——脚本面重复停不是错误）
    if (action === 'shutdown') {
      const code = await stopDaemon();
      return {
        action,
        outcome: 'daemon-signalled',
        exitCode: code,
        message: 'daemon 停机信号序已执行（SIGTERM→轮询→SIGKILL→清 daemon.json）',
      };
    }
    // reboot：先判有无活 daemon——无可重启对象时诚实退 0（不凭空 start 一个）
    const alive = await detectDaemon();
    if (alive === undefined) {
      return {
        action,
        outcome: 'no-daemon',
        exitCode: 0,
        message: 'daemon 未运行——无可重启对象（进程内形态用桌面 /reboot 接力）',
      };
    }
    const stopCode = await stopDaemon();
    const startCode = await startDaemon();
    return {
      action,
      outcome: 'daemon-signalled',
      exitCode: startCode !== 0 ? startCode : stopCode !== 0 ? stopCode : 0,
      message: 'daemon 已停并重启接力（stop 信号序 + start 起机序）',
    };
  }

  // in-process 形态：本进程收口自退（selfExit 走宿主优雅退出序列全序——零新编舞）
  const selfExit = deps.selfExit ?? (() => undefined);
  if (action === 'shutdown') {
    selfExit();
    return {
      action,
      outcome: 'self-exiting',
      exitCode: 0,
      message: '关停已确认——收口自退中（会话归档走既有优雅退出序列）',
    };
  }
  // reboot：先 spawn 接力（失败不退——进程照旧活着可重试），后自退
  const spawnRelaunch = deps.spawnRelaunch ?? defaultSpawnRelaunch;
  let child: ChildProcess | undefined;
  try {
    child = spawnRelaunch();
  } catch {
    child = undefined;
  }
  if (child === undefined) {
    return {
      action,
      outcome: 'spawn-failed',
      exitCode: 1,
      message: '重启接力 spawn 失败——本进程未退出，可重试 /reboot',
    };
  }
  selfExit();
  return {
    action,
    outcome: 'relaunching',
    exitCode: 0,
    message: '重启已确认——新实例已接力 spawn，本进程收口自退中',
  };
}

/**
 * 重启接力缺省 spawn（daemon start 的 spawn 形态同款）：node 解释器 +
 * execArgv 随行（tsx dev 形态 loader 不丢）+ 自身入口脚本 + 原样参数；
 * detached + unref（父退子活——接力语义）；spawn 同步异常上抛由调用方兜。
 */
function defaultSpawnRelaunch(): ChildProcess | undefined {
  const selfScript = process.argv[1];
  if (selfScript === undefined) return undefined; // 入口脚本缺席（理论不可达）——诚实失败
  const child = spawn(process.execPath, [...process.execArgv, selfScript, ...process.argv.slice(2)], {
    detached: true,
    stdio: 'inherit',
  });
  child.unref(); // 父进程不等子——接力即脱钩
  // 子进程 spawn 期错误（如解释器不在）吸收到 error 事件——已 unref 不影响父退
  child.on('error', () => undefined);
  return child;
}

/**
 * CLI 动词主流程（`berry shutdown` / `berry reboot`——入口二）。
 *
 * --yes = 确认门钥匙（等价桌面 UI 二次确认）；缺 --yes 时 stderr 拒因 +
 * 指路 --yes + 退 2（fail-loud——恒杀全家不默认执行）。结果文案落 stdout。
 * @returns 进程退出码
 */
export async function powerCliMain(
  action: PowerAction,
  opts: { yes: boolean; write?: (text: string) => void; deps?: PowerDeps },
): Promise<number> {
  const write =
    opts.write ??
    ((text: string) => {
      process.stdout.write(text);
    });
  if (!opts.yes) {
    process.stderr.write(
      `拒绝执行 ${action}：${POWER_KILL_FAMILY_TEXT}\n` + `确认请加 --yes（berry ${action} --yes）。\n`,
    );
    return 2;
  }
  const result = await runPowerAction(action, { confirmed: true, form: 'client', deps: opts.deps });
  write(`${result.message}\n`);
  return result.exitCode;
}
