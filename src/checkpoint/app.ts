/**
 * L3 checkpoint — 官方快照·回退件（会话篇 §5.3，2026-08-30 纵切落码；
 * 内核边界篇席 23 / 契约篇 §5.1 默认层第十一行——Ring 2 真·可卸）。
 *
 * 给「动手改工作区」的会话一张安全网：每个动手 run 起点拍工作区快照
 * （tools_pre_execute 应用行注册序末位——安全守门行 prepend 占首位断链，
 * **放行才捕获**），操作者 /rewind 把文件与会话一起退回任一起点。
 *
 * 编舞三段：
 *   ① 捕获监听（tools_pre_execute 末位监听；判据 = 工具声明 effect !== 'read'
 *      ——未声明视为变更，安全网宁多拍 fail-closed）——per-session 去重旗
 *      （Map 分账，键 = 会话身份判据；RunSettled 复位）；
 *   ② 旗复位（注册表会话自己的旗 + 捕获时记父键的子代理旗一并复位）；
 *   ③ /rewind 命令（guard 捕获 → 文件恢复 files-first → fork+adopt 两段事务）。
 *
 * 会话身份判据（§5.3 触发条，冷读 CR-2）：`chainSessionId() ?? routed()`——
 * ALS 调用链是真相源（子代理 run 不在驱动注册表内，routed() 单独用会错账到
 * 前台）。子代理捕获：manifest 照记（键 = 子会话 id，安全网覆盖委派路径——
 * 委派工具若声明 read，父 run 不拍，子会话的捕获即是唯一安全网）；durable
 * 审计事件免落——appendEvent 无目标会话参数是 S1 路由纪律刻意形态（§5.2
 * 「不为 fork 破例」同判），routed() 对非注册表子会话回落前台，落账即错投父账。
 *
 * 'sessions' 恒供走硬 inject；'paths'/'agent'/'channels'/'ui' 走 optionalInject
 * （诊断装配缺供降级：无 paths 无数据域即停用；无 agent 无 run 无捕获旗无从
 * 生长；无 channels/ui 仅无命令面——监听器照常）。
 */

import { Type } from '../contracts/typebox.js';
import { TOOL_PRE_EXECUTE_EVENT } from '../contracts/tools.js';
import type { GateInput } from '../contracts/tools.js';
import type { SessionEvent } from '../contracts/events.js';
import type { BuiltinAppModule, AppContext } from '../contracts/app.js';
import type { Disposer } from '../context/types.js';
import { chainSessionId } from '../context/index.js';
// 词汇宿主面注册的模块副作用导入（官方件纪律：durable 词汇可读性不随组合树
// 行装载漂移——件可禁用，曾回退过的会话日志必须永远可读）
import './events.js';
import { ensureLayout, listAllManifests, listSessionManifests, type CheckpointManifest } from './store.js';
import { captureSnapshot, executePrune, prunePlan, type CaptureContext } from './snapshot.js';
import { restoreWorkspace } from './restore.js';

/* ---------------------------------------------------------------------------------- */
/* 服务最小面（结构类型窄化——checkpoint 模块不 import app/chat 实现，拓扑边不越界）。  */
/* ---------------------------------------------------------------------------------- */

/** ctx.sessions 窄面（本件消费：审计落账 + 事件读 + fork/adopt/isBusy + 边界探针） */
interface SessionsCheckpointFace {
  appendEvent(type: string, data: unknown): SessionEvent | undefined;
  eventsOfType(type: string): SessionEvent[];
  currentSessionId(): string | undefined;
  fork(boundary?: number): Promise<string | undefined>;
  adopt(sessionId: string): boolean;
  isBusy(sessionId?: string): boolean;
  /** 路由会话的最后闭合 turn 边界（宿主单源计算——forkSeq 唯一取值口，见 sessionMeta） */
  lastClosedBoundary(): number | undefined;
}

/** ctx.agent 窄面（本件消费：RunSettled 旗复位） */
interface AgentCheckpointFace {
  onRunSettled(cb: (settled: { readonly sessionId: string }) => void): Disposer;
}

