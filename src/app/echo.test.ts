/**
 * app — Echo 金样双拓扑 parity 测试（契约篇 §1.7 金样应用，第二十七批刀三）。
 *
 * 同一份 authored 码（src/app/echo.ts）以两行进同一组合树：
 *   - echo-main   runtime: main  （主线程直载——真 ctx 作用域）
 *   - echo-worker runtime: worker（worker 域桥接——桩 ctx + 过桥 RPC）
 * 行 id 非 builtin: 前缀（装载身份 = 测试资产——机器执法保持前缀纯，§1.7）；
 * overlay 直指入口文件真身（单源——非测试内联 fixture 副本）。
 *
 * parity 断言面（两域行为收敛——桥协议/装载管线任一侧漂移即红）：
 * 1. 两行 activated；
 * 2. 工具经注册表可执行（worker 行 execute 过桥回 worker 真实现）；
 * 3. 服务双通 + 调用面异步收窄分叉文档化：main get 同步真值、worker get
 *    RPC stub（Promise 面唯一形态）——「声明面零变化、调用面允许异步收窄」；
 * 4. 收窄清单 v1 逐项核：worker 五面全 BRIDGE_SURFACE_NARROWED；main 五面全
 *    ok——三派发面以模式各就的探针词（echo/par|ser|wf）真跑通，两
 *    registration 面真注册（差分即文档）；
 * 5. 事件往返：宿主 root emit echo/tick → 双域行内轨迹打点（worker 经 sub
 *    转发器过桥回投——fire-and-forget 异步到达，轮询等）；
 * 6. dispose 面（/reload）：main 行 effect LIFO 回卷（轨迹尾部 down）+ 服务
 *    换新（identity 分叉）；worker 旧 RPC 代理随域收编不可达
 *    （BRIDGE_WORKER_EXITED）；重装后双行工具仍可执行（双拓扑重装载收敛）。
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBerryRuntime } from './assembly.js';
import { BRIDGE_SURFACE_NARROWED, BRIDGE_WORKER_EXITED } from '../contracts/errors.js';
import { appZoneId, tryResolveService } from '../context/index.js';

/** 金样 authored 码真身（overlay 两行直指同一入口——双拓扑同一份源码） */
const ECHO_ENTRY = realpathSync(fileURLToPath(new URL('./echo.ts', import.meta.url)));

/** 轮询直到谓词为真（worker 域 fire-and-forget 异步到达面的确定性等待） */
async function until(predicate: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect.unreachable(`轮询超时（${ms}ms）——异步面未到达`);
}

/** main 域 taps 服务面（真对象引用——echo 同步真值；narrowed async：派发面 Promise reject 站内收敛） */
interface MainTaps {
  echo(x: unknown): unknown;
  trace(): string[];
  narrowed(): Promise<Record<string, string>>;
}

/** worker 域 taps 服务面（RPC stub——方法调用过界，Promise 面唯一形态） */
interface WorkerTaps {
  echo(x: unknown): Promise<unknown>;
  trace(): Promise<string[]>;
  narrowed(): Promise<Record<string, string>>;
}

