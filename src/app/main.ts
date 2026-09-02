#!/usr/bin/env node
/**
 * L5 app — CLI 入口（技术栈篇 §5：极简三命令，手写 argv——第九批拍板 #15
 * 不引 commander；解析本体见 parseArgs，本文件含帮助文案与入口分派）。
 *
 *   berry                  无参 = TUI 进入对话（默认命令，产品主入口；起屏前
 *                          裸检测：daemon 正跑时提示 attach/standalone 退非零）
 *   berry run "<message>"  单次执行：一轮对话 → stdout 输出结果
 *   berry run --tick <名>  tick 到点编排（OS 调度器唤起形态——读行→due→
 *                          闸→抢占→跑→归属回写；tick-main 主流程）
 *   berry daemon start     常驻执行体起跑（ready-gate 真握手才报就绪；客户端
 *                          命令族 start/stop/status/doctor——契约篇 §6.8 刀一/二）
 *   berry attach           接上 daemon 的 TUI 纯客户端（零本地装配——HTTP/SSE；
 *                          契约篇 §6.8 刀二）
 *   berry dump-config      打印实际生效组合树（诊断面）
 *   旗标：--version / --help / --debug（日志提级）/ --read-only（run 限定只读档）
 *         / --sandbox-host（run 限定宿主沙箱 wrapper——e1，技术栈篇 §5）
 *         / --port <n>（Web 通道开面——TUI 与 run 收，契约篇 §6.8；daemon 形态
 *           下 = webui 常开端口，缺省 7860；attach 下 = 覆盖 daemon.json 记录值）
 *         / --foreground（daemon 限定：前台常驻——start spawn 的目标形态）
 *         / --standalone（裸 berry 限定：跳过 daemon 检测显式单开进程内形态）
 *
 * 命令面即产品契约（输出保持稳定）；三命令分别接 tui-main / run-main /
 * dump-config 的真实主流程。顶层异常统一 stderr 一行 + 退出码 1。
 */
import { VERSION_WITH_CODENAME as VERSION } from './version.js';
import { describeError } from '../contracts/errors.js';
import { upgradeMain } from './upgrade.js';
import { tuiMain } from './tui-main.js';
import { runOnceMain } from './run-main.js';
import { tickMain } from './tick-main.js';
import { dumpConfigMain } from './dump-config.js';
import { relaunchUnderHostSandbox } from './host-sandbox.js';
import { daemonCommandMain, daemonDoctorMain, daemonForegroundMain, detectDaemonHandshake } from './daemon.js';
import { attachMain } from './attach-main.js';
import { warnIfStaleDist } from './build-meta.js';
import { DEFAULT_WEBUI_PORT } from '../webui/index.js';

/** 帮助文案（命令面 = 产品契约，输出保持稳定） */
const HELP = `Berry ${VERSION} — 应用式智能体运行时

用法：
  berry                  进入 TUI 对话（默认命令；daemon 正跑时提示改道退非零）
  berry run "<message>"  单次执行：一轮对话 → stdout
  berry run --tick <名>  tick 到点编排（OS 调度唤起：读任务行→due 判定→闸→跑）
  berry daemon <start|stop|status|doctor>
                         常驻执行体客户端命令（契约篇 §6.8 刀一/二）：start 就绪
                         门槛（须 token 端点真握手才 exit 0）；stop 信号序；status
                         真握手披露；doctor 七项体检（pid/token/库/版本/端口）。
                         daemon 形态 webui 常开回环，缺省 7860
  berry attach           接上 daemon 的 TUI 纯客户端（零本地装配/零本地库——
                         HTTP/SSE 直连回环；审批卡/打断/投递全走 daemon 面）
  berry upgrade           升级维护动词：查 registry 更新 → npm 形态自升级（npm i -g
                         berry-agent-os@<版本>）/ 源码形态给指引 / 未发布态诚实告知；
                         用户显式维护动作——缺省零版本检查不变
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
               enabled+port，只作用 boot 树（/reload 重读盘）；daemon 形态下 =
               webui 常开端口（缺省 7860）
  --foreground daemon 限定：前台常驻形态（start spawn 的目标——launchd/systemd
               监视直接子进程的唯一正确形态，自 fork 会双实例循环）
  --standalone 裸 berry 限定：跳过 daemon 检测显式单开进程内形态（attach 的
               反义面——工作区会话归本进程，不与 daemon 抢写）
  --no-apps 安全模式：boot 组合树空装（默认层与 overlay 全跳过，只保 Ring 1 硬装配行
               ——坏应用锁死启动的自救位；/reload 读盘不受旗标影响，修好 overlay 即恢复全树）
  --app-file <path> 快速试件（开发指南 §8）：入口文件路径直接跑一次——组合树注入
               临时行（id=_quick_test，挂 chat 应用域），零装机零挂载零落盘。
               退出后组合树恢复原状（不写 overlay）。berry / berry run 两入口收
  --sandbox-host run 子命令限定：宿主进程套 OS 沙箱 wrapper（macOS seatbelt / Linux bwrap）
               ——检出后 CLI 重 exec 自身，本进程连同全部应用跑在沙箱内。
               可写面 = 档位根 ∪ 数据目录（~/.berry：库与凭证必须可写）。
               诚实边界：①策略并集粒度——数据目录内部互害关不住；②非网络沙箱
               ——出网默认放行（LLM API 刚需）；③seatbelt profile 非稳定公开接口，
               随 macOS 漂移；④Windows 无后端——fail-closed 拒跑（退出码 1）
  --           终结符：其后的参数全作消息字面、旗标解析停摆——正当以 -- 起头的
               消息内容（如让模型解释某旗标）经 berry run -- "--foo bar" 保真送达；
               未识别的 -- 旗标（含 --app=chat 等 = 取值形/拼写错写）全入口用法错退 2`;