/** ctx.paths 窄面（本件消费：件数据根 + canonical 工作区根——禁 env 猜 cwd） */
interface PathsCheckpointFace {
  appDataDir(id: string): string;
  workspaceRoot(): string;
}

/** 命令注册面（channels 服务最小面——goal 件同款局部窄面） */
interface ChannelsCommandFace {
  registerCommand(cmd: {
    readonly name: string;
    readonly description: string;
    readonly source?: string;
    handler(args: string): void | Promise<void>;
  }): Disposer;
}

/** ui 通知面（命令回执的唯一出口——/rewind 人读结果） */
interface UiNotifyFace {
  notify(message: string): void;
}

/** 件配置面（行 config——typebox 启动校验；缺省值件内解析填充） */
export const checkpointConfig = Type.Object({
  /** 每会话快照上限（oldest-first 裁剪） */
  maxSnapshots: Type.Optional(Type.Number({ minimum: 1, maximum: 10_000 })),
  /** 全局 blob 软帽（字节——跨会话 oldest-first；下界 = 在册会话最新一条） */
  maxTotalBytes: Type.Optional(Type.Number({ minimum: 1024 * 1024 })),
  /** 排除 glob（工作区遍历——PRUNE 硬表 node_modules/.git 之上叠加；缺省 = DEFAULT_EXCLUDE） */
  exclude: Type.Optional(Type.Array(Type.String())),
});

/**
 * exclude 缺省清单（基建大扫 #39 拍板，会话篇 §5.3）：目录剪枝 + 秘密文件族。
 * 工作区里的环境变量文件 / SSH 私钥 / 证书密钥永不进 blob 仓与 manifest——
 * 快照面是「代码态」安全网，不是秘密备份位；operator 要显式放开某秘密，
 * 在行 config exclude 追加否定 glob（如 `!.env`）——gitignore 语义后规则覆盖
 * 前规则，字面放开不联动变体（.env 放开 ≠ .env.local 放开）。
 */
export const DEFAULT_EXCLUDE: readonly string[] = [
  'node_modules/', // 目录剪枝（原缺省保留——装机物体量毁快照面）
  '.git/', // 目录剪枝（同上——git 对象）
  '.env', // 环境变量文件（dotenv 缺省名——凭证最常见宿主）
  '.env.*', // 变体族（.env.local / .env.production 等）
  '*.pem', // 证书 / 私钥（PEM 面）
  '*.key', // 密钥文件
  'id_rsa*', // SSH 私钥族（id_rsa / id_rsa-cert 等）
  'id_ed25519*', // SSH ed25519 私钥族
  'id_ecdsa*', // SSH ecdsa 私钥族
  '*.p12', // PKCS#12 证书包
  '*.pfx', // PKCS#12 变体名
];

/** 已解析配置（缺省值填充后的形状——件内统一经此读） */
interface ResolvedConfig {
  readonly maxSnapshots: number;
  readonly maxTotalBytes: number;
  readonly exclude: readonly string[];
}

/** 官方件构造依赖（装配期闭包注入——官方件 = 宿主装配特权） */
export interface CheckpointAppDeps {
  /**
   * 驱动注册表在册（未退役）会话活集合（prune 下界判据，冷读 CR-8——大仓小帽
   * 不得自剪成「无快照」；子代理等不可达会话不享下界）。组合根闭包注入（晚绑
   * ——registry 装配序晚于本构造，运行期才调用）。
   */
  readonly activeSessions: () => ReadonlySet<string>;
}

/** 从 user/message content 提取纯文本（string 直取；blocks 拼 text 块——compaction 同款） */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : '',
      )
      .join('');
  }
  return '';
}

/** 字节数人读化（回执展示） */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/** 毫秒时间戳 → HH:MM:SS（ISO 切片——确定性，不随 locale 漂） */
function clockOf(time: number): string {
  return new Date(time).toISOString().slice(11, 19);
}

