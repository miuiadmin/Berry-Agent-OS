/**
 * PoC ② worker 侧：构造 typebox schema 过界给主 realm 校验；并校验主 realm 过界来的 schema。
 */
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { parentPort } from 'node:worker_threads';

const port = parentPort;

port.on('message', (m) => {
  if (m.cmd === 'schema') {
    // worker realm 自己的 typebox 实例构造（跨 realm 双实例形态）
    const schema = Type.Object({ name: Type.String(), age: Type.Optional(Type.Number()) });
    const symCount = Object.getOwnPropertySymbols(schema).length;
    // postMessage 走结构化克隆——schema 对象能否保真过界是本 PoC 的判定对象
    port.postMessage({ cmd: 'schema', schema, symCount });
  } else if (m.cmd === 'check') {
    const ok = Value.Check(m.schema, { name: 'berry', age: 1 });
    const bad = Value.Check(m.schema, { name: 42 });
    port.postMessage({ cmd: 'check-result', ok, bad });
  }
});