describe('Echo 金样双拓扑 parity（契约篇 §1.7）', () => {
  it('同一份 authored 码在 main/worker 两域行为收敛', async () => {
    const compositionDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'echo-')));
    // overlay 两行：同一入口、slot 参数化防撞名（服务/工具名按 slot 分岔——
    // 真注册表查重执法面与跨用例隔离，两行互不知晓互不碰撞）。apps: [chat]——
    // 触发② 执法下第三方行必挂应用（chat 为在册官方应用；worker 行同语义）
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      [
        'rows:',
        '  - id: echo-main',
        `    pkg: ${ECHO_ENTRY}`,
        '    sandbox: { carrier: main }',
        '    apps: [chat]',
        '    config: { slot: main }',
        '  - id: echo-worker',
        `    pkg: ${ECHO_ENTRY}`,
        '    sandbox: { carrier: worker }',
        '    apps: [chat]',
        '    config: { slot: worker }',
        '',
      ].join('\n'),
    );
    const runtime = await createBerryRuntime({
      dbPath: ':memory:',
      workspace: compositionDir,
      compositionDir,
    });
    try {
      // ① 两行 activated（装载身份：普通第三方形态注入，行 id 非 builtin:）
      const statuses = runtime.appsService.list();
      expect(statuses.find((r) => r.id === 'echo-main')).toMatchObject({ status: 'activated' });
      expect(statuses.find((r) => r.id === 'echo-worker')).toMatchObject({ status: 'activated' });

      // ② 工具经注册表可执行：声明面双行都在（worker 行声明面本地、execute 过桥）。
      // 行挂 app: chat（触发②）→ 工具落 chat 应用域层——get 全局面不查域层，
      // 按应用域视角取（D1 域层路由口径）
      const toolMain = runtime.tools.listFor('chat').find((t) => t.name === 'echo/echo-main');
      const toolWorker = runtime.tools.listFor('chat').find((t) => t.name === 'echo/echo-worker');
      expect(toolMain).toBeDefined();
      expect(toolWorker).toBeDefined();
      const rMain = await toolMain!.execute({ text: 'hi-main' }, { toolCallId: 'echo:test:main' });
      const rWorker = await toolWorker!.execute({ text: 'hi-worker' }, { toolCallId: 'echo:test:worker' });
      expect(rMain).toMatchObject({ content: [{ type: 'text', text: 'hi-main' }] });
      expect(rWorker).toMatchObject({ content: [{ type: 'text', text: 'hi-worker' }] });

      // ③ 服务双通 + 异步收窄分叉（§1.7 同步面投影策略——文档化断言）：
      // main 域 get 返回真服务（echo 同步等值）；worker 域 get 返回 RPC stub
      // （echo 调用即 Promise——方法调用过界，Promise 面唯一形态）。
      // 取法 = 按区读链（D3 装载分面分区：行挂 apps: [chat] → 服务落 chat
      // 区表，root get 读链只查系统区表查不到——tryResolveService 带 zone）
      const mainTaps = tryResolveService(runtime.ctx, appZoneId('chat'), 'echo/taps-main') as MainTaps;
      const workerTaps = tryResolveService(runtime.ctx, appZoneId('chat'), 'echo/taps-worker') as WorkerTaps;
      expect(mainTaps.echo('v')).toBe('v');
      expect(workerTaps.echo('v')).toBeInstanceOf(Promise);
      await expect(workerTaps.echo('v')).resolves.toBe('v');

      // ④ 收窄清单 v1 逐项核（§1.7）：worker 桩五面全 NARROWED（宁响亮不静默
      // 假实现）；main 真面五面全 ok——三派发面以模式各就的探针词（echo/par|
      // ser|wf）真跑通（词汇执法过 = 真派发面在场），两 registration 面真注册
      expect(await mainTaps.narrowed()).toEqual({
        parallel: 'ok',
        serial: 'ok',
        waterfall: 'ok',
        registerMessageRole: 'ok',
        registerSessionEventType: 'ok',
      });
      await expect(workerTaps.narrowed()).resolves.toEqual({
        parallel: BRIDGE_SURFACE_NARROWED,
        serial: BRIDGE_SURFACE_NARROWED,
        waterfall: BRIDGE_SURFACE_NARROWED,
        registerMessageRole: BRIDGE_SURFACE_NARROWED,
        registerSessionEventType: BRIDGE_SURFACE_NARROWED,
      });

      // ⑤ 事件往返：宿主 root emit → main 行同步打点 + worker 行过桥回投打点
      runtime.ctx.emit('echo/tick', 'v1');
      expect(mainTaps.trace()).toContain('up'); // effect 上下已进轨迹（apply 完成）
      expect(mainTaps.trace()).toContain('tick:v1');
      await until(async () => (await workerTaps.trace()).includes('tick:v1'));

      // ⑥ dispose 面（/reload 全量重载：main 行作用域回卷 / worker 域收编换新）
      const reload = await runtime.reload();
      expect(reload.error).toBeUndefined();
      expect(reload.payload?.activated).toEqual(expect.arrayContaining(['echo-main', 'echo-worker']));
      // main 行 effect LIFO：回卷后轨迹尾部 down（旧对象闭包仍可观测——
      // 真作用域回卷的执行证据，非注册表遮蔽）
      const trace = mainTaps.trace();
      expect(trace[trace.length - 1]).toBe('down');
      // 服务换新：重装载后 provide 物是全新对象（identity 分叉）。按区读链取
      //（同 ③——D3 分区后 root get 不查应用区表）
      expect(tryResolveService(runtime.ctx, appZoneId('chat'), 'echo/taps-main')).not.toBe(mainTaps);
      // worker 旧 RPC 代理随域收编不可达（端点 dispose 后调用即刻拒绝）
      await expect(workerTaps.echo('x')).rejects.toMatchObject({ code: BRIDGE_WORKER_EXITED });
      // 重装后双行工具仍可执行（双拓扑重装载收敛——含 main 行注册摘除/重注册）。
      // 应用域层口径取具（行挂 app: chat——同 ② 取具面）
      const rWorker2 = await runtime.tools
        .listFor('chat')
        .find((t) => t.name === 'echo/echo-worker')!
        .execute({ text: 'hi-again' }, { toolCallId: 'echo:test:again' });
      expect(rWorker2).toMatchObject({ content: [{ type: 'text', text: 'hi-again' }] });
    } finally {
      await runtime.shutdown();
      rmSync(compositionDir, { recursive: true, force: true });
    }
  }, 30_000);
});
