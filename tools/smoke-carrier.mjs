#!/usr/bin/env node
/**
 * 真模型 × 第三方应用 × 双载体端到端冒烟（dev 工具，不入产品码——拓扑门禁只扫
 * src/，与测试文件同豁免口径；2026-08-29 复盘批 critic #5 销账炮）。
 *
 * 与 smoke-real.mjs 的分工：smoke-real = 五轮验收流（memory/subagent/goal 等
 * 官方件行为面）；本炮 = **第三方应用装载链 × 载体隔离**——此前无一炮覆盖
 * 「真模型 + 第三方应用 + worker/external 双载体」，金样基线也止于
 * builtin-only 时代。
 *
 * 五环（全生产面，零 mock——模型层走真 provider 代理，其余全真）：
 *   1. 两态动词链：appsService.install（仓库态零生效）+ mount（挂载态写行
 *      生效）× 2 fixture——fx-ext（external fork 域）/ fx-wk（worker 线程域）；
 *   2. reload 三清单：runtime.reload() 全量重载 → activated 含双行；
 *   3. 装载物化：appsService.list() 双行 activated + 组成面（compositionFor）
 *      双工具可见——external 行经 fork 进程桥注册、worker 行经线程桥注册；
 *      前台先显式进 chat 会话（挂载目标 apps:['chat'] 的组成面判据位——
 *      默认应用位随策略走，#20：boot-open 首会话已随 b78ab40 默认 coder 化）；
 *   4. 桥真调两腿：宿主直调（确定性——工具 execute 过桥往返拿回 fixture 标记）
 *      + 真模型自主调用（submitOnce 提示词驱动模型真调双工具，tool/call 落账）；
 *   5. 重开库自检：shutdown → Persistence.open 重开 → durable 事件流含双 fx
 *      工具的 tool/call（外部域/线程域的工具调用与内置件同账落库）。
 *
 * 用法（与 smoke-real.mjs 同环境约定）：
 *   ANTHROPIC_BASE_URL=http://… ANTHROPIC_AUTH_TOKEN=sk-… \
 *     npx tsx tools/smoke-carrier.mjs [模型id（缺省 glm-5.3）]
 *
 * 安全纪律：凭证只从环境读取、绝不回显；数据/工作区全 mktemp 隔离（不污染
 * ~/.berry；compositionDir 显式隔离——与 smoke-real 同款防装机历史污染）。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../src/app/assembly.js';
import { Persistence } from '../src/persist/index.js';
import { collectBuiltinMigrations } from '../src/app/builtins.js';
import { PROXY_PROVIDER_ID, buildProxyProvider, requireProxyEnv } from './smoke-provider.mjs';

/* ---------------- 环境与参数 ---------------- */

/** 代理环境约定（缺参即用法退出——共享层单点，基建大扫 #34） */
const { baseUrl, token } = requireProxyEnv('tools/smoke-carrier.mjs [模型id]');
/** 模型 id（argv[2]，缺省 glm-5.3——本环境代理的缺省服务模型） */
const modelId = process.argv[2] ?? 'glm-5.3';

/* ---------------- 临时目录（realpath 归一——macOS /var 前缀差异教训） ---------------- */

const smokeData = mkdtempSync(join(realpathSync(tmpdir()), 'berry-smoke-carrier-data-'));
const smokeWorkspace = mkdtempSync(join(realpathSync(tmpdir()), 'berry-smoke-carrier-ws-'));
const smokeHome = mkdtempSync(join(realpathSync(tmpdir()), 'berry-smoke-carrier-home-'));

// 数据目录钉扎（20260901-d #2，与 smoke-replay/real 同款）：external 载体行的
// 可写根推导走 appDataDirOf(dataDir(), row.id)——不钉 APP_DATA_DIR 则 fixture
// 的 jiti 缓存会写进真实 ~/.berry/apps/<行id>/tmp（磁盘实证：fx-ext 残骸即此
// 形态），boot 期扫龄/孤儿清扫同样对真实 ~/.berry 动手。
process.env['APP_DATA_DIR'] = smokeData;