/**
 * 构造 checkpoint 官方件（builtins 注册）。
 */
export function createCheckpointApp(deps: CheckpointAppDeps): BuiltinAppModule {
  const module: BuiltinAppModule = {
    name: 'checkpoint',
    inject: ['sessions'] as const,
    optionalInject: ['paths', 'agent', 'channels', 'ui'] as const,
    config: checkpointConfig,

    apply: async (ctx: AppContext) => {
      const paths = ctx.tryGet<PathsCheckpointFace>('paths');
      if (paths === undefined) {
        // paths 服务缺供（诊断装配）——无数据域无捕获面，件停用（行装载成功语义诚实）
        ctx.logger.warn('无 ctx.paths 服务（诊断装配）——checkpoint 官方件停用：无件数据域');
        return;
      }
      const sessions = ctx.get<SessionsCheckpointFace>('sessions');

      // 数据域就位（blobs/ + manifests/ 骨架幂等建）——行 id 正规获取口（AppContext.rowId）
      const dataRoot = paths.appDataDir(ctx.rowId ?? 'checkpoint');
      await ensureLayout(dataRoot);

      const cfgRaw = ctx.config;
      const cfg: ResolvedConfig = {
        maxSnapshots: (cfgRaw.maxSnapshots as number) ?? 50,
        maxTotalBytes: (cfgRaw.maxTotalBytes as number) ?? 512 * 1024 * 1024,
        exclude: (cfgRaw.exclude as string[] | undefined) ?? DEFAULT_EXCLUDE,
      };

      /**
       * per-run 已捕获旗：键 = 会话身份判据；值 = 父会话 id（null = 注册表会话，
       * 自己的 RunSettled 复位；非 null = 子代理捕获，随父 run RunSettled 一并
       * 复位——子代理 run 无独立 RunSettled，§5.3 触发条）。
       */
      const captured = new Map<string, string | null>();
      /** 在飞捕获 promise（同会话并发调用共享同一份安全网——§5.3 触发条） */
      const inflight = new Map<string, Promise<void>>();

      const captureCx = (): CaptureContext => ({
        dataRoot,
        workspaceRoot: paths.workspaceRoot(),
        exclude: cfg.exclude,
      });

      /**
       * 算回退边界与触发指令文本（注册表会话路——经 routed() 读会话事件日志）。
       * forkSeq = 捕获时 lastClosedTurnBoundary（宿主面单源探针——物理全日志的
       * 闭合前缀长度）：回退到「当前敞开 turn 之前的最后闭合边界——新会话尾部
       * 干净 idle」。件内不得从 eventsOfType 过滤数组自拼位置（词级数组下标与
       * 全日志位置恒错位——修前 /rewind fork 恒抛边界落在敞开 turn 内的病根）。
       */
      const sessionMeta = (): { forkSeq: number; triggerText: string | null } => {
        // 无路由落点（理论上 isRegistrySession 已排除；?? 0 = 空前缀，fork 语义最保守）
        const forkSeq = sessions.lastClosedBoundary() ?? 0;
        const users = sessions.eventsOfType('user/message');
        const last = users.at(-1);
        const text = last !== undefined ? extractText((last.data as { content?: unknown }).content) : '';
        // 回执原文截 120 字（manifest 轻量；清单展示再截 40）
        return { forkSeq, triggerText: text !== '' ? text.slice(0, 120) : null };
      };

      /**
       * 拍一次快照 + 审计落账 + 顺手裁剪（guard 路 = /rewind 前置防误退捕获）。
       * 审计事件只在注册表会话路落（isRegistrySession）——子代理捕获 manifest
       * 照记、事件免落（appendEvent 无目标会话参数，routed() 回落前台即错投）。
       */
      const doCapture = async (sessionId: string, triggerTool: string, guard: boolean): Promise<CheckpointManifest> => {
        const routedId = sessions.currentSessionId();
        const isRegistrySession = sessionId === routedId;
        const meta = isRegistrySession ? sessionMeta() : { forkSeq: null, triggerText: null };
        const manifest = await captureSnapshot(captureCx(), {
          sessionId,
          triggerTool,
          guard,
          forkSeq: meta.forkSeq,
          triggerText: meta.triggerText,
        });
        if (isRegistrySession) {
          // 审计账（log-only；64KiB 纪律——data 不含路径清单，只载规模四件）
          sessions.appendEvent('checkpoint/snapshot', {
            id: manifest.id,
            triggerTool,
            files: manifest.files.length,
            bytes: manifest.newBytes,
            guard,
          });
        }
        // 顺手裁剪（单入口不设第二触发点——捕获后即裁；失败 warn 下次重试）。
        // 清单视图携带损坏账（复盘 E-1）：损坏文件非空即本轮清孤保护跳过
        //（解析失败 ≠ 可删）；损坏面在读侧 warn 点名（logger 传入）
        try {
          const inventory = await listAllManifests(dataRoot, ctx.logger);
          await executePrune(dataRoot, inventory, prunePlan(inventory.manifests, cfg, deps.activeSessions()));
        } catch (err) {
          ctx.logger.warn('checkpoint 裁剪失败（下次捕获重试）', { error: String(err) });
        }
        return manifest;
      };

      /* ---- ① 捕获监听（tools_pre_execute 应用行注册序末位——无 prepend，位序是行序涌现，§5.3 CR-9） ---- */
      ctx.effect(() =>
        ctx.on(TOOL_PRE_EXECUTE_EVENT, async (input: GateInput, next: () => unknown) => {
          try {
            // 身份判据：ALS 链是真相源；无链回落路由；两者皆无 = 无会话语境不拍
            const chained = chainSessionId();
            const routedId = sessions.currentSessionId();
            const identity = chained ?? routedId;
            if (identity === undefined) return next();
            // 判据 effect !== 'read'（未声明 undefined = 变更——安全网宁多拍 fail-closed）
            if (input.tool.effect === 'read') return next();
            if (captured.has(identity)) {
              // 本 run 已捕获：在飞则共享同一 promise；已落则直接放行
              const p = inflight.get(identity);
              if (p !== undefined) await p.catch(() => {}); // 失败已由首调用方记日志
              return next();
            }
            // 父会话键：子代理捕获（链身份 ≠ 路由身份）记路由前台 id（旗随父复位）
            const parentSessionId = chained !== undefined && chained !== routedId ? (routedId ?? null) : null;
            // 旗先置（同步段）——同 run 后续变更免重；捕获失败不重试（每 run 一次尝试，成本有界）
            captured.set(identity, parentSessionId);
            const p = (async () => {
              await doCapture(identity, input.tool.name, false);
            })()
              .catch((err) => {
                // contained：安全网不是策略，绝不挡工具——本 run 安全网缺位如实记日志
                ctx.logger.error('checkpoint 捕获失败（contained——照常放行）', {
                  sessionId: identity,
                  tool: input.tool.name,
                  error: String(err),
                });
              })
              .finally(() => {
                inflight.delete(identity);
              });
            inflight.set(identity, p);
            await p; // pre-mutation 语义：捕获完成才放行工具
          } catch (err) {
            // 外层兜底（内层已尽）：监听器绝不因自身异常挡工具
            ctx.logger.error('checkpoint 监听器异常（contained）', { error: String(err) });
          }
          return next(); // 监听器纪律：绝不返回自有值（误返 block 形即挡工具）
        }),
      );

      /* ---- ② 旗复位：RunSettled 按会话路由（自己的旗 + 父键匹配的子代理旗） ---- */
      const agent = ctx.tryGet<AgentCheckpointFace>('agent');
      if (agent !== undefined) {
        ctx.effect(() =>
          agent.onRunSettled((settled) => {
            captured.delete(settled.sessionId); // 注册表会话自己的旗
            // 子代理旗：捕获时记的父会话键在此一并复位（§5.3——子 run 无独立 RunSettled）
            for (const [sid, parent] of captured) {
              if (parent === settled.sessionId) captured.delete(sid);
            }
          }),
        );
      }
      // agent 缺供（chat 件未装载/诊断装配）：无 run 即无捕获，旗无从生长——静默
      //（件核心 = 监听器，不依赖 agent；与 compaction 的 warn 停用不同判）

      /* ---- ③ /rewind 命令（操作者命令——模型面 v1 不开放，§5.3 诚实边界④） ---- */
      const channels = ctx.tryGet<ChannelsCommandFace>('channels');
      const ui = ctx.tryGet<UiNotifyFace>('ui');
      if (channels === undefined || ui === undefined) {
        // 无命令面宿主（headless run / 诊断装配）：监听器照常——文件面安全网
        // 不依赖 UI；仅操作者命令缺席（与 memory 件文件命令面同判）
        return;
      }
      // 回执出口绑定为非空常量（闭包窄化稳定——TS 流分析不进 handler 函数体）
      const notify = ui.notify.bind(ui);

      /** 渲染快照清单（新→旧；guard 快照带 ◆ 标——回退到 guard 即撤销上次回退） */
      const renderList = (list: readonly CheckpointManifest[], sessionId: string): string => {
        if (list.length === 0) {
          return `会话 ${sessionId.slice(0, 8)}… 还没有快照——首个变更类工具调用会自动拍快照（本会话 run 内首个非 read 工具）。`;
        }
        const lines = list.map((m, i) => {
          const guardMark = m.guard ? '◆guard ' : '';
          const trigger = m.triggerText !== null ? ` · 回退到「${m.triggerText.slice(0, 40)}」之前` : '';
          return `  ${i + 1}. ${m.id} ${guardMark}${clockOf(m.time)} · ${m.files.length} 文件 · ${humanBytes(m.totalBytes)} · 触发 ${m.triggerTool}${trigger}`;
        });
        return [
          `快照清单（会话 ${sessionId.slice(0, 8)}…，新 → 旧）：`,
          ...lines,
          '/rewind <序号|id前缀|latest> 回退；guard（◆）= /rewind 前的防误退快照。',
        ].join('\n');
      };

      /** 寻址三形解析：返回目标 manifest 或失败文案（string） */
      const resolveTarget = (args: string, list: readonly CheckpointManifest[]): CheckpointManifest | string => {
        if (list.length === 0) return '本会话还没有快照可回退。';
        if (args === 'latest') return list[0]!;
        if (/^\d+$/.test(args)) {
          const target = list[Number(args) - 1];
          return target ?? `序号 ${args} 超出范围（共 ${list.length} 条）。`;
        }
        const q = args.startsWith('cp-') ? args : `cp-${args}`;
        const matches = list.filter((m) => m.id.startsWith(q));
        if (matches.length === 0) return `没有匹配 ${q} 的快照。`;
        if (matches.length > 1) return `${q} 前缀匹配 ${matches.length} 条——用更长的前缀或序号。`;
        return matches[0]!;
      };

      /** /rewind 处理器（两段事务 files first——§5.3 回退条） */
      const handleRewind = async (args: string): Promise<void> => {
        const focusedId = sessions.currentSessionId();
        if (focusedId === undefined) {
          notify('当前无前台会话——/rewind 需要会话上下文。');
          return;
        }
        // /rewind 清单读取带 logger（复盘 E-1）：损坏 manifest 在此点名 warn——
        // 快照从清单静默消失必须有痕（操作者据此人工处置）
        const list = await listSessionManifests(dataRoot, focusedId, ctx.logger);
        if (args === '') {
          notify(renderList(list, focusedId));
          return;
        }
        const resolved = resolveTarget(args, list);
        if (typeof resolved === 'string') {
          notify(resolved);
          return;
        }
        const target = resolved;
        // 前置拒：目标会话 run 在跑（isBusy 只查目标会话——同工作区兄弟会话不设
        // 互斥是 §5.3 诚实边界⑥，恢复可能与兄弟写入交错）
        if (sessions.isBusy(focusedId)) {
          notify('当前会话 run 在跑——/rewind 被拒（文件恢复不得在跑动的 agent 脚下进行）；等 run 结束后再试。');
          return;
        }
        // ① guard 捕获（防误退——回退本身可回退；失败即中止：不可撤销的回退不做）
        let guardManifest: CheckpointManifest | undefined;
        try {
          guardManifest = await doCapture(focusedId, '/rewind', true);
        } catch (err) {
          notify(`guard 快照拍摄失败：${String(err)}——已中止（回退前必须有可撤销点）。`);
          return;
        }
        // 前置拒第二段（2026-09-01 遗漏大扫 20260901-c #5，§5.3 两段收口）：
        // isBusy 是纯读探针非锁非预留，guard 快照（全工作区 walk）秒级窗口内
        // 同会话 run 可经 webui /submit 启动——guard 完成后、恢复开始前二次
        // 复验，run 已启动即中止（guard 快照保留可重试；残余微窗由 restore
        // 写段入写串行链收口——restore.ts 头注）
        if (sessions.isBusy(focusedId)) {
          notify(
            'guard 快照期间会话 run 已启动——已中止回退（guard 快照保留，可重试；文件恢复不得在跑动的 agent 脚下进行）。',
          );
          return;
        }
        // ② 文件恢复（失败不 fork、快照保留——§5.3 失败语义）
        let report;
        try {
          report = await restoreWorkspace(paths.workspaceRoot(), dataRoot, target);
        } catch (err) {
          notify(`文件恢复失败：${String(err)}——未回退（快照保留，可重试）。`);
          return;
        }
        // ③ 会话回退：fork（边界 = 目标快照捕获时的闭合边界）+ adopt 切前台
        if (target.forkSeq === null) {
          notify('目标快照无会话边界（不可回退）——文件已恢复，会话时间线未动。');
          return;
        }
        let newId: string | undefined;
        try {
          newId = await sessions.fork(target.forkSeq);
        } catch (err) {
          notify(
            `会话 fork 失败：${String(err)}——文件已恢复（半事务是诚实态：工作区已退回、会话时间线未退；快照仍在，可重试）。`,
          );
          return;
        }
        if (newId === undefined) {
          notify(
            '会话 fork 失败（无持久层？）——文件已恢复（半事务是诚实态：工作区已退回、会话时间线未退；快照仍在，可重试）。',
          );
          return;
        }
        // 旧会话时间线留一行（adopt 前路由仍指旧会话——此后 routed() 切新会话；
        // surface 词不进 deriveMessages 折叠、UI 转录行 only——模型不可见）
        sessions.appendEvent('checkpoint/rewind', {
          id: target.id,
          newSessionId: newId,
          files: target.files.length,
        });
        const adopted = sessions.adopt(newId);
        const leftovers =
          report.leftovers.length > 0
            ? `\n快照后新建未删 ${report.leftovers.length} 个文件（无删除铁律——如不需要请手删）。`
            : '';
        notify(
          `已回退至 ${target.id}（${clockOf(target.time)}）——新会话 ${newId.slice(0, 8)}…，${report.restored} 个文件已恢复；` +
            `guard 快照 ${guardManifest.id} 已拍（撤销本次回退：/app 切回本会话后 /rewind ${guardManifest.id}）。` +
            `原指令：${target.triggerText ?? '（无记录）'}${leftovers}` +
            (adopted ? '' : '\n注意：新会话收养失败（无注册面？）——会话已 fork 但未切前台。'),
        );
      };

      ctx.effect(() =>
        channels.registerCommand({
          name: 'rewind',
          description:
            '工作区快照回退：/rewind 列本会话快照清单；/rewind <序号|id前缀|latest> 把文件与会话一起退回该快照（guard 防误退自动拍）',
          source: 'app',
          handler: (args) => handleRewind(args.trim()),
        }),
      );
    },
  };

  return module;
}
