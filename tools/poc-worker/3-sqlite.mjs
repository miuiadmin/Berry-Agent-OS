#!/usr/bin/env node
/**
 * PoC ③（第二十七批刀一可证伪项三）：better-sqlite3 在 worker_threads 环境可用性
 * + WAL 跨连接可见性。
 *
 * 形态：主线程与 worker **各自打开自己的连接**指向同一 SQLite 文件（WAL 模式）——
 * 连接对象不跨线程（结构化克隆会拒），这正是「每 realm 各开各的」的落码形态。
 *
 * 流程：
 *   1. 主线程建临时 db 文件、开 WAL、建表插 'main' 行；
 *   2. worker 自开连接：读 'main' 行（WAL 跨连接可见性）+ 插 'worker' 行；
 *   3. worker 内另开 :memory: 库做建表读写（worker 内纯内存库可用性）；
 *   4. 主线程回读 'worker' 行（反向可见性）。
 *
 * 判定：任一步失败 = 可证伪项③证伪。退出码：0 = PASS，1 = FAIL。
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

/** 临时数据库目录（realpath 归一——macOS /var→/private/var 符号链接） */
const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'poc-sqlite-')));
const dbPath = join(dir, 'poc.db');

// 主线程自己的连接：WAL + 建表 + 首行
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE t (who TEXT)');
db.prepare("INSERT INTO t (who) VALUES ('main')").run();

// 30 秒硬超时：worker 内 native 模块挂死/崩溃 = 证伪形态之一
const timer = setTimeout(() => {
  console.error('FAIL: PoC 超时（30s）');
  process.exit(1);
}, 30_000);
timer.unref();

const worker = new Worker(new URL('./3-sqlite.worker.mjs', import.meta.url));
let fail = false;
let settled = false;

worker.on('message', (m) => {
  if (m.stage === 'read-main') {
    console.log(`[步一] worker 自开连接读主线程写入行: ${JSON.stringify(m.rows)} → ${m.ok ? 'PASS' : 'FAIL'}`);
    if (!m.ok) fail = true;
  } else if (m.stage === 'memory-db') {
    console.log(`[步二] worker 内 :memory: 库读写: ${m.ok ? 'PASS' : 'FAIL'}`);
    if (!m.ok) fail = true;
    // 主线程回读 worker 写入的行（反向可见性）——收尾前最后一验
    const rows = db
      .prepare('SELECT who FROM t')
      .all()
      .map((r) => r.who);
    const ok = rows.includes('worker');
    console.log(`[步三] 主线程回读 worker 写入行: ${JSON.stringify(rows)} → ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) fail = true;
    settled = true;
    worker.terminate();
  }
});

worker.on('error', (e) => {
  console.error('FAIL: worker 抛错——', e.message);
  fail = true;
  settled = true;
  worker.terminate();
});

worker.on('exit', () => {
  clearTimeout(timer);
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (settled) {
    console.log(
      fail
        ? '== PoC ③ 结论: FAIL（可证伪项③证伪）=='
        : '== PoC ③ 结论: PASS（better-sqlite3 worker 多连接 + WAL 互见）==',
    );
  }
  process.exit(fail ? 1 : 0);
});

worker.postMessage({ cmd: 'start', dbPath });
