/**
 * Session-level tracker for files that have been read.
 * Used by edit_code to enforce "read-before-edit" safety gate.
 */
const readFiles = new Set<string>();

export function markFileRead(resolvedPath: string): void {
  readFiles.add(resolvedPath);
}

export function hasFileBeenRead(resolvedPath: string): boolean {
  return readFiles.has(resolvedPath);
}

export function clearReadTracker(): void {
  readFiles.clear();
}
