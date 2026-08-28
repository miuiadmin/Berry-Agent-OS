/**
 * PoC ⑦ probe 侧：在 Permission Model 沙箱内尝试装载 better-sqlite3。
 * 结果以 JSON 单行回报 stdout（父侧解析判定——进程退出码不是判定面）。
 */
import { createRequire } from 'node:module';

try {
  // better-sqlite3 是 CJS 包——createRequire 引入（PM 下 addon 装载受 --allow-addons 管辖）
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id TEXT)');
  db.prepare("INSERT INTO t (id) VALUES ('row-1')").run();
  const row = db.prepare('SELECT id FROM t LIMIT 1').get();
  db.close();
  console.log(JSON.stringify({ loaded: true, roundTrip: row.id }));
} catch (err) {
  // 拒载面：错误码是判定对象（预期 ERR_DLOPEN_DISABLED 族——addon 管辖签名）
  console.log(JSON.stringify({ loaded: false, errCode: err.code ?? err.constructor.name }));
}
