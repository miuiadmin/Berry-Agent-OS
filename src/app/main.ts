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
 *
 * 命令面即产品契约（输出保持稳定）；三命令分别接 tui-main / run-main /
 * dump-config 的真实主流程。顶层异常统一 stderr 一行 + 退出码 1。
 */
import { VERSION } from './version.js';
import { tuiMain } from './tui-main.js';
import { runOnceMain } from './run-main.js';
import { tickMain } from './tick-main.js';
import { dumpConfigMain } from './dump-config.js';

/** 帮助文案（命令面 = 产品契约，输出保持稳定） */
const HELP = `Berry ${VERSION} — 插件式智能体运行时

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
  --tick <名>  run 子命令限定：到点编排形态（prompt 取自任务行；与位置参数互斥）`;

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
}

/**
 * 手写 argv 解析（不引 commander——第九批拍板 #15）。
 * `--tick` 是取值旗标：吃掉紧随其后的一个参数作任务名（与位置参数互斥在
 * run case 执法——解析层只负责取值）。
 */
function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let debug = false;
  let readOnly = false;
  let background = false;
  let tick: string | undefined;
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
    } else {
      positional.push(arg);
    }
  }
  const [command = '', ...rest] = positional;
  return { command, args: rest, debug, readOnly, background, tick };
}

/** 入口分派：同步签名 + 顶层兜底（异步主流程的异常在此收口为退出码 1） */
function main(argv: string[]): number {
  const { command, args, readOnly, background, tick } = parseArgs(argv);

  const run = async (): Promise<number> => {
    switch (command) {
      case '':
        return tuiMain();
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
          if (!tick || args.length > 0) {
            process.stderr.write('用法：berry run --tick <任务名> [--read-only] [--background]\n');
            return 2;
          }
          // 旗标显式值优先；tick-main 兜底缺省（read-only + background——
          // 与 /tick run spawn 公式同款任务面档）
          return tickMain(tick, {
            ...(readOnly ? { sandboxMode: 'read-only' as const } : {}),
            ...(background ? { usagePriority: 'background' as const } : {}),
          });
        }
        const message = args.join(' ');
        if (!message) {
          process.stderr.write('用法：berry run "<message>" [--read-only] [--background]\n');
          return 2;
        }
        // --read-only → sandboxMode read-only（tick 任务面同入口——技术栈篇 §5；
        // headless 无应答者，审批天然 fail-closed，无需另设审批旗标）
        // --background → llm/usage 记账入 background 道（tick 唤起入口声明——
        // 席 13 第二刀：否则 tick 花 foreground 道、闸读 background 道，空转）
        return runOnceMain(message, {
          ...(readOnly ? { sandboxMode: 'read-only' as const } : {}),
          ...(background ? { usagePriority: 'background' as const } : {}),
        });
      }
      case 'dump-config':
        return dumpConfigMain();
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
