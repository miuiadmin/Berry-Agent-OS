/**
 * L5 app — `berry run --tick <name>` 到点编排入口（headless：OS 调度器〔K2-d
 * launchd/crontab 注册〕唤起的形态——本进程就是被调起的那个进程，跑在本地
 * 不再 spawn；/tick run 手动路走 scheduler 件 spawn 子进程，两路同闸同账）。
 *
 * 编排序（内核边界篇 §4.1 席 13 第二刀拍板①④ + 复盘 C-2 双开预闸）：
 *   boot 前预读任务行 → due 判定（未到/已终/迟到超窗——不烧钱即退）→
 *   双开预闸（busy/held——零写入不变式，让路不整机装配）→
 *   DiscoveryGates 统一闸（复验）→ reserveRun 原子抢占 → in-process 跑一轮 →
 *   last_session_id 归属回写 → 落盘关停。
 *
 * 投递二值（拍板①）由 jobs.session_id 列分叉：
 * - 列空 = 子进程单发：boot 新会话跑一轮，无归属声明（本进程即那发）；
 * - 列非空 = 会话投递：预读出的目标 id 注入 boot resumeSession 直达目标
 *   会话开轮（预读的动机：boot 缺省会另开一个空会话再弃——先读行才知道
 *   往哪续，365 天日更任务不造 365 个空会话行）。
 *
 * 退出码：任务不存在/行坏 2 / 未到点·已跑完·迟到超窗·让路（闸拒/抢占败）0 /
 * 跑失败·目标会话不存在·对话件未装载 1 / 正常 0。让路不是错——OS 钟下一跳
 * 自然再来，退出码 0 是「本轮无动作」的诚实陈述。
 */

import { openStore, openTurnDepth } from '../persist/index.js';
import type { Store } from '../persist/index.js';
import type { LlmService } from '../llm/index.js';
import { JobsStore, parseSchedule, evaluateDue, discoveryGates, GOAL_JOB_OWNER } from '../scheduler/index.js';
import type { JobRecord } from '../scheduler/index.js';
import { GoalStore, newWakeId, wakeGate, renderContinuationPrompt, wakeToolFilter } from '../goal/index.js';
import type { ToolsService } from '../contracts/tools.js';
import type { RunResult } from '../agent/loop.js';
import type { AssistantMessage } from '../contracts/llm.js';
import { createRuntime } from './assembly.js';
import type { RuntimeOptions } from './assembly.js';
import { collectBuiltinMigrations } from './builtins.js';
import { dbPath } from './paths.js';
import { installExitSignals } from './signals.js';
import { isDaemonAlive, readDaemonState } from './daemon-state.js';

/** 取 run 内最后一条 assistant 消息的文本（text 块拼接；无则 undefined——run-main 同款） */
function lastAssistantText(result: RunResult): string | undefined {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const message = result.messages[i]!;
    if (message.role === 'assistant') {
      const text = (message as AssistantMessage).content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      return text || undefined;
    }
  }
  return undefined;
}

/**
 * sessions 服务最小面（goal 挂钟分支消费——结构子集，宿主服务天然满足）：
 * appendEvent 记因（goal/evidence）+ eventsOfType 读投影（user/message——
 * 唤醒帽 durable 扫描源）。tickMain 顶层无调用链 → routed() 回退聚焦条目
 * = boot resume 的目标会话——读写天然锚定归属会话。
 */
interface TickSessionsFace {
  appendEvent(type: string, data: unknown): void; // 返回值消费面忽略——void 形（真服务任意返回可赋)
  eventsOfType(type: string): readonly { readonly time: number; readonly data: unknown }[];
}

/**
 * 同库短连接执行轻事务（boot 前情报面——库路径与 boot 同源）。
 *
 * 三个调用站点：① 预读任务行（missing 快败 + 会话投递路的 boot 前情报——
 * resumeSession 是 boot 选项，开完再改就晚了）；② missed 记因（写一列就走，
 * 不值得整机装配）；③ 双开预闸读 turnDepth（复盘 C-2——busy 判据前置到
 * 整机装配之前，让路路径零装配零写入）。迁移链与装配同源
 * （collectBuiltinMigrations）——短连接若带短链，开新库即撞
 * 「user_version 高于宿主已知」闸。
 * @param options 组合根选项（取 dbPath——与真 boot 同库）
 * @param fn 在短连接 Store 上执行的操作（返回值原样透传）
 */
