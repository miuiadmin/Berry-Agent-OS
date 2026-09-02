/**
 * L5 app — attach 测试面（应答器 + 会话选择 + 前置闸）。
 *
 * 三层：① 审批应答器（全面复盘 #51 回归锁——应答政策单点）；②
 * pickAttachSession 纯逻辑；③ attachMain 前置闸四道（复盘 #31——全部
 * return 1 无 TTY 依赖，对真 mini HTTP server 可测）。闸后 TUI 段有 TTY
 * 结构性依赖，不在本文件面。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { attachMain, createApprovalAnswerer, pickAttachSession } from './attach-main.js';
import type { WebuiPendingApproval, WebuiSessionSummary } from '../webui/index.js';
import { daemonDirOf, daemonStatePath, daemonTokenPath } from './daemon-state.js';

/** 最小审批卡（应答器只读 summary/reason/ownership/suggestedEntry 四面） */
function makeApproval(overrides: Partial<WebuiPendingApproval> = {}): WebuiPendingApproval {
  return {
    approvalId: 'ap-1',
    summary: '写入 workspace/test.txt',
    ...overrides,
  } as WebuiPendingApproval;
}

/** 脚本化应答器依赖面：confirm/decide 可编程、decide 调用全录（断言面） */
function makeDeps(overrides: Partial<Parameters<typeof createApprovalAnswerer>[0]> = {}) {
  const decided: Array<{ approvalId: string; decision: string }> = [];
  const deps = {
    confirm: vi.fn(async () => true as boolean | undefined),
    notify: vi.fn(),
    decide: vi.fn(async (approvalId: string, decision: 'approve' | 'reject' | 'always') => {
      decided.push({ approvalId, decision });
      return { status: 200, accepted: true };
    }),
    isQuitting: () => false,
    ...overrides,
  };
  return { deps, decided };
}

