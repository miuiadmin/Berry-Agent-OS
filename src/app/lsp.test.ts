/**
 * L5 app — lsp 官方件全栈测试（契约篇 §6.7 第一刀：默认层第十二行）。
 *
 * 件逻辑轨——真 Context + 真 tools 注册面 + 真 JsonRpcConnection（mcp 桥核
 * 帧无关复用的接线验证）+ 真 post 管道（TOOL_POST_EXECUTE_EVENT 全瀑布派发），
 * 只有子进程是假的（PassThrough 流对 + Content-Length 帧脚本化应答器）。
 *
 * 覆盖：apply 语义（空表/非法键/惰性兑现）、四工具端到端（路由/根外/ensure-open
 * 管线）、post 注入（预热首触注记/已活诊断段/delete 告别/超时降级）、熔断
 * （3 连败 + notify）、effect 回卷（登记簿落删 + 协议化关停）。
 */

import { PassThrough } from 'node:stream';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../context/index.js';
import type { ContextScope } from '../context/index.js';
import { createToolPipeline } from '../tools/pipeline.js';
import { registerToolsService } from '../tools/registry.js';
import type { ToolsService } from '../contracts/tools.js';
import { Type } from '../contracts/typebox.js';
import { APP_CONFIG_INVALID } from '../contracts/errors.js';
import type { AgentToolResult } from '../contracts/tools.js';
import { JsonRpcConnection } from '../mcp/index.js';
import { createLspApp } from '../lsp/index.js';
import type { LspAppDeps } from '../lsp/index.js';
import type { SpawnedProcess } from '../lsp/client.js';
import { createFrameDecoder, encodeFrame } from '../lsp/framing.js';

/* ---------------- 测试基建 ---------------- */

/** 新临时目录（realpath 防 macOS /var 符号链接漂移） */
const makeTempDir = (prefix: string): string => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));

/**
 * 脚本化 LSP 服务器（Content-Length 帧收发——真帧层与真桥都参与）：
 * 自动应答 initialize/shutdown；didOpen/didChange 按 diagnostics 回调推送
 * publishDiagnostics（version 回显——post 注入等待对齐的确定性驱动源）；
 * documentSymbol/definition/references 按注入表应答。
 */
interface FakeLspServer {
  child: SpawnedProcess;
  /** 服务器侧收到的全部消息（帧已解码） */
  frames: Array<Record<string, unknown>>;
  /** 模拟子进程退出（guarded：stdout 只真关一次，可重复触发） */
  die: (code: number | null) => void;
}

/** 假服务器行为面（per-测试配置） */
interface FakeServerBehavior {
  /** uri → 诊断集；undefined = 不推送（超时降级用例）；缺省 [] = 推空集 */
  readonly diagnosticsFor?: (
    uri: string,
  ) => { message: string; severity?: number; line?: number; code?: number }[] | undefined;
  /** documentSymbol 应答（缺省空表） */
  readonly symbols?: { name: string; line?: number }[];
  /** definition/references 应答（缺省空表） */
  readonly locations?: { uri: string; line: number; character: number }[];
  /** initialize 永不应答（握手窗观察用——spawn 即写测试的聋形态） */
  readonly hangInitialize?: boolean;
}

/** 全部假服务器登记（afterEach 统一 die——让关停宽限即刻结算不留 3s 计时器） */
const fakes: FakeLspServer[] = [];
/** 本用例根作用域登记（afterEach 统一回卷） */
const roots: ContextScope[] = [];
afterEach(async () => {
  for (const root of roots) await root.dispose();
  roots.length = 0;
  // 作用域回卷触发的协议化关停在后台竞速——die 全部假件让宽限立即赢
  for (const fake of fakes) fake.die(0);
  fakes.length = 0;
});

