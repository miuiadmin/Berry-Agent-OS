/**
 * PoC ⑫ probe 侧：PM 沙箱内做 UDS bind 与普通写对照探测。
 * argv: [mode, targetDir]  mode=escape（白名单外三探测）| normal（白名单内 bind+回环）
 * 结果 JSON 单行回报（父侧记档判定）。
 */
import { createServer, connect } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2];
const targetDir = process.argv[3];
const sockPath = join(targetDir, 'poc12.sock');

/** 单探测：返回 {code}——成功 null、失败错误码 */
async function probeBind(path) {
  return new Promise((resolve) => {
    const server = createServer();
    server.on('error', (err) => resolve({ code: err.code ?? err.constructor.name }));
    server.listen({ path }, () => resolve({ code: null, server }));
  });
}

if (mode === 'escape') {
  // 探测一：普通文件写在同目录（隔离变量——同一目录普通写应被 PM 拒）
  let plainWriteOutside;
  try {
    writeFileSync(join(targetDir, 'plain.txt'), 'x');
    plainWriteOutside = { code: null };
  } catch (err) {
    plainWriteOutside = { code: err.code ?? err.constructor.name };
  }
  // 探测二：UDS bind 落 socket 文件在同一白名单外目录
  const bindRes = await probeBind(sockPath);
  const report = {
    plainWriteOutside,
    bindOutside: bindRes.code === null ? 'bound' : 'denied',
    bindOutsideErr: bindRes.code,
    sockPath,
  };
  bindRes.server?.close(); // 收尾（socket 文件留给父清理——目录整体 rmSync）
  console.log(JSON.stringify(report));
  process.exit(0);
} else if (mode === 'normal') {
  // 白名单内：bind + 本进程内客户端回环连通
  const bindRes = await probeBind(sockPath);
  if (bindRes.code !== null) {
    console.log(JSON.stringify({ bindInside: 'denied', bindInsideErr: bindRes.code, connectEcho: null }));
    process.exit(0);
  }
  const echo = await new Promise((resolve) => {
    bindRes.server.on('connection', (socket) => {
      socket.on('data', (d) => socket.write(d)); // 回环 echo
    });
    const client = connect({ path: sockPath }, () => client.write('echo-ok'));
    client.on('data', (d) => {
      client.destroy();
      resolve(d.toString());
    });
    client.on('error', () => resolve(null));
  });
  bindRes.server.close();
  console.log(JSON.stringify({ bindInside: 'bound', connectEcho: echo, sockPath }));
  process.exit(0);
}