/* ---------------- 第三方应用 fixture × 2（真实目录形态：入口 index.ts + 词名导出） ---------------- */

/**
 * fixture 应用源（与真实第三方应用同形：export name 词名 + default apply +
 * ctx.get('tools') 注册工具——契约篇 §3.2 注册即 effect）。两 fixture 结构同形
 * 仅词名/标记不同；标记硬编码（分域行 mount 拒写 config——宿主不代校验域侧
 * schema，R1 P0-3），故不走 config 注入。
 */
const fixtureSource = (appName, toolName, marker) => `
export const name = ${JSON.stringify(appName)};
export default async function apply(ctx) {
  const tools = ctx.get("tools");
  // 契约篇 §3.2：注册即 effect——apply 回卷时注册随之撤销
  ctx.effect(() =>
    tools.register({
      name: ${JSON.stringify(toolName)},
      description: "双载体冒烟 fixture 工具（回声标记）",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: async (args) => ({
        content: [{ type: "text", text: ${JSON.stringify(marker)} + ":" + String(args.text) }],
      }),
    }),
  );
}
`;

/** 装机目录族：fx-ext（external 腿）/ fx-wk（worker 腿）——install 从目录收割词名 */
const appDirExt = join(smokeData, 'fx-ext');
const appDirWk = join(smokeData, 'fx-wk');
mkdirSync(appDirExt, { recursive: true });
mkdirSync(appDirWk, { recursive: true });
writeFileSync(join(appDirExt, 'index.ts'), fixtureSource('fx-ext', 'fx/ext_echo', 'EXT-ECHO'));
writeFileSync(join(appDirWk, 'index.ts'), fixtureSource('fx-wk', 'fx/wk_echo', 'WK-ECHO'));

/* ---------------- provider 构造（共享层单点——基建大扫 #34，与 smoke-real 同源；代理场景必经注册面） ---------------- */

const provider = buildProxyProvider({ baseUrl, token, modelId });

/* ---------------- 五环主体 ---------------- */

/** 五环判定（逐环打点，末尾汇总成 ok——冒烟退出码即裁决） */
const rings = { installMount: false, reload: false, materialize: false, bridge: false, reopen: false };

