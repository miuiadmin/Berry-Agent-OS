/**
 * L5 app — CLI 入口（技术栈篇 §5：极简三命令，手写 argv，~50 行纪律）。
 *
 *   berry                  无参 = TUI 进入对话（默认命令，产品主入口）
 *   berry run "<message>"  单次执行：一轮对话 → stdout 输出结果
 *   berry dump-config      打印实际生效组合树（诊断面）
 *   旗标：--version / --help / --debug（日志提级）
 *
 * M1 骨架阶段：命令面先行钉死，三命令均为占位回执——session/agent/channels(TUI)
 * 模块落地后逐命令接真实现，命令集本身不再变。
 */
import { VERSION } from './version.js';

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
  --port <n>   Web 通道端口（M2+）`;

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
    } else if (arg === '--version' || arg === '--help') {
      positional.push(arg);
    } else {
      positional.push(arg);
    }
  }
  const [command = '', ...rest] = positional;
  return { command, args: rest, debug };
}

/** 入口：进程启动即执行；错误统一以非零码退出 + stderr 一行 */
function main(argv: string[]): number {
  const { command, args } = parseArgs(argv);

  switch (command) {
    case '':
    case '--help':
    case '-h':
      // 无参暂以帮助代替 TUI（channels 落地后：无参 = 进 TUI 对话）
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
      // M1 骨架占位：session/agent/llm 落地后接真实单轮执行
      process.stdout.write(
        `[M1 落码进行中] run 收到消息（${message.length} 字符），执行管线随 session/agent 落地接入\n`,
      );
      return 0;
    }
    case 'dump-config':
      // M1 骨架占位：组合树解析（yaml 依赖已就位）落地后打印真实树
      process.stdout.write('[M1 落码进行中] dump-config：组合树解析随 app 组合根落地接入\n');
      return 0;
    default:
      process.stderr.write(`未知命令：${command}\n\n${HELP}\n`);
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
