/**
 * L5 app — subagent 内置插件（契约篇 §6.1 `builtin:subagent`；骨架篇 §6.1 纵切四注记）。
 *
 * 官方默认层第二行（Ring 2 真·可卸——卸掉即无委派能力，核心循环不破）。
 * 三注册全挂 ctx.effect（装载锚 dispose 即 LIFO 回卷，/plugin-toggle 同语义）：
 * ① in-process provider 进 ctx.subagents（真工厂闭包经 deps 注入）；
 * ② 委派工具 `agent` 进 ctx.tools（tools_change 原位刷新即模型可见）——provider 名
 *    静态绑定 'in-process'，模型不见动态选择器（§6.3 静态工具绑定）；
 * ③ 清单披露段 `subagent/list`（技能式渐进披露：render 物化 provider 名+能力位，
 *    随会话冻结、/reload 边界变更——description 本体恒静态，运行时清单绝不进
 *    system prompt 之外的任何动态拼装）。
 */

import { Type } from '../contracts/typebox.js';
import type { ToolDefinition, AgentToolResult } from '../contracts/tools.js';
import type { BuiltinPluginModule } from '../contracts/plugin.js';
import type { Context, Disposer } from '../context/types.js';
import type { SubagentsServiceFace, SubagentRun } from '../contracts/subagent.js';
import { createInProcessProvider } from '../subagent/inprocess.js';
import type { InProcessChildFactory } from '../subagent/inprocess.js';
import type { Session } from '../session/session.js';

/** 内置件构造依赖（装配期活闭包——真工厂零件 + 会话活引用） */
export interface SubagentPluginDeps {
  /** in-process 真工厂（app/subagent-factory.ts 组合根闭包产物） */
  readonly factory: InProcessChildFactory;
  /** 父会话活引用（委派工具 start 时取 ownerSessionId——结算通知路由键） */
  readonly getSession: () => Session | undefined;
}

/** 配置面（组合树行 config 腿；typebox 校验——加载器启动一次校验同款） */
const SUBAGENT_CONFIG_SCHEMA = Type.Object({
  /** 子代理 token 预算帽（子累计 totalTokens 触帽即 abort 改判 max-tokens） */
  tokenBudget: Type.Optional(Type.Number({ minimum: 1 })),
  /** 委派深度帽（与请求 maxDepth 取 min 执法） */
  maxDepth: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
});

/** 内置件配置（经 typebox 校验后的落码形态） */
type SubagentConfig = { tokenBudget?: number; maxDepth?: number };

/** 工具注册面（ctx.get('tools') 的最小结构面——与 memory 插件同款局部面） */
interface ToolsRegisterFace {
  register(def: ToolDefinition): Disposer;
}

/** 提示词段注册面（prompts 服务最小面，pi-4(a) 具名段——与 memory 插件同款） */
interface PromptsRegisterFace {
  registerSection(section: { id: string; render(): string }): Disposer;
}

/** 委派工具名（模型调用词汇——静态绑定 in-process 的单实例） */
const AGENT_TOOL_NAME = 'agent';

/**
 * 构造 subagent 内置插件模块引用（builtins 注册表 `builtin:subagent` 行）。
 *
 * @param deps 真工厂 + 活会话引用
 * @returns BuiltinPluginModule（与文件插件 named export 同形——装载管线完全同轨）
 */
export function createSubagentPlugin(deps: SubagentPluginDeps): BuiltinPluginModule {
  return {
    name: 'subagent',
    inject: ['tools', 'prompts', 'subagents'],
    config: SUBAGENT_CONFIG_SCHEMA,
    apply: (ctx: Context, config?: Readonly<Record<string, unknown>>) =>
      applySubagentPlugin(ctx, (config ?? {}) as SubagentConfig, deps),
  };
}

/** 内置件 apply 本体（三注册——全部挂 ctx.effect 随装载锚回卷） */
async function applySubagentPlugin(ctx: Context, cfg: SubagentConfig, deps: SubagentPluginDeps): Promise<void> {
  const subagents = ctx.get<SubagentsServiceFace>('subagents');
  const tools = ctx.get<ToolsRegisterFace>('tools');
  const prompts = ctx.get<PromptsRegisterFace>('prompts');

  /* ---- ① in-process provider（真工厂 + 配置帽）---- */
  const provider = createInProcessProvider({
    factory: deps.factory,
    ...(cfg.tokenBudget !== undefined ? { tokenBudget: cfg.tokenBudget } : {}),
    ...(cfg.maxDepth !== undefined ? { maxDepth: cfg.maxDepth } : {}),
  });
  ctx.effect(() => subagents.register(provider));

  /* ---- ② 委派工具（§6.3 静态绑定：description 静态、provider 名不进参数面）---- */
  ctx.effect(() => tools.register(createAgentTool({ subagents, getSession: deps.getSession })));

  /* ---- ③ 清单披露段（技能式渐进披露——render 仅重建时点求值，随会话冻结）---- */
  ctx.effect(() =>
    prompts.registerSection({
      id: 'subagent/list',
      render: () => renderProviderList(subagents),
    }),
  );
}

