/**
 * L5 app — CLI 入口（技术栈篇 §5：极简三命令，手写 argv——第九批拍板 #15
 * 不引 commander；解析本体见 parseArgs，本文件含帮助文案与入口分派）。
 *
 *   berry                  无参 = TUI 进入对话（默认命令，产品主入口）
 *   berry run "<message>"  单次执行：一轮对话 → stdout 输出结果
 *   berry dump-config      打印实际生效组合树（诊断面）
 *   旗标：--version / --help / --debug（日志提级）/ --read-only（run 限定只读档）
 *
 * 命令面即产品契约（输出保持稳定）；三命令分别接 tui-main / run-main /
 * dump-config 的真实主流程。顶层异常统一 stderr 一行 + 退出码 1。
 */
import { VERSION } from './version.js';
import { tuiMain } from './tui-main.js';
import { runOnceMain } from './run-main.js';
import { dumpConfigMain } from './dump-config.js';

/** 帮助文案（命令面 = 产品契约，输出保持稳定） */
const HELP = `Berry ${VERSION} — 插件式智能体运行时

用法：
  berry                  进入 TUI 对话（默认命令）
  berry run "<message>"  单次执行：一轮对话 → stdout
  berry dump-config      打印实际生效的组合树

旗标：
  --version    输出版本号
  --help       本帮助
  --debug      进程日志提级到 debug
  --read-only  run 子命令限定：只读档单发（sandboxMode read-only——tick 任务面复用同入口）`;

/** 解析结果：首个非旗标参数为子命令，其余顺次为参数 */
interface ParsedArgs {
  command: string;
  args: string[];
  debug: boolean;
  /** run 子命令只读档（tick 子进程复用同入口——技术栈篇 §5） */
  readOnly: boolean;
}

/** 手写 argv 解析（不引 commander——第九批拍板 #15；旗标 --debug/--read-only 两个） */
function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let debug = false;
  let readOnly = false;
  for (const arg of argv) {
    if (arg === '--debug') {
      debug = true;
      if (!process.env['APP_LOG_LEVEL']) process.env['APP_LOG_LEVEL'] = 'debug';
    } else if (arg === '--read-only') {
      // 只读档对 run 语义化；TUI 入口收到时无害忽略（TUI 档位另有 /sandbox 命令面）
      readOnly = true;
    } else {
      positional.push(arg);
    }
  }
  const [command = '', ...rest] = positional;
  return { command, args: rest, debug, readOnly };
}

/** 入口分派：同步签名 + 顶层兜底（异步主流程的异常在此收口为退出码 1） */
function main(argv: string[]): number {
  const { command, args, readOnly } = parseArgs(argv);

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
        const message = args.join(' ');
        if (!message) {
          process.stderr.write('用法：berry run "<message>" [--read-only]\n');
          return 2;
        }
        // --read-only → sandboxMode read-only（tick 任务面同入口——技术栈篇 §5；
        // headless 无应答者，审批天然 fail-closed，无需另设审批旗标）
        return runOnceMain(message, readOnly ? { sandboxMode: 'read-only' } : {});
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