describe('createApprovalAnswerer — attach 审批应答政策（复盘 #51 回归锁）', () => {
  it('y 应答投 approve：decide 单发、卡摘除', async () => {
    const { deps, decided } = makeDeps();
    const answerer = createApprovalAnswerer(deps);
    answerer.ask(makeApproval());
    await vi.waitFor(() => expect(decided).toHaveLength(1));
    expect(decided[0]).toEqual({ approvalId: 'ap-1', decision: 'approve' });
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('n 应答投 reject（用户在场明确拒绝——合法路径）', async () => {
    const { deps, decided } = makeDeps({ confirm: vi.fn(async () => false) });
    createApprovalAnswerer(deps).ask(makeApproval());
    await vi.waitFor(() => expect(decided).toHaveLength(1));
    expect(decided[0]!.decision).toBe('reject');
  });

  it('【回归锁】Ctrl+D 收尾（quitting）时在身卡不投 decide——撤销 ≠ 拒绝，留 daemon 侧待决', async () => {
    // 复盘 #51 链条：cancelAsks → confirm 收场 false（signal 未 aborted）→
    // 修复前 quitting 守卫不覆盖 decide 路 → 把用户从未做出的拒绝投给 daemon
    //（daemon 侧账本落 reject 决定，违背「Ctrl+D = 仅退 attach 不动 daemon」）
    const { deps, decided } = makeDeps({
      confirm: vi.fn(async () => false), // cancelAsks 语义下 confirm 收场为 false
      isQuitting: () => true,
    });
    const answerer = createApprovalAnswerer(deps);
    answerer.ask(makeApproval());
    // confirm 已收场（微任务后）但 decide 必须零调用
    await vi.waitFor(() => expect(deps.confirm).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decided).toEqual([]);
  });

  it('【回归锁】quitting 收场同样不追问 always（y + 草案在场也不投）', async () => {
    const { deps, decided } = makeDeps({ isQuitting: () => true });
    const answerer = createApprovalAnswerer(deps);
    answerer.ask(makeApproval({ suggestedEntry: { tool: 'write' } as never }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deps.confirm).toHaveBeenCalledTimes(1); // 只首问，无 always 追问
    expect(decided).toEqual([]);
  });

  it('decided 镜像竞速败腿：settle 摘卡 + abort signal，confirm 收场后不投 decide', async () => {
    let release!: (value: boolean | undefined) => void;
    const confirm = vi.fn(
      () =>
        new Promise<boolean | undefined>((resolve) => {
          release = resolve;
        }),
    );
    const { deps, decided } = makeDeps({ confirm });
    const answerer = createApprovalAnswerer(deps);
    answerer.ask(makeApproval());
    answerer.settle('ap-1'); // 他腿已决——abort 在身提问
    release(false); // confirm 以 false 收（aborted 守卫应拦截）
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decided).toEqual([]);
  });

  it('【回归锁】decided 镜像在追问腿期间到达：追问同享 signal + aborted 复查拦截，不投 decide（遗漏大扫 20260902 #8）', async () => {
    // 现场复刻：首问 y（草案在场）→ 追问 always 在身时他腿已决（decided 镜像
    // 到达）——修前追问 confirm 传 {}（无 signal）且无 aborted 复查：镜像收
    // 不了场、追问作答后照常投 decide（对着已失效的追问要答案）
    const confirmOpts: Array<{ signal?: AbortSignal } | undefined> = [];
    let releaseSecond!: () => void;
    const confirm = vi.fn((_message: string, opts?: { signal?: AbortSignal }) => {
      confirmOpts.push(opts);
      if (confirmOpts.length === 1) return Promise.resolve(true); // 首问 y
      return new Promise<boolean | undefined>((resolve) => {
        releaseSecond = () => resolve(undefined); // 追问挂起——等竞速现场
      });
    });
    const { deps, decided } = makeDeps({ confirm });
    const answerer = createApprovalAnswerer(deps);
    answerer.ask(makeApproval({ suggestedEntry: { tool: 'write' } as never }));
    await vi.waitFor(() => expect(confirmOpts).toHaveLength(2)); // 首问已答、追问在身
    // 追问腿 signal 接线（修前 {} 无 signal——必红位①）
    expect(confirmOpts[1]!.signal).toBeInstanceOf(AbortSignal);
    answerer.settle('ap-1'); // decided 镜像到达——摘卡 + abort 在身追问
    releaseSecond(); // 追问收场（真 TUI 里 signal 驱动；此处手动放行）
    await new Promise((resolve) => setTimeout(resolve, 20));
    // aborted 复查拦截（修前无复查——追问 false 作答后投 approve——必红位②）
    expect(decided).toEqual([]);
  });

  it('sync 幂等：同一卡重复投递只建一卡（清单重拉/镜像竞窗）', async () => {
    let release!: (value: boolean | undefined) => void;
    const confirm = vi.fn(
      () =>
        new Promise<boolean | undefined>((resolve) => {
          release = resolve;
        }),
    );
    const { deps, decided } = makeDeps({ confirm });
    const answerer = createApprovalAnswerer(deps);
    answerer.sync([makeApproval(), makeApproval()]);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    release(true);
    await vi.waitFor(() => expect(decided).toHaveLength(1));
  });
});

describe('pickAttachSession — 会话选择律（cwd 匹配 active 优先、无匹配取最新）', () => {
  const base = { id: 's1', active: true, cwd: '/w/x', createdAt: 10, updatedAt: 10 };
  const session = (o: Partial<WebuiSessionSummary>): WebuiSessionSummary => ({ ...base, ...o }) as WebuiSessionSummary;

  it('cwd 匹配者优先且取最新 updatedAt', () => {
    const picked = pickAttachSession(
      [
        session({ id: 'a', cwd: '/w/x', updatedAt: 5 }),
        session({ id: 'b', cwd: '/w/x', updatedAt: 9 }),
        session({ id: 'c', cwd: '/other', updatedAt: 99 }),
      ],
      '/w/x',
    );
    expect(picked?.id).toBe('b');
  });

  it('无匹配取最新 active；零 active = undefined', () => {
    expect(pickAttachSession([session({ id: 'c', cwd: '/other', updatedAt: 1 })], '/w/x')?.id).toBe('c');
    expect(pickAttachSession([session({ id: 'z', active: false, updatedAt: 50 })], '/w/x')).toBeUndefined();
  });
});

describe('attachMain 前置闸四道（复盘 #31——return 1 面，无 TTY 依赖）', () => {
  /** stderr 捕获（闸面错误行即断言面——TUI 段未到） */
  function captureStderr(): { text: () => string; restore: () => void } {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    return { text: () => chunks.join(''), restore: () => spy.mockRestore() };
  }

  /** 落一份形状完整的 daemon.json（闸面只读形状——判活不在闸序）+ 可选 token */
  function writeState(root: string, port: number, withToken: boolean): void {
    mkdirSync(daemonDirOf(root), { recursive: true });
    writeFileSync(
      daemonStatePath(root),
      JSON.stringify({ pid: 4321, processStartId: 'gate-x', bootId: 'gate-boot', port, heldSessions: [] }),
    );
    if (withToken) writeFileSync(daemonTokenPath(root), 'gate-token');
  }

  it('① 无 daemon.json → 1 + 未运行指引', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'attach-gate-'));
    const cap = captureStderr();
    try {
      await expect(attachMain({ dataRoot: root, cwd: '/w' })).resolves.toBe(1);
      expect(cap.text()).toContain('daemon 未运行');
    } finally {
      cap.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('② 有 state 无 token → 1 + 重签发指引（禁 ensure 写）', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'attach-gate-'));
    const cap = captureStderr();
    try {
      writeState(root, 47861, false);
      await expect(attachMain({ dataRoot: root, cwd: '/w' })).resolves.toBe(1);
      expect(cap.text()).toContain('token 文件缺失');
      expect(cap.text()).toContain('daemon start');
    } finally {
      cap.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('③ 端口无监听 → 1 + 连接失败；401 → 1 + token 不符注记', async () => {
    // 连接拒腿：先占后放一个端口（关闭即瞬时 ECONNREFUSED——不走 10s 超时）
    const ghost = createServer();
    await new Promise<void>((resolve) => ghost.listen(0, '127.0.0.1', resolve));
    const port = (ghost.address() as { port: number }).port;
    await new Promise<void>((resolve) => ghost.close(() => resolve()));
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'attach-gate-'));
    const cap = captureStderr();
    try {
      writeState(root, port, true);
      await expect(attachMain({ dataRoot: root, cwd: '/w' })).resolves.toBe(1);
      expect(cap.text()).toContain('连接失败');
    } finally {
      cap.restore();
      rmSync(root, { recursive: true, force: true });
    }
    // 401 腿：真 mini server 答非（token 不符面——轮换竞窗披露）
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port401 = (server.address() as { port: number }).port;
    const root401 = mkdtempSync(join(realpathSync(tmpdir()), 'attach-gate-'));
    const cap401 = captureStderr();
    try {
      writeState(root401, port401, true);
      await expect(attachMain({ dataRoot: root401, cwd: '/w' })).resolves.toBe(1);
      expect(cap401.text()).toContain('token 不符');
    } finally {
      cap401.restore();
      rmSync(root401, { recursive: true, force: true });
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('④ 真握手 200 但零 active 会话 → 1 + 无活会话指引（真服务端形状：裸数组）', async () => {
    // 服务端 GET /api/sessions 恒裸数组（server.ts sendJson(sessionsFor())）——
    // 夹具必须复刻真形状（复盘 #31 连带真缺陷：listSessions 曾只认 {sessions} 壳）
    const server = createServer((req, res) => {
      if (req.url === '/api/sessions') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([]));
        return;
      }
      res.writeHead(404).end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'attach-gate-'));
    const cap = captureStderr();
    try {
      writeState(root, port, true);
      await expect(attachMain({ dataRoot: root, cwd: '/w' })).resolves.toBe(1);
      expect(cap.text()).toContain('无活会话可聚焦');
    } finally {
      cap.restore();
      rmSync(root, { recursive: true, force: true });
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
