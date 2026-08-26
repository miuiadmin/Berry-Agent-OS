/**
 * PoC ③ worker 侧：在 worker_threads 内打开 better-sqlite3。
 * 自开连接（不接收主线程的 Database 对象——不可克隆），WAL 模式下跨连接互见；
 * 另验 worker 内 :memory: 纯内存库。
 */
import Database from 'better-sqlite3';
import { parentPort } from 'node:worker_threads';

const port = parentPort;

port.on('message', (m) => {
  if (m.cmd !== 'start') return;
  try {
    // worker realm 自开连接——与主线程连接指向同一文件、各自独立
    const db = new Database(m.dbPath);
    const rows = db
      .prepare('SELECT who FROM t')
      .all()
      .map((r) => r.who);
    const ok = rows.includes('main'); // WAL 跨连接可见性：主线程已提交的行应可见
    db.prepare("INSERT INTO t (who) VALUES ('worker')").run();
    db.close();

    // worker 内纯内存库：建表+读回（future 插件自带 :memory: 库的形态）
    const mem = new Database(':memory:');
    mem.exec('CREATE TABLE m (v INTEGER)');
    mem.prepare('INSERT INTO m (v) VALUES (42)').run();
    const memOk = mem.prepare('SELECT v FROM m').get().v === 42;
    mem.close();

    port.postMessage({ stage: 'read-main', rows, ok });
    port.postMessage({ stage: 'memory-db', ok: memOk });
  } catch (e) {
    // native 模块在 worker 崩溃 = 可证伪项③的证伪形态
    port.postMessage({ stage: 'read-main', rows: [], ok: false, error: e.message });
    port.postMessage({ stage: 'memory-db', ok: false });
  }
});
