/**
 * L4 exec 单元测试 — spawn 管道（真子进程，无 mock）。
 *
 * 覆盖：失败二分两腿（未启动抛 EXEC_SPAWN_FAILED 携 cause.code / 退出非零
 * 正常返回）/ 超时树杀抛 TOOL_TIMEOUT / stdin 一次性喂入 / onOutput 流式 /
 * 合并预算保尾截断 / abort 取消正常结算 / classifyDenials 分类。
 * POSIX 环境跑（CI = darwin/linux）；Windows 无 bash 不在本测试矩阵。
 */

import { describe, expect, it } from 'vitest';
import { EventEmitter, getEventListeners } from 'node:events';
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, EXEC_SPAWN_FAILED, TOOL_TIMEOUT } from '../contracts/errors.js';
import { classifyDenials, runArgv, killTree, OUTPUT_BUDGET_BYTES } from './spawn.js';

/** 仓内 tsx CLI（src/exec → 上两级 = 仓根；子进程以 tsx 转译真源码形态起跑） */
const TSX_CLI = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));

/** 断言拒绝码（错误码是唯一判据） */
async function expectRejectCode(fn: () => Promise<unknown>, code: string): Promise<AppError> {
  try {
    await fn();
    expect.unreachable('应当抛错');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
  }
}

describe('失败二分（未启动 ≠ 退出非零）', () => {
  it('程序不存在 = EXEC_SPAWN_FAILED 携 cause.code=ENOENT（绝不折算 exit 1）', async () => {
    const err = await expectRejectCode(() => runArgv(['definitely-not-a-program-xyz']), EXEC_SPAWN_FAILED);
    expect(err.message).toContain('ENOENT');
  });
  it('退出非零 = 正常返回 {exitCode, stderr}——不是异常', async () => {
    const run = await runArgv(['bash', '-c', 'echo boom >&2; exit 3']);
    expect(run.exitCode).toBe(3);
    expect(run.stderr).toContain('boom');
    expect(run.signal).toBeUndefined();
  });
});

describe('正常执行', () => {
  it('stdout 采集 + exitCode 0 + durationMs 计时', async () => {
    const run = await runArgv(['bash', '-c', 'echo hello']);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('hello\n');
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.truncated).toBe(false);
  });
  it('stdin 一次性写入（cat 回显）', async () => {
    const run = await runArgv(['bash', '-c', 'cat'], { stdin: 'abc-stdin' });
    expect(run.stdout).toBe('abc-stdin');
  });
  it('子进程不读 stdin 也不算失败（EPIPE 吞掉）', async () => {
    const run = await runArgv(['bash', '-c', 'echo ok'], { stdin: 'ignored' });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('ok\n');
  });
});

describe('超时自治（execute 内自计时 + 树杀）', () => {
  it('到点抛 TOOL_TIMEOUT，不等满命令时长', async () => {
    // 单调钟 + 相对阈值（遗漏大扫 20260903 test D8-2）：墙钟 Date.now 免疫 NTP
    // 跳变缺失、绝对阈值不随参数伸缩——统一 performance.now + `timeoutMs*2+1000`
    //（修前红语义不破：陪跑 30s 远超 1600）
    const started = performance.now();
    await expectRejectCode(() => runArgv(['bash', '-c', 'sleep 30'], { timeoutMs: 300 }), TOOL_TIMEOUT);
    expect(performance.now() - started).toBeLessThan(300 * 2 + 1000); // 没陪跑 30s
  });
  it('树杀杀整组：孙进程一并终结（killpg 负 pid）', async () => {
    // bash -c 起 sleep 孙进程后主 sleep 挂着；超时树杀后全组死——若只杀直接
    // 子进程，孙 sleep 会拖着 close 不来（测试以 TOOL_TIMEOUT 及时到为证）
    await expectRejectCode(() => runArgv(['bash', '-c', 'sleep 30 & sleep 30'], { timeoutMs: 300 }), TOOL_TIMEOUT);
  });
});

