import type { SkillFrontmatter } from '../loader/frontmatter.js';

export interface SkillPermissionScope {
  skillName: string;
  allowedTools?: string[];
  deniedTools?: string[];
  timeout?: number;
  effort?: 'low' | 'medium' | 'high';
}

export function buildPermissionScope(name: string, fm: SkillFrontmatter): SkillPermissionScope | undefined {
  if (!fm.allowed_tools?.length && !fm.denied_tools?.length && !fm.timeout && !fm.effort) {
    return undefined;
  }

  return {
    skillName: name,
    allowedTools: fm.allowed_tools,
    deniedTools: fm.denied_tools,
    timeout: fm.timeout,
    effort: fm.effort,
  };
}

export function isToolAllowed(toolName: string, scope: SkillPermissionScope): boolean {
  if (scope.deniedTools?.includes(toolName)) return false;
  if (scope.allowedTools && !scope.allowedTools.includes(toolName)) return false;
  return true;
}
