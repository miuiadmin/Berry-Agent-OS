/**
 * PoC ⑧ probe 侧：在 PM 白名单（父侧推导的 flags）下做四探测。
 * 各探测独立 try/catch，错误码原样回报——父侧判定「拒的签名对不对」。
 * 场景常量由父侧约定：allowedDir/outsideDir 经 argv 传入。
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const allowedDir = process.argv[2];
const outsideDir = process.argv[3];

/** 单探测：返回 {pass, code}——pass=操作成功；失败时 code=错误码 */
function probe(fn) {
  try {
    fn();
    return { pass: true, code: null };
  } catch (err) {
    return { pass: false, code: err.code ?? err.constructor.name };
  }
}

const report = {
  // 读根内：白名单在 → 应过
  readInside: probe(() => readFileSync(join(allowedDir, 'seed.txt'), 'utf8')),
  // 读根外：outside 不在读白名单 → 应拒（ERR_ACCESS_DENIED）
  readOutside: probe(() => existsSync(join(outsideDir, 'whatever.txt'))),
  // 写根内：allowed 在写白名单 → 应过
  writeInside: probe(() => writeFileSync(join(allowedDir, 'new.txt'), 'written-inside')),
  // 写根外：outside 不在写白名单 → 应拒（ERR_ACCESS_DENIED）
  writeOutside: probe(() => writeFileSync(join(outsideDir, 'new.txt'), 'written-outside')),
};
// 通道独立性反证：existsSync 用 stat 系——PM 对 stat 的管辖与 openFileRead 不同，
// 上面 readOutside 若以 stat 形式不拒，父侧会看到 code 差异（记档面，不静默）。

console.log(JSON.stringify(report));
// 收尾清掉写根内的探测残留（outside 若被写进去就是 FAIL，父侧看不到清理也无妨）
rmSync(join(allowedDir, 'new.txt'), { force: true });
process.exit(0);