/** 造一台假 LSP 服务器 */
function makeFakeLspServer(behavior: FakeServerBehavior, pid: number): FakeLspServer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.on('error', () => undefined); // 重复 end 的无害化（die 可多次触发）
  const closeCbs: Array<(code: number | null, signal: string | null) => void> = [];
  let stdoutEnded = false;
  const child: SpawnedProcess = {
    pid,
    stdin: {
      write: (chunk: string) => stdin.write(chunk),
      end: () => stdin.end(),
      on: () => undefined,
    },
    stdout,
    stderr: { on: () => undefined },
    on: (event: 'close', cb: (code: number | null, signal: string | null) => void) => {
      if (event === 'close') closeCbs.push(cb);
    },
  };
  const frames: Array<Record<string, unknown>> = [];
  const send = (obj: unknown): void => {
    stdout.write(encodeFrame(JSON.stringify(obj)));
  };
  const sendResult = (id: unknown, result: unknown): void => send({ jsonrpc: '2.0', id, result });

  /** didOpen/didChange 触达 → 推诊断（version 回显——waiter 对齐的确定性源） */
  const pushDiagnostics = (uri: string, version: number | undefined): void => {
    const diags = behavior.diagnosticsFor?.(uri);
    if (diags === undefined) return; // 不推送（超时降级用例）
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        version,
        diagnostics: diags.map((d) => ({
          message: d.message,
          severity: d.severity ?? 1,
          code: d.code,
          // 行号 1-based 声明 → 0-based 协议（client 呈现前再 +1 回来）
          range: {
            start: { line: (d.line ?? 1) - 1, character: 0 },
            end: { line: (d.line ?? 1) - 1, character: 3 },
          },
        })),
      },
    });
  };

  // 服务器侧帧解码（真帧层）+ 应答编舞
  const feedServer = createFrameDecoder((json) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    frames.push(frame);
    const id = frame['id'];
    const method = String(frame['method'] ?? '');
    const params = (frame['params'] ?? {}) as Record<string, unknown>;
    if (method === 'initialize') {
      if (behavior.hangInitialize === true) return; // 聋形态：握手窗内永不应答
      sendResult(id, { capabilities: {}, serverInfo: { name: 'fake-lsp', version: '0' } });
      return;
    }
    if (method === 'shutdown') {
      sendResult(id, null);
      return;
    }
    if (method === 'textDocument/documentSymbol') {
      sendResult(
        id,
        (behavior.symbols ?? []).map((s) => ({
          name: s.name,
          kind: 12,
          ...(s.line === undefined
            ? {}
            : { range: { start: { line: s.line - 1, character: 0 }, end: { line: s.line - 1, character: 5 } } }),
        })),
      );
      return;
    }
    if (method === 'textDocument/definition' || method === 'textDocument/references') {
      sendResult(
        id,
        (behavior.locations ?? []).map((l) => ({
          uri: l.uri,
          range: {
            start: { line: l.line - 1, character: l.character - 1 },
            end: { line: l.line - 1, character: l.character + 3 },
          },
        })),
      );
      return;
    }
    // 通知腿（无 id）：文档触达 → 推诊断（didOpen/didChange 同源驱动）
    if (id === undefined) {
      const doc = params['textDocument'] as { uri?: string; version?: number } | undefined;
      if ((method === 'textDocument/didOpen' || method === 'textDocument/didChange') && doc?.uri !== undefined) {
        pushDiagnostics(doc.uri, doc.version);
      }
    }
  });
  stdin.on('data', (chunk: Buffer | string) => feedServer(chunk));
  const fake: FakeLspServer = {
    child,
    frames,
    die: (code) => {
      if (!stdoutEnded) {
        stdoutEnded = true;
        stdout.end();
      }
      for (const cb of [...closeCbs]) cb(code, null);
    },
  };
  fakes.push(fake);
  return fake;
}

/** 测试环境：真 Context + 真 tools 服务 + 真管道 + ui 通知录制（装载器同构的 fork 行作用域） */
interface TestEnv {
  root: ContextScope;
  scope: ContextScope;
  tools: ToolsService;
  /** 三段管道执行器（runTool 经此跑全瀑布——pre/execute/post 事件随之派发） */
  pipeline: ReturnType<typeof createToolPipeline>;
  notifies: Array<{ message: string; level?: string }>;
}

