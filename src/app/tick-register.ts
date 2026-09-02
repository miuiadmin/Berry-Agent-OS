/**
 * L5 app — OS 定时注册器（内核边界篇 §4.1 席 13 第二刀 K2-d：launchd /
 * crontab 注册——spawn 与系统文件操作上提组合根，scheduler 件经闭包收
 * 面不见 exec，同 scheduler-runner 先例）。
 *
 * 平台形态（拍板：OS 调度器持时、应用不持进程——注册的是一条 OS 调度
 * 唤起，不是看护进程）：
 * - darwin：~/Library/LaunchAgents/tick.<名>.plist（launchd）——三形状
 *   schedule 全支持（StartCalendarInterval 日历字段 / StartInterval 秒数）；
 * - Linux：crontab 行（`M H * * * <命令> # tick:<名>` 标记行）——v1 只
 *   daily@HH:MM（间隔/一次性形状 cron 表达不了间隔语义，硬翻墙钟对齐会
 *   与 tick-main 的基点 due 复核互相打架——披露不支持胜过错位支持）；
 * - 其余平台（win32 等）：披露不支持。
 *
 * 注册的唤起命令 = tick runner 公式同源：`<基座 argv> run --tick <名>
 * --read-only --background`——到点进程 = K2-c 编排入口，due 复闸（OS 钟
 * 触发 + 库内锚判定双闸——OS 侧漂移由 evaluateDue 兜底）。
 *
 * 凭证边界：OS 调起的进程**不继承**宿主 shell env（launchd 只给最小
 * env）——plist/cron 注入定位双变量（APP_DATA_DIR/APP_DB_PATH 恒注入）+
 * 宿主覆盖类三变量（HOST_OVERRIDE_ENV_NAMES 单源名单——注册时快照、有值
 * 才注，遗漏大扫 20260902-c #13），凭证走数据目录凭证库正路（persist 凭证
 * 表）；宿主 env 凭证（代理 key 等）不复制进系统注册面（明文凭证二次落盘
 * 是新的泄漏面，不做——enable 回执披露此边界与快照语义）。
 */

import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeAtomicFile } from '../persist/index.js';
import { runArgv, buildChildEnv, type CommandProcessLog } from '../exec/index.js';
import type { RunResult } from '../exec/index.js';
import { parseSchedule, evaluateDue } from '../scheduler/index.js';
import type { JobRecord } from '../scheduler/index.js';
// 重放基座公式单源（20260901-d #6 勘正——与 runner 两消费面同源，勿各自内联）
// + 宿主覆盖类名单单源（20260902-c #13——plist/cron 注入面与 runner 传值面复用）
import { tickRelaunchBaseArgv, HOST_OVERRIDE_ENV_NAMES } from './scheduler-runner.js';

/** 注册/注销结果（人读回执直用——件面不做二次措辞） */
export interface TickOsResult {
  readonly ok: boolean;
  /** 人读结果（成功含注册位置/失败含原因——命令回执直用） */
  readonly message: string;
}

/** OS 定时注册器三面（件经闭包收——缺省诊断装配无此面，命令报不可用） */
export interface TickOsRegistrar {
  /** 注册/覆盖注册一个任务的 OS 调度（读任务行的 schedule 翻译 OS 语义） */
  register(job: JobRecord): Promise<TickOsResult>;
  /** 注销（未注册 = 幂等回执非错误） */
  unregister(name: string): Promise<TickOsResult>;
  /** 是否已注册（list 行探测——同步文件探测 + cron 查询） */
  isRegistered(name: string): Promise<boolean>;
}

/** 注册器构造选项（全注入式——平台/目录/基座 argv 可冻结单测） */
export interface TickOsOptions {
  /** 宿主 resolved 数据目录（plist 定位变量 + 日志目录） */
  readonly dataDir: string;
  /** 宿主 resolved 库路径（plist 定位变量） */
  readonly dbPath: string;
  /** 平台（缺省 process.platform——测试冻结） */
  readonly platform?: NodeJS.Platform;
  /** LaunchAgents 目录（缺省 ~/Library/LaunchAgents——测试注入临时目录） */
  readonly launchAgentsDir?: string;
  /** 基座 argv（缺省 [process.execPath, ...process.argv.slice(1)]——测试注入） */
  readonly baseArgv?: readonly string[];
  /** launchctl/crontab 子进程 env（缺省 process.env 白名单清洗） */
  readonly env?: NodeJS.ProcessEnv;
  /** launchctl 可执行（缺省 'launchctl'——测试注入假脚本） */
  readonly launchctlBin?: string;
  /** crontab 可执行（缺省 'crontab'——测试注入假脚本） */
  readonly crontabBin?: string;
  /** 命令进程登记簿（契约篇 §6.6 exec 腿——launchctl/crontab 系统命令同律登记清扫） */
  readonly commandLog?: CommandProcessLog;
}

