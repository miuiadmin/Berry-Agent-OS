/**
 * 统一管理器 `/monitor` 服务面 + 行投影纯函数（OS 三大管理面研究刀四，
 * [运行时骨架]篇 §1.2「统一管理器三页签」2026-09-04 规范先行）。
 *
 * 实现分工（冷读裁决 C1——现役视图先例形态，不发明壳扩展契约）：渲染树组装
 * 与键位分派住壳 desktop-shell（store/sessions 同构）；本件持**服务面 +
 * 行投影纯函数**（数据组装与行文本格式化——纯函数无渲染树），壳只持 view
 * 枚举值、页签光标与键位分派。
 *
 * 数据源纪律（spec 同条）：三页签全部既有面投影——舰队计数经 AppRuntime
 * 返回值扩面 fleetStats()；scheduler-view / memory-browse 经组合根闭包注入；
 * 零新表族、零新 ctx 服务键。计数来源（冷读裁决 C3）：建树活取零订阅
 * （每次 panel() 调用重取——零常驻零 dispose 义务）。
 */

import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { memoryUsage } from 'node:process';

import type { JobsServiceFace } from '../contracts/jobs.js';
import { canonicalWorkspaceRoot } from '../context/index.js';
import {
  MemoryStore,
  exportMemoryText,
  isPathInsideRoots,
  writeExportFile,
  type MemoryRecord,
  type MemoryStatus,
} from '../memory/index.js';
import { openRollupStore, type RollupTable } from '../obs/index.js';
import type { SchedulerViewFace, SchedulerViewRow } from '../scheduler/index.js';
import type { FleetStats } from './bridge-fleet.js';

/** 页签三值（proc 进程 / jobs 任务 / mem 内存——spec §1.2 三页签） */
export type MonitorTab = 'proc' | 'jobs' | 'mem';

/**
 * 光标可寻址行宾语（页签动词的宾语——壳按光标取行调 face 动词）：
 * job = ctx.jobs Job（proc 页签 k 取消）/ tick = tick 任务名（jobs 页签
 * e·d·n）/ memory = 记忆条目 id（mem 页签 f·x·v）。
 */
export interface MonitorItem {
  readonly kind: 'job' | 'tick' | 'memory';
  /** 动词宾语键（Job id / 任务名 / 记忆 id） */
  readonly key: string;
  /** 人读标签（confirm 文案与回执呈现用） */
  readonly label: string;
}

/** 面板行（item 在场 = 光标可寻址动作行；缺席 = 只读仪表行） */
export interface MonitorRow {
  readonly text: string;
  readonly item?: MonitorItem;
}

/** 一页签面板（行投影产物——壳渲染树只读本，数据组装全在本件） */
export interface MonitorPanel {
  /** 面板标题行 */
  readonly title: string;
  /** 正文行（等宽呈现——item 行与仪表行交织） */
  readonly rows: readonly MonitorRow[];
}

/**
 * 管理动作回执（结构兼容桌面 admin 回执形态：string = 单行提示 /
 * receipt = 回执视图标题 + 正文行）。confirm 两段式只在壳层组装（忘掉动词
 * ——本件不持交互态）。
 */
export type MonitorResult = MonitorReceipt | string;

/** 回执结构形（壳落 confirm 视图只读呈现——任意键返回 monitor） */
export interface MonitorReceipt {
  readonly title: string;
  readonly lines: readonly string[];
}

/** 监视面（宿主 desktop-main 构造闭包注入壳 DesktopShellDeps.monitor 槽） */
export interface DesktopMonitorFace {
  /** 建面板（建树活取——每调用重取，零订阅；tab 三值各投各域） */
  panel(tab: MonitorTab): Promise<MonitorPanel>;
  /** 取消 Job（proc 页签 k——ctx.jobs.cancel 不带 as = operator 直控） */
  cancelJob(id: string): Promise<MonitorResult>;
  /** 全量 reload（proc 页签 r——/reload 既有编舞同源） */
  reloadAll(): Promise<MonitorResult>;
  /** tick 任务动词（jobs 页签 e/d/n——经 scheduler-view dispatch 字符串分派，守卫单源） */
  tick(verb: 'enable' | 'disable' | 'run', name: string): Promise<MonitorResult>;
  /** 冻结/解冻翻转（mem 页签 f——MemoryStore 同 DAO 单实现） */
  memoryToggleFrozen(id: string): Promise<MonitorResult>;
  /** 忘掉（mem 页签 x——软删；壳层过 confirm 两段式） */
  memoryForget(id: string): Promise<MonitorResult>;
  /** 恢复（mem 页签 v——一期无 revision：最新态复活免 confirm，冷读裁决 C7） */
  memoryRestore(id: string): Promise<MonitorResult>;
  /** 导出（mem 页签 e——/memory-export 同一实现真身：exportMemoryText + 可写根判定） */
  memoryExport(): Promise<MonitorResult>;
}

