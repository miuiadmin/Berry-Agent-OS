/**
 * PoC ⑩ 子侧：stdin 进指令、stdout 回 NDJSON 行。
 * ① big：构造 1MiB payload 单行回传（自带 sha256 供父对照）；
 * ② flood：连发 n 行带序号（每行 ~2KiB pad 撑大缓冲，逼出背压）；
 * ③ 背压计数：process.stdout.write() 返 false 计数（缓冲超 highWaterMark 即 false，
 *    不暂停直接续写——验证「不协同排水也不丢」（pipe 缓冲无上限生长，内核侧兜住），
 *    暂停协同的正确形态由生产代码做，此处先证下界）。
 */
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

// 每行 pad ~2KiB：500 行 ≈ 1MiB 总量，足以把父侧读速差异转化成子侧缓冲堆积
const PAD = 'x'.repeat(2048);

const lines = createInterface({ input: process.stdin });
let backpressureHits = 0;

/** 带背压计数的写行（不暂停续写——本炮证「下界：不排也不丢」） */
function writeLine(obj) {
  if (!process.stdout.write(JSON.stringify(obj) + '\n')) {
    backpressureHits++; // 缓冲超 highWaterMark——背压信号点
  }
}

lines.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.cmd === 'big') {
    // 构造 >1MiB 的 payload（重复段 + 尾标记，内容可哈希对照）
    const payload = `poc10-payload|${'A'.repeat(1024 * 1024)}|END`;
    writeLine({
      cmd: 'big',
      payload,
      hash: createHash('sha256').update(payload, 'utf8').digest('hex'),
    });
  } else if (m.cmd === 'flood') {
    for (let i = 0; i < m.n; i++) {
      writeLine({ cmd: 'flood-seq', seq: i, pad: PAD });
    }
    writeLine({ cmd: 'flood-done', n: m.n, backpressureHits });
  } else if (m.cmd === 'exit') {
    process.exit(0);
  }
});
