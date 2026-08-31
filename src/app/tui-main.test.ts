/**
 * L5 app — tui-main 判据纯函数单测（daemon 刀二·P3 触达面②）。
 *
 * daemonHoldsWorkspaceSession 只测判据四分支（无工作区/无 daemon.json/判死/
 * 判活命中），不起 TUI 全栈（front.quit 无注入口——tuiMain P3 分支全栈面由
 * daemon-fullstack「tuiMain P3 分支」用例子进程物证兜住：拒开 warn + 另开
 * 新会话落库 + SIGTERM 143；横幅渲染是 pi-tui 内务不归断言面）。判活判据源
 * = processStartId 双匹配，本进程 pid 即活体（省真子进程——判据函数无
 * self-pid 豁免语义，谁活谁算）。
 *
 * 纪律：APP_DATA_DIR 钉临时目录（readDaemonState 走 dataDir() 缺省根），测后还原。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { daemonDirOf, daemonStatePath, defaultProcessProbe } from './daemon-state.js';
import { daemonHoldsWorkspaceSession, isFirstBoot } from './tui-main.js';

/** 近史行速造（判据只吃 cwd + id 两字段——窄类型即窄断言面） */
const row = (id: string, cwd: string): { cwd: string; id: string } => ({ id, cwd });

describe('daemonHoldsWorkspaceSession：P3 触达面②判据四分支', () => {
  /** 钉默认数据根 + 落一份持有态（pid/processStartId 由用例注入）；返回还原闭包 */
  function pinState(state: { pid: number; processStartId: string; heldSessions: string[] }): () => void {
    const dataRoot = mkdtempSync(join(realpathSync(tmpdir()), 'tui-held-data-'));
    const prev = process.env['APP_DATA_DIR'];
    process.env['APP_DATA_DIR'] = dataRoot;
    mkdirSync(daemonDirOf(dataRoot), { recursive: true });
    writeFileSync(daemonStatePath(dataRoot), JSON.stringify({ ...state, bootId: 'tui-boot', port: 7860 }));
    return () => {
      if (prev === undefined) delete process.env['APP_DATA_DIR'];
      else process.env['APP_DATA_DIR'] = prev;
      rmSync(dataRoot, { recursive: true, force: true });
    };
  }

  it('无 workspaceRoot（persist:false 等无 paths 面）→ 恒 false（不读盘）', () => {
    expect(daemonHoldsWorkspaceSession(undefined, [row('s-1', '/w')])).toBe(false);
  });

  it('无 daemon.json / 判死（processStartId 不匹配）→ false', () => {
    const restore = pinState({
      pid: process.pid,
      processStartId: 'stale-start-id', // 非本进程现值 = 判死（pid 复用窗同形）
      heldSessions: ['s-1'],
    });
    try {
      expect(daemonHoldsWorkspaceSession('/w', [row('s-1', '/w')])).toBe(false);
    } finally {
      restore();
    }
  });

  it('判活 + 近史行 cwd 匹配本工作区且 id ∈ heldSessions → true（横幅分流正判）', () => {
    const restore = pinState({
      pid: process.pid,
      processStartId: defaultProcessProbe.startId(process.pid)!, // 本进程现值 = 活
      heldSessions: ['s-1', 's-9'],
    });
    try {
      // 命中：cwd 匹配 + id 在册
      expect(daemonHoldsWorkspaceSession('/w', [row('s-0', '/other'), row('s-1', '/w')])).toBe(true);
      // 不命中三形：cwd 全不匹配 / id 不在 heldSessions / 近史空
      expect(daemonHoldsWorkspaceSession('/w', [row('s-1', '/elsewhere')])).toBe(false);
      expect(daemonHoldsWorkspaceSession('/w', [row('s-2', '/w')])).toBe(false);
      expect(daemonHoldsWorkspaceSession('/w', [])).toBe(false);
    } finally {
      restore();
    }
  });

  it('无 daemon.json（readDaemonState undefined 路）→ false 不抛', () => {
    const dataRoot = mkdtempSync(join(realpathSync(tmpdir()), 'tui-held-empty-'));
    const prev = process.env['APP_DATA_DIR'];
    process.env['APP_DATA_DIR'] = dataRoot;
    try {
      expect(daemonHoldsWorkspaceSession('/w', [row('s-1', '/w')])).toBe(false);
    } finally {
      if (prev === undefined) delete process.env['APP_DATA_DIR'];
      else process.env['APP_DATA_DIR'] = prev;
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

describe('isFirstBoot（§8.5 第 4 件首启判定——纯函数）', () => {
  it(':memory: 恒非首启（内存库不构成「第一次使用」语义）', () => {
    expect(isFirstBoot(':memory:')).toBe(false);
  });
  it('不存在的库文件 = 首启；存在 = 非首启（注入覆盖感知）', () => {
    const fresh = join(tmpdir(), `berry-fb-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    expect(isFirstBoot(fresh)).toBe(true); // 不存在
    mkdirSync(dirname(fresh), { recursive: true });
    writeFileSync(fresh, 'x');
    expect(isFirstBoot(fresh)).toBe(false); // 存在
    rmSync(fresh);
  });
});