describe('后台孤儿形态执法（运行时探针 20260902 F-2 修死）', () => {
  it('超时腿：主进程秒退 + 后台 & 孤儿持管道——预算点整组树杀结算，不被孤儿寿命绑架', { timeout: 12_000 }, async () => {
    // 修前实证（探针真跑 8014ms 才结算）：killTree 守卫 child.exitCode===null
    // 在主 bash 秒退后为 false → killpg 不发（守卫反掉设计意图：孤儿存在 ⟺
    // 主进程已退）→ 孤儿同 pgid 存活持有 stdout 管道 → close 等管道 EOF →
    // 结算被孤儿自然寿命绑架、sleep 泄漏、文案谎称「进程组已树杀」。
    // 修后：无条件 killpg（组空 ESRCH 落 catch 无害）→ 预算点结算。
    const started = performance.now();
    await expectRejectCode(() => runArgv(['bash', '-c', 'sleep 8 & echo launched'], { timeoutMs: 1500 }), TOOL_TIMEOUT);
    // 相对阈值（timeoutMs*2+1000，D8-2）——修前 ~8000ms（孤儿 8s 自然退出）
    expect(performance.now() - started).toBeLessThan(1500 * 2 + 1000);
  });

  it('取消腿：abort 树杀不被孤儿管道绑架结算', { timeout: 12_000 }, async () => {
    // 修前实证（探针真跑 +12068ms 才结算）：abort 腿同守卫不杀 → 孤儿持管道
    // → close 等到孤儿 12s 自然退出。修后：abort 无条件 killpg → 管道随孤儿
    // 死而关 → close 及时到，主进程正常退出码照常结算
    const ac = new AbortController();
    const ABORT_AT_MS = 300; // abort 锚（相对阈值随锚伸缩——D8-2）
    setTimeout(() => ac.abort(), ABORT_AT_MS);
    const started = performance.now();
    const run = await runArgv(['bash', '-c', 'sleep 12 & echo go'], { signal: ac.signal });
    expect(performance.now() - started).toBeLessThan(ABORT_AT_MS * 2 + 1000); // 修前 ~12000ms
    expect(run.exitCode).toBe(0); // 主进程早已正常退出——abort 不是失败二分腿
  });

  it(
    '组外管道持有者（detached 异组孤儿）：树杀不可达也不绑架结算——执法后宽限主动结算',
    { timeout: 12_000 },
    async () => {
      // killpg 结构性罩组内成员；detached 异组孤儿（setsid 逃逸族——威胁模型
      // 外不追杀）持管道时 close 永等其自然退出。修后：执法已发（组内
      // SIGKILL 不可挡）而 close 宽限内未至 → 按 exit 事件已知信息主动结算，
      // 不被输出流尾巴绑架（探针 F-2 修法②）。
      const started = performance.now();
      await expectRejectCode(
        () =>
          runArgv(
            [
              process.execPath,
              '-e',
              'const {spawn}=require("node:child_process");' +
                'spawn(process.execPath,["-e","setTimeout(()=>{},12000)"],' +
                '{detached:true,stdio:["ignore",1,2]});console.log("go")',
            ],
            { timeoutMs: 1200 },
          ),
        TOOL_TIMEOUT,
      );
      // 相对阈值（timeoutMs*2+1000，D8-2）——修前 ~12000ms（异组孤儿自然退出）
      expect(performance.now() - started).toBeLessThan(1200 * 2 + 1000);
    },
  );
});

