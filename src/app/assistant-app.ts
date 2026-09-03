/**
 * L5 app — 系统助手官方件（第八十五批批 E，价值主张篇/核心命题篇 §3.5 助手条款）。
 *
 * 桌面输入框无前缀文本的**默认应答者** + 首启引导的真身。轻问答面：收问 → 答，
 * 无自有持久会话域、零新表族——凭证态读 desktop-status（批 D 探针同源，禁第二
 * 份），模型调用走 ctx.llm 的 complete 单发（问答不需要流式对话循环）。
 *
 * 应答三路（route 判定序即此序）：
 * ① 凭证缺失（desktop-status 快照 credentialIssue 在场）→ **零 LLM 调用**直答
 *    凭证配置引导（零配置首启可用——describeProviderFailure 同源文案转述）；
 * ② 凭证在位 → complete 单发（系统提示词内嵌精简手册——命令面/概念/配置指路）；
 * ③ 模型调用失败/空应答 → 诚实回落（说不知道 + 指路 berry dump-config 与 docs/）。
 *
 * **carve-out 四条执法**（核心命题篇 §3.5 助手条款——本件的存在边界）：
 * 1. 非中枢：本文件 import 图只许 ../contracts/*（静态 import 断言测试执法）——
 *    不 import 任何路由/分派面（组合根、桌面壳、通道），被引用而不引用；
 * 2. 无仲裁权：服务面仅 answer/guide 两键（键形测试执法）——不裁应用冲突、
 *    不持装载序话语权，桌面的路由主权在壳；
 * 3. 纯清单应用：桌面清单一行（apps/assistant.app.yaml），无浮层无常驻特权位；
 * 4. 默认应答者：行缺席（overlay 禁用）≠ 桌面死路——壳回落帮助文案（壳侧执法）。
 */

import type { BuiltinAppModule, AppContext } from '../contracts/app.js';
import type { Message } from '../contracts/llm.js';

/**
 * 模型面结构窄面（ReviewLlmFace 同款纪律：零跨模块 import，结构性子集——
 * 真身 = ctx.llm 具名服务，complete 单发一法即够，问答不吃流式/预算面）。
 */
export interface AssistantLlmFace {
  /** 受托管单发补全（重试内置；错误终态上抛 LLM_COMPLETE_FAILED） */
  complete(req: { systemPrompt?: string; messages: Message[] }): Promise<{ message: { content: unknown } }>;
}

/** 凭证警示窄面（真身 = ctx 键 `desktop-status` 的快照子集——批 D 探针同源读） */
export interface AssistantStatusFace {
  /** 顶栏快照（credentialIssue 在场 = 凭证缺失，guidance 为同源引导文案） */
  snapshot(): { readonly credentialIssue?: { readonly provider: string; readonly guidance: string } } | undefined;
}

/** 应答结果（kind = 应答分路标记——测试与呈现共用同一判据） */
export interface AssistantAnswer {
  /** guidance = 凭证引导直答（零 LLM）/ model = 模型应答 / fallback = 诚实回落 */
  readonly kind: 'guidance' | 'model' | 'fallback';
  /** 应答正文行（已按 \n 拆行——呈现面零再加工） */
  readonly lines: readonly string[];
}

/** 系统助手服务面（ctx 键 `assistant`——壳/宿主经 getter 活取，行卸载即缺席） */
export interface AssistantService {
  /** 无前缀文本的默认应答（三路判定见模块头；永不 reject——内部消化错误终态） */
  answer(question: string): Promise<AssistantAnswer>;
  /** 首启引导面（/guide 与 g 热键的真身：凭证分步指引或已配置说明） */
  guide(): readonly string[];
}

/**
 * 内嵌精简手册（路 ② 系统提示词——系统用法的模型侧知识面）。
 * 只收录稳定事实；诚实纪律写死：手册外不编造，指路 docs/ 与 dump-config。
 */
const ASSISTANT_MANUAL = [
  '你是「系统助手」——Berry Agent OS 桌面输入框的默认应答者，只回答本系统的用法与配置问题。',
  '',
  '系统速览（回答依据——超出此范围诚实说不知道）：',
  '- 形态：桌面（默认起屏）与应用视图双栈；一切皆应用，五件固定内核只司「装/跑/守/存」。',
  '- 桌面键位：↑↓ 选应用、Enter 打开、m 菜单、g 引导（凭证警示在场时）、←→/Tab 切分组、Esc 返回；底部输入框 / 前缀 = 命令，无前缀 = 问你。',
  '- 桌面命令：/guide 首启引导、/shutdown 与 /reboot 关停重启（二次确认）、/desktop 回桌面、/exit 退出。',
  '- CLI 命令族：berry（桌面起屏）、berry run "任务"（单次执行）、berry dump-config（组合诊断）、berry upgrade（升级）、berry daemon 与 berry attach（常驻与接入）。',
  '- 应用内命令面（/help 看全量）：/app 应用切换、/new 新会话、/skills 技能清单、/apps* 装机族（install/mount/unmount/uninstall/toggle/update）、/goal /tick 目标与定时、/rewind 工作区回退、/reload 组合重载、/memory-export|import 记忆搬运。',
  '- 模型与凭证：缺省模型 anthropic/claude-sonnet-5，环境变量 APP_MODEL 覆盖；凭证两途径——环境变量 <PROVIDER>_API_KEY（如 ANTHROPIC_API_KEY）或凭证表（docs/使用指南 §2「模型与凭证」）；修改后重启进程生效。',
  '- 常用环境变量：APP_DATA_DIR（数据目录，缺省 ~/.berry）、APP_DB_PATH（库文件路径）、APP_LOG_LEVEL（日志级别）。',
  '- 核心概念：组合树行（Ring 1 必备不可卸 / Ring 2 可卸——overlay.yaml 禁用即卸载）、技能（SKILL.md 渐进披露）、沙箱三档与审批对、会话事件日志、记忆库。',
  '',
  '回答纪律：',
  '- 简短直接，中文作答；给命令给步骤，不展开无关内容。',
  '- 只依据上述事实回答；不确定的命令/配置键不编造——明说不知道，并指路：docs/（使用指南/应用开发指南/运维手册/架构总览）与 berry dump-config。',
  '- 与本系统无关的问题（写代码、闲聊、通用知识）礼貌拒答，指路对话应用（桌面 Enter 打开 berrycode）。',
].join('\n');

