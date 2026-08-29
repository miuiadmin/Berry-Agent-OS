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
 * 孤儿防护：父亡（宿主被 SIGKILL）→ stdin 管道断 → 'end' 到达——组杀本域
 * 进程组（同组孙进程一并收割）后自尽（in-flight 调用已无消费者；域内资源随
 * 进程死释放，与 worker terminate 同语义）。应用自起定时器等长命 handle 时本
 * 防线兜住「stdin 断后进程仍活」的孤儿形态；正常关停走宿主树杀（负 pid）不
 * 依赖本防线。宿主侧 in-flight exec 命令（svc-invoke 宿主半 spawn、每命令
 * 自建组）本防线不可达——由 exec 命令登记簿 + 启动期孤儿清扫承接（契约篇
 * §6.6 子进程治理条 exec 腿）。
 */
import { StdioBridgePort } from './port-stdio.js';
import { startWorkerRealm } from './worker.js';

// 域 id（argv[0]=node、argv[1]=本入口；缺省 'external' 与 worker 入口缺省同族）
const workerId = process.argv[2] ?? 'external';
// NDJSON 载体端口：stdin 入站（宿主→域）、stdout 出站（域→宿主）——stdio[2]
// （stderr）不进协议面：崩溃栈由宿主侧收集为死亡结算 diagnostic
startWorkerRealm(new StdioBridgePort(process.stdin, process.stdout), workerId);

/**
 * 孤儿收尾（critic #1 收割腿，2026-08-29）：stdin 断 = 宿主已亡——先组杀本域
 * 进程组再自尽。fork 域 detached 自成组长（pgid = pid），负 pid 组杀罩域内
 * 直接 spawn 的同组后代（PM 白名单放行的 child processes 等：非 detached
 * spawn 继承本域 pgid——原 `process.exit(0)` 只退域进程本身、同组孙进程永活
 * = 宪章七进程墙的生命周期残角）；域自身亦在组内，组杀即自尽（POSIX：向
 * 自身所在组发不可捕获信号，进程在 kill() 返回前终结）。kill 抛错（组已空
 * 边角 / win32 无负 pid 语义）兜 exit(0) 退回纯自尽形态。
 */
function reapDomainGroup(): void {
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    // 组杀不达（边角平台形态）——跳过，走纯自尽
  }
  process.exit(0);
}
// 孤儿防线：stdin 断 = 宿主已亡 = 域死（见 reapDomainGroup 头注）——组杀
// 收割同组后代后自尽，跳过一切回卷（与进程被杀同语义：域内清理不依赖本
// 路径，宿主侧行作用域回卷才是收尾面；正常关停走宿主树杀不依赖本防线）
process.stdin.on('end', reapDomainGroup);
process.stdin.on('close', reapDomainGroup);
// stdin 缺省暂停态——resume 才会有 'end' 事件（孤儿防线生效前提）
process.stdin.resume();