/** 搭测试环境 */
function makeEnv(): TestEnv {
  const root = createContext({ name: 'lsp-plugin-test' });
  const pipeline = createToolPipeline(root);
  const tools = registerToolsService(root, { pipeline });
  const notifies: Array<{ message: string; level?: string }> = [];
  root.provide('ui', {
    notify: (message: string, opts?: { level?: 'info' | 'warn' | 'error' }) =>
      notifies.push({ message, level: opts?.level }),
  });
  const scope = root.fork({ name: 'row:lsp' });
  roots.push(root); // afterEach 统一回卷
  return { root, scope, tools, pipeline, notifies };
}

/** 假登记簿（结构子集——录 add/remove，sweep 空） */
interface FakeRegistry {
  adds: Array<{ hostPid: number; childPid: number; server: string; command: string }>;
  removes: number[];
  sweepCalls: number;
}

/** 件依赖束：假 spawn（可注入失败腿）+ killTree 录制 + 假登记簿 + 真桥工厂 */
interface Harness {
  deps: LspAppDeps;
  registry: FakeRegistry;
  kills: number[];
  spawnCount: number;
  /** 假服务器清单（按 spawn 序——断言 die/帧面用） */
  servers: FakeLspServer[];
  workspace: string;
}

/** 造件依赖（spawnError 在场 = 每次 spawn 抛错——熔断用例） */
function makeHarness(behavior: FakeServerBehavior, spawnError?: Error): Harness {
  const workspace = makeTempDir('lsp-app-');
  const registry: FakeRegistry = { adds: [], removes: [], sweepCalls: 0 };
  const kills: number[] = [];
  const servers: FakeLspServer[] = [];
  let pid = 7100;
  let spawnCount = 0; // 活计数（闭包内递增——懒兑现/熔断用例断言面）
  const harness: Harness = {
    registry,
    kills,
    servers,
    workspace,
    get spawnCount(): number {
      return spawnCount;
    },
    deps: {
      spawnServer: async () => {
        spawnCount += 1;
        if (spawnError !== undefined) throw spawnError;
        const server = makeFakeLspServer(behavior, pid++);
        servers.push(server);
        return server.child;
      },
      killTree: (killedPid) => kills.push(killedPid),
      registry: {
        add: (entry) => registry.adds.push(entry),
        remove: (childPid) => registry.removes.push(childPid),
        sweep: async () => {
          registry.sweepCalls += 1;
          return { killed: [] };
        },
      },
      rootPhysicalRoot: () => workspace,
      resolvePath: (p: string): string => (isAbsolute(p) ? resolve(p) : resolve(workspace, p)),
      newConnection: (opts) => new JsonRpcConnection(opts), // 真桥（mcp 帧无关复用的接线验证）
    },
  };
  return harness;
}

/** 标准 servers 配置（ts 路由 .ts；diagnostics_timeout_ms 可压小做超时用例） */
const serversConfig = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ts: { command: '/fake/bin/typescript-language-server', args: ['--stdio'], languages: ['.ts'], ...extra },
});

/** apply 快捷（config 即行 config 形态 `{servers: 表}`——件本体零 spawn） */
async function applyLsp(env: TestEnv, harness: Harness, config: Record<string, unknown>): Promise<void> {
  const mod = createLspApp(harness.deps);
  await mod.apply(env.scope, config);
}

/** 工具执行快捷（经三段管道跑全瀑布——post 事件随之派发；裸调 def.execute 绕管道违规） */
async function runTool(env: TestEnv, name: string, args: Record<string, unknown>): Promise<AgentToolResult> {
  return env.pipeline(env.tools.get(name)!, 't1', args);
}

/** 取结果首段文本（断言便利） */
function textOf(result: AgentToolResult): string {
  const first = result.content[0];
  return first !== undefined && first.type === 'text' ? first.text : '';
}

/* ---------------- apply 语义 ---------------- */

