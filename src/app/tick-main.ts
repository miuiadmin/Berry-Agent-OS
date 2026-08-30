/**
 * L5 app — `berry run --tick <name>` 到点编排入口（headless：OS 调度器〔K2-d
 * launchd/crontab 注册〕唤起的形态——本进程就是被调起的那个进程，跑在本地
 * 不再 spawn；/tick run 手动路走 scheduler 件 spawn 子进程，两路同闸同账）。
 *
 * 编排序（内核边界篇 §4.1 席 13 第二刀拍板①④）：
 *   boot 前预读任务行 → due 判定（未到/已终/迟到超窗——不烧钱即退）→
 *   DiscoveryGates 统一闸 → reserveRun 原子抢占 → in-process 跑一轮 →
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
import type { LlmService } from '../llm/index.js';
import { JobsStore, parseSchedule, evaluateDue, discoveryGates } from '../scheduler/index.js';
import type { JobRecord } from '../scheduler/index.js';
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
 * 同库短连接执行 JobsStore 操作（boot 前轻事务）。
 *
 * 两个调用站点：① 预读任务行（missing 快败 + 会话投递路的 boot 前情报——
 * resumeSession 是 boot 选项，开完再改就晚了）；② missed 记因（写一列就
 * 走，不值得整机装配）。迁移链与装配同源（collectBuiltinMigrations）——
 * 短连接若带短链，开新库即撞「user_version 高于宿主已知」闸。
 * @param options 组合根选项（取 dbPath——与真 boot 同库）
 * @param fn 在 JobsStore 上执行的操作（返回值原样透传）
 */
function withJobsStore<T>(options: RuntimeOptions, fn: (store: JobsStore) => T): T {
  // 库路径与 boot 同源（dbPath() 缺省；:memory: 时读到的是自己的空库——
  // 任务必不存在，与「无库无任务」同语义）
  const store = openStore({ path: options.dbPath ?? dbPath(), migrations: collectBuiltinMigrations() });
  try {
    return fn(new JobsStore(store.connection));
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
  const job = withJobsStore(options, (store) => store.get(jobName));
  if (job === undefined) {
    process.stderr.write(`任务不存在：${jobName}（/tick list 查看）\n`);
    return 2;
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
      withJobsStore(options, (store) => store.markMissed(jobName, Date.now()));
      process.stderr.write(`任务 ${jobName} 迟到超窗（grace 已过），记 missed 不跑\n`);
      return 0;
    }
    // due.action === 'fire' → 继续往下
  }

  /* ---- ③ 整机装配（headless；tick 任务面固定档——CLI 旗标显式值优先） ---- */
  // 会话投递路：目标 session_id 注入 boot——chat 件 apply 期 registry.open
  // 直达目标会话（缺省 undefined = 新建，即子进程单发路的目标）
  const runtime = await createRuntime({
    ...options,
    interactive: false,
    // 只读档缺省：tick 任务面拍板（席 13 第一刀公式同款——无人值守不持写权）
    sandboxMode: options.sandboxMode ?? 'read-only',
    // 后台道缺省：正确性要求非偏好——canAfford 读的账在 background 道，
    // tick 花 foreground 道即闸盲区（骨架篇 §8.7 never-unbounded 破律）
    usagePriority: options.usagePriority ?? 'background',
    ...(job.sessionId !== null ? { resumeSession: job.sessionId } : {}),
  });
  // 无持久层 = 无任务面可写（reserve/回写全无落点）——语义性失败非崩溃
  if (runtime.persistence === undefined) {
    process.stderr.write('persist:false 无会话库——tick 无任务面可执行\n');
    await runtime.shutdown();
    return 1;
  }

  /* ---- ④ 统一闸（DiscoveryGates 四判据——tick 定时路的取值形态） ---- */
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
    const result = await entry.driver.submitOnce(job.prompt);
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
