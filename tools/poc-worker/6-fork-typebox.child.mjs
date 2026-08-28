/**
 * PoC ⑥ fork 侧：构造 typebox schema 过界给宿主校验；并校验宿主过界来的 schema。
 * 子进程自 import 同一物理包——跨进程双实例（正是「每域单实例」要验证的 fork 形态）。
 */
import { Type } from 'typebox';
import { Value } from 'typebox/value';

process.on('message', (m) => {
  if (m.cmd === 'schema') {
    // fork 子进程自己的 typebox 实例构造
    const schema = Type.Object({ name: Type.String(), age: Type.Optional(Type.Number()) });
    const symCount = Object.getOwnPropertySymbols(schema).length;
    // process.send 走 nodejs IPC 结构化克隆——schema 对象能否保真过界是本 PoC 的判定对象
    process.send({ cmd: 'schema', schema, symCount });
  } else if (m.cmd === 'check') {
    const ok = Value.Check(m.schema, { id: 'row-1', tags: ['a', 'b'] });
    const bad = Value.Check(m.schema, { id: 'row-1', tags: 'not-array' });
    const symCount = Object.getOwnPropertySymbols(m.schema).length;
    process.send({ cmd: 'check-result', ok, bad, symCount });
  } else if (m.cmd === 'exit') {
    process.exit(0);
  }
});
