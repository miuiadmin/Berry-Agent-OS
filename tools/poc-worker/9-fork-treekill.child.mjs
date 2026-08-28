/**
 * PoC ⑨ fork 侧：按父指令 spawn 孙进程并回报 pid。
 * 孙进程 = node -e 长活循环（不主动退出）——树杀对象。本子进程自身不 spawn
 * 孙之前是干净的（与「应用在 external 域内 spawn 孙」的生产形态对齐）。
 */
import { spawn } from 'node:child_process';

let grand = null;

process.on('message', (m) => {
  if (m.cmd === 'spawn-grandchild') {
    // 孙进程：长活（setInterval 挂住事件循环不退出）——只有外力能收
    grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: false, // 不建组——继承本进程的 pgid（生产里孙默认同组，正合树杀模型）
    });
    process.send({ cmd: 'grand-ready', pid: grand.pid });
  } else if (m.cmd === 'exit') {
    process.exit(0);
  }
});

// 兜底：本子进程若先退（异常路径），把孙带走（防泄漏；正常路径由父树杀接管）
process.on('exit', () => {
  if (grand) {
    try {
      grand.kill('SIGKILL');
    } catch {
      /* 已死则罢 */
    }
  }
});