/**
 * 手写 argv 解析（不引 commander——第九批拍板 #15）。
 * `--tick` / `--app` 是取值旗标：吃掉紧随其后的一个参数作值（与位置参数的
 * 互斥在 run case 执法——解析层只负责取值）。
 *
 * 未识别 `--` 词与终结符（20260901-c #1 修死，技术栈篇 §5「CLI 解析面执法四律」）：
 * - 以 `--` 起头且不在已知集的词收进 `unknownFlags`（分派层统一用法错退 2）——
 *   旧形落进位置参数被静默并进消息，`--app=chat` 等语序错写语义静默丢失；
 * - 裸 `--` = 终结符：其后的 argv 全字面进位置参数（旗标解析停摆）——正当以
 *   `--` 起头的消息内容经 `berry run -- "--foo bar"` 保真送达；
 * - 单短横线词不在射程（`-5` 形负数/缩写消息正当存在，维持位置参数落点）。
 */
/** 已知取值/布尔旗标全集（未列者以 `--` 起头即未识别——命令位词另见 COMMAND_WORDS） */
const KNOWN_FLAG_WORDS: ReadonlySet<string> = new Set([
  '--debug',
  '--read-only',
  '--background',
  '--tick',
  '--app',
  '--port',
  '--no-apps',
  '--sandbox-host',
  '--foreground',
  '--app-file',
  '--standalone',
]);
/** 命令位词（合法落在位置参数首位、由分派 switch 匹配——不算未识别旗标） */
const COMMAND_WORDS: ReadonlySet<string> = new Set(['--help', '-h', '--version', '-v']);

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
  /** daemon 前台常驻（--foreground，契约篇 §6.8 刀一）：daemon 限定——start spawn 的目标形态 */
  foreground: boolean;
  /** 裸 berry 显式单开（--standalone，契约篇 §6.8 刀二）：跳过 daemon 检测——其余入口无害忽略 */
  standalone: boolean;
  /** 快速试件路径（--app-file <path>，开发指南 §8）：berry/run 两入口收——组合树注入临时行，零装机零挂载零落盘 */
  appFile: string | undefined;
  /** 未识别 `--` 词（终结符之前收到的——分派层统一用法错退 2，20260901-c #1） */
  unknownFlags: readonly string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const unknownFlags: string[] = [];
  let debug = false;
  let readOnly = false;
  let background = false;
  let noApps = false;
  let tick: string | undefined;
  let app: string | undefined;
  let port: string | undefined;
  let sandboxHost = false;
  let foreground = false;
  let standalone = false;
  let appFile: string | undefined;
  let terminated = false; // `--` 终结符已见——其后 argv 全字面（旗标解析停摆）
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (terminated) {
      // 终结符之后：一切词原样作位置参数（以 -- 起头的消息内容经此保真送达）
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      // 裸 `--` = 终结符本体（消费不进位置参数——存在意义就是切换解析态）
      terminated = true;
      continue;
    }
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
    } else if (arg === '--foreground') {
      // daemon 前台常驻（契约篇 §6.8 刀一）：daemon 限定——其余入口收到时无害
      // 忽略（同 --read-only 律：语义只在 daemon case 执法）
      foreground = true;
    } else if (arg === '--app-file') {
      // 快速试件（开发指南 §8）：取值旗标——下一参数即入口文件路径
      appFile = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--standalone') {
      // 裸 berry 显式单开（契约篇 §6.8 刀二）：跳过 daemon 检测——其余入口收到
      // 时无害忽略（同律：语义只在裸 berry case 执法）
      standalone = true;
    } else if (arg.startsWith('--') && !KNOWN_FLAG_WORDS.has(arg) && !COMMAND_WORDS.has(arg)) {
      // 未识别 `--` 词（含 = 取值形/拼写错写）：收进名单交分派层统一用法错——
      // 旧形落位置参数被静默并进消息（#1：`berry run --app=chat "hi"` 送进 LLM）
      unknownFlags.push(arg);
    } else {
      positional.push(arg);
    }
  }
  const [command = '', ...rest] = positional;
  return {
    command,
    args: rest,
    debug,
    readOnly,
    background,
    tick,
    app,
    port,
    noApps,
    sandboxHost,
    foreground,
    standalone,
    appFile,
    unknownFlags,
  };
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
/**
 * 已知 APP_ 环境变量词表（基建大扫 #31）——与 docs/使用指南.md §5 表同源，
 * 新增配置变量须两处同步。`APP_SESSION_ID` 在列但属宿主注入位（exec/env.ts
 * hostInjectRecord 单源——宿主向子进程披露当前会话 id 的运行时数据值，非用户
 * 配置面），列入为的是注入场景（bash 工具子进程再起 berry）不误报。
 */
