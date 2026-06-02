import { execSync } from 'node:child_process';
import { getLogger } from './logger.js';

const logger = getLogger('kill-tree');

export async function killTree(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      // Try killing the process group first (negative PID)
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }

      // Wait 200ms then force kill if still alive
      await new Promise(r => setTimeout(r, 200));

      try {
        process.kill(-pid, 0); // check if still alive
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already dead, good
      }
    }
  } catch (err) {
    logger.debug({ pid, err }, 'killTree: process already exited');
  }
}
