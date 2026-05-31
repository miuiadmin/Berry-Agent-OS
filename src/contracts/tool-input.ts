/**
 * Common tool input shapes for file-related tools.
 * Different tools use different property names for the file path.
 */
export interface FileToolInput {
  path?: string;
  file_path?: string;
}

/** Extract file path from various tool input shapes (path | file_path). */
export function extractToolPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as FileToolInput;
  return obj.path ?? obj.file_path ?? null;
}