const KNOWN_APP_ENV_VARS = new Set([
  'APP_MODEL', // 覆盖缺省模型
  'APP_DATA_DIR', // 覆盖 ~/.berry 数据目录
  'APP_DB_PATH', // 覆盖 SQLite 库文件路径
  'APP_LOG_LEVEL', // 日志级别（支持逗号分模块调级，logger 模块）
  'APP_FD_PATH', // @ 文件段 fd 补全路径
  'APP_BASH_PATH', // bash 工具可执行路径
  'APP_BROWSER_PATH', // 浏览器引擎可执行路径
  'APP_SESSION_ID', // 宿主注入（非用户配置面）——豁免告警
]);

/**
 * 未知 APP_ 环境变量提示（基建大扫 #31）：拼错（如 APP_DAT_DIR）会静默无效——
 * 比启动失败更糟（配置意图无声丢失）。boot 期 stderr 一行点名全部未知键，
 * 不硬拒（前向兼容：旧版本遇到新版本新增变量只提示不炸，行为不变）。
 * 导出为可注入纯函数供测试直调（env/write 双注入面）。
 */
export function warnUnknownAppEnvVars(
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => process.stderr.write(line),
): void {
  const unknown = Object.keys(env).filter((key) => key.startsWith('APP_') && !KNOWN_APP_ENV_VARS.has(key));
  if (unknown.length > 0) {
    write(`[env] 未识别的 APP_ 环境变量：${unknown.join(', ')}（可能拼错或不被本版本支持；已知变量见 berry --help）\n`);
  }
}

