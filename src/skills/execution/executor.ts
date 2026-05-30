import type { LoadedSkill } from '../loader/loader.js';
import type { SkillPermissionScope } from '../activation/permission.js';
import { buildPermissionScope } from '../activation/permission.js';
import { processTemplateVars, processShellInjections } from './template.js';
import { runHook, hasHook } from './hooks.js';
import type { TemplateContext } from './template.js';

export interface SkillExecuteArgs {
  arguments?: string;
  sessionId?: string;
  cwd?: string;
  shellInjection?: boolean;
}

export interface SkillExecuteResult {
  content: string;
  permissionScope?: SkillPermissionScope;
  hooks: { before: boolean; after: boolean; onError: boolean };
  effort?: 'low' | 'medium' | 'high';
  contextFork: boolean;
  hookOutput?: { stdout: string; stderr: string };
}

export class SkillExecutor {
  async execute(skill: LoadedSkill, args?: SkillExecuteArgs): Promise<SkillExecuteResult> {
    const fm = skill.frontmatter;

    const beforeResult = await runHook('before_execution', fm, skill.skillDir);

    const templateCtx: TemplateContext = {
      skillDir: skill.skillDir,
      sessionId: args?.sessionId,
      cwd: args?.cwd,
    };

    if (args?.arguments !== undefined) {
      templateCtx.arguments = args.arguments;
      templateCtx.positional = args.arguments.split(/\s+/).filter(Boolean);
      if (fm.arguments) {
        templateCtx.named = {};
        for (let i = 0; i < fm.arguments.length && i < templateCtx.positional.length; i++) {
          templateCtx.named[fm.arguments[i]] = templateCtx.positional[i];
        }
      }
    }

    let content = processTemplateVars(skill.rawContent, templateCtx);

    if (args?.shellInjection) {
      content = await processShellInjections(content, skill.skillDir);
    }

    return {
      content,
      permissionScope: buildPermissionScope(skill.name, fm),
      hooks: {
        before: hasHook('before_execution', fm),
        after: hasHook('after_execution', fm),
        onError: hasHook('on_error', fm),
      },
      effort: fm.effort,
      contextFork: fm.context_fork,
      hookOutput: beforeResult ? { stdout: beforeResult.stdout, stderr: beforeResult.stderr } : undefined,
    };
  }

  async onComplete(skill: LoadedSkill, success: boolean): Promise<void> {
    const hookName = success ? 'after_execution' : 'on_error';
    await runHook(hookName, skill.frontmatter, skill.skillDir);
  }
}