/** launchd 调度形状（三形状翻译的结构化产物——渲染在注册器内部） */
export type LaunchdSchedule =
  /** 日历字段（缺年月日 = 每日；全字段 = 一次性时刻——launchd 时刻过后不再触发） */
  | { readonly kind: 'calendar'; readonly fields: Record<string, number> }
  /** 固定间隔（秒——从 load 时刻起算，与库内锚由 due 复闸对齐） */
  | { readonly kind: 'interval'; readonly seconds: number };

/**
 * schedule 声明串 → launchd 调度形状（纯函数——注册器唯一翻译件）。
 * once@ 带时区后缀（Z/偏移）也投影到本地日历字段（launchd StartCalendarInterval
 * 本就是本地钟语义——与 daily@ 无后缀 = 本地同律）。
 */
export function scheduleToLaunchd(schedule: string, now: number): LaunchdSchedule | { error: string } {
  const parsed = parseSchedule(schedule, now, { allowPast: true });
  if (!parsed.ok) return { error: parsed.error };
  switch (parsed.schedule.kind) {
    case 'daily':
      return { kind: 'calendar', fields: { Hour: parsed.schedule.hour, Minute: parsed.schedule.minute } };
    case 'every':
      return { kind: 'interval', seconds: parsed.schedule.intervalMs / 1000 };
    case 'once': {
      // 本地投影：launchd 按本地钟解释日历字段（ISO 无后缀 = 本地 / 显式
      // 时区 = 换算后的本地钟——Date 构造天然完成换算）
      const at = new Date(parsed.schedule.at);
      return {
        kind: 'calendar',
        fields: {
          Year: at.getFullYear(),
          Month: at.getMonth() + 1,
          Day: at.getDate(),
          Hour: at.getHours(),
          Minute: at.getMinutes(),
        },
      };
    }
  }
}

/**
 * schedule 声明串 → cron 行时间字段（纯函数）。v1 只 daily——every 的间隔
 * 语义 cron 表达不了（墙钟对齐 ≠ 间隔），once 的单次语义 cron 同样没有；
 * 披露不支持（错位支持会与库内 due 复闸打架）。
 */
export function scheduleToCronFields(schedule: string, now: number): string | { error: string } {
  const parsed = parseSchedule(schedule, now, { allowPast: true });
  if (!parsed.ok) return { error: parsed.error };
  if (parsed.schedule.kind !== 'daily') {
    return { error: `cron 形态暂只支持 daily@HH:MM（当前 ${schedule}——间隔/一次性形状 darwin launchd 全支持）` };
  }
  const { hour, minute } = parsed.schedule;
  return `${minute} ${hour} * * *`;
}

/** plist Label / 文件名 / cron 标记共用的任务名前缀（中性词——品牌红线） */
const TICK_LABEL_PREFIX = 'tick';

/** plist 路径（~/Library/LaunchAgents/tick.<名>.plist） */
function plistPath(dir: string, name: string): string {
  return join(dir, `${TICK_LABEL_PREFIX}.${name}.plist`);
}

/** cron 行标记（过滤/去重锚——注释段，中性词） */
function cronMarker(name: string): string {
  return `# ${TICK_LABEL_PREFIX}:${name}`;
}

