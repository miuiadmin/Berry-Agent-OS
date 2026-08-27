/**
 * L5 app — subagent 官方件（契约篇 §6.1 `builtin:subagent`；骨架篇 §6.1 纵切四注记）。
 *
 * 官方默认层第三行（chat 首行、memory 次行之后；Ring 2 真·可卸——卸掉即无
 * 委派能力，核心循环不破）。
 * 三注册全挂 ctx.effect（装载锚 dispose 即 LIFO 回卷，/plugin-toggle 同语义）：
 * ① in-process provider 进 ctx.subagents（真工厂闭包经 deps 注入）；
 * ② 委派工具 `agent` 进 ctx.tools（tools_change 原位刷新即模型可见）——provider 名
 *    静态绑定 'in-process'，模型不见动态选择器（§6.3 静态工具绑定）；
 * ③ 清单披露段 `subagent/list`（技能式渐进披露：render 物化 provider 名+能力位，
 *    随会话冻结、/reload 边界变更——description 本体恒静态，运行时清单绝不进
 *    system prompt 之外的任何动态拼装）。
 */

import { Type } from '../contracts/typebox.js';
import type { AgentToolResult, ToolDefinition, ToolsService } from '../contracts/tools.js';
import type { BuiltinPluginModule, PluginContext } from '../contracts/plugin.js';
import type { PromptsService } from '../contracts/app.js';
import type { Context } from '../context/types.js';
import type { SubagentsServiceFace, SubagentRun } from '../contracts/subagent.js';
import { createInProcessProvider } from '../subagent/inprocess.js';
import type { InProcessChildFactory } from '../subagent/inprocess.js';
import { defaultAgentLocations, discoverAgentMds, mergeRequestForAgentMd, type AgentLocation } from './agents-md.js';
import type { Session } from '../session/session.js';

/** 官方件构造依赖（装配期活闭包——真工厂零件 + 会话活引用） */
export interface SubagentPluginDeps {
  /** in-process 真工厂（app/subagent-factory.ts 组合根闭包产物） */
  readonly factory: InProcessChildFactory;
  /** 父会话活引用（委派工具 start 时取 ownerSessionId——结算通知路由键） */
  readonly getSession: () => Session | undefined;
  /**
   * 声明式子代理发现位置（缺省 defaultAgentLocations——契约篇 §4.4 声明式段
   * 镜像 skills 四处；测试注入 fixture 目录用）
   */
  readonly agentLocations?: readonly AgentLocation[];
}

/** 配置面（组合树行 config 腿；typebox 校验——加载器启动一次校验同款） */
const SUBAGENT_CONFIG_SCHEMA = Type.Object({
  /** 子代理 token 预算帽（子累计 totalTokens 触帽即 abort 改判 max-tokens） */
  tokenBudget: Type.Optional(Type.Number({ minimum: 1 })),
  /** 委派深度帽（与请求 maxDepth 取 min 执法） */
  maxDepth: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
});

/** 官方件配置（经 typebox 校验后的落码形态） */
type SubagentConfig = { tokenBudget?: number; maxDepth?: number };

/** 委派工具名（模型调用词汇——静态绑定 in-process 的单实例） */
const AGENT_TOOL_NAME = 'agent';

/**
 * 构造 subagent 官方件模块引用（builtins 注册表 `builtin:subagent` 行）。
 *
 * @param deps 真工厂 + 活会话引用
 * @returns BuiltinPluginModule（与文件插件 named export 同形——装载管线完全同轨）
 */
export function createSubagentPlugin(deps: SubagentPluginDeps): BuiltinPluginModule {
  return {
    name: 'subagent',
    inject: ['tools', 'prompts', 'subagents'],
    config: SUBAGENT_CONFIG_SCHEMA,
    apply: (ctx: PluginContext, config?: Readonly<Record<string, unknown>>) =>
      applySubagentPlugin(ctx, (config ?? {}) as SubagentConfig, deps),
  };
}