function withShortStore<T>(options: RuntimeOptions, fn: (store: Store) => T): T {
  // 库路径与 boot 同源（dbPath() 缺省；:memory: 时读到的是自己的空库——
  // 任务必不存在，与「无库无任务」同语义）
  const store = openStore({ path: options.dbPath ?? dbPath(), migrations: collectBuiltinMigrations() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/**
 * tick 到点主流程。
 * @param jobName 任务名（/tick add 登记；名即身份）
 * @param options 组合根选项透传（测试注入 streamFn/dbPath 用；CLI 旗标已
 *   显式传的 sandboxMode/usagePriority 优先于本入口缺省）
 * @returns 进程退出码
 */
export async function tickMain(jobName: string, options: RuntimeOptions = {}): Promise<number> {
  /* ---- ① 预读任务行（missing 快败 + 会话投递路的 boot 前情报） ---- */
  const job = withShortStore(options, (store) => new JobsStore(store.connection).get(jobName));
  if (job === undefined) {
    process.stderr.write(`任务不存在：${jobName}（/tick list 查看）\n`);
    return 2;
  }
  // goal 挂钟停摆快径（刀四 v14 enabled 位的真价值——CR-6 生命周期位）：
  // 终态/降级同笔停摆后行留史、OS 注册保留（廉价 no-op 非反复注销重注册）
  //——OS 钟照跳，本进程预读即退，不整机装配。速序先于 due：停摆的钟
  // 无论到不到点都不投递
  if (job.owner === GOAL_JOB_OWNER && !job.enabled) {
    process.stderr.write(`goal ${job.ownerKey} 的挂钟已停摆（enabled=0）——让路不跑\n`);
    return 0;
  }

  /* ---- ② due 判定（schedule 声明在场才判；无声明 = 手动触发语义，到门口即授权） ---- */
  if (job.schedule !== null) {
    // allowPast：重解析存量行时 once@ 时刻已过是正常态（done/missed 的前提）——
    // 「过去即拒」是 add 面策略，时机裁决归 evaluateDue
    const parsed = parseSchedule(job.schedule, Date.now(), { allowPast: true });
    if (!parsed.ok) {
      // 行内坏串只可能来自手编库（add 面已当场执法）——诚实拒，不猜意图
      process.stderr.write(`任务 ${jobName} 的 schedule 坏串：${parsed.error}\n`);
      return 2;
    }
    const due = evaluateDue(parsed.schedule, job.lastRunAt, job.createdAt, Date.now());
    if (due.action === 'wait' || due.action === 'done') {
      // 未到点 / once 已跑完（生命周期终）——安静退出，OS 钟下一跳再来
      return 0;
    }
    if (due.action === 'missed') {
      // once 迟到超窗：记因不跑（last_run_reason='missed'，不推进触发时刻）
      withShortStore(options, (store) => new JobsStore(store.connection).markMissed(jobName, Date.now()));
      process.stderr.write(`任务 ${jobName} 迟到超窗（grace 已过），记 missed 不跑\n`);
      return 0;
    }
    // due.action === 'fire' → 继续往下
  }

  /* ---- ②b 双开预闸（2026-09-01 复盘 C-2：零写入不变式——busy/held 两拒不整机装配） ---- */
  // 只限会话投递路（job.sessionId 非空）：子进程单发路 boot 开新会话，恢复
  // 合成无可触碰的宿主会话，闸留在 ④ 原位即可
  if (job.sessionId !== null) {
    // held 预闸（daemon.json 判活——纯文件读零库开销）：被持有即改道退 1。
    // ⑤ 的同判据兜底仍在（boot 窗口竞收口），此处前移保证 held 拒开路径
    // 零装配零写入
    const heldState = readDaemonState();
    if (heldState !== undefined && isDaemonAlive(heldState) && heldState.heldSessions.includes(job.sessionId)) {
      process.stderr.write(
        `该会话由 daemon 持有：${job.sessionId}（heldSessions 租约）——` +
          '`berry attach` 接上应答，或经 `POST /api/sessions/:id/submit` 投递\n',
      );
      return 1;
    }
    // busy 预闸：turn/start·turn/end 配对深度投影（events 表 SQL——跨进程
    // 有效，宿主 TUI 在跑即让路退 0）。必须在整机装配**前**：boot 的
    // registry.open 恢复合成会为敞开 turn 落 turn/end 假终态并经 write-behind
    // 落库——闸若在 boot 后，让路路径已把假终态写进宿主在跑的会话（闸读数
    // 被自身恢复清零 → 下一跳盲闸放行双跑；宿主下批落库撞 cursor 护栏）。
    // ④ 的统一闸保留为复验（防预闸后竞窗新开轮；canAfford 判据面在装配内
    // 只能复验不能前移）
    const turnDepth = withShortStore(options, (store) => openTurnDepth(store));
    if (turnDepth > 0) {
      process.stderr.write(`让路（agent_busy：库内有轮在跑，openTurnDepth=${turnDepth}）——本轮不投递\n`);
      return 0;
    }
  }

  /* ---- ③ 整机装配（headless；tick 任务面固定档——CLI 旗标显式值优先） ---- */
  // 会话投递路：目标 session_id 注入 boot——chat 件 apply 期 registry.open
  // 直达目标会话（缺省 undefined = 新建，即子进程单发路的目标）
  const runtime = await createRuntime({
    ...options,
    interactive: false,
    // 进程形态（刀三）：tick 子进程 resume 会话 = 挂钟轮到点——goal active
    // 行不降级（挂钟语义跨 tick 存活，骨架篇 §6.8）
    processKind: 'tick',
    // 只读档缺省：tick 任务面拍板（席 13 第一刀公式同款——无人值守不持写权）
    sandboxMode: options.sandboxMode ?? 'read-only',
    // 后台道缺省：正确性要求非偏好——canAfford 读的账在 background 道，
    // tick 花 foreground 道即闸盲区（骨架篇 §8.7 never-unbounded 破律）
    usagePriority: options.usagePriority ?? 'background',
    ...(job.sessionId === null ? {} : { resumeSession: job.sessionId }),
  });
  // 无持久层 = 无任务面可写（reserve/回写全无落点）——语义性失败非崩溃
  if (runtime.persistence === undefined) {
    process.stderr.write('persist:false 无会话库——tick 无任务面可执行\n');
    await runtime.shutdown();
    return 1;
  }

  /* ---- ④ 统一闸复验（DiscoveryGates 四判据——②b 预闸后的第二道：防预闸
   至 boot 间竞窗新开轮；canAfford/wakeCount 判据面在装配内，本就是唯一判点） ---- */
  // llm 服务面经根 ctx 取（④b 装配期 provide 的同一实例——同一底账同一闸）
  const llm = runtime.ctx.get<LlmService>('llm');
  const gate = discoveryGates({
    // busy 判据：turn/start·turn/end 配对深度投影（events 表 SQL——跨进程
    // 有效，双开/宿主 TUI 在跑都能看见）
    turnDepth: openTurnDepth(runtime.persistence.store),
    // recent_user_msg 恒 null 退化：OS 时钟唤起的本进程读不到宿主内存态
    //（30 秒窗进程内锚定——拍板已知边界，非缺陷）
    lastUserMessageAt: null,
    // canAfford 判据：当日后台道余额（同一底账同一闸——与 scheduler 件
    // /tick run 路读的是同一个 ctx.llm 闭包）
    backgroundAffordable: llm.canAfford('background'),
    // 自激预算不计：定时是外部钟非自激链（拍板 CR-1-2.4——连击帽管的是
    // 「唤醒→结算→再唤醒」自旋，管不了也不该管 OS 钟）
    wakeCount: null,
    now: Date.now(),
  });
  if (!gate.ok) {
    // 让路不是失败：agent 在跑/用户刚说话/后台预算尽——OS 钟下一跳再来
    process.stderr.write(`让路（${gate.reason}）——本轮不投递\n`);
    await runtime.shutdown();
    return 0;
  }

  /* ---- ⑤ boot 条目校验（跑前两道诚实错——都在抢占前，坏目标不烧抢占） ---- */
  const entry = runtime.drivers.focused();
  if (entry === undefined) {
    // P3 拒绝完整 UX·触达面①（daemon 刀二，契约篇 §6.8）：会话投递路撞
    // daemon 持有 = 最可能因（heldElsewhere 拒开 → 无聚焦条目落到这里）。
    // ②b 预闸已前移同判据（held 拒开零装配）；此处为 boot 窗口竞兜底。
    // 先判 held 再报未装载——两因指引完全不同：held 给 attach/submit 指引
    //（非零退，OS 钟下一跳再撞同墙）；未装载才是装配问题。daemon.json 判活
    // + 持有目标即成立（与 assembly heldElsewhere 同判据同源——tick 子进程
    // 非 daemon，无 self-held 豁免题）
    if (job.sessionId !== null) {
      const heldState = readDaemonState();
      if (heldState !== undefined && isDaemonAlive(heldState) && heldState.heldSessions.includes(job.sessionId)) {
        process.stderr.write(
          `该会话由 daemon 持有：${job.sessionId}（heldSessions 租约）——` +
            '`berry attach` 接上应答，或经 `POST /api/sessions/:id/submit` 投递\n',
        );
        await runtime.shutdown();
        return 1;
      }
    }
    // 可卸语义：chat 件未装载即无对话循环（overlay 禁用 builtin:chat 等）
    process.stderr.write('对话应用未装载（builtin:chat 被禁用）——tick 无对话循环可执行；/apps 查看装配。\n');
    await runtime.shutdown();
    return 1;
  }
  if (job.sessionId !== null && entry.session.header.sessionId !== job.sessionId) {
    // boot「续接优先不是必须续接」的回落新建在 tick 语境是诚实错：目标会话
    // 已不存在（库被清/手编 id），静默改投新会话 = 归属声明失真
    process.stderr.write(
      `目标会话不存在：${job.sessionId}（任务 ${jobName} 的 session_id 已失效——/tick 配对到新会话）\n`,
    );
    await runtime.shutdown();
    return 1;
  }

  /* ---- ⑤b goal 挂钟投递前执法（刀四 K2-c goal 分支：查行兜底 + 唤醒帽 + 动态渲染） ----
   * 都在抢占前（token 不可逆——坏目标不烧抢占）。goal 分支三闸全 durable/表判据，
   * 跨进程有效；让路退出码 0（OS 钟下一跳自然再来）。记因经 ctx.sessions 落
   * goal/evidence（appendEvent 顶层无调用链 → routed 回退聚焦条目 = 目标会话） */
  let prompt = job.prompt; // 非 goal 路恒用行内静态 prompt
  let goalAttribution: Readonly<Record<string, string>> | undefined;
  let goalToolFilter: readonly string[] | undefined;
  if (job.owner === GOAL_JOB_OWNER) {
    const sessions = runtime.ctx.get<TickSessionsFace>('sessions');
    // 查行兜底：goal 行缺席/非 active/已重绑他乡（时钟行 session_id 指针
    // 陈旧——重挂本应在 resume 时治愈，此处兜竞窗）→ 让路记因 inactive
    //（willRetry=false：状态不回 active 就不再来；resume 重挂即复活）
    const row = new GoalStore(runtime.persistence.store.connection).getByGoalId(job.ownerKey ?? '');
    if (row === undefined || row.status !== 'active' || row.sessionId !== job.sessionId) {
      // 防无界残响两件（全面复盘 #53）：① 同 goalId 首跳去重——本会话末条
      // goal/evidence 已是 inactive 则不重复落账（OS 钟每跳一记、every@1m 即
      // 日增 1440 条的账本无界增长止血；复活后如常再落）；② 自愈停摆——行
      // 缺席/非 active 两形 goal 已不在或已终局永不再投，同笔翻转钟行
      // enabled=0（次跳即走 ① 预读停摆快径零整机装配；needs-resume 形
      // resume 重挂自愈复活不损失）。重绑他乡形不翻转：goal 活着，resume
      // upsert 下一跳自愈，至多让一跳
      const lastEvidence = sessions
        .eventsOfType('goal/evidence')
        .filter((event) => (event.data as { goalId?: unknown } | undefined)?.goalId === job.ownerKey)
        .at(-1);
      if ((lastEvidence?.data as { reason?: unknown } | undefined)?.reason !== 'inactive') {
        sessions.appendEvent('goal/evidence', { goalId: job.ownerKey, reason: 'inactive', willRetry: false });
      }
      if (row === undefined || row.status !== 'active') {
        new JobsStore(runtime.persistence.store.connection).setOwnedEnabled(
          GOAL_JOB_OWNER,
          job.ownerKey ?? '',
          false,
          Date.now(),
        );
      }
      process.stderr.write(`goal ${job.ownerKey} 非 active（${row?.status ?? '行缺席'}）——让路不投递\n`);
      await runtime.shutdown();
      return 0;
    }
    // 唤醒帽（与自激路同一 wakeGate 单源——durable 投影扫 user/message 归因，
    // 跨进程链帽；进程内 maxConsecutiveWakes 管不了也看不见 tick 链）。超帽
    // = 暂停投递非终态停：willRetry=true，用户手写或到窗后自然恢复
    const wakeVerdict = wakeGate({
      goalId: row.goalId,
      now: Date.now(),
      events: sessions.eventsOfType('user/message'),
    });
    if (!wakeVerdict.allow) {
      sessions.appendEvent('goal/evidence', { goalId: row.goalId, reason: 'capped', willRetry: true });
      process.stderr.write(`goal ${row.goalId} 唤醒帽拒（${wakeVerdict.reason}）——本轮让路\n`);
      await runtime.shutdown();
      return 0;
    }
    // 动态渲染（与自激路同一渲染函数单源：objective + 沉淀摘要 + 预算余额 +
    // 纪律六件——不预设立场，完成审计条款在场）。渲染异常落 objective 静态
    // 快照兜底（job.prompt）——投递不因渲染面故障而丢轮
    try {
      prompt = renderContinuationPrompt(row);
    } catch {
      prompt = job.prompt;
    }
    goalAttribution = { goalId: row.goalId, wakeId: newWakeId(), wakePath: 'tick' };
    // v1 tick 恒只读边界（CR-10）：needsWrite 未申报即与自激路同一收窄单源
    // wakeToolFilter（read 类 + goal_get/goal_update）；申报开洞 = 全量工具面
    if (!row.needsWrite) {
      goalToolFilter = wakeToolFilter(
        runtime.ctx.get<ToolsService>('tools').compositionFor(entry.session.header.sessionId),
      );
    }
  }

  /* ---- ⑥ 执行前抢占（token 花费不可逆，抢占必须发生在花钱之前） ---- */
  const store = new JobsStore(runtime.persistence.store.connection);
  const reserved = store.reserveRun(jobName, Date.now(), 'scheduled');
  if (reserved === 'missing') {
    // 探针后行被删（兄弟进程 /tick rm）——任务不存在同语义
    process.stderr.write(`任务不存在：${jobName}（探针后被删）\n`);
    await runtime.shutdown();
    return 2;
  }
  if (reserved === 'lost-race') {
    // 双开两进程同刻到点：单语句原子更新至多一个赢——败者让路不跑
    process.stderr.write('并发兄弟已抢占，让路\n');
    await runtime.shutdown();
    return 0;
  }

  /* ---- ⑦ 跑一轮（boot 已开好目标条目——两路在此合流为同一个调用） ---- */
  // 信号编舞（骨架篇 §1.3 全表，与 run 入口共用；S6 形态④注记：tick runner 恒
  // 单驱动——两 kind 同走 requestQuit 全序列，无分档面）：SIGINT 首次优雅 abort
  // 当前 run / 二次立即 130 / SIGTERM 143 / SIGHUP 129 / uncaught 不吞 exit(1)
  const signals = installExitSignals({
    onGracefulQuit: () => entry.driver.requestQuit(),
    onFatal: async (error, kind) => {
      runtime.ctx.logger.error(`致命异常（${kind}），尽力落盘后退出`, {
        kind,
        error: error instanceof Error ? error.stack : String(error),
      });
      await runtime.persistence?.flush().catch(() => undefined);
    },
  });

  let code: number;
  try {
    // goal 挂钟路：backgroundWake 计道 + 归因（goalId/wakeId/wakePath='tick'
    //——durable 落账，帽投影与结算归因扫的就是这面）+ 工具收窄（⑤b 算好）；
    // 其余任务路维持原样（静态 prompt、无收窄——用户手写在场语义）
    const result =
      goalAttribution === undefined
        ? await entry.driver.submitOnce(prompt)
        : await entry.driver.submitOnce(prompt, {
            source: 'app:goal',
            attribution: goalAttribution,
            backgroundWake: true,
            ...(goalToolFilter === undefined ? {} : { toolFilter: goalToolFilter }),
          });
    if (!result) {
      // 防御：quit 已触发时 submitOnce 转队列返回 undefined——按中断处理
      process.stderr.write('已中断\n');
      code = 0;
    } else if (result.status === 'failed') {
      process.stderr.write(`${result.errorMessage ?? '执行失败'}\n`);
      code = 1;
    } else {
      const text = lastAssistantText(result);
      if (text !== undefined) process.stdout.write(`${text}\n`);
      code = 0;
    }
  } finally {
    // 归属回写（事实陈述：本轮落在哪个会话——成败都记）+ 落盘关停
    store.recordLastSession(jobName, entry.session.header.sessionId, Date.now());
    signals.dispose();
    await runtime.shutdown();
  }
  // 优雅路退出码：SIGINT 首次 = 0；SIGTERM/SIGHUP 采纳记账码（仅覆盖 0——
  // run 自身失败码 1 优先于信号记账）
  return code === 0 ? signals.exitCode : code;
}
