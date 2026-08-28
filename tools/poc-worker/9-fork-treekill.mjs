#!/usr/bin/env node
/**
 * PoC ⑨（第三十七批 PoC 台账·补炮五）：fork 域内 spawn 孙进程的树杀建组语义。
 *
 * d37 研究判词：external 域（PM 子进程）里应用 spawn 的孙进程（spawn 强制经
 * ctx.exec 的逃逸面）必须能整树收割——机制 = 建组（POSIX process group）+
 * 负 pid 杀（kill(-pgid, sig)）。
 *
 * 本炮三段：
 *   段一：fork {detached:true} → child 自成组长（pgid == childPid）；child 内
 *     spawn 孙进程 → 孙继承 child 的 pgid（同组）——组关系用 ps -o pgid= 实证；
 *   段二：父 process.kill(-childPid, SIGKILL) → child 与孙全灭（kill(pid,0)
 *     双双 ESRCH 轮询确认）——树杀一次成形；
 *   段三（对照，不真杀）：非 detached fork → child 与父同组——证明「不建组就
 *     树杀」必然误伤父域（负 pid 杀等于自杀），建组是唯一正解。
 * 退出码：0 = PASS，1 = FAIL。
 */
import { fork, spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const childPath = fileURLToPath(new URL('./9-fork-treekill.child.mjs', import.meta.url));

// 30 秒硬超时
const timer = setTimeout(() => {
  console.error('FAIL: PoC 超时（30s）——树杀/组关系探测挂死');
  process.exit(1);
}, 30_000);
timer.unref();

let fail = false;
/** 兜底击杀清单：任何路径退出前把可能存活的探测进程清干净（防泄漏） */
const cleanup = new Set();
function sweep() {
  for (const pid of cleanup) {
    try {
      process.kill(-pid, 'SIGKILL'); // 尽量按组杀
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 已死则罢 */
      }
    }
  }
}
process.on('exit', sweep);

/** 查某 pid 的 pgid（darwin ps；失败返回 null） */
function pgidOf(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pgid=', '-p', String(pid)], (err, stdout) => {
      resolve(err ? null : Number(stdout.trim()));
    });
  });
}

/** 轮询等待 pid 死透（kill(pid,0) 抛 ESRCH 即死；上限 ~3s） */
async function waitDead(pid) {
  for (let i = 0; i < 60; i++) {
    try {
      process.kill(pid, 0); // 信号 0 = 探活不发信号
    } catch (err) {
      return err.code === 'ESRCH'; // ESRCH = 进程不存在 = 死透
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/* ---- 段一+二：detached fork 建组 → 孙同组 → 负 pid 树杀 ---- */
{
  // stdio 显式数组时必须带 'ipc' 席位——fork 的 IPC channel 不自动补（缺则 process.send 为 undefined）
  const child = fork(childPath, [], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const childPid = child.pid;
  cleanup.add(childPid);
  child.send({ cmd: 'spawn-grandchild' }); // 触发指令——不发则子等指令父等回报，死锁

  const grandPid = await new Promise((resolve, reject) => {
    child.stdout.on('data', (c) => {
      const m = String(c).match(/GRANDPID=(\d+)/); // 子回报孙 pid（单行协议）
      if (m) resolve(Number(m[1]));
    });
    child.on('message', (m) => {
      if (m?.cmd === 'grand-ready') resolve(m.pid);
    });
    child.on('error', reject);
  });
  cleanup.add(grandPid);

  // 组关系实证：child 自成组长（pgid == pid），孙与其同组
  const childPgid = await pgidOf(childPid);
  const grandPgid = await pgidOf(grandPid);
  const groupOk = childPgid === childPid && grandPgid === childPid;
  console.log(
    `[段一] 建组: child(${childPid}) pgid=${childPgid}(组长=${childPgid === childPid ? '是' : '否'}) 孙(${grandPid}) pgid=${grandPgid}(同组=${grandPgid === childPid ? '是' : '否'}) → ${groupOk ? 'PASS' : 'FAIL'}`,
  );
  if (!groupOk) fail = true;

  // 段二：负 pid 一次性树杀（整组）
  process.kill(-childPid, 'SIGKILL');
  const [childDead, grandDead] = await Promise.all([waitDead(childPid), waitDead(grandPid)]);
  const killOk = childDead && grandDead;
  console.log(
    `[段二] 树杀 kill(-${childPid}, SIGKILL): child 灭=${childDead} 孙灭=${grandDead} → ${killOk ? 'PASS' : 'FAIL'}`,
  );
  if (!killOk) fail = true;
  cleanup.delete(childPid);
  cleanup.delete(grandPid);
}

/* ---- 段三（对照）：非 detached fork 与父同组——只观测不真杀 ---- */
{
  const child = fork(childPath, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const childPid = child.pid;
  cleanup.add(childPid);
  const myPgid = await pgidOf(process.pid);
  const childPgid = await pgidOf(childPid);
  const sameGroup = childPgid === myPgid;
  console.log(
    `[段三] 对照·不建组: 父(${process.pid}) pgid=${myPgid} child(${childPid}) pgid=${childPgid} 同组=${sameGroup} → ${sameGroup ? 'PASS（负 pid 杀会误伤父域——建组是树杀唯一正解）' : 'FAIL'}`,
  );
  if (!sameGroup) fail = true;
  child.kill('SIGKILL'); // 对照子收尾（单点杀即可，未建组）
  await waitDead(childPid);
  cleanup.delete(childPid);
}

clearTimeout(timer);
console.log(
  fail
    ? '== PoC ⑨ 结论: FAIL（树杀建组语义与预期不符）=='
    : '== PoC ⑨ 结论: PASS（detached 建组+孙同组+负 pid 一次树杀）==',
);
process.exit(fail ? 1 : 0);