describe('lsp 件 — apply 语义', () => {
  it('空 servers：零清扫零 spawn 零工具注册（行惰性无害）', async () => {
    const env = makeEnv();
    const harness = makeHarness({});
    await applyLsp(env, harness, {});
    expect(harness.registry.sweepCalls).toBe(0); // 空表早退在清扫之前
    expect(harness.spawnCount).toBe(0);
    expect(env.tools.list().some((t) => t.name.startsWith('lsp_'))).toBe(false);
  });

  it('非法键：apply 抛 APP_CONFIG_INVALID（词法防线——schema Record 拦不住）', async () => {
    const env = makeEnv();
    const harness = makeHarness({});
    await expect(applyLsp(env, harness, { servers: { 'bad key!': serversConfig() } })).rejects.toMatchObject({
      code: APP_CONFIG_INVALID,
    });
    expect(harness.spawnCount).toBe(0);
  });

  it('有配置零调用：apply 完成 + 零 spawn（首用才 spawn）+ 四工具静态注册', async () => {
    const env = makeEnv();
    const harness = makeHarness({});
    await applyLsp(env, harness, { servers: serversConfig() });
    expect(harness.registry.sweepCalls).toBe(1); // 有配置即孤儿清扫（先于自家 spawn）
    expect(harness.spawnCount).toBe(0); // 惰性兑现为字面义：注册不依赖服务器在线
    const names = env.tools.list().map((t) => t.name);
    for (const tool of ['lsp_diagnostics', 'lsp_symbols', 'lsp_definitions', 'lsp_references']) {
      expect(names).toContain(tool);
    }
  });
});

/* ---------------- 四工具端到端（ensure-open 管线 + 真桥真帧） ---------------- */