/** 服务面构造依赖（宿主 desktop-main 闭包供料——全部活取值，随 /reload 即时生效） */
export interface MonitorDeps {
  /** 双舰队计数活取（AppRuntime.fleetStats 扩面——proc 页签数据源①） */
  readonly fleetStats: () => { readonly ring1: FleetStats; readonly apps: FleetStats };
  /** scheduler-view 面活取（AppRuntime 扩面——jobs 页签；缺席诚实示） */
  readonly schedulerView: () => SchedulerViewFace | undefined;
  /** ctx.jobs 活取（tryGet——proc 页签 Job 清单与取消；缺席诚实示） */
  readonly jobs: () => JobsServiceFace | undefined;
  /** browser 引擎状态活取（tryGet ctx 'browser'——proc 页签四态；缺席 = 行未装配） */
  readonly browserStatus: () => { readonly state: 'idle' | 'starting' | 'running' | 'closed' } | undefined;
  /** 全量 reload（AppRuntime.reload——r 动词） */
  readonly reload: () => Promise<unknown>;
  /** reload 回执格式化（formatReloadResult 单源——宿主注入防重复格式化） */
  readonly formatReload: (report: unknown) => string;
  /** 会话库文件路径活取（mem 页签 fs.stat 宾语——全仓首个 fs.stat-of-db-file 消费面） */
  readonly dbFilePath: () => string;
  /** 记忆库 DAO 活取（persist:false 缺席 = 记忆段与记忆动词诚实示/拒） */
  readonly memoryStore: () => MemoryStore | undefined;
  /** 记忆 owner 键集活取（memory 件 ownerKeys 同式：global + projectOwnerKey） */
  readonly memoryOwnerKeys: () => readonly string[];
  /** 工作区根活取（导出缺省路径锚 + ownerRoots 面——原始根，本件内 canonical 化） */
  readonly workspaceRoot: () => string;
  /** 可写根活取（导出写面判定；缺席 = 导出动词诚实拒——memory 件同律） */
  readonly writableRoots: () => readonly string[] | undefined;
  /** obs rollup.db 路径活取（mem 页签五表今日数——existsSync 守卫存在才开） */
  readonly obsDbPath: () => string;
  /** 时钟（缺省 Date.now——测试注入冻结） */
  readonly now?: () => number;
}

/* ---------------- 行投影纯函数（格式化面——导出供测试直测） ---------------- */