/** 诚实回落正文（路 ③——模型失败不是死路，诊断指路恒在场） */
function fallbackLines(reason: string): readonly string[] {
  return [
    '这个问题我暂时答不上来（模型调用未成功）。',
    `原因：${reason}`,
    '',
    '诊断：终端跑 berry dump-config 看装配全貌；文档见 docs/（使用指南/应用开发指南/运维手册/架构总览）。',
  ];
}

/** 内容块 → 纯文本（string 直通；[{type:'text',text}] 块拼接——ReviewLlmFace 同款收口） */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n');
}

/**
 * 构造系统助手服务面（行 apply 调用——llm/status 均为活引用快照注入：
 * 两服务都是 boot 期单例，行卸载随装载锚回卷整体销毁，无悬挂引用面）。
 */
export function createAssistantService(deps: {
  /** 模型单发面（ctx.llm 真身的结构窄面） */
  readonly llm: AssistantLlmFace;
  /** 凭证态快照面（desktop-status 真身的结构窄面） */
  readonly status: AssistantStatusFace;
}): AssistantService {
  /** 当前凭证警示（活取——探针 boot 后异步落值，问答时点才读） */
  const issueOf = () => deps.status.snapshot()?.credentialIssue;
  return {
    async answer(question: string): Promise<AssistantAnswer> {
      // 路 ①：凭证缺失 → 零 LLM 直答引导（零配置首启可用；文案与 berry run
      // stderr 同源转述——describeProviderFailure 的第二消费面，禁抄第二份）
      const issue = issueOf();
      if (issue !== undefined) {
        return {
          kind: 'guidance',
          lines: [
            '当前模型凭证未配置——问答无法发起模型调用，先按下面指引配置：',
            '',
            ...issue.guidance.split('\n'),
            '',
            '配置完成并重启进程后，再次提问即得模型应答。',
          ],
        };
      }
      // 路 ②：complete 单发（缺省模型继承 + 前台道——桌面问答是用户当面交互）
      try {
        const result = await deps.llm.complete({
          systemPrompt: ASSISTANT_MANUAL,
          messages: [{ role: 'user', content: question, timestamp: Date.now() }],
        });
        const text = textOfContent(result.message.content).trim();
        if (text === '') {
          // 空应答与失败同判——诚实回落（不把空模型输出当好答案）
          return { kind: 'fallback', lines: fallbackLines('模型返回了空应答') };
        }
        return { kind: 'model', lines: text.split('\n') };
      } catch (err) {
        // 路 ③：错误终态诚实回落（complete 已内置重试，到此即终局）
        return { kind: 'fallback', lines: fallbackLines(err instanceof Error ? err.message : String(err)) };
      }
    },
    guide(): readonly string[] {
      const issue = issueOf();
      if (issue === undefined) {
        return [
          '模型凭证已配置（当前无警示）。',
          '',
          '系统用法直接在桌面输入框提问（无前缀文本即询问系统助手）。',
          '配置新 provider 见 docs/使用指南.md §2「模型与凭证」。',
        ];
      }
      return [
        '首启引导——模型凭证未配置，对话与问答都无法发起模型调用。',
        '',
        ...issue.guidance.split('\n'),
        '',
        '配置后重启进程生效（凭证链在 boot 期读取）；引导不阻塞桌面其他使用。',
      ];
    },
  };
}

/**
 * 构造系统助手官方件模块引用（builtins 注册表 `builtin:assistant` 行——
 * 组合树默认层第十八行，Ring 2 真·可卸：overlay 禁用即无前缀文本回落帮助
 * 文案〔carve-out 第四条〕，核心循环不破）。apply 在行作用域执行一次：
 * 注入两服务（llm 根表 / desktop-status 系统区表）后 provide `assistant` 面。
 */
export function createAssistantApp(): BuiltinAppModule {
  return {
    name: 'assistant',
    // inject = Kahn 硬依赖（缺供即启动断言拒启）：llm 根表 boot 前就位
    //（obs 件 inject 'paths' 同款先例）、desktop-status 由 Ring 1 desktop 行
    // 先装载提供——两键都是恒在场服务，声明只为装载序显式化
    inject: ['llm', 'desktop-status'],
    apply: (ctx: AppContext) => {
      const llm = ctx.get<AssistantLlmFace>('llm');
      const status = ctx.get<AssistantStatusFace>('desktop-status');
      ctx.provide<AssistantService>('assistant', createAssistantService({ llm, status }));
    },
  };
}