/** 官方件 apply 本体（三注册 + 声明式子代理批——全部挂 ctx.effect 随装载锚回卷） */
async function applySubagentPlugin(ctx: PluginContext, cfg: SubagentConfig, deps: SubagentPluginDeps): Promise<void> {
  const subagents = ctx.get<SubagentsServiceFace>('subagents');
  const tools = ctx.get<ToolsService>('tools');
  const prompts = ctx.get<PromptsService>('prompts');

  /* ---- ① in-process provider（真工厂 + 配置帽）---- */
  const provider = createInProcessProvider({
    factory: deps.factory,
    ...(cfg.tokenBudget !== undefined ? { tokenBudget: cfg.tokenBudget } : {}),
    ...(cfg.maxDepth !== undefined ? { maxDepth: cfg.maxDepth } : {}),
  });
  ctx.effect(() => subagents.register(provider));

  /* ---- ①b 声明式子代理（agents/*.md——契约篇 §4.4 声明式段，尾刀落码）----
   * 每文件一 named provider（in-process 机器 + mergeRequest 固定注入：正文写
   * persona、tools 交集、model 覆盖）+ 一静态工具 agent_<name>（工具闭包绑定
   * provider 名——§6.3 模型不见动态选择器，dsh 档位行纪律）。坏文件 warning
   * 跳过不炸装配。 */
  const locations = deps.agentLocations ?? defaultAgentLocations(process.cwd(), { trusted: true });
  const { definitions, diagnostics } = discoverAgentMds(locations);
  for (const diagnostic of diagnostics) ctx.logger.warn(`[agents-md] ${diagnostic.message}`);
  // 内建名保留集：文件名撞内建 provider（如 in-process.md）→ 坏文件语义 warn
  // 跳过整条（服务面注册撞名是 SUBAGENT_PROVIDER_DUPLICATE 炸装配——用户文件
  // 取到这个名字是可预见的用户行为，不该炸整个官方件）
  const reservedNames = new Set(['in-process']);
  for (const def of definitions) {
    if (reservedNames.has(def.name)) {
      ctx.logger.warn(`[agents-md] ${def.filePath}：name "${def.name}" 与内建 provider 撞名——跳过该声明式子代理`);
      continue;
    }
    // 工具名词汇面约束（模型调用面 ^[A-Za-z0-9_-]+$）：基名非法 → 只注册 provider 不注册工具，诊断告警
    if (!/^[A-Za-z0-9_-]+$/.test(def.name)) {
      ctx.logger.warn(
        `[agents-md] ${def.filePath}：name "${def.name}" 不合工具名字符集（字母/数字/_/-）——provider 已注册但无 agent_<name> 工具`,
      );
    } else {
      ctx.effect(() =>
        tools.register(
          createAgentTool({
            subagents,
            getSession: deps.getSession,
            agentName: def.name,
            providerName: def.name,
            staticDescription: def.description,
          }),
        ),
      );
    }
    const declarative = createInProcessProvider({
      factory: deps.factory,
      ...(cfg.tokenBudget !== undefined ? { tokenBudget: cfg.tokenBudget } : {}),
      ...(cfg.maxDepth !== undefined ? { maxDepth: cfg.maxDepth } : {}),
      name: def.name,
      description: def.description,
      mergeRequest: mergeRequestForAgentMd(def),
    });
    ctx.effect(() => subagents.register(declarative));
  }

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

/**
 * context 请求位参数面（第三十一批 context 腿——两形态共用）：携带父会话尾轮
 * 上下文，父闭合边界投影裁尾 N 轮（user 消息边界）作子首请求种子。帽在工厂侧
 * min(请求值, 20) 钳制（schema 不硬拒——钳制语义写进 description）。
 */
const CONTEXT_PARAM = Type.Optional(
  Type.Object(
    { recentTurns: Type.Number({ minimum: 1, description: '携带的父会话尾轮数（超过装配帽 20 按 20 封顶）' }) },
    { description: '携带父会话尾轮上下文作子首请求种子（父闭合边界内裁尾 N 轮）' },
  ),
);

/** 委派工具构造选项 */
interface AgentToolOptions {
  readonly subagents: SubagentsServiceFace;
  readonly getSession: () => Session | undefined;
  /**
   * 声明式子代理名（静态多工具形态）：提供即生成 `agent_<name>` 定制工具——
   * 工具闭包绑定该子代理（description 换文件 frontmatter 描述、参数面收窄、
   * provider 路由钉死）；缺省 = 通用 `agent` 工具（v1 单实例形态）。
   */
  readonly agentName?: string;
  /** provider 路由名（静态绑定——缺省 'in-process'；声明式工具传文件 name） */
  readonly providerName?: string;
  /** 静态 description（声明式工具 = 文件 frontmatter description——模型选择依据） */
  readonly staticDescription?: string;
}

/**
 * 委派工具定义（双形态：通用 v1 / 声明式静态）。
 * effect 归 'read'：委派本身不触盘，子的写走子管道自己的守门（父 read-only 档
 * 委派的子同样 read-only——§6.5 快照语义；归 'write' 会误杀只读研究委派）。
 * 导出面（第三纵切）：delegable 应用的 `agent_<id>` 静态工具复用本构造
 * （组合根 boot 注册——与声明式 agents/*.md 同形态）。
 */
export function createAgentTool(opts: AgentToolOptions): ToolDefinition {
  const isStatic = opts.agentName !== undefined;
  // 声明式形态：persona/toolFilter 由文件固定（mergeRequest 收窄执法）——参数面
  // 不暴露这两个位（模型给了也会被合并收窄，索性不误导）；prompt/label/background
  // /maxDepth/context 与通用形态同语义（context/maxDepth 不被文件钉死故不收窄）
  return {
    name: isStatic ? `agent_${opts.agentName}` : AGENT_TOOL_NAME,
    label: isStatic ? `委派 ${opts.agentName}` : '委派子代理',
    description: isStatic
      ? [
          `${opts.staticDescription ?? `声明式子代理 ${opts.agentName}`}。`,
          '委派其执行一次性任务：前台（缺省）阻塞至结算并返回其汇报文本；background:true 注册为后台任务立即返回任务 id，结算后自动通知。',
        ].join('')
      : [
          '委派一个子代理执行一次性任务：子代理获得独立工具环境（文件读写等，权限随当前沙箱档位）。',
          '前台（缺省）阻塞至结算并返回其汇报文本；background:true 注册为后台任务立即返回任务 id，结算后自动通知。',
          '可用子代理类型见系统提示词的子代理清单段（静态）。',
        ].join(''),
    parameters: isStatic
      ? Type.Object({
          prompt: Type.String({ description: '任务指令（子代理的唯一输入——写清目标与边界，它是独立上下文）' }),
          label: Type.Optional(Type.String({ description: '人读标签（任务列表/通知显示）' })),
          background: Type.Optional(Type.Boolean({ description: 'true = 后台执行（立即返回任务 id，结算自动通知）' })),
          maxDepth: Type.Optional(Type.Number({ description: '委派深度上限（缺省 3）' })),
          context: CONTEXT_PARAM,
        })
      : Type.Object({
          prompt: Type.String({ description: '任务指令（子代理的唯一输入——写清目标与边界，它是独立上下文）' }),
          label: Type.Optional(Type.String({ description: '人读标签（任务列表/通知显示）' })),
          background: Type.Optional(Type.Boolean({ description: 'true = 后台执行（立即返回任务 id，结算自动通知）' })),
          toolFilter: Type.Optional(
            Type.Array(Type.String(), { description: '工具 include 名单（如 ["read_file","grep"]）——缺省全量' }),
          ),
          persona: Type.Optional(Type.String({ description: '子代理系统提示覆盖（人格/角色设定）' })),
          maxDepth: Type.Optional(Type.Number({ description: '委派深度上限（缺省 3）' })),
          context: CONTEXT_PARAM,
        }),
    effect: 'read',
    execute: async (args, tctx): Promise<AgentToolResult> => {
      // 参数面（schema 校验已过守门段——此处形状可信，逐字段取用；静态形态
      // 无 toolFilter/persona 位，联合收形后可选字段两形态通用）
      const req = args as {
        prompt: string;
        label?: string;
        background?: boolean;
        toolFilter?: string[];
        persona?: string;
        maxDepth?: number;
        context?: { recentTurns: number };
      };
      const ownerSessionId = opts.getSession()?.header.sessionId;
      const run: SubagentRun = opts.subagents.start({
        // 路由静态绑定：声明式工具钉文件 name，通用工具走缺省 in-process
        provider: opts.providerName ?? 'in-process',
        prompt: req.prompt,
        ...(req.label !== undefined ? { label: req.label } : {}),
        ...(ownerSessionId !== undefined ? { ownerSessionId } : {}),
        ...(req.toolFilter !== undefined ? { toolFilter: req.toolFilter } : {}),
        ...(req.persona !== undefined ? { persona: req.persona } : {}),
        ...(req.maxDepth !== undefined ? { maxDepth: req.maxDepth } : {}),
        ...(req.context !== undefined ? { context: req.context } : {}),
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

/** 清单披露段渲染（provider 名 + description + 能力位——随物化冻结，/reload 边界变更） */
function renderProviderList(subagents: SubagentsServiceFace): string {
  const rows = subagents.list().map((info) => {
    const caps = [
      info.capabilities.toolFilter ? '工具子集' : null,
      info.capabilities.persona ? '人格' : null,
      info.capabilities.depthLimit ? '深度帽' : null,
      info.capabilities.context ? '上下文' : null,
    ].filter((part) => part !== null);
    // description = 声明式 agent 的模型选择依据（通用 in-process 无此位）
    return `- ${info.name}${info.description !== undefined ? `：${info.description}` : ''}${
      caps.length > 0 ? `（支持：${caps.join('/')}）` : ''
    }`;
  });
  if (rows.length === 0) return '';
  return ['可用子代理类型（经 agent 工具委派）：', ...rows].join('\n');
}
