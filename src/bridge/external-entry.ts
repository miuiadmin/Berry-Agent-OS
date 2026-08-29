/**
 * bridge — external（fork 进程）域入口（契约篇 §1.7 external 载体，external carrier 落码批）。
 *
 * fork 子进程的主模块：argv[2] 携域 id（宿主半 spawn 时指名 `e:<行id>`），
 * stdin/stdout 包成 NDJSON 载体端口后**复用 worker 域入口** startWorkerRealm
 * ——svc.load/apply/unload/invoke/tool-invoke 五处理方 + 代理桩 ctx + 事件
 * 回投全部同码（「不换协议只换 carrier」的域内半边；realm 内 jiti 装载/
 * schema 校验在 fork 域可用性 = PoC ⑤⑥ 实证）。
 *
 * 与 worker.ts 的关系：import 它只为拿 startWorkerRealm——其底部
 * `if (parentPort !== null)` 守卫在 fork 进程（无 parent port）天然 no-op，
 * import 副作用为零，安全。
 *
 * 孤儿防护：父亡（宿主被 SIGKILL）→ stdin 管道断 → 'end' 到达——即刻退
 * （in-flight 调用已无消费者；域内资源随进程死释放，与 worker terminate
 * 同语义）。应用自起定时器等长命 handle 时本防线兜住「stdin 断后进程仍活」
 * 的孤儿形态；正常关停走宿主树杀（负 pid）不依赖本防线。
 */
import { StdioBridgePort } from './port-stdio.js';
import { startWorkerRealm } from './worker.js';

// 域 id（argv[0]=node、argv[1]=本入口；缺省 'external' 与 worker 入口缺省同族）
const workerId = process.argv[2] ?? 'external';
// NDJSON 载体端口：stdin 入站（宿主→域）、stdout 出站（域→宿主）——stdio[2]
// （stderr）不进协议面：崩溃栈由宿主侧收集为死亡结算 diagnostic
startWorkerRealm(new StdioBridgePort(process.stdin, process.stdout), workerId);
// 孤儿防线：stdin 断 = 宿主已亡 = 域死（见头注）——exit(0) 跳过一切回卷，
// 与进程被杀同语义（域内清理不依赖本路径，宿主侧行作用域回卷才是收尾面）
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
// stdin 缺省暂停态——resume 才会有 'end' 事件（孤儿防线生效前提）
process.stdin.resume();
