/**
 * L5 app — CLI 入口（技术栈篇 §5：极简三命令，手写 argv——第九批拍板 #15
 * 不引 commander；解析本体见 parseArgs，本文件含帮助文案与入口分派）。
 *
 *   berry                  无参 = TUI 进入对话（默认命令，产品主入口）
 *   berry run "<message>"  单次执行：一轮对话 → stdout 输出结果
 *   berry run --tick <名>  tick 到点编排（OS 调度器唤起形态——读行→due→
 *                          闸→抢占→跑→归属回写；tick-main 主流程）
 *   berry dump-config      打印实际生效组合树（诊断面）
 *   旗标：--version / --help / --debug（日志提级）/ --read-only（run 限定只读档）
 *         / --sandbox-host（run 限定宿主沙箱 wrapper——e1，技术栈篇 §5）
 *         / --port <n>（Web 通道开面——TUI 与 run 收，契约篇 §6.8）
 *
 * 命令面即产品契约（输出保持稳定）；三命令分别接 tui-main / run-main /
 * dump-config 的真实主流程。顶层异常统一 stderr 一行 + 退出码 1。
 */
import { VERSION } from './version.js';
import { tuiMain } from './tui-main.js';
import { runOnceMain } from './run-main.js';
import { tickMain } from './tick-main.js';
import { dumpConfigMain } from './dump-config.js';
import { relaunchUnderHostSandbox } from './host-sandbox.js';

/** 帮助文案（命令面 = 产品契约，输出保持稳定） */
const HELP = `Berry ${VERSION} — 应用式智能体运行时

用法：
  berry                  进入 TUI 对话（默认命令）
  berry run "<message>"  单次执行：一轮对话 → stdout
  berry run --tick <名>  tick 到点编排（OS 调度唤起：读任务行→due 判定→闸→跑）
  berry dump-config      打印实际生效的组合树

旗标：
  --version    输出版本号
  --help       本帮助
  --debug      进程日志提级到 debug
  --read-only  run 子命令限定：只读档单发（sandboxMode read-only——tick 任务面复用同入口）
  --background run 子命令限定：llm/usage 记账入后台道（tick 唤起入口声明——canAfford 读的账）
  --tick <名>  run 子命令限定：到点编排形态（prompt 取自任务行；与位置参数互斥）
  --app <id>   run 子命令限定：以应用身份单发（会话域/装配默认位/审批预设随清单
               生效；与 --tick 互斥——tick 是任务行身份，应用身份另属清单）
  --port <n>   Web 通道开面（契约篇 §6.8）：监听 127.0.0.1:<n>（1-65535 整数）；
               TUI 与 run 收，dump-config/tick 不收。等价 overlay 给 webui 行开
               enabled+port，只作用 boot 树（/reload 重读盘）
  --no-apps 安全模式：boot 组合树空装（默认层与 overlay 全跳过，只保 Ring 1 硬装配行
               ——坏应用锁死启动的自救位；/reload 读盘不受旗标影响，修好 overlay 即恢复全树）
  --sandbox-host run 子命令限定：宿主进程套 OS 沙箱 wrapper（macOS seatbelt / Linux bwrap）
               ——检出后 CLI 重 exec 自身，本进程连同全部应用跑在沙箱内。
               可写面 = 档位根 ∪ 数据目录（~/.berry：库与凭证必须可写）。
               诚实边界：①策略并集粒度——数据目录内部互害关不住；②非网络沙箱
               ——出网默认放行（LLM API 刚需）；③seatbelt profile 非稳定公开接口，
               随 macOS 漂移；④Windows 无后端——fail-closed 拒跑（退出码 1）`;