describe('lsp 件 — 四工具', () => {
  it('lsp_diagnostics：spawn + 握手 + didOpen + 诊断回流（1-based 行号/severity/码）', async () => {
    const env = makeEnv();
    const harness = makeHarness({
      diagnosticsFor: (_uri) => [{ message: `类型不匹配`, severity: 1, line: 3, code: 2322 }],
    });
    await applyLsp(env, harness, { servers: serversConfig() });
    writeFileSync(join(harness.workspace, 'a.ts'), 'const x: number = "s";\n', 'utf8');
    const result = await runTool(env, 'lsp_diagnostics', { path: 'a.ts' });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('LSP 诊断（ts，1 条）');
    expect(textOf(result)).toContain('[Error] :3 类型不匹配');
    // 登记簿 spawn 即记 + 服务器侧帧面（initialize → didOpen）
    expect(harness.registry.adds).toHaveLength(1);
    const frames = harness.servers[0]!.frames;
    expect(frames.some((f) => f['method'] === 'initialize')).toBe(true);
    expect(frames.some((f) => f['method'] === 'textDocument/didOpen')).toBe(true);
  });

  it('lsp_symbols：符号大纲（DocumentSymbol 形态 + 1-based 行号）', async () => {
    const env = makeEnv();
    const harness = makeHarness({ symbols: [{ name: 'main', line: 5 }, { name: 'helper' }] });
    await applyLsp(env, harness, { servers: serversConfig() });
    writeFileSync(join(harness.workspace, 'b.ts'), 'function main() {}\n', 'utf8');
    const result = await runTool(env, 'lsp_symbols', { path: 'b.ts' });
    expect(textOf(result)).toContain('符号大纲');
    expect(textOf(result)).toContain('- main :5');
    expect(textOf(result)).toContain('- helper'); // 无 range 的符号不带行号
  });

  it('lsp_definitions/lsp_references：位置查询（1-based 坐标 → 0-based 协议出 → 1-based 呈现）', async () => {
    const env = makeEnv();
    const harness = makeHarness({
      locations: [{ uri: 'file:///elsewhere/def.ts', line: 10, character: 4 }],
    });
    await applyLsp(env, harness, { servers: serversConfig() });
    writeFileSync(join(harness.workspace, 'c.ts'), 'main();\n', 'utf8');
    const defs = await runTool(env, 'lsp_definitions', { path: 'c.ts', line: 1, column: 1 });
    expect(textOf(defs)).toContain('定义（1 处）');
    expect(textOf(defs)).toContain('- file:///elsewhere/def.ts :10:4');
    const refs = await runTool(env, 'lsp_references', { path: 'c.ts', line: 1, column: 1 });
    expect(textOf(refs)).toContain('引用（1 处）');
  });

  it('扩展名不在路由表：error 结果带配置指引（不 spawn）', async () => {
    const env = makeEnv();
    const harness = makeHarness({});
    await applyLsp(env, harness, { servers: serversConfig() });
    writeFileSync(join(harness.workspace, 'notes.md'), '# hi\n', 'utf8');
    const result = await runTool(env, 'lsp_diagnostics', { path: 'notes.md' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('路由表');
    expect(harness.spawnCount).toBe(0); // 路由判定先于拉起
  });

  it('根外路径：error 结果明说根界（服务器只解析根内文档）', async () => {
    const env = makeEnv();
    const harness = makeHarness({});
    await applyLsp(env, harness, { servers: serversConfig() });
    const result = await runTool(env, 'lsp_diagnostics', { path: '../outside.ts' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('根外');
  });
});

/* ---------------- post 注入（预热/诊断段/告别/降级——真管道全瀑布） ---------------- */

describe('lsp 件 — write/edit 后诊断注入', () => {
  /**
   * 假 write 工具（真盘写 + details.path——与 tools fs 族同口径；经 tools 服务面
   * 执行 = 真管道全瀑布，post 事件随之派发）。
   */
  function registerFakeWrite(env: TestEnv, workspace: string): void {
    env.tools.register({
      name: 'write',
      description: '假 write（测试 post 注入——真盘写）',
      parameters: Type.Object({ path: Type.String() }),
      effect: 'write',
      execute: async (args: Record<string, unknown>) => {
        const abs = isAbsolute(String(args.path)) ? String(args.path) : resolve(workspace, String(args.path));
        writeFileSync(abs, `content of ${abs}\n`, 'utf8');
        return { content: [{ type: 'text', text: `已写入 ${abs}` }], details: { path: abs } };
      },
    });
  }

  it('未活首触：预热注记一次（本次不附诊断）→ 等活后二次写附诊断段', async () => {
    const env = makeEnv();
    const harness = makeHarness({
      diagnosticsFor: () => [{ message: '变量未使用', severity: 2, line: 1 }],
    });
    await applyLsp(env, harness, { servers: serversConfig() });
    registerFakeWrite(env, harness.workspace);
    // 首触：实例未活 → fire-and-forget 预热 + 一次性注记（原结果不动 isError）
    const first = await runTool(env, 'write', { path: 'w1.ts' });
    expect(first.isError).toBeFalsy();
    expect(textOf(first)).toContain('已写入');
    expect(textOf(first)).toContain('LSP 服务器「ts」预热中，本次未附诊断（下次写入生效）');
    // 预热在后台竞速——等活（登记簿记上 = connect 完成）
    await vi.waitFor(() => {
      expect(harness.registry.adds).toHaveLength(1);
    });
    // 二次写：实例已活 → 同步 + 等诊断（cap 内回流）→ 诊断段追加
    const second = await runTool(env, 'write', { path: 'w1.ts' });
    expect(textOf(second)).toContain('LSP 诊断（ts，1 条）');
    expect(textOf(second)).toContain('[Warning] :1 变量未使用');
    expect(textOf(second)).toContain('已写入'); // 原结果保留（追加不改写）
    // 预热注记只此一次：三次写不再出现「预热中」
    const third = await runTool(env, 'write', { path: 'w1.ts' });
    expect(textOf(third)).not.toContain('预热中');
  });

  it('edit delete 路径：didClose 告别（已 open 的 URI 才有告别面）', async () => {
    const env = makeEnv();
    // 诊断推空集（lsp_diagnostics 才能快速返——不压 8s 全额等待钟）
    const harness = makeHarness({ diagnosticsFor: () => [] });
    await applyLsp(env, harness, { servers: serversConfig() });
    // 先经 lsp_diagnostics 把文档 open 上（ensure-open 管线）
    writeFileSync(join(harness.workspace, 'del.ts'), 'x\n', 'utf8');
    await runTool(env, 'lsp_diagnostics', { path: 'del.ts' });
    await vi.waitFor(() => {
      expect(harness.registry.adds).toHaveLength(1);
    });
    // 假 edit 工具（delete 操作——details.operations 结构化数组）
    env.tools.register({
      name: 'edit',
      description: '假 edit（delete 操作——测试告别路径）',
      parameters: Type.Object({ path: Type.String() }),
      effect: 'write',
      execute: async (args: Record<string, unknown>) => {
        const abs = resolve(harness.workspace, String(args.path));
        return { content: [{ type: 'text', text: '已删除' }], details: { operations: [{ op: 'delete', path: abs }] } };
      },
    });
    const result = await runTool(env, 'edit', { path: 'del.ts' });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('已删除'); // delete 不追加诊断段（无写路径无诊断面）
    expect(harness.servers[0]!.frames.some((f) => f['method'] === 'textDocument/didClose')).toBe(true);
  });

  it('诊断未及回流：诚实降级注记（不算失败——诊断异步性是协议本质）', async () => {
    const env = makeEnv();
    // 服务器不推诊断（diagnosticsFor 缺省 undefined = 不推送）+ 配置压小等待
    const harness = makeHarness({});
    await applyLsp(env, harness, { servers: serversConfig({ diagnostics_timeout_ms: 50 }) });
    registerFakeWrite(env, harness.workspace);
    // 先活（直接写首触预热 + 等活——本用例只验降级段）
    await runTool(env, 'write', { path: 'slow.ts' });
    await vi.waitFor(() => {
      expect(harness.registry.adds).toHaveLength(1);
    });
    const second = await runTool(env, 'write', { path: 'slow.ts' });
    expect(textOf(second)).toContain('LSP 诊断未及回流');
    expect(second.isError).toBeFalsy(); // 降级非失败
  });

  // 混合态回归锁（20260901-d #9）：部分路径回流空集、部分路径超钟——超钟路径
  // 须逐一点名，不得与已回流路径合并成「0 条无问题」的全清宣称（诚实降级按
  // 路径粒度执法，契约篇 §6.7 勘正）。修前形态：gotAny=some(...) 判定下混合态
  // 走「已检路径无问题」分支，超钟路径静默蒸发。
  it('混合态（部分超钟+部分干净零诊断）：超钟路径逐一点名，不谎报全清', async () => {
    const env = makeEnv();
    // clean.ts 推空集（干净回流）；其余永不推送（超钟）
    const harness = makeHarness({
      diagnosticsFor: (uri) => (uri.endsWith('clean.ts') ? [] : undefined),
    });
    await applyLsp(env, harness, { servers: serversConfig({ diagnostics_timeout_ms: 50 }) });
    // 先活（首触预热走 write 单路径 clean.ts——诊断回流即活）
    registerFakeWrite(env, harness.workspace);
    await runTool(env, 'write', { path: 'clean.ts' });
    await vi.waitFor(() => {
      expect(harness.registry.adds).toHaveLength(1);
    });
    // 假 edit 双写路径（一次 post 注入同时盖 clean + slow——混合态构造）
    env.tools.register({
      name: 'edit',
      description: '假 edit（双写路径——混合态测试）',
      parameters: Type.Object({ path: Type.String() }),
      effect: 'write',
      execute: async (_args: Record<string, unknown>) => {
        const clean = resolve(harness.workspace, 'clean.ts');
        const slow = resolve(harness.workspace, 'slow.ts');
        return {
          content: [{ type: 'text', text: '已改' }],
          details: {
            operations: [
              { op: 'edit', path: clean },
              { op: 'edit', path: slow },
            ],
          },
        };
      },
    });
    const result = await runTool(env, 'edit', { path: 'x.ts' });
    expect(result.isError).toBeFalsy(); // 降级仍非失败
    const text = textOf(result);
    // 超钟路径逐一点名（slow.ts 不得静默蒸发）
    expect(text).toContain('未及回流');
    expect(text).toContain('slow.ts');
    // 已回流路径照实报 0 条——但全清宣称必须带超钟限定
    expect(text).toContain('0 条');
  });
});

/* ---------------- 熔断与回卷 ---------------- */

describe('lsp 件 — 熔断与 effect 回卷', () => {
  it('spawn 即写：握手窗内已入登记簿，握手失败对称删行（遗漏大扫 20260902-b #7——修前登记滞后到 initialize 握手完成，握手窗内宿主硬崩则孤儿清扫结构性失明）', async () => {
    const env = makeEnv();
    const harness = makeHarness({ hangInitialize: true });
    await applyLsp(env, harness, { servers: serversConfig({ startup_timeout_sec: 1 }) });
    writeFileSync(join(harness.workspace, 'h.ts'), 'x\n', 'utf8');
    const toolPromise = runTool(env, 'lsp_symbols', { path: 'h.ts' });
    // 握手窗内（1s 超时未到）：spawn 返回 pid 的同步点已入簿（红先载体——
    // 修前 registry.add 在 connectLspServer 握手成功返回之后，聋服务器永不至）
    await vi.waitFor(() => expect(harness.registry.adds).toHaveLength(1));
    expect(harness.registry.adds[0]).toMatchObject({ hostPid: process.pid, server: 'ts' });
    const childPid = harness.registry.adds[0]!.childPid;
    // 握手失败收场（1s 到点）：工具腿失败 + 撤销面删行 + 树杀（不留簿不留进程）
    const out = await toolPromise;
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain('不可用');
    expect(harness.registry.removes).toEqual([childPid]);
    expect(harness.kills).toContain(childPid);
  }, 10_000);

  it('3 连败熔断：connect 失败逐次计败 → notify warn + 第 4 调直接拒（复位走 /reload）', async () => {
    const env = makeEnv();
    const harness = makeHarness({}, new Error('ENOENT: no such file'));
    await applyLsp(env, harness, { servers: serversConfig() });
    writeFileSync(join(harness.workspace, 'x.ts'), 'x\n', 'utf8');
    // 三次调用 = 三次 connect 失败（每次真 spawn 腿被拒）
    for (let i = 0; i < 3; i += 1) {
      const result = await runTool(env, 'lsp_diagnostics', { path: 'x.ts' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('不可用');
    }
    expect(env.notifies.some((n) => n.message.includes('熔断'))).toBe(true);
    // 第 4 调：熔断态直接拒（不再 spawn）
    const spawnBefore = harness.spawnCount;
    const fourth = await runTool(env, 'lsp_diagnostics', { path: 'x.ts' });
    expect(textOf(fourth)).toContain('已熔断');
    expect(harness.spawnCount).toBe(spawnBefore);
  });

  it('回卷：登记簿落删 + 协议化关停（shutdown → exit）', async () => {
    const env = makeEnv();
    const harness = makeHarness({});
    await applyLsp(env, harness, { servers: serversConfig() });
    writeFileSync(join(harness.workspace, 'r.ts'), 'x\n', 'utf8');
    await runTool(env, 'lsp_symbols', { path: 'r.ts' }); // 拉活一实例
    const childPid = harness.registry.adds[0]!.childPid;
    // 回卷行作用域（/reload 单区/卸载同径）——协议化关停在后台竞速
    await env.scope.dispose();
    await vi.waitFor(() => {
      const frames = harness.servers[0]!.frames;
      expect(frames.some((f) => f['method'] === 'shutdown')).toBe(true);
      expect(frames.some((f) => f['method'] === 'exit')).toBe(true);
    });
    expect(harness.registry.removes).toContain(childPid);
    // 回卷后工具面同步消失（四工具件级寿命）
    expect(env.tools.list().some((t) => t.name.startsWith('lsp_'))).toBe(false);
  });
});
