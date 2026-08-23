/**
 * L5 app — CLI 入口（技术栈篇 §5：极简三命令，手写 argv，~50 行纪律）。
 *
 *   berry                  无参 = TUI 进入对话（默认命令，产品主入口）
 *   berry run "<message>"  单次执行：一轮对话 → stdout 输出结果
 *   berry dump-config      打印实际生效组合树（诊断面）
 *   旗标：--version / --help / --debug（日志提级）
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
  --debug      进程日志提级到 debug`;

/** 解析结果：首个非旗标参数为子命令，其余顺次为参数 */
interface ParsedArgs {
  command: string;
  args: string[];
  debug: boolean;
}

/** 手写 argv 解析（~50 行纪律的一部分：不引 commander，第九批拍板 #15） */
function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let debug = false;
  for (const arg of argv) {
    if (arg === '--debug') {
      debug = true;
      if (!process.env['APP_LOG_LEVEL']) process.env['APP_LOG_LEVEL'] = 'debug';
    } else {
      positional.push(arg);
    }
  }
  const [command = '', ...rest] = positional;
  return { command, args: rest, debug };
}

/** 入口分派：同步签名 + 顶层兜底（异步主流程的异常在此收口为退出码 1） */
function main(argv: string[]): number {
  const { command, args } = parseArgs(argv);

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
          process.stderr.write('用法：berry run "<message>"\n');
          return 2;
        }
        return runOnceMain(message);
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