/** 解析结果：首个非旗标参数为子命令，其余顺次为参数 */
interface ParsedArgs {
  command: string;
  args: string[];
  debug: boolean;
  /** run 子命令只读档（tick 子进程复用同入口——技术栈篇 §5） */
  readOnly: boolean;
  /** run 子命令后台记账道（tick 子进程复用同入口——席 13 第二刀 blocker 修） */
  background: boolean;
  /** run 子命令到点编排形态（取值旗标——值为任务名；undefined = 普通单发） */
  tick: string | undefined;
  /** run 子命令应用身份（第三纵切，取值旗标——值为应用 id；undefined = 对话应用域） */
  app: string | undefined;
  /** Web 通道端口（契约篇 §6.8 刀一，取值旗标——值为端口串，入口层转数执法）；TUI/run 收，dump-config 不收 */
  port: string | undefined;
  /** 安全模式（--no-apps，技术栈篇 §5）：boot 组合树空装只保 Ring 1 硬装配行 */
  noApps: boolean;
  /** e1 宿主沙箱包裹（--sandbox-host，技术栈篇 §5 第二十八批题 3A）：run 限定，wrapper 重 exec */
  sandboxHost: boolean;
}

/**
 * 手写 argv 解析（不引 commander——第九批拍板 #15）。
 * `--tick` / `--app` 是取值旗标：吃掉紧随其后的一个参数作值（与位置参数的
 * 互斥在 run case 执法——解析层只负责取值）。
 */
function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let debug = false;
  let readOnly = false;
  let background = false;
  let noApps = false;
  let tick: string | undefined;
  let app: string | undefined;
  let port: string | undefined;
  let sandboxHost = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--debug') {
      debug = true;
      if (!process.env['APP_LOG_LEVEL']) process.env['APP_LOG_LEVEL'] = 'debug';
    } else if (arg === '--read-only') {
      // 只读档对 run 语义化；TUI 入口收到时无害忽略（TUI 档位另有 /sandbox 命令面）
      readOnly = true;
    } else if (arg === '--background') {
      // 后台记账道对 run 语义化（tick 唤起入口声明）；TUI 入口收到时无害忽略
      background = true;
    } else if (arg === '--tick') {
      // 取值旗标：下一参数即任务名；缺席为用法错（空串占位让 run case 执法）
      tick = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--app') {
      // 取值旗标同款：下一参数即应用 id；缺席为用法错（空串占位让 run case 执法）
      app = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--port') {
      // Web 通道端口（取值旗标同款）：值为端口串，TUI/run 入口层转数执法
      //（1-65535 整数——非数/越界 = 用法错）；dump-config/tick 不透传
      port = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--no-apps') {
      // 安全模式对 TUI/run/dump-config 语义化（boot 形态面）；tick 唤起不透传
      //（自动化入口无「救援」语义——安全模式救的是交互面，tick 子进程恒全树）
      noApps = true;
    } else if (arg === '--sandbox-host') {
      // e1 宿主沙箱（技术栈篇 §5 第二十八批题 3A）：只对 run 语义化——wrapper
      // 重 exec 在 run case 执法；TUI/dump-config 收到时无害忽略（同 --read-only 律）
      sandboxHost = true;
    } else {
      positional.push(arg);
    }
  }
  const [command = '', ...rest] = positional;
  return { command, args: rest, debug, readOnly, background, tick, app, port, noApps, sandboxHost };
}

/**
 * `--port` 值转数（Web 通道刀一，契约篇 §6.8）：1-65535 整数合法，其余
 * 返回 undefined 由入口层写用法错——与 --app「解析层只取值、执法在入口」同律
 */
function parsePortValue(value: string): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

