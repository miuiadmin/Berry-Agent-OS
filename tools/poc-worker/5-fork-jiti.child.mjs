/**
 * PoC ⑤ fork 侧：fork 子进程内自建 jiti 实例装载 TS 应用。
 * moduleCache:false 与宿主装载器（src/context/loader.ts）同款——/reload 重载语义的基底。
 * fork 域与 worker 域互不共享模块图（跨进程），jiti 实例天然独立。
 */
import { createJiti } from 'jiti';

// fork 子进程自建实例（跨进程独立——「每域单实例」的 fork 形态）
const jiti = createJiti(import.meta.url, { moduleCache: false });

process.on('message', async (m) => {
  if (m.cmd === 'load') {
    const mod = await jiti.import(m.appPath);
    process.send({ stage: 'load1', name: mod.name, applied: mod.default() });
  } else if (m.cmd === 'reimport') {
    const mod = await jiti.import(m.appPath);
    process.send({ stage: 'load2', applied: mod.default() });
  } else if (m.cmd === 'exit') {
    process.exit(0);
  }
});