/** 委派工具构造选项 */
interface AgentToolOptions {
  readonly subagents: SubagentsServiceFace;
  readonly getSession: () => Session | undefined;
}

/**
 * 委派工具定义（v1 单实例——前台 await 结算 / 后台立即返回 jobId）。
 * effect 归 'read'：委派本身不触盘，子的写走子管道自己的守门（父 read-only 档
 * 委派的子同样 read-only——§6.5 快照语义；归 'write' 会误杀只读研究委派）。
 */
function createAgentTool(opts: AgentToolOptions): ToolDefinition {
  return {
    name: AGENT_TOOL_NAME,
    label: '委派子代理',
    description: [
      '委派一个子代理执行一次性任务：子代理获得独立工具环境（文件读写等，权限随当前沙箱档位）。',
      '前台（缺省）阻塞至结算并返回其汇报文本；background:true 注册为后台任务立即返回任务 id，结算后自动通知。',
      '可用子代理类型见系统提示词的子代理清单段（静态）。',
    ].join(''),
    parameters: Type.Object({
      prompt: Type.String({ description: '任务指令（子代理的唯一输入——写清目标与边界，它是独立上下文）' }),
      label: Type.Optional(Type.String({ description: '人读标签（任务列表/通知显示）' })),
      background: Type.Optional(Type.Boolean({ description: 'true = 后台执行（立即返回任务 id，结算自动通知）' })),
      toolFilter: Type.Optional(
        Type.Array(Type.String(), { description: '工具 include 名单（如 ["read_file","grep"]）——缺省全量' }),
      ),
      persona: Type.Optional(Type.String({ description: '子代理系统提示覆盖（人格/角色设定）' })),
      maxDepth: Type.Optional(Type.Number({ description: '委派深度上限（缺省 3）' })),
    }),
    effect: 'read',
    execute: async (args, tctx): Promise<AgentToolResult> => {
      // 参数面（schema 校验已过守门段——此处形状可信，逐字段取用）
      const req = args as {
        prompt: string;
        label?: string;
        background?: boolean;
        toolFilter?: string[];
        persona?: string;
        maxDepth?: number;
      };
      const ownerSessionId = opts.getSession()?.header.sessionId;
      const run: SubagentRun = opts.subagents.start({
        provider: 'in-process',
        prompt: req.prompt,
        ...(req.label !== undefined ? { label: req.label } : {}),
        ...(ownerSessionId !== undefined ? { ownerSessionId } : {}),
        ...(req.toolFilter !== undefined ? { toolFilter: req.toolFilter } : {}),
        ...(req.persona !== undefined ? { persona: req.persona } : {}),
        ...(req.maxDepth !== undefined ? { maxDepth: req.maxDepth } : {}),
        ...(req.background === true ? { background: true } : {}),
      });

      // 后台路：立即返回任务 id（通知走 §6.4 三通道——不在这里等）
      if (req.background === true) {
        return {
          content: [
            {
              type: 'text',
              text: `子代理已入后台（${req.label ?? '无标签'}）：任务 id ${run.job?.id ?? run.id}，结算后自动通知`,
            },
          ],
        };
      }

      // 前台路：父 ToolCtx 取消信号传导子运行（用户中断即子收工——好公民工具纪律）
      tctx.signal?.addEventListener('abort', () => run.dispose(), { once: true });
      const result = await run.result;
      run.dispose(); // 前台释放归调用方（§6.4 onSettle 链序——此处即调用方）
      // 结算折叠已在 onSettle 链完成（llm/usage）——工具结果不重复报 usage
      if (result.stopReason !== 'completed') {
        return {
          content: [
            {
              type: 'text',
              text: `子代理「${req.label ?? req.prompt.slice(0, 40)}」未完成（${result.stopReason}${
                result.diagnostic !== undefined ? `：${result.diagnostic}` : ''
              }）${result.output !== '' ? `\n部分产出：${result.output}` : ''}`,
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: result.output }] };
    },
  };
}

/** 清单披露段渲染（provider 名 + 能力位——随物化冻结，/reload 边界变更） */
function renderProviderList(subagents: SubagentsServiceFace): string {
  const rows = subagents.list().map((info) => {
    const caps = [
      info.capabilities.toolFilter ? '工具子集' : null,
      info.capabilities.persona ? '人格' : null,
      info.capabilities.depthLimit ? '深度帽' : null,
    ].filter((part) => part !== null);
    return `- ${info.name}${caps.length > 0 ? `（支持：${caps.join('/')}）` : ''}`;
  });
  if (rows.length === 0) return '';
  return ['可用子代理类型（经 agent 工具委派）：', ...rows].join('\n');
}
