#!/usr/bin/env node
/**
 * 补票（闸门第四项·完整性尾款，第二十七批冷读裁决）：完整 hello 过界——ctx 桩 RPC 往返。
 *
 * 三炮（jiti/typebox/sqlite）只证机制件可用；本炮把协议本体拉过界，实证两隐性假设：
 *   ① 同步阻抗——过界调用只能以 Promise 面呈现（await 形态、底层 ask/result 两跳）；
 *   ② 取消传播——AbortSignal 不可克隆 → {kind:'cancel', callId} 消息化 +
 *      桩本地立即结算 + 宿主迟到 result 丢弃 + 宿主侧在途工作真被掐断。
 *
 * 宿主侧持有工具面（echo 快工具 / slow 协作式慢工具），worker 侧插件经桩过界调用。
 * 退出码：0 = PASS，1 = FAIL。
 */
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

/** 宿主侧观测面：echo 调用数 + slow 工具的真实执行结果（completed/workedMs） */
const hostObserved = { echoCalls: 0, slowResult: null };

/** 毫秒延迟（编排用） */
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 快工具：立即回礼（同步面调用的靶） */
async function echo(args) {
  hostObserved.echoCalls++;
  return { greeting: `hello, ${args.name}!` };
}

/**
 * 协作式慢工具：按 durationMs 跑满，每 25ms 一档检查取消。
 * 注意——协作式 yield 才可取消；紧密同步循环收不到任何消息，
 * 那是 watchdog terminate（刀〇b 四时钟族）的辖区，协议 cancel 不管。
 */
async function slow(args, signal) {
  const t0 = Date.now();
  const deadline = t0 + args.durationMs;
  while (Date.now() < deadline) {
    if (signal.aborted) break;
    await delay(25);
  }
  return { completed: !signal.aborted, workedMs: Date.now() - t0 };
}

const tools = { echo, slow };

// 30 秒硬超时：挂死本身就是失败信号（协议死锁 = 证伪形态）
const timer = setTimeout(() => {
  console.error('FAIL: 补票超时（30s）——桥接往返疑似挂死');
  process.exit(1);
}, 30_000);
timer.unref();

const worker = new Worker(new URL('./4-hello.worker.mjs', import.meta.url));
/** 宿主侧在途调用表：callId -> AbortController（收到 cancel 时的掐断把手） */
const inFlight = new Map();
let fail = false;

worker.on('message', (m) => {
  // —— 桥接协议 v0 子集：宿主侧执行面 ——
  if (m.kind === 'ask') {
    const tool = tools[m.tool];
    if (!tool) {
      worker.postMessage({
        kind: 'result',
        callId: m.callId,
        ok: false,
        error: { code: 'TOOL_NOT_FOUND', message: m.tool },
      });
      return;
    }
    const ctl = new AbortController();
    inFlight.set(m.callId, ctl);
    Promise.resolve(tool(m.args, ctl.signal))
      .then(
        (value) => {
          // slow 的执行事实留在宿主观测面（completed=false + workedMs 即取消是否真生效的证据）
          if (m.tool === 'slow') hostObserved.slowResult = value;
          worker.postMessage({ kind: 'result', callId: m.callId, ok: true, value });
        },
        (error) =>
          worker.postMessage({
            kind: 'result',
            callId: m.callId,
            ok: false,
            error: { code: 'TOOL_FAILED', message: String(error?.message ?? error) },
          }),
      )
      .finally(() => inFlight.delete(m.callId));
    return;
  }
  if (m.kind === 'cancel') {
    const ctl = inFlight.get(m.callId);
    if (ctl) ctl.abort(); // 取消到达：掐断在途工作（result 仍发出——由桩侧迟到分支丢弃）
    return;
  }
  // —— 编排面：worker 最终报告 ——
  if (m.stage === 'done') {
    const r = m.report;
    const s = m.stubStats;
    check(r.syncOk, `[①同步面调用] echo 过界往返：greeting 正确（宿主 echoCalls=${hostObserved.echoCalls}）`);
    check(r.cancel.caught === 'BRIDGE_CANCELLED', `[②取消传播] 桩本地结算拒绝码 = ${r.cancel.caught}`);
    check(r.cancel.abortSettleMs <= 50, `[②取消传播] abort→结算本地完成（不等宿主往返）：${r.cancel.abortSettleMs}ms`);
    check(s.lateResults === 1, `[②迟到纪律] 已取消调用的宿主迟到 result 恰一次被丢弃：lateResults=${s.lateResults}`);
    check(
      hostObserved.slowResult?.completed === false,
      `[②宿主侧] 慢活未跑满（completed=${hostObserved.slowResult?.completed}）`,
    );
    check(
      (hostObserved.slowResult?.workedMs ?? 99999) < 1000,
      `[②宿主侧] 取消真掐断了工作（workedMs=${hostObserved.slowResult?.workedMs} < 1000，编排 80ms 档 + 档间隔 25ms）`,
    );
    worker.terminate();
  }
});

worker.on('error', (e) => {
  console.error('FAIL: worker 抛错——', e.message);
  worker.terminate();
  fail = true;
  finish();
});

worker.on('exit', () => finish());

/** 单条断言：打印 PASS/FAIL 行 */
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) fail = true;
}

function finish() {
  clearTimeout(timer);
  console.log(
    fail
      ? '== 补票结论: FAIL（hello 过界隐性假设证伪——回拍板桌）=='
      : '== 补票结论: PASS（同步阻抗 + 取消传播两隐性假设过界实证）==',
  );
  process.exit(fail ? 1 : 0);
}

worker.postMessage({
  cmd: 'run',
  pluginPath: fileURLToPath(new URL('./4-hello.plugin.ts', import.meta.url)),
});