function main(argv: string[]): number {
  const {
    command,
    args,
    readOnly,
    background,
    tick,
    app,
    port,
    noApps,
    sandboxHost,
    foreground,
    standalone,
    appFile,
    unknownFlags,
  } = parseArgs(argv);

  // 未知 APP_ 变量提示（基建大扫 #31）：boot 期一次、全命令族统一
  warnUnknownAppEnvVars();

  // dist 陈旧告警（成熟度扫描 20260901 P1-13）：入口跑在 /dist/ 下且包根即
  // git 仓根且 build-meta 落后 HEAD 时 stderr 一行提示重跑 build——dev 便利件，
  // 三前置任一失败静默跳过（src 直跑/装机形态零成本；build-meta.ts 头注）
  warnIfStaleDist(import.meta.url);

  const run = async (): Promise<number> => {
    // 未识别 `--` 旗标闸（20260901-c #1，技术栈篇 §5「CLI 解析面执法四律」①）：
    // 全入口统一退 2——旧形落位置参数被静默并进消息/子命令，语义静默丢失
    if (unknownFlags.length > 0) {
      process.stderr.write(
        `未识别旗标：${unknownFlags.join(' ')}（用法见 berry --help；以 -- 起头的消息内容用 \`--\` 终结符转义）\n`,
      );
      return 2;
    }
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
        // --app-file 缺值空串占位执法（20260901-c #14）：占位逃过 undefined 判据
        // 会直传装配层以 APP_ENTRY_UNRESOLVED 退 1（路径文案现 cwd 谎报）——入口退 2
        if (appFile === '') {
          process.stderr.write('用法：berry --app-file <入口文件路径>\n');
          return 2;
        }
        // 裸 berry 检测（刀二，契约篇 §6.8）：daemon.json 在场时对其 port 发真握手
        //（只读 token，200 = 唯一正判）——正判即提示改道退非零；探败/stale/僵尸 =
        // 照常起进程内形态零副作用（不清态文件）；--standalone 显式跳过
        if (!standalone) {
          const detected = await detectDaemonHandshake();
          if (detected !== undefined) {
            process.stdout.write(
              `检测到 daemon 正在本机运行（127.0.0.1:${detected.port}）——工作区会话由它持有。\n` +
                '  · `berry attach` 接上继续（TUI 纯客户端）\n' +
                '  · `berry --standalone` 显式单开进程内形态\n',
            );
            return 1;
          }
        }
        return tuiMain({
          ...(noApps ? { noApps: true } : {}),
          ...(webuiPort === undefined ? {} : { webuiPort }),
          ...(appFile === undefined ? {} : { appFile }),
        });
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
          if (!tick || args.length > 0 || app !== undefined || appFile !== undefined) {
            process.stderr.write('用法：berry run --tick <任务名> [--read-only] [--background]\n');
            return 2;
          }
          // e1 宿主沙箱包裹：用法校验先行（快失败不浪费 wrapper spawn），剥旗标
          // 重 exec 后内层 argv 再入此分支照常走 tick 形态（旗标已剥不递归）。
          // wrapper 档位恒 read-only（20260901-c #2，技术栈篇 §5「CLI 解析面执法
          // 四律」④）：tick 任务面档 = tick-main 缺省 read-only（进程档永不宽于
          // 只读），OS 硬墙不随 --read-only 在场与否分叉——旧形缺席时给
          // workspace-write，硬墙宽于进程语义档即档位口径漂移
          if (sandboxHost) {
            return relaunchUnderHostSandbox(process.argv, process.cwd(), 'read-only' as const);
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
          if (!app || appFile !== undefined) {
            process.stderr.write('用法：berry run --app <应用id> "<message>" [--read-only] [--background]\n');
            return 2;
          }
        }
        // --app-file 缺值空串占位执法（20260901-c #14，同 TUI 入口律）：占位逃过
        // undefined 判据会直传装配层以 APP_ENTRY_UNRESOLVED 退 1——入口退 2
        if (appFile === '') {
          process.stderr.write('用法：berry run --app-file <入口文件路径> "<message>"\n');
          return 2;
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
        // --app-file → 快速试件（契约篇 §5.5）：组合树注入临时行，零装机零挂载零落盘
        // --port → Web 通道开面（组合树 webui 行注入 enabled+port——与 overlay
        // 开面等价，只作用 boot 树；run 单发形态下通道随进程关停）
        return runOnceMain(message, {
          ...(readOnly ? { sandboxMode: 'read-only' as const } : {}),
          ...(background ? { usagePriority: 'background' as const } : {}),
          ...(app === undefined ? {} : { app }),
          ...(noApps ? { noApps: true } : {}),
          ...(webuiPort === undefined ? {} : { webuiPort }),
          ...(appFile === undefined ? {} : { appFile }),
        });
      }
      case 'attach': {
        // attach 纯客户端（刀二，契约篇 §6.8）：零 createRuntime/零本地库——
        // --port 覆盖 daemon.json 记录值（诊断用法）；其余形态旗标互斥即用法错
        const webuiPort = port === undefined ? undefined : parsePortValue(port);
        if (port !== undefined && webuiPort === undefined) {
          process.stderr.write('用法：berry attach [--port <1-65535>]\n');
          return 2;
        }
        if (
          args.length > 0 ||
          readOnly ||
          background ||
          tick !== undefined ||
          app !== undefined ||
          sandboxHost ||
          noApps ||
          foreground ||
          appFile !== undefined
        ) {
          process.stderr.write('用法：berry attach [--port <n>]（run/daemon 族旗标不适用）\n');
          return 2;
        }
        return attachMain({ ...(webuiPort === undefined ? {} : { port: webuiPort }) });
      }
      case 'daemon': {
        // daemon 命令族（契约篇 §6.8 常驻执行体条·刀一/二）：客户端命令
        // start/stop/status/doctor + --foreground 前台常驻（start spawn 的目标——
        // launchd/systemd 监视直接子进程形态，操作者通常不经手）。旗标面只收
        // --port（webui 常开端口，缺省 7860）与 --debug（env 传染子进程）；
        // run 族旗标混入即用法错（形态面互斥——单发/调度语义不属常驻体）
        const webuiPort = port === undefined ? undefined : parsePortValue(port);
        if (port !== undefined && webuiPort === undefined) {
          process.stderr.write('用法：berry daemon <start|stop|status|doctor|--foreground> [--port <1-65535>]\n');
          return 2;
        }
        if (
          readOnly ||
          background ||
          tick !== undefined ||
          app !== undefined ||
          sandboxHost ||
          noApps ||
          appFile !== undefined
        ) {
          process.stderr.write(
            '用法：berry daemon <start|stop|status|doctor|--foreground> [--port <n>]（run 族旗标不适用）\n',
          );
          return 2;
        }
        if (foreground) {
          if (args.length > 0) {
            process.stderr.write('用法：berry daemon --foreground [--port <n>]（--foreground 不与子命令并存）\n');
            return 2;
          }
          return daemonForegroundMain(webuiPort ?? DEFAULT_WEBUI_PORT);
        }
        const sub = args[0];
        if ((sub !== 'start' && sub !== 'stop' && sub !== 'status' && sub !== 'doctor') || args.length > 1) {
          process.stderr.write('用法：berry daemon <start|stop|status|doctor> [--port <n>]\n');
          return 2;
        }
        if (sub === 'doctor') {
          // doctor 不消费端口（体检面读 daemon.json 真相——与 stop/status 同律）
          return daemonDoctorMain();
        }
        // stop/status 不消费端口（daemon.json 态文件即真相）；start/foreground
        // 缺省 7860（webui 常开回环）
        return daemonCommandMain(sub, webuiPort ?? DEFAULT_WEBUI_PORT);
      }
      case 'upgrade': {
        // 第六命令（技术栈篇 §8.5，第五十一批）：纯 CLI 维护动词——零装配（不建
        // runtime/不触库）；run 族旗标不适用即用法错（形态面互斥同 daemon 律）。
        // 互斥面修订（20260901-c #13，契约篇 §5.5 互斥表）：--app-file 入拒列
        // （快试件与升级动词并给 = 语义静默吞且 spawn npm i -g 会真跑）；
        // --standalone 自拒列退役——无害忽略同 --foreground 律（attach/daemon 同款，
        // 原拒列是码面偏离规范的孤例）
        if (
          args.length > 0 ||
          readOnly ||
          background ||
          tick !== undefined ||
          app !== undefined ||
          port !== undefined ||
          noApps ||
          sandboxHost ||
          foreground ||
          appFile !== undefined
        ) {
          process.stderr.write('用法：berry upgrade（无旗标——升级维护动词不与运行形态旗标并用）\n');
          return 2;
        }
        return upgradeMain();
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
      // 顶层兜底走 describeError 单源（基建大扫 #8）：AppError 织 [CODE] 前缀
      //（码词汇不在 CLI 最后一环丢失——headless 脚本消费方追码可依）、其余取
      // message（一行 stderr——细节在 debug 日志）
      process.stderr.write(`✖ ${describeError(error)}\n`);
      process.exitCode = 1;
    },
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