/** 字节数 → 人读串（MiB 一位小数；< 1 MiB 落 KiB） */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KiB`;
}

/** 概要截断（一行宽纪律——呈现行不撑爆终端；空白折叠） */
function clipText(text: string, max = 64): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

/** 舰队计数一行（六计数全量呈现——双舰队各一行不合并，spec 钉死） */
export function fleetLine(name: string, stats: FleetStats): string {
  return ` ${name}：spawned ${stats.spawned} · live ${stats.live} · crashed ${stats.crashed} · ooms ${stats.ooms} · 心跳冻结 ${stats.heartbeatFreezes} · terminated ${stats.terminated}`;
}

/** 浏览器引擎状态行（四态人读——EngineStatus.state 投影） */
export function browserLine(state: 'idle' | 'starting' | 'running' | 'closed'): string {
  const labels: Record<typeof state, string> = {
    idle: 'idle（未起——首次浏览器工具调用才 spawn）',
    starting: 'starting（spawn 后握手中）',
    running: 'running（引擎在跑）',
    closed: 'closed（已关停——闲置回收/回卷）',
  };
  return ` 浏览器引擎：${labels[state]}`;
}

/** Job 清单行（状态帽 + kind + label + id 截短——operator 全量视角） */
export function jobRowText(job: { id: string; kind: string; label?: string; status: string }): string {
  const label = job.label === undefined ? '' : ` ${clipText(job.label, 40)}`;
  return `[${job.status}] ${job.kind}${label}（${job.id.slice(0, 8)}）`;
}

/** tick 任务清单行（声明 + 下次触发人读串 + OS 注册态 + 生命周期位） */
export function tickRowText(row: SchedulerViewRow): string {
  const schedule = row.schedule ?? '仅手动';
  const os = row.osState === 'registered' ? 'OS 已注册' : row.osState === 'unregistered' ? 'OS 未注册' : 'OS 面‖';
  return `${row.name} — ${schedule} · 下次 ${row.nextRun} · ${os}${row.enabled ? '' : ' · 已停用'}${
    row.owner === null ? '' : ` · ${row.owner}`
  }`;
}

/** 记忆条目行（状态帽 + 摘要 + 冻结/终态徽标） */
export function memoryRowText(record: MemoryRecord): string {
  const flags = [...(record.frozen ? ['❄冻结'] : []), ...(record.status !== 'active' ? [record.status] : [])].join('');
  return `[${record.kind}] ${clipText(record.summary)}${flags === '' ? '' : ` 〔${flags}〕`}（${record.id.slice(0, 8)}）`;
}

/** 记忆计数行（四状态逐状态客户端计数——list(ownerKeys, status) 四取，spec A5） */
export function memoryCountLine(counts: Record<MemoryStatus, number>): string {
  return ` 记忆计数（本域 owner）：active ${counts.active} · dismissed ${counts.dismissed} · superseded ${counts.superseded} · expired ${counts.expired}`;
}

/** obs 今日数行（五表各取代表度量——llm/tool=calls · turn=turns · approval=asked · deprecation=uses） */
export function obsTodayLine(counts: {
  llm: number;
  tool: number;
  turn: number;
  approval: number;
  deprecation: number;
}): string {
  return ` obs 今日：llm 调用 ${counts.llm} · 工具 ${counts.tool} · 轮次 ${counts.turn} · 审批 ${counts.approval} · 废弃用法 ${counts.deprecation}`;
}

/* ---------------- 服务面构造 ---------------- */

/** 记忆条目呈现帽（刷屏护栏——全量走导出面） */
const MEMORY_LIST_CAP = 30;

/** 构造监视面（desktop-main 调用——闭包持 deps 全活取，零状态零订阅） */
export function createMonitorFace(deps: MonitorDeps): DesktopMonitorFace {
  const now = deps.now ?? Date.now;

  /** 今日零点（本地时制——obs 今日窗口起点） */
  const startOfToday = (): number => {
    const d = new Date(now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  /** obs 五表今日代表度量数（existsSync 守卫 + 开查关——apps-check 同款零副作用纪律） */
  const obsToday = ():
    { llm: number; tool: number; turn: number; approval: number; deprecation: number } | undefined => {
    const dbPath = deps.obsDbPath();
    if (!existsSync(dbPath)) return undefined;
    const store = openRollupStore(dbPath);
    try {
      const from = startOfToday();
      const to = Number.MAX_SAFE_INTEGER;
      // 每表代表度量（TABLE_META measures 计数面——非时长面）
      const ask = (metric: RollupTable, measure: string): number =>
        store
          .query({ metric, fromMs: from, toMs: to, groupBy: [] })
          .reduce((acc, row) => acc + (row.measures[measure] ?? 0), 0);
      return {
        llm: ask('llm', 'calls'),
        tool: ask('tool', 'calls'),
        turn: ask('turn', 'turns'),
        approval: ask('approval', 'asked'),
        deprecation: ask('deprecation', 'uses'),
      };
    } finally {
      store.close(); // 开查关——只读窗口不留连接
    }
  };

  /** 记忆段行组（计数行 + 条目行；store 缺席 = 单行诚实示） */
  const memoryRows = (): { counts: Record<MemoryStatus, number> | undefined; rows: readonly MonitorRow[] } => {
    const store = deps.memoryStore();
    if (store === undefined)
      return { counts: undefined, rows: [{ text: ' 记忆库不在场（persist:false）——记忆动词不可用' }] };
    const ownerKeys = [...deps.memoryOwnerKeys()];
    if (ownerKeys.length === 0) return { counts: undefined, rows: [{ text: ' 记忆 owner 键集为空——无计数可读' }] };
    // 逐状态取数（零新 DAO 方法——spec A5）：active 走可见谓词，终态裸 status 段
    const byStatus = new Map<MemoryStatus, readonly MemoryRecord[]>();
    for (const status of ['active', 'dismissed', 'superseded', 'expired'] as const) {
      byStatus.set(status, store.list(ownerKeys, status, now()));
    }
    const counts: Record<MemoryStatus, number> = {
      active: byStatus.get('active')!.length,
      dismissed: byStatus.get('dismissed')!.length,
      superseded: byStatus.get('superseded')!.length,
      expired: byStatus.get('expired')!.length,
    };
    // 条目行：active 在前、终态随后（v 恢复的宾语），帽 30 行防刷屏（全量走导出）
    const records = [
      ...byStatus.get('active')!,
      ...byStatus.get('dismissed')!,
      ...byStatus.get('superseded')!,
      ...byStatus.get('expired')!,
    ];
    const shown = records.slice(0, MEMORY_LIST_CAP);
    const rows: MonitorRow[] = [
      { text: memoryCountLine(counts) },
      ...(shown.length === 0
        ? [{ text: ' （无记忆条目）' }]
        : shown.map((record) => ({
            text: memoryRowText(record),
            item: { kind: 'memory' as const, key: record.id, label: clipText(record.summary) },
          }))),
      ...(records.length > MEMORY_LIST_CAP
        ? [{ text: ` （仅示前 ${MEMORY_LIST_CAP} 条 / 共 ${records.length} 条——全量经 e 导出）` }]
        : []),
    ];
    return { counts, rows };
  };

  /** 记忆库单条读取守卫（动词共用——缺席/无行统一拒因） */
  const memoryRecordFor = (id: string): { store: MemoryStore; record: MemoryRecord } | { error: string } => {
    const store = deps.memoryStore();
    if (store === undefined) return { error: '记忆库不在场（persist:false）——记忆动词不可用' };
    const record = store.get(id);
    if (record === undefined) return { error: `记忆条目不存在（${id.slice(0, 8)}）——可能已被整理` };
    return { store, record };
  };

  const face: DesktopMonitorFace = {
    async panel(tab) {
      if (tab === 'proc') {
        const fleet = deps.fleetStats();
        // browser 状态活取（getter 可能返 undefined = 行未装配/被禁用——诚实示）
        const browserState = deps.browserStatus();
        const rows: MonitorRow[] = [
          { text: '── 舰队统计（worker/external 双载体行）──' },
          { text: fleetLine('ring1 舰队', fleet.ring1) },
          { text: fleetLine('app 舰队', fleet.apps) },
          { text: '── 引擎 ──' },
          ...(browserState === undefined
            ? [{ text: ' 浏览器引擎：行未装配（browser 件缺席/被禁用）' } as MonitorRow]
            : [{ text: browserLine(browserState.state) }]),
        ];
        const jobs = deps.jobs();
        if (jobs === undefined) {
          rows.push({ text: '── 后台 Job ──' }, { text: ' Job 服务不在场（subagent 件缺席）' });
        } else {
          const list = jobs.list();
          const live = list.filter((job) => job.status === 'running' || job.status === 'stopping').length;
          rows.push({ text: `── 后台 Job（活 ${live} / 总 ${list.length}，终态帽 256）──` });
          rows.push(
            ...list.map((job) => ({
              text: jobRowText(job),
              item: { kind: 'job' as const, key: job.id, label: job.label ?? job.kind },
            })),
          );
          if (list.length === 0) rows.push({ text: ' （无 Job——后台任务清单空）' });
        }
        return { title: 'Berry 桌面 — 管理器 · 进程', rows };
      }
      if (tab === 'jobs') {
        const view = deps.schedulerView();
        if (view === undefined) {
          return {
            title: 'Berry 桌面 — 管理器 · 任务',
            rows: [{ text: ' scheduler-view 未装载（persist:false / 重装窗）——/tick 命令面仍可用' }],
          };
        }
        const list = await view.list();
        return {
          title: 'Berry 桌面 — 管理器 · 任务',
          rows:
            list.length === 0
              ? [{ text: ' （无任务——/tick add <名> [声明] <提示词…> 新增）' }]
              : list.map((row) => ({
                  text: tickRowText(row),
                  item: { kind: 'tick' as const, key: row.name, label: row.name },
                })),
        };
      }
      // mem 页签：容量仪表 + 库文件体积 + 记忆段 + obs 今日数
      const mem = memoryUsage();
      const rows: MonitorRow[] = [
        { text: ` 进程内存：RSS ${formatBytes(mem.rss)} · heapUsed ${formatBytes(mem.heapUsed)}` },
      ];
      // fs.stat-of-db-file（全仓首个消费面——spec 冷读勘 A6 精确表述）
      try {
        const stat = await fsp.stat(deps.dbFilePath());
        rows.push({ text: ` 会话库文件：${formatBytes(stat.size)}（${deps.dbFilePath()}）` });
      } catch (err) {
        rows.push({ text: ` 会话库文件：读取失败（${err instanceof Error ? err.message : String(err)}）` });
      }
      rows.push({ text: '── 记忆 ──' }, ...memoryRows().rows);
      rows.push({ text: '── obs ──' });
      const today = obsToday();
      rows.push(
        today === undefined ? { text: ' 今日数：（obs 未启用——rollup.db 不存在）' } : { text: obsTodayLine(today) },
      );
      return { title: 'Berry 桌面 — 管理器 · 内存', rows };
    },

    async cancelJob(id) {
      const jobs = deps.jobs();
      if (jobs === undefined) return 'Job 服务不在场（subagent 件缺席）——取消不可用';
      jobs.cancel(id); // 不带 as = operator 直控（spec：围栏语义）
      return `已请求取消 Job ${id.slice(0, 8)}（请求非结算——终态由 executor 落）`;
    },

    async reloadAll() {
      const report = await deps.reload();
      return { title: '全量 reload 完成', lines: [deps.formatReload(report)] };
    },

    async tick(verb, name) {
      const view = deps.schedulerView();
      if (view === undefined) return 'scheduler-view 未装载（persist:false / 重装窗）——/tick 命令面仍可用';
      const receipt = await view.dispatch(`${verb} ${name}`);
      // 回执行收集（捕获 ui 相位法产物）——空行滤净落回执视图
      return { title: `tick ${verb} ${name}`, lines: receipt.split('\n').filter((line) => line.trim() !== '') };
    },

    async memoryToggleFrozen(id) {
      const found = memoryRecordFor(id);
      if ('error' in found) return found.error;
      const next = !found.record.frozen;
      const ok = found.store.setFrozen(id, next, now());
      if (!ok) return `翻转失败：条目不存在（${id.slice(0, 8)}）`;
      return next
        ? `已冻结 ${id.slice(0, 8)}（❄ 恒简报/免 TTL/免覆写——解冻-再忘是唯一路径）`
        : `已解冻 ${id.slice(0, 8)}（TTL 钟按策略重算）`;
    },

    async memoryForget(id) {
      const store = deps.memoryStore();
      if (store === undefined) return '记忆库不在场（persist:false）——记忆动词不可用';
      const outcome = store.forget(id, 'user', now()); // 用户终审手权最大（§8.4——桌面腿恒 user）
      switch (outcome) {
        case 'ok':
          return `已忘掉 ${id.slice(0, 8)}（软删——v 可恢复；版本链与访问流水留档）`;
        case 'missing':
          return `记忆条目不存在（${id.slice(0, 8)}）`;
        case 'frozen':
          return `条目冻结中（${id.slice(0, 8)}）——冻结免覆写，解冻（f）后再忘`;
        case 'dismissed':
          return `条目已是忘掉态（${id.slice(0, 8)}）——幂等未执行`;
      }
    },

    async memoryRestore(id) {
      const store = deps.memoryStore();
      if (store === undefined) return '记忆库不在场（persist:false）——记忆动词不可用';
      const outcome = store.restore(id, now()); // 一期无 revision——最新态复活（spec 冷读裁决 C7）
      return outcome.restored
        ? `已恢复 ${id.slice(0, 8)}（active——TTL 钟按策略重算）`
        : `恢复失败：条目不存在（${id.slice(0, 8)}）`;
    },

    async memoryExport() {
      const store = deps.memoryStore();
      if (store === undefined) return '记忆库不在场（persist:false）——导出不可用';
      const roots = deps.writableRoots();
      if (roots === undefined) return '可写根未注入——导出不可用（/memory-export 同律）';
      // 缺省路径与 /memory-export 同式：工作区根 + 时间戳防误覆盖
      const canonical = canonicalWorkspaceRoot(deps.workspaceRoot());
      const target = join(canonical, `memory-export-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.jsonl`);
      if (!isPathInsideRoots(target, roots)) {
        return `拒写：目标不在可写根内（${target}）——导出只写可写根内的路径。`;
      }
      const text = exportMemoryText(store, undefined, [canonical]);
      await writeExportFile(target, text);
      const count = text.split('\n').filter((line) => line.trim() !== '').length - 1; // 减 header
      return {
        title: `已导出 ${count} 条（全状态）`,
        lines: [`  ${target}`, '  ⚠ 明文 JSON——含全部记忆内容与已软删/过期行，注意文件去向。'],
      };
    },
  };
  return face;
}

/** 直达参数解析（'/monitor proc' 尾参——非法值 undefined 由壳诚实拒） */
export function parseMonitorTabArg(arg: string): MonitorTab | undefined {
  return arg === 'proc' || arg === 'jobs' || arg === 'mem' ? arg : undefined;
}
