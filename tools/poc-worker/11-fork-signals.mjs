#!/usr/bin/env node
/**
 * PoC ⑪（第三十七批 PoC 台账·补炮七）：信号编舞对子域传导。
 *
 * d37 研究判词：external 域的关停编舞 = 「告别（graceful handler 跑完）→
 * 宽限（超时阈值）→ 树杀（SIGKILL 升级）」，且 PM 沙箱不拦信号投递。
 * 本炮三景对照（子按 argv 模式自扮）：
 *   景一（乖子）：子带 SIGTERM handler（告别行 + 收尾退出）→ 父 SIGTERM →
 *     告别行先于进程退出到达 → 宽限期内自然退（无需升级）；
 *   景二（赖子）：子吞 SIGTERM（handler 空挂）→ 父 SIGTERM → 宽限超时 →
 *     父升级 SIGKILL → 子被强杀（exit 事件 signal=SIGKILL）；
 *   景三（PM 子）：--permission 沙箱内的子照常收 SIGTERM 并告别——PM 管文件
 *     系统与 addon，不管信号投递。
 * 退出码：0 = PASS，1 = FAIL。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const childPath = fileURLToPath(new URL('./11-fork-signals.child.mjs', import.meta.url));

// 30 秒硬超时
const timer = setTimeout(() => {
  console.error('FAIL: PoC 超时（30s）——信号编舞疑似挂死');
  process.exit(1);
}, 30_000);
timer.unref();

let fail = false;

/**
 * 跑一景：spawn 指定模式子 → 等 READY → 发 SIGTERM → 裁决。
 * @param {string} label 景名（打印用）
 * @param {string} mode 子模式（good|stubborn|pm）
 * @param {object} opts 判据参数 {expectFarewell, expectSignalKill, graceMs}
 */
function runScene(label, mode, opts) {
  return new Promise((resolve) => {
    // PM 景加沙箱旗（读白名单只给入口自身——子不读别的文件）
    const execArgv = mode === 'pm' ? ['--permission', `--allow-fs-read=${childPath}`] : [];
    const child = spawn(process.execPath, [...execArgv, childPath, mode], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const lines = createInterface({ input: child.stdout });
    const events = []; // 事件序：READY / FAREWELL / exit 的相对顺序是判定对象
    let killed = false;

    lines.on('line', (l) => {
      const t = l.trim();
      if (t === 'READY' || t === 'FAREWELL') events.push(t);
      if (t === 'FAREWELL') {
        // 告别已到——赖子景不应走到这里（外层判据兜）
      }
    });

    child.on('exit', (code, signal) => {
      events.push(`exit(code=${code},signal=${signal})`);
      let pass;
      if (opts.expectFarewell) {
        // 乖子/PM 子：告别行先于 exit（顺序断言）+ 自然退（signal 为 null）
        const farewellBeforeExit = events.indexOf('FAREWELL') < events.length - 1 && events.includes('FAREWELL');
        pass = farewellBeforeExit && signal === null;
        console.log(
          `[${label}] 事件序=[${events.join(' → ')}] → ${pass ? 'PASS（告别先于退出，宽限期内自然退）' : 'FAIL'}`,
        );
      } else {
        // 赖子：升级 SIGKILL 强杀（signal=SIGKILL）
        pass = signal === 'SIGKILL';
        console.log(
          `[${label}] 事件序=[${events.join(' → ')}] 升级强杀=${signal === 'SIGKILL'} → ${pass ? 'PASS（宽限超时 SIGKILL 升级成立）' : 'FAIL'}`,
        );
      }
      if (!pass) fail = true;
      resolve();
    });

    // READY 后才开火（保证 handler 已挂好）
    const onReady = setInterval(() => {
      if (events.includes('READY')) {
        clearInterval(onReady);
        child.kill('SIGTERM'); // 第一段：告别信号
        if (!opts.expectFarewell) {
          // 赖子景：宽限后升级（生产语义 = 同款两段）。
          // 注意 child.killed 只表示「发过信号」不表示「死了」——判活只能看 exitCode
          setTimeout(() => {
            if (child.exitCode === null) {
              killed = true;
              child.kill('SIGKILL');
            }
          }, opts.graceMs);
        }
      }
    }, 20);
  });
}

// 景一：乖子——SIGTERM 告别先于退出
await runScene('景一·乖子', 'good', { expectFarewell: true });
// 景二：赖子——吞 SIGTERM，宽限 600ms 后 SIGKILL 升级
await runScene('景二·赖子', 'stubborn', { expectFarewell: false, graceMs: 600 });
// 景三：PM 子——沙箱内信号照投
await runScene('景三·PM子', 'pm', { expectFarewell: true });

clearTimeout(timer);
console.log(
  fail ? '== PoC ⑪ 结论: FAIL（信号编舞传导证伪）==' : '== PoC ⑪ 结论: PASS（告别→宽限→树杀三段成立 + PM 不拦信号）==',
);
process.exit(fail ? 1 : 0);