describe('宽限结算流销毁（遗漏大扫 20260903 fix-code D1-1 修死）', () => {
  it(
    '组外管道持有者形态：runArgv 宽限结算返回后进程自然退出（修前管道句柄钉死事件循环）',
    { timeout: 20_000 },
    async () => {
      // 进程级探针（探针 leak-runargv2.mts 转正）：子进程跑真身 runArgv——主
      // 进程秒退 + detached 异组孙进程持管道（'inherit'）+ 300ms abort → 宽限
      // 主动结算生效 runArgv 正常返回；修前：结算后 child.stdout/stderr 的
      // libuv poll handle 存活钉死事件循环，子进程永不自然退出（探针实证
      // +3557ms 仍活、看门狗强杀）——单发 CLI 用户视角挂死、daemon 泄漏 fd。
      // 修后：合成结算腿补 destroy 两流 → 事件循环放空自然退出（exit 0）。
      // 孙进程用有界 setTimeout（8s 自灭）防测试自身泄漏；看门狗 4s exit(9)
      // 区分「钉死」与「退出」两种终态。
      const spawnModule = fileURLToPath(new URL('./spawn.ts', import.meta.url));
      const script = [
        `import { runArgv } from ${JSON.stringify(spawnModule)};`,
        `const NODE = process.execPath;`,
        `const inner = ${JSON.stringify(
          `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], ` +
            `{ stdio: ['ignore', 'inherit', 'ignore'], detached: true, windowsHide: true }); process.exit(0);`,
        )};`,
        `const ac = new AbortController();`,
        `setTimeout(() => ac.abort(), 300);`,
        `try {`,
        `  const run = await runArgv([NODE, '-e', inner], { signal: ac.signal });`,
        `  console.log('RUN_ARGV_RETURNED exitCode=' + run.exitCode);`,
        `} catch (e) { console.log('RUN_ARGV_THROWN ' + (e && e.code)); }`,
        `console.log('SCRIPT_DONE');`,
        // 看门狗必须 unref——普通定时器自身就钉住事件循环，会把「自然退出」
        // 误判成悬挂；unref 后仅当循环被真句柄（修前=管道读端）钉住时才触发
        `setTimeout(() => { console.log('WATCHDOG_FIRED'); process.exit(9); }, 4000).unref();`,
      ].join('\n');
      const scriptPath = join(tmpdir(), `spawn-grace-exit-${process.pid}-${Date.now()}.mts`);
      writeFileSync(scriptPath, script);
      try {
        const child = spawn(process.execPath, [TSX_CLI, scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout!.on('data', (d: Buffer) => {
          out += d.toString();
        });
        child.stderr!.on('data', (d: Buffer) => {
          out += d.toString();
        });
        const code = await new Promise<number>((resolve) => {
          child.on('exit', (c) => resolve(c ?? -1));
        });
        expect(out).toContain('RUN_ARGV_RETURNED'); // 宽限结算本身生效（F-2 修法②语义不破）
        expect(out).toContain('SCRIPT_DONE');
        expect(out).not.toContain('WATCHDOG_FIRED'); // 修前：4s 看门狗强杀即此标记
        expect(code).toBe(0); // 自然退出（修前 exit 9）
      } finally {
        rmSync(scriptPath, { force: true });
      }
    },
  );
});

