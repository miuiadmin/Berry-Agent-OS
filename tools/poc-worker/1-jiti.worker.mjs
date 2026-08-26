/**
 * PoC ① worker 侧：worker_threads 内自建 jiti 实例装载 TS 插件。
 * moduleCache:false 与宿主装载器（src/context/loader.ts）同款——/reload 重载语义的基底。
 */
import { createJiti } from 'jiti';
import { parentPort } from 'node:worker_threads';

const port = parentPort;
// worker realm 自建实例：与主线程互不共享（「每 realm 单实例」形态的实证面）
const jiti = createJiti(import.meta.url, { moduleCache: false });

port.on('message', async (m) => {
  if (m.cmd === 'load') {
    const mod = await jiti.import(m.pluginPath);
    port.postMessage({ stage: 'load1', name: mod.name, applied: mod.default() });
  } else if (m.cmd === 'reimport') {
    const mod = await jiti.import(m.pluginPath);
    port.postMessage({ stage: 'load2', applied: mod.default() });
  }
});