/** 入口分派：同步签名 + 顶层兜底（异步主流程的异常在此收口为退出码 1） */
function main(argv: string[]): number {
  const { command, args, readOnly, background, tick, app, port, noApps, sandboxHost } = parseArgs(argv);

  const run = async (): Promise<number> => {
    switch (command) {
      case '': {
        // 安全模式主场景就是 TUI：坏应用锁死启动时起最小内核壳（无驱动形态
        // 壳照启可退）——命令面/应用管理完好，修 overlay 后 /reload 恢复全树；
        // --app 对 TUI 不透传（TUI 的应用面是 /app <id> 命令——交互进入非进程身份）
        const webuiPort = port === undefined ? undefined : parsePortValue(port);
        if (port !== undefined && webuiPort === undefined) {
          process.stderr.write('用法：berry --port <1-65535>（端口须为整数）\n');
          return 2;
        }
        return tuiMain({ ...(noApps ? { noApps: true } : {}), ...(webuiPort !== undefined ? { webuiPort } : {}) });
      }
      case '--help':
      case '-h':
        process.stdout.write(HELP + '\n');
        return 0;
      case '--version':
      case '-v':
        process.stdout.write(VERSION + '\n');
        return 0;
      case 'run': {
        // --tick 到点编排形态：prompt 取自任务行，位置参数不得混入（混入即
        // 用法错——静默忽略哪个都会失真）
        if (tick !== undefined) {
          if (!tick || args.length > 0 || app !== undefined) {
            process.stderr.write('用法：berry run --tick <任务名> [--read-only] [--background]\n');
            return 2;
          }
          // e1 宿主沙箱包裹：用法校验先行（快失败不浪费 wrapper spawn），剥旗标
          // 重 exec 后内层 argv 再入此分支照常走 tick 形态（旗标已剥不递归）
          if (sandboxHost) {
            return relaunchUnderHostSandbox(
              process.argv,
              process.cwd(),
              readOnly ? ('read-only' as const) : 'workspace-write',
            );
          }
          // 旗标显式值优先；tick-main 兜底缺省（read-only + background——
          // 与 /tick run spawn 公式同款任务面档）
          return tickMain(tick, {
            ...(readOnly ? { sandboxMode: 'read-only' as const } : {}),
            ...(background ? { usagePriority: 'background' as const } : {}),
          });
        }
        // --app 与 --tick 互斥：tick 是任务行身份（prompt 归属任务面），应用身份
        // 另属清单——两者并给时静默择一会失真，用法错明示
        if (app !== undefined) {
          if (!app) {
            process.stderr.write('用法：berry run --app <应用id> "<message>" [--read-only] [--background]\n');
            return 2;
          }
        }
        const message = args.join(' ');
        if (!message) {
          process.stderr.write('用法：berry run "<message>" [--read-only] [--background] [--app <id>]\n');
          return 2;
        }
        // --port 值执法（Web 通道刀一）：与 TUI 入口同律——非整数/越界 = 用法错 2
        const webuiPort = port === undefined ? undefined : parsePortValue(port);
        if (port !== undefined && webuiPort === undefined) {
          process.stderr.write('用法：berry run --port <1-65535>（端口须为整数）\n');
          return 2;
        }
        // e1 宿主沙箱包裹（同 tick 分支）：用法校验后、装配前重 exec——内层进程
        // 于 wrapper 下走完装配与单发，退出码透传
        if (sandboxHost) {
          return relaunchUnderHostSandbox(
            process.argv,
            process.cwd(),
            readOnly ? ('read-only' as const) : 'workspace-write',
          );
        }
        // --read-only → sandboxMode read-only（tick 任务面同入口——技术栈篇 §5；
        // headless 无应答者，审批天然 fail-closed，无需另设审批旗标）
        // --background → llm/usage 记账入 background 道（tick 唤起入口声明——
        // 席 13 第二刀：否则 tick 花 foreground 道、闸读 background 道，空转）
        // --no-apps → 无驱动一等态：run 无对话循环可执行，语义性失败退出码 1
        // --app → 以应用身份单发（第三纵切：assembly 组合根 resolveApp 解析清单
        //——查无 = APP_NOT_FOUND，message 披露在册可用清单）
        // --port → Web 通道开面（组合树 webui 行注入 enabled+port——与 overlay
        // 开面等价，只作用 boot 树；run 单发形态下通道随进程关停）
        return runOnceMain(message, {
          ...(readOnly ? { sandboxMode: 'read-only' as const } : {}),
          ...(background ? { usagePriority: 'background' as const } : {}),
          ...(app !== undefined ? { app } : {}),
          ...(noApps ? { noApps: true } : {}),
          ...(webuiPort !== undefined ? { webuiPort } : {}),
        });
      }
      case 'dump-config':
        // 安全模式同径可见：诊断面打印的就是实际生效装配（Ring 1 行 + 标记行）
        return dumpConfigMain({ ...(noApps ? { noApps: true } : {}) });
      default:
        process.stderr.write(`未知命令：${command}\n\n${HELP}\n`);
        return 2;
    }
  };

  run().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // 顶层兜底：AppError 携码、其余取 message（一行 stderr——细节在 debug 日志）
      process.stderr.write(`✖ ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