describe('命令进程登记簿（契约篇 §6.6 exec 腿——spawn 即登记/净退即删）', () => {
  it('长命命令执行中已登记（含命令行标签），净退后撤销同 pid', { timeout: 15_000 }, async () => {
    const added: Array<{ pid: number; label: string }> = [];
    const removed: number[] = [];
    const commandLog = {
      add: (pid: number, label: string): void => {
        added.push({ pid, label });
      },
      remove: (pid: number): void => {
        removed.push(pid);
      },
    };
    const pending = runArgv(['bash', '-c', 'sleep 0.5 && echo done'], { commandLog });
    // 执行中轮询到登记（'spawn' 事件先于 close——登记必须发生在进程活着的窗口内，
    // 这是「宿主猝死后清扫簿上有账」的前提）
    const deadline = Date.now() + 10_000;
    while (added.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(added.length).toBe(1);
    expect(added[0]!.pid).toBeGreaterThan(0);
    expect(added[0]!.label).toContain('bash'); // 标签 = PID 复用防护的命令行比对基线
    expect(removed).toEqual([]); // 尚未净退——不许提前删
    const run = await pending;
    expect(run.exitCode).toBe(0);
    expect(removed).toEqual([added[0]!.pid]); // 净退即删（close 配对）
  });
  it('超时树杀路同样撤销登记（close 收全四路结算）', { timeout: 15_000 }, async () => {
    const added: number[] = [];
    const removed: number[] = [];
    await expectRejectCode(
      () =>
        runArgv(['bash', '-c', 'sleep 30'], {
          timeoutMs: 300,
          commandLog: {
            add: (pid) => {
              added.push(pid);
            },
            remove: (pid) => {
              removed.push(pid);
            },
          },
        }),
      TOOL_TIMEOUT,
    );
    expect(added.length).toBe(1);
    expect(removed).toEqual(added); // 树杀 → close → 撤销，账面归零
  });
});

describe('abort 取消（正常结算，signal 字段识别）', () => {
  it('abort 后树杀并以带 signal 的结果结算（不抛错）', async () => {
    const controller = new AbortController();
    const runPromise = runArgv(['bash', '-c', 'sleep 30'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const run = await runPromise;
    expect(run.exitCode).toBeNull();
    expect(run.signal).toBeDefined();
  });
});

describe('复盘 20260901 L-3 回归锁（abort 监听器摘除 + 超时归因不被 abort 吞）', () => {
  it('监听器不跨调用累积：结算即摘——共享 runAbort.signal 的 N 次调用后零残留', async () => {
    // 同一 run 内 N 次 bash 调用共享同一 signal（conversation.ts 接线形态）——
    // 监听器闭包钉住已退 child + 双 60KiB 输出缓冲，直到 run 结束才随 signal 释放
    const controller = new AbortController();
    await runArgv(['bash', '-c', 'echo one'], { signal: controller.signal });
    await runArgv(['bash', '-c', 'echo two'], { signal: controller.signal });
    // HEAD：once 只保证触发后自摘——正常完成的调用监听器永不触发即永不摘（2 残留）；
    // 修复后：结算即 removeEventListener（零残留，signal 生命周期内不积攒）
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('超时归因先到先得：超时树杀后 close 前 abort 到达——TOOL_TIMEOUT 不被覆写吞掉', { timeout: 15_000 }, async () => {
    const controller = new AbortController();
    // 竞速窗制造：内层 node spawn detached:true 即 setsid 脱组（自成一组成新会话
    // 首领）且 stdio inherit 持有主进程的 stdout/stderr 管道——组杀（超时腿）
    // 不及其身；Node 'close' = exit + stdio 流关——被内层钉住到它退出（~1.5s），
    // 制造「超时已武装（250ms）、close 未到（1.5s）」窗，窗内（400ms）abort 到达
    const script =
      "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], " +
      "{ detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); setTimeout(() => {}, 30000);";
    const runPromise = runArgv([process.execPath, '-e', script], {
      timeoutMs: 250,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 400);
    // HEAD：onAbort 首行 timedOut = false 无条件覆写 → settle 走正常结算腿
    //（只见 SIGKILL，TOOL_TIMEOUT 归因丢失）；修复后：超时归因不被 abort 吞
    await expectRejectCode(() => runPromise, TOOL_TIMEOUT);
  });
});

describe('onOutput 流式增量', () => {
  it('执行中即推（run-to-completion 单品是 pi-7 反面）', async () => {
    const chunks: Array<{ stream: string; text: string }> = [];
    const run = await runArgv(['bash', '-c', 'echo one; echo two >&2; echo three'], {
      onOutput: (chunk) => chunks.push({ stream: chunk.stream, text: chunk.text }),
    });
    expect(run.stdout).toContain('one');
    expect(chunks.length).toBeGreaterThanOrEqual(2); // 不是终态一次性倒
    expect(chunks.some((c) => c.stream === 'stderr' && c.text.includes('two'))).toBe(true);
  });
});

describe('输出预算（合并 60 KiB 保尾截断）', () => {
  it('超预算保尾：尾部标记可见、头部长串被弃、truncated=true', async () => {
    // 头部 100 KiB 垃圾 + 尾部标记——保尾语义 = 标记必须在
    const run = await runArgv(['bash', '-c', 'head -c 102400 /dev/zero | tr "\\0" "a"; echo TAIL-MARKER']);
    expect(run.truncated).toBe(true);
    expect(run.stdout.endsWith('TAIL-MARKER\n')).toBe(true);
    expect(run.stdout.startsWith('aaaa')).toBe(true); // 保尾 = 尾留头弃
    const total = Buffer.byteLength(run.stdout, 'utf8') + Buffer.byteLength(run.stderr, 'utf8');
    expect(total).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES + 128); // 预算线内（标注行余量）
  });
});

describe('classifyDenials（stderr 按后端签名分类）', () => {
  it('大小写不敏感子串命中；未命中 = 空数组', () => {
    expect(classifyDenials('Operation not permitted', ['Operation not permitted'])).toEqual([
      'Operation not permitted',
    ]);
    expect(classifyDenials('operation NOT permitted', ['Operation not permitted'])).toEqual([
      'Operation not permitted',
    ]);
    expect(classifyDenials('just a warning', ['Operation not permitted'])).toEqual([]);
    expect(classifyDenials('anything', [])).toEqual([]);
  });
});

describe('输出编码（决策树 spawn 半边，P1-3 挖矿 B11 缺口④）', () => {
  it('干净 UTF-8 输出 = 双流终判 utf-8（快路零探测）', async () => {
    const run = await runArgv(['bash', '-c', 'echo 你好']);
    expect(run.outputEncoding).toEqual({ stdout: 'utf-8', stderr: 'utf-8' });
    expect(run.stdout).toContain('你好');
  });

  it('GBK 字节输出（非 win32 无标签）= 有损终态 + utf-8-lossy 标注（非静默纪律）', async () => {
    // printf 直出 '测试' 的 GBK 字节 B2 E2 CA D4——非 win32 本地标签恒空，落④有损
    const run = await runArgv(['bash', '-c', "printf '\\xb2\\xe2\\xca\\xd4'"]);
    expect(run.exitCode).toBe(0);
    expect(run.outputEncoding.stdout).toBe('utf-8-lossy');
    // 有损文本含替换符（绝不静默伪装成成功解码）
    expect(run.stdout).toContain('�');
  });

  it('双流独立判定：stdout UTF-8 + stderr GBK 字节 → 两流终判分叉', async () => {
    const run = await runArgv(['bash', '-c', "echo ok; printf '\\xb2\\xe2\\xca\\xd4' >&2"]);
    expect(run.outputEncoding.stdout).toBe('utf-8');
    expect(run.outputEncoding.stderr).toBe('utf-8-lossy');
  });
});

describe('killTree win32 腿形状（deps 注入缝——POSIX CI 上锁形状）', () => {
  /** 假 spawn：记参序 + 微任务内即报 close（win32KillTree 的 await 随之走完） */
  function fakeSpawnRecorder(calls: string[][]): typeof import('node:child_process').spawn {
    return ((program: string, args: readonly string[]) => {
      calls.push([program, ...args]);
      const fake = new EventEmitter();
      queueMicrotask(() => fake.emit('close', 0));
      return fake as unknown as import('node:child_process').ChildProcess;
    }) as unknown as typeof import('node:child_process').spawn;
  }

  /** killTree win32 腿异步收尾等待口（生产面 fire-and-forget；测试等它走完再断言） */
  async function killTreeAsync(pid: number, deps: Parameters<typeof killTree>[1]): Promise<void> {
    killTree(pid, deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('快照全集多 /PID 单发 + /T 竞态带（MSYS fork 孤儿不漏杀）', async () => {
    const calls: string[][] = [];
    await killTreeAsync(4242, {
      platform: 'win32',
      spawnKill: fakeSpawnRecorder(calls),
      enumerateTree: async (root) => [root, 100, 200],
    });
    expect(calls).toHaveLength(1); // 单发
    expect(calls[0]).toEqual(['taskkill', '/T', '/F', '/PID', '4242', '/PID', '100', '/PID', '200']);
  });

  it('枚举失败回退裸 taskkill /T /PID root（等价旧行为，绝不空手而归）', async () => {
    const calls: string[][] = [];
    await killTreeAsync(777, {
      platform: 'win32',
      spawnKill: fakeSpawnRecorder(calls),
      enumerateTree: async () => {
        throw new Error('PowerShell 缺席');
      },
    });
    expect(calls[0]).toEqual(['taskkill', '/T', '/F', '/PID', '777']);
  });

  it('POSIX 腿零 spawn（killpg 走 process.kill——进程组即树等价物）', async () => {
    const calls: string[][] = [];
    // pid 大到不存在 → process.kill 抛（catch 静默）；断言只看无 taskkill 发出
    await killTreeAsync(999999, { platform: 'darwin', spawnKill: fakeSpawnRecorder(calls) });
    expect(calls).toHaveLength(0);
  });
});