/** XML 文本转义（plist 值内插防注入——路径/名字含 &<> 的结构防御） */
function xmlEscape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** shell 单词引号（cron 命令行内插——含空白/元字符即单引号包裹） */
function shellQuote(word: string): string {
  return /^[A-Za-z0-9_\-./:=@]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** OS 调起的进程日志路径（dataDir/tick-logs/<名>.log——让路/退出码 stderr 留痕面） */
function tickLogPath(dataDir: string, name: string): string {
  return join(dataDir, 'tick-logs', `${name}.log`);
}

/**
 * 构造 OS 定时注册器。
 * launchctl/crontab 走 runArgv（exec 白名单内建——env 经 buildChildEnv
 * 白名单清洗；测试注入假可执行脚本即全真子进程路）。
 */
export function createTickOsRegistrar(opts: TickOsOptions): TickOsRegistrar {
  const platform = opts.platform ?? process.platform;
  const launchAgentsDir = opts.launchAgentsDir ?? join(homedir(), 'Library', 'LaunchAgents');
  // 缺省基座 = 重放宿主入口三律公式（20260901-d #6 勘正——写进 plist/crontab 的
  // 是 OS 到点调起面，宿主形态旗标/execArgv 缺失都会造出加载即死或拒启的坏注册）
  const baseArgv = opts.baseArgv ?? tickRelaunchBaseArgv();
  // 宿主 env 源（注入式——测试冻结）：plist/cron 注入面读**原始宿主值**
  // （override 类注册时快照）。与 buildChildEnv 的产物（launchctl/crontab
  // 子进程 env——白名单清洗后）分立两账：渲染面不消费清洗产物
  const hostEnv = opts.env ?? process.env;
  // 宿主覆盖类注册时快照（20260902-c #13——与 runner 同名单单源；有值才注
  // 不造空串，与凭证族同款纪律）。构造期算一次：值固定即快照语义本体
  const overrideSnapshot: Array<readonly [name: string, value: string]> = [];
  for (const name of HOST_OVERRIDE_ENV_NAMES) {
    const value = hostEnv[name];
    if (value !== undefined && value !== '') overrideSnapshot.push([name, value]);
  }
  const env = buildChildEnv(hostEnv);
  const launchctlBin = opts.launchctlBin ?? 'launchctl';
  const crontabBin = opts.crontabBin ?? 'crontab';

  /** tick 唤起 argv（K2-c 入口 + 任务面旗标——runner 公式同源） */
  const tickArgv = (name: string): string[] => [...baseArgv, 'run', '--tick', name, '--read-only', '--background'];

  /** 跑一个系统命令（launchctl/crontab——超时 15s 防系统命令挂死命令面） */
  const runSys = (argv: readonly string[]): Promise<RunResult> =>
    runArgv(argv, {
      env,
      timeoutMs: 15_000,
      // 命令进程登记簿透传（宿主猝死孤儿治理——见 TickOsOptions.commandLog 注）
      ...(opts.commandLog !== undefined ? { commandLog: opts.commandLog } : {}),
    });

  /** 平台不支持的人读回执（win32 等——诚实披露非错误崩溃；规范定性即「披露
   * 不支持」，不挂账：无触发判据的未来承诺是无主挂账——遗漏大扫 20260901-b #18） */
  const unsupported = (): TickOsResult => ({
    ok: false,
    message: '当前平台不支持 OS 定时注册（支持 darwin launchd / Linux crontab）',
  });

  /* ---------------- darwin：launchd plist 面 ---------------- */

  /** 渲染 plist 全文（ProgramArguments + 定位双变量 + override 快照 + 调度形状 + 日志路径） */
  const renderPlist = (job: JobRecord, schedule: LaunchdSchedule): string => {
    const programArgs = tickArgv(job.name)
      .map((part) => `        <string>${xmlEscape(part)}</string>`)
      .join('\n');
    // 宿主覆盖类快照段（20260902-c #13——plist EnvironmentVariables 追加项；
    // 空快照零段 = 与原 dict 逐字节同形）
    const overrideXml = overrideSnapshot
      .map(([name, value]) => `        <key>${name}</key>\n        <string>${xmlEscape(value)}</string>`)
      .join('\n');
    const scheduleXml =
      schedule.kind === 'interval'
        ? `    <key>StartInterval</key>\n    <integer>${schedule.seconds}</integer>`
        : `    <key>StartCalendarInterval</key>\n    <dict>\n${Object.entries(schedule.fields)
            .map(([key, value]) => `      <key>${key}</key>\n      <integer>${value}</integer>`)
            .join('\n')}\n    </dict>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${TICK_LABEL_PREFIX}.${xmlEscape(job.name)}</string>
    <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>APP_DATA_DIR</key>
        <string>${xmlEscape(opts.dataDir)}</string>
        <key>APP_DB_PATH</key>
        <string>${xmlEscape(opts.dbPath)}</string>
${overrideXml === '' ? '' : `${overrideXml}\n`}    </dict>
${scheduleXml}
    <key>StandardOutPath</key>
    <string>${xmlEscape(tickLogPath(opts.dataDir, job.name))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(tickLogPath(opts.dataDir, job.name))}</string>
</dict>
</plist>
`;
  };

  /** darwin 注册：写 plist（原子写）→ unload 旧（忽略失败）→ load 新 */
  const registerLaunchd = async (job: JobRecord): Promise<TickOsResult> => {
    const schedule = scheduleToLaunchd(job.schedule ?? '', Date.now());
    if ('error' in schedule) return { ok: false, message: `schedule 不合法：${schedule.error}` };
    mkdirSync(launchAgentsDir, { recursive: true });
    // 日志目录先行（launchd 不建目录——目录缺席时 stdout/stderr 静默丢弃）
    mkdirSync(join(opts.dataDir, 'tick-logs'), { recursive: true });
    const plist = plistPath(launchAgentsDir, job.name);
    writeAtomicFile(plist, renderPlist(job, schedule));
    // 覆盖注册两步：先 unload 清旧定义（未装载/文件已删均非错误——忽略退出码），
    // 再 load 新定义（此步失败即注册失败——plist 已写但未生效，回执示明）
    await runSys([launchctlBin, 'unload', plist]).catch(() => undefined);
    const loaded = await runSys([launchctlBin, 'load', plist]);
    if (loaded.exitCode !== 0) {
      return {
        ok: false,
        message: `launchctl load 失败（退出码 ${loaded.exitCode}）：${loaded.stderr.trim() || loaded.stdout.trim() || '无输出'}`,
      };
    }
    return {
      ok: true,
      message: `已注册 OS 定时（launchd）：${plist}\n注意：OS 调起的进程不继承宿主 env——定时轮凭证取数据目录凭证库（宿主 env 代理 key 不随调起传递）；APP_MODEL/APP_BASH_PATH/APP_LOG_LEVEL 以注册时快照注入，改动后需重新 /tick enable 生效`,
    };
  };

  /** darwin 注销：unload → 删 plist */
  const unregisterLaunchd = async (name: string): Promise<TickOsResult> => {
    const plist = plistPath(launchAgentsDir, name);
    if (!existsSync(plist)) return { ok: true, message: `未注册（无 ${plist}）——无需注销` };
    await runSys([launchctlBin, 'unload', plist]).catch(() => undefined);
    rmSync(plist);
    return { ok: true, message: `已注销 OS 定时并删除 ${plist}` };
  };

  /* ---------------- Linux：crontab 标记行面 ---------------- */

  /** 读现行 crontab（无 crontab / crontab 命令缺席 = 空串——写路的失败才是真失败） */
  const readCrontab = async (): Promise<string> => {
    const result = await runSys([crontabBin, '-l']).catch(() => undefined);
    return result !== undefined && result.exitCode === 0 ? result.stdout : '';
  };

  /** 过滤掉某任务的标记行（去重/注销共用） */
  const stripMarker = (content: string, name: string): { kept: string; removed: boolean } => {
    const marker = cronMarker(name);
    const lines = content.split('\n').filter((line) => !line.endsWith(marker));
    return { kept: lines.join('\n'), removed: lines.length !== content.split('\n').length };
  };

  /** 装载新 crontab 内容（临时文件中转——runArgv 无 stdin 面） */
  const writeCrontab = async (content: string): Promise<RunResult> => {
    const tempFile = join(opts.dataDir, 'tick-logs', `crontab-install.txt`);
    mkdirSync(join(opts.dataDir, 'tick-logs'), { recursive: true });
    writeAtomicFile(tempFile, content.endsWith('\n') || content === '' ? content : `${content}\n`);
    return runSys([crontabBin, tempFile]);
  };

  /** Linux 注册：过滤旧行 → 追加新标记行 → 装载 */
  const registerCron = async (job: JobRecord): Promise<TickOsResult> => {
    const fields = scheduleToCronFields(job.schedule ?? '', Date.now());
    if (typeof fields !== 'string') return { ok: false, message: fields.error };
    const current = await readCrontab();
    const { kept } = stripMarker(current, job.name);
    // env 前缀注入（20260902-c #13——plist EnvironmentVariables 的 cron 等价
    // 物）：定位双变量恒注（OS 调起进程不继承宿主 env，非缺省数据目录下不注
    // 即读错库）+ override 类快照（有值才注）；cron 命令段经 sh 执行，
    // `VAR=value cmd` 前缀是合法语法
    const envPrefix = [
      `APP_DATA_DIR=${shellQuote(opts.dataDir)}`,
      `APP_DB_PATH=${shellQuote(opts.dbPath)}`,
      ...overrideSnapshot.map(([name, value]) => `${name}=${shellQuote(value)}`),
    ].join(' ');
    const command = `${envPrefix} ${tickArgv(job.name).map(shellQuote).join(' ')}`;
    // 标记行 = 命令 + 行尾注释（cron 的 % 在命令段有特殊义——prompt 不进命令段无此患）
    const line = `${fields} ${command} ${cronMarker(job.name)}`;
    const next = kept === '' ? line : `${kept.replace(/\n$/, '')}\n${line}`;
    const installed = await writeCrontab(next);
    if (installed.exitCode !== 0) {
      return {
        ok: false,
        message: `crontab 装载失败（退出码 ${installed.exitCode}）：${installed.stderr.trim() || '无输出'}`,
      };
    }
    return {
      ok: true,
      message: `已注册 OS 定时（crontab）：${fields} → ${job.name}\n注意：OS 调起的进程不继承宿主 env——定时轮凭证取数据目录凭证库；APP_MODEL/APP_BASH_PATH/APP_LOG_LEVEL 以注册时快照注入，改动后需重新 /tick enable 生效`,
    };
  };

  /** Linux 注销：过滤标记行 → 有删到才重装（未注册幂等回执） */
  const unregisterCron = async (name: string): Promise<TickOsResult> => {
    const current = await readCrontab();
    const { kept, removed } = stripMarker(current, name);
    if (!removed) return { ok: true, message: `未注册（crontab 无 ${cronMarker(name)} 行）——无需注销` };
    const installed = await writeCrontab(kept);
    if (installed.exitCode !== 0) {
      return {
        ok: false,
        message: `crontab 装载失败（退出码 ${installed.exitCode}）：${installed.stderr.trim() || '无输出'}`,
      };
    }
    return { ok: true, message: `已注销 OS 定时（crontab 行移除）` };
  };

  /* ---------------- 平台分派 ---------------- */

  return {
    async register(job) {
      // schedule 缺席 = 仅手动任务：无到点语义，注册 OS 调度是概念错配
      if (job.schedule === null) {
        return {
          ok: false,
          message: `任务 ${job.name} 无 schedule 声明（仅手动触发）——OS 定时注册需要 once@/every@/daily@ 声明`,
        };
      }
      // once 已跑（done）/ 迟到超窗（missed）= 生命周期已终——注册了也永不再
      // 触发，诚实拒；未到（wait）与到窗内（fire）照常注册
      if (job.schedule.startsWith('once@')) {
        const parsed = parseSchedule(job.schedule, Date.now(), { allowPast: true });
        if (parsed.ok) {
          const action = evaluateDue(parsed.schedule, job.lastRunAt, job.createdAt, Date.now()).action;
          if (action === 'done' || action === 'missed') {
            return { ok: false, message: `once@ 任务 ${job.name} 生命周期已终（${action}）——重新 add 新任务` };
          }
        }
      }
      if (platform === 'darwin') return registerLaunchd(job);
      if (platform === 'linux') return registerCron(job);
      return unsupported();
    },
    async unregister(name) {
      if (platform === 'darwin') return unregisterLaunchd(name);
      if (platform === 'linux') return unregisterCron(name);
      return unsupported();
    },
    async isRegistered(name) {
      if (platform === 'darwin') return existsSync(plistPath(launchAgentsDir, name));
      if (platform === 'linux') {
        const current = await readCrontab();
        return current.split('\n').some((line) => line.endsWith(cronMarker(name)));
      }
      return false;
    },
  };
}