try {
  /* ---- 装配（隔离面与 smoke-real 同款：dataDir/workspace/homeDir/compositionDir 全 mktemp） ---- */
  const runtime = await createRuntime({
    model: `${PROXY_PROVIDER_ID}/${modelId}`,
    dbPath: join(smokeData, 'sessions.db'),
    workspace: smokeWorkspace,
    homeDir: smokeHome,
    compositionDir: join(smokeData, 'composition'),
  });
  runtime.llm.registerProvider(provider);

  try {
    /* ---- 环 1：两态动词链（install 仓库态 → mount 挂载态写行；显式双载体） ---- */
    await runtime.appsService.install(appDirExt);
    await runtime.appsService.install(appDirWk);
    const mountExt = await runtime.appsService.mount('fx-ext', { apps: ['chat'], carrier: 'external' });
    const mountWk = await runtime.appsService.mount('fx-wk', { apps: ['chat'], carrier: 'worker' });
    installMountFace: {
      const rowsOk = mountExt.id === 'fx-ext' && mountWk.id === 'fx-wk';
      // install 仓库态零生效（D2 联锁的正面形态）：写行前组合树无 fx 行
      const treeHasFx = runtime.composition.rows.some((row) => row.id === 'fx-ext' || row.id === 'fx-wk');
      rings.installMount = rowsOk && !treeHasFx;
      console.log(
        `[smoke] 环1 两态动词: mount 回执 ${rowsOk ? '✓' : '✗'}（fx-ext→external / fx-wk→worker）  写行前组合树零 fx 行 ${treeHasFx ? '✗（意外在场）' : '✓'}`,
      );
      if (!rings.installMount) break installMountFace;
    }

    /* ---- 环 2：reload 三清单（全量重载——boot 装配期外的第三 spawn 时点） ---- */
    const reloadResult = await runtime.reload();
    rings.reload =
      reloadResult.queued !== true &&
      reloadResult.error === undefined &&
      reloadResult.payload !== undefined &&
      reloadResult.payload.activated.includes('fx-ext') &&
      reloadResult.payload.activated.includes('fx-wk') &&
      reloadResult.payload.failed.length === 0;
    console.log(
      `[smoke] 环2 reload: ${rings.reload ? '✓' : '✗'}  activated=[${reloadResult.payload?.activated.join(',') ?? '(无)'}] failed=[${reloadResult.payload?.failed.join(',') ?? ''}]${reloadResult.error !== undefined ? ` error=${reloadResult.error}` : ''}`,
    );

    /* ---- 环 3：装载物化（行状态面 + 组成面工具——两腿桥各自注册的产物） ---- */
    const listRows = runtime.appsService.list();
    const extRow = listRows.find((row) => row.id === 'fx-ext');
    const wkRow = listRows.find((row) => row.id === 'fx-wk');
    // 前台应用确定性（遗漏大扫 20260901-d #20 诊断修正）：boot-open 首会话随
    // 默认应用策略走（组装批 b78ab40 起默认 = coder），而本炮挂载目标恒 chat
    // ——组成面与模型轮必须对齐 chat 应用域。显式进 chat 会话（/app chat 同源
    // 程序面 drivers.open({app})：新建 + 切前台一条龙），此后 session/conversation
    // 两投影恒为 chat 驱动，与默认位谁家彻底解耦。
    const chatManifest = runtime.apps.get('chat');
    if (chatManifest === undefined) throw new Error('官方应用清单未见 chat（官方全家桶缺场——装配形态异常）');
    const chatEntry = runtime.drivers.open({ app: chatManifest });
    if (chatEntry === undefined) throw new Error('chat 会话 open 无果（本炮恒真持久层——不该发生）');
    const sessionKey = chatEntry.session.header.sessionId;
    const domainTools = sessionKey ? runtime.tools.compositionFor(sessionKey).map((def) => def.name) : [];
    const toolExtOk = domainTools.includes('fx/ext_echo');
    const toolWkOk = domainTools.includes('fx/wk_echo');
    rings.materialize = extRow?.status === 'activated' && wkRow?.status === 'activated' && toolExtOk && toolWkOk;
    console.log(
      `[smoke] 环3 物化: 行状态 fx-ext=${extRow?.status ?? '无'} fx-wk=${wkRow?.status ?? '无'}  组成面工具 ext${toolExtOk ? '✓' : '✗'} wk${toolWkOk ? '✓' : '✗'}（组成面共 ${domainTools.length} 件）`,
    );

    /* ---- 环 4a：宿主直调桥检查（确定性腿——execute 过桥往返拿回 fixture 标记） ---- */
    let directExtOk = false;
    let directWkOk = false;
    try {
      const callFixture = async (name, text) => {
        const def = runtime.tools.compositionFor(sessionKey).find((d) => d.name === name);
        if (def === undefined) throw new Error(`组成面未见工具：${name}`);
        const result = await runtime.tools.toAgentTool(def).execute('smoke-carrier', { text });
        return result.content[0]?.type === 'text' ? result.content[0].text : '';
      };
      const extText = await callFixture('fx/ext_echo', '直调');
      const wkText = await callFixture('fx/wk_echo', '直调');
      directExtOk = extText === 'EXT-ECHO:直调'; // fork 进程域内执行体经 NDJSON 桥往返
      directWkOk = wkText === 'WK-ECHO:直调'; // worker 线程域同构
      console.log(
        `[smoke] 环4a 宿主直调: external 桥${directExtOk ? '✓' : `✗（得 ${extText.slice(0, 60)}）`}  worker 桥${directWkOk ? '✓' : `✗（得 ${wkText.slice(0, 60)}）`}`,
      );
    } catch (error) {
      console.error(`[smoke] 环4a 直调异常: ${error instanceof Error ? error.message : String(error)}`);
    }

    /* ---- 环 4b：真模型自主调用（模型读组成面清单 → 主动调双工具 → tool/call 落账） ---- */
    let modelExtOk = false;
    let modelWkOk = false;
    let modelCompleted = false;
    try {
      const result = await runtime.conversation.submitOnce(
        '请依次调用 fx/ext_echo 工具（text 参数给「甲」）和 fx/wk_echo 工具（text 参数给「乙」），完成后用一句话分别引用两个工具返回的完整文本。',
      );
      const events = runtime.session?.events ?? [];
      const calledNames = events.filter((e) => e.type === 'tool/call').map((e) => String(e.data?.name ?? '?'));
      modelExtOk = calledNames.includes('fx/ext_echo');
      modelWkOk = calledNames.includes('fx/wk_echo');
      modelCompleted = result?.status === 'completed';
      const last = result?.messages.at(-1);
      const text =
        last && last.role === 'assistant'
          ? (last.content ?? [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('')
          : '';
      console.log(
        `[smoke] 环4b 真模型: status=${result?.status}  调用=[${calledNames.join(', ') || '无'}]  ext${modelExtOk ? '✓' : '✗'} wk${modelWkOk ? '✓' : '✗'}  回答: ${text.slice(0, 200)}`,
      );
    } catch (error) {
      console.error(`[smoke] 环4b 模型轮异常: ${error instanceof Error ? error.message : String(error)}`);
    }
    rings.bridge = directExtOk && directWkOk && modelExtOk && modelWkOk && modelCompleted;
  } finally {
    /* ---- 环 5 前置：优雅关停（fleet 域终止编舞 + flush 屏障 + 关库 + ctx 回卷） ---- */
    await runtime.shutdown();
  }

  /* ---- 环 5：重开库自检（durable 事件流含双 fx 工具 tool/call——跨载体同账） ---- */
  try {
    const reopened = Persistence.open({
      path: join(smokeData, 'sessions.db'),
      migrations: collectBuiltinMigrations(),
    });
    const ids = reopened.store.listSessionIds();
    const allEvents = ids.flatMap((id) => reopened.loadSession(id)?.events ?? []);
    const persistedCalls = allEvents
      .filter((e) => e.type === 'tool/call')
      .map((e) => String(e.data?.name ?? '?'))
      .filter((name) => name.startsWith('fx/'));
    rings.reopen =
      persistedCalls.includes('fx/ext_echo') &&
      persistedCalls.includes('fx/wk_echo') &&
      // 直调腿不进会话账（不经驱动）——持久化计数 = 模型自主调用的次数（每件 ≥ 1）
      persistedCalls.filter((n) => n === 'fx/ext_echo').length >= 1 &&
      persistedCalls.filter((n) => n === 'fx/wk_echo').length >= 1;
    console.log(
      `[smoke] 环5 重开库: ${ids.length} 会话 / ${allEvents.length} 事件  durable fx 调用=[${persistedCalls.join(', ') || '无'}] ${rings.reopen ? '✓' : '✗'}`,
    );
    await reopened.close();
  } catch (error) {
    console.error(`[smoke] 环5 重开库异常: ${error instanceof Error ? error.message : String(error)}`);
  }
} catch (error) {
  console.error(`[smoke] 未预期异常: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
}

const ok = Object.values(rings).every(Boolean);
console.log(
  `[smoke] 判定汇总: 两态动词=${rings.installMount ? '✓' : '✗'} reload=${rings.reload ? '✓' : '✗'} 物化=${rings.materialize ? '✓' : '✗'} 桥双腿=${rings.bridge ? '✓' : '✗'} 重开库=${rings.reopen ? '✓' : '✗'}  →  ${ok ? '全绿' : '有红'}`,
);
console.log(`[smoke] data=${smokeData}  workspace=${smokeWorkspace}`);

// 流末即用即清（基建大扫 #33）：成功路三临时根收场即删；失败保留现场供
// postmortem；SMOKE_KEEP=1 逃生门无条件保留
if (ok && process.env['SMOKE_KEEP'] !== '1') {
  for (const dir of [smokeData, smokeWorkspace, smokeHome]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不改变退出码（残留可容忍——退出码才是裁决）
    }
  }
}
process.exit(ok ? 0 : 1);
