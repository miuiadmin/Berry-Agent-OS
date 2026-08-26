/**
 * 冒烟共享流（dev 工具，不入产品码——拓扑门禁只扫 src/）。
 *
 * 真模型冒烟（smoke-real.mjs）与金样回放（smoke-replay.mjs）共用的五轮验收流 +
 * 重开库自检：boot 结构面（memory/subagent/goal/检索族）→ 主轮 → 委派轮 →
 * goal 续跑轮 → memory 差分轮 → 优雅关停 → 重开库断言。
 *
 * 两驱动唯一差异 = 模型层来源（真 provider / 金样回放流），流程与断言完全同文
 * ——金样回放轨的回归价值正在于此：同一段验收逻辑无 key 可重复跑。
 *
 * 对外只导出 runSmokeFlow({ runtime, prompt, smokeData })：跑完返回 { ok }，
 * 退出码裁决归驱动。
 */

import { join } from 'node:path';
import { Persistence } from '../src/persist/index.js';
import { collectBuiltinMigrations } from '../src/app/builtins.js';

/**
 * 跑完整冒烟流（五轮 + 重开库自检）。全程打印 [smoke] 前缀报告；结构性判定
 * 汇总进返回值 ok（模型行为只报告不判定——冒烟不替模型背书）。
 * @param runtime 已装配 runtime（模型层已就绪——真 provider 或回放流）
 * @param prompt 主轮提示词
 * @param smokeData 数据目录（重开库自检的库文件所在）
 */
