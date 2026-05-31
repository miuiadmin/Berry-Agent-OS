/**
 * Process signal utilities — safe kill and liveness check helpers.
 *
 * All functions swallow errors from already-exited processes,
 * matching the `try { process.kill(...) } catch { /* already dead *\/ }` pattern
 * used throughout the codebase.
 */

/**
 * Check whether a process with the given PID is still alive.
 * Uses signal 0 (no-op) to probe without sending a real signal.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a signal to a process, silently ignoring if it has already exited.
 * Returns `true` if the signal was delivered, `false` if the process was gone.
 */
export function killProcessSafely(pid: number, signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