export async function runSmokeFlow({ runtime, prompt, smokeData }) {
  /* ---- boot 结构面：ctx.llm 具名服务 + memory/subagent/goal 默认层 + 检索族 ---- */
  const service = runtime.ctx.tryGet('llm');
  console.log(`[smoke] ctx.llm 服务 ${service ? '✓' : '✗（缺 provide）'}`);

  const hasMemoryRow = runtime.composition.rows.some((row) => row.id === 'memory');
  const memoryStatus = runtime.plugins.list().find((row) => row.id === 'memory')?.status;
  const toolNames = runtime.tools.list().map((def) => def.name);
  const memoryTools = ['memory_write', 'memory_forget', 'memory_restore', 'memory_read', 'memory_search'];
  const toolsOk = memoryTools.every((name) => toolNames.includes(name));
  const bootMemoryOk = hasMemoryRow && memoryStatus === 'activated' && toolsOk;
  console.log(
    `[smoke] 默认层 memory 行 ${hasMemoryRow ? '✓' : '✗'}  装载状态 ${memoryStatus ?? '(无)'}  工具 ${toolNames.length} 件（memory 五件${toolsOk ? '✓' : '✗'}）`,
  );
  console.log(
    `[smoke] systemPrompt 含记忆简报段: ${runtime.systemPrompt.includes('以下来自历史记忆') ? '✓' : '（空库跳过，属预期）'}`,
  );

  const hasSubagentRow = runtime.composition.rows.some((row) => row.id === 'subagent');
  const subagentStatus = runtime.plugins.list().find((row) => row.id === 'subagent')?.status;
  const agentToolOk = toolNames.includes('agent');
  const listSectionOk = runtime.systemPrompt.includes('可用子代理类型');
  const bootSubagentOk = hasSubagentRow && subagentStatus === 'activated' && agentToolOk && listSectionOk;
  console.log(
    `[smoke] 默认层 subagent 行 ${hasSubagentRow ? '✓' : '✗'}  装载状态 ${subagentStatus ?? '(无)'}  agent 工具${agentToolOk ? '✓' : '✗'}  清单段${listSectionOk ? '✓' : '✗'}`,
  );

  const hasGoalRow = runtime.composition.rows.some((row) => row.id === 'goal');
  const goalStatus = runtime.plugins.list().find((row) => row.id === 'goal')?.status;
  const goalTools = ['goal_get', 'goal_set', 'goal_update'];
  const goalToolsOk = goalTools.every((name) => toolNames.includes(name));
  const bootGoalOk = hasGoalRow && goalStatus === 'activated' && goalToolsOk;
  console.log(
    `[smoke] 默认层 goal 行 ${hasGoalRow ? '✓' : '✗'}  装载状态 ${goalStatus ?? '(无)'}  工具三件${goalToolsOk ? '✓' : '✗'}`,
  );

  // S2 组合域分片后工具面两层：检索族留全局层（caller 无关纯机制），fs 四件
  // 随 chat 件 open() 注册进本会话域层——boot 判定必须走域面 listFor（sessionId
  // = 默认会话头），全局 list() 查不到 fs 四名是分片语义非缺失（规范钉死）
  const sessionKey = runtime.session?.header?.sessionId;
  const domainToolNames = sessionKey ? runtime.tools.listFor(sessionKey).map((def) => def.name) : [];
  const searchTools = ['find', 'grep'];
  const fsTools = ['read', 'write', 'edit', 'ls'];
  const searchOk = searchTools.every((name) => toolNames.includes(name));
  const fsOk = fsTools.every((name) => domainToolNames.includes(name));
  console.log(
    `[smoke] Ring 1 工具面  fs 四件（域面 ${sessionKey ? sessionKey.slice(0, 8) + '…' : '无会话键'}）${fsOk ? '✓' : '✗'}  检索两件${searchOk ? '✓' : '✗'}（bash 随 exec 纵切）`,
  );

  const failBoot = !bootMemoryOk || !bootSubagentOk || !bootGoalOk || !searchOk || !fsOk || !service;

  /* ---- 五轮主体 ---- */
  /** 差分轮判定（finally 重开库面引用） */
  let diffOk = false;
  /** 委派轮判定（try 内赋值、finally 汇总） */
  let subagentOk = false;
  /** goal 轮判定（同上） */
  let goalRoundOk = false;
  /** 差分轮写入条目短 id（重开库面匹配 '+' 条目用） */
  let writtenShortId = '';
  /** 主轮结果状态（判定汇总用） */
  let mainCompleted = false;

  try {
    const result = await runtime.conversation.submitOnce(prompt);
    const events = runtime.session?.events ?? [];
    const types = events.map((e) => e.type);
    console.log(`[smoke] 事件序: ${types.join(' → ')}`);
    const toolCalls = events.filter((e) => e.type === 'tool/call').map((e) => String(e.data?.name ?? '?'));
    console.log(`[smoke] 工具调用: ${toolCalls.length ? toolCalls.join(', ') : '（无）'}`);
    const last = result?.messages.at(-1);
    const text =
      last && last.role === 'assistant'
        ? (last.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
        : '(无 assistant 文本)';
    console.log(`[smoke] status=${result?.status}  回答: ${text.slice(0, 300)}`);
    mainCompleted = result?.status === 'completed';

    /* ---- subagent service 级真模型委派轮 ---- */
    let childSessionId = '';
    try {
      const subagents = runtime.ctx.get('subagents');
      const run = subagents.start({
        provider: 'in-process',
        prompt: '调用 ls 工具查看工作区目录内容，然后用一条完整的消息报告你看到了什么。',
        label: '冒烟委派',
      });
      childSessionId = run.id;
      const settled = await run.result;
      run.dispose();
      const childText = settled.output ?? '';
      console.log(
        `[smoke] 委派结算: stopReason=${settled.stopReason}  汇报 ${childText.length} 字: ${childText.slice(0, 160)}`,
      );
      subagentOk = settled.stopReason === 'completed' && childText.trim() !== '';
    } catch (error) {
      console.error(`[smoke] 委派轮异常: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(`[smoke] 委派面 ${subagentOk ? '✓' : '✗'}  子会话 ${childSessionId.slice(0, 8)}…`);

    /* ---- goal 真模型续跑轮 ---- */
    try {
      const callTool = (name, args) => {
        const def = runtime.tools.get(name);
        if (!def) throw new Error(`工具未注册：${name}`);
        return runtime.tools.toAgentTool(def).execute('smoke-goal', args);
      };
      const goalStateText = async () => {
        const result = await callTool('goal_get', {});
        return result.content[0]?.text ?? '';
      };
      await callTool('goal_set', {
        objective: '在工作区创建 goal-smoke.txt，内容为一行「goal 冒烟完成」',
        // 预算裕度必须远大于链实耗（约 5 万）：贴近实耗会出现「录制时未刹 / 回放
        // 时被刹」的临界漂移——刹车收尾注入会多发一次计划外模型调用，金样按调用
        // 序消费即错位发散（2026-08-27 回放 19/20 发散的实锤根因）。刹车边界行为
        // 由 goal 件单元测试覆盖，冒烟流只验端到端接线，不压预算边界。
        tokenBudget: 200_000,
      });
      console.log(`[smoke] goal 已设定:\n${await goalStateText()}`);
      await runtime.conversation.submitOnce('请推进当前目标：按目标内容做完，然后调用 goal_update 申报完成并附证据。');
      let goalTerminal = '';
      for (let round = 0; round < 12; round += 1) {
        await runtime.conversation.settle();
        const text = await goalStateText();
        const statusLine = text.split('\n').find((line) => line.startsWith('状态：')) ?? '';
        if (/状态：(completed|blocked|stopped)/.test(statusLine)) {
          goalTerminal = statusLine;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      const sessionEvents = runtime.session?.events ?? [];
      const injections = sessionEvents.filter(
        (e) => e.type === 'user/message' && e.data?.source === 'plugin:goal',
      ).length;
      const goalUpdateCalled = sessionEvents.some((e) => e.type === 'tool/call' && e.data?.name === 'goal_update');
      goalRoundOk = (goalTerminal.includes('completed') && goalUpdateCalled) || injections > 0;
      console.log(
        `[smoke] goal 终态: ${goalTerminal || '（12 轮内未终——续跑链或预算所致）'}  续跑注入 ${injections} 次  goal_update 调用 ${goalUpdateCalled ? '✓' : '✗'}  → ${goalRoundOk ? '✓' : '✗'}`,
      );
    } catch (error) {
      console.error(`[smoke] goal 轮异常: ${error instanceof Error ? error.message : String(error)}`);
    }

    /* ---- memory 简报差分追注轮 ---- */
    try {
      let sawInjection = '';
      runtime.ctx.on('context_transform', (messages, next) => {
        const list = Array.isArray(messages) ? messages : [];
        for (const m of list) {
          if (m && typeof m === 'object' && m.role === 'memory/diff' && typeof m.content === 'string') {
            sawInjection = m.content;
          }
        }
        return next(messages);
      });
      const callToolDiff = (name, args) => {
        const def = runtime.tools.get(name);
        if (!def) throw new Error(`工具未注册：${name}`);
        return runtime.tools.toAgentTool(def).execute('smoke-diff', args);
      };
      const writeResult = await callToolDiff('memory_write', {
        kind: 'preference',
        summary: '冒烟差分条目：简报面漂移验证（smoke-diff）',
        content: '冒烟专用记忆条目：用于验证简报差分追注机制的确定性写入。',
        confidence: 0.95,
      });
      writtenShortId = String(writeResult.details?.id ?? '').slice(0, 8);
      console.log(
        `[smoke] memory_write 落库 ${writtenShortId ? `✓（短 id ${writtenShortId}）` : '✗（无 details.id）'}`,
      );
      const diffResult = await runtime.conversation.submitOnce(
        '请直接用一句话回答：你的上下文尾部是否出现了一条记忆差分说明？若有，请引用其中的短 id 标记。',
      );
      const liveEvents = runtime.session?.events ?? [];
      const diffEvents = liveEvents.filter((e) => e.type === 'memory/diff');
      const plusEntry = diffEvents.some((e) => {
        const entries = Array.isArray(e.data?.entries) ? e.data.entries : [];
        return entries.some((en) => en?.op === '+' && en.id === writtenShortId);
      });
      const injectionHit = sawInjection !== '' && sawInjection.includes(`[m:${writtenShortId}]`);
      diffOk = writtenShortId !== '' && plusEntry && injectionHit;
      const lastDiff = diffResult?.messages.at(-1);
      const diffText =
        lastDiff && lastDiff.role === 'assistant'
          ? (lastDiff.content ?? [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('')
          : '';
      console.log(
        `[smoke] 差分事件 ${diffEvents.length} 条（'+' 匹配 ${plusEntry ? '✓' : '✗'}）  注入 ${injectionHit ? '✓' : '✗'}  → ${diffOk ? '✓' : '✗'}  模型回答: ${diffText.slice(0, 120)}`,
      );
    } catch (error) {
      console.error(`[smoke] 差分轮异常: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    console.error(`[smoke] 未预期异常: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // 优雅关停：run 结算 → flush 屏障 → 关库 → ctx 回卷（骨架篇 §1.3）
    await runtime.shutdown();
    // 落库自检：重开库（collectBuiltinMigrations 全链——新增带表件自动跟进，此处零改动）
    let reopenOk = true;
    try {
      const reopened = Persistence.open({
        path: join(smokeData, 'sessions.db'),
        migrations: collectBuiltinMigrations(),
      });
      const ids = reopened.store.listSessionIds();
      const firstId = ids[0];
      const events = firstId ? (reopened.loadSession(firstId)?.events ?? []) : [];
      console.log(`[smoke] 重开库: ${ids.length} 会话 / ${events.length} 事件`);
      const delegationIds = ids.filter((id) => reopened.loadSession(id)?.header.origin === 'delegation');
      console.log(
        `[smoke] 委派子会话落库 ${delegationIds.length ? '✓' : '✗'}（${delegationIds.length} 个 origin=delegation）`,
      );
      if (delegationIds.length === 0) reopenOk = false;
      const db = reopened.store.connection;
      const count = (sql) => db.prepare(sql).get().n;
      const memoryCount = count('SELECT COUNT(*) AS n FROM memories');
      const ftsCount = count('SELECT COUNT(*) AS n FROM session_fts');
      const ftsSessions = count('SELECT COUNT(*) AS n FROM session_fts_state');
      console.log(`[smoke] memory 表 ${memoryCount} 条 / session_fts ${ftsCount} 行 / 水位 ${ftsSessions} 会话`);
      const goalRows = db.prepare('SELECT session_id, status, stop_reason, tokens_used, token_budget FROM goals').all();
      console.log(
        `[smoke] goals 表 ${goalRows.length} 行: ${goalRows.map((g) => `${g.status}${g.stop_reason ? `/${g.stop_reason}` : ''} ${g.tokens_used}/${g.token_budget}t`).join('；') || '（无）'}`,
      );
      if (goalRows.length === 0) reopenOk = false;
      const allEvents = ids.flatMap((id) => reopened.loadSession(id)?.events ?? []);
      const persistedDiff = allEvents.filter((e) => e.type === 'memory/diff');
      const persistedPlus = persistedDiff.some((e) => {
        const entries = Array.isArray(e.data?.entries) ? e.data.entries : [];
        return entries.some((en) => en?.op === '+' && en.id === writtenShortId);
      });
      console.log(`[smoke] memory/diff 落库 ${persistedDiff.length} 条（冒烟 '+' 条目 ${persistedPlus ? '✓' : '✗'}）`);
      if (!persistedPlus) reopenOk = false;
      await reopened.close();
    } catch (error) {
      console.error(`[smoke] 重开库自检失败: ${error instanceof Error ? error.message : String(error)}`);
      reopenOk = false;
    }
    const ok = !failBoot && mainCompleted && subagentOk && goalRoundOk && diffOk && reopenOk;
    // 委派/goal 轮的判定在 try 内部完成，异常路径下保持 false——由 ok 汇总
    console.log(
      `[smoke] 判定汇总: boot=${!failBoot ? '✓' : '✗'} main=${mainCompleted ? '✓' : '✗'} subagent=${subagentOk ? '✓' : '✗'} goal=${goalRoundOk ? '✓' : '✗'} diff=${diffOk ? '✓' : '✗'} reopen=${reopenOk ? '✓' : '✗'}`,
    );
    return { ok };
  }
}
