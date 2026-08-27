/**
 * L0 contracts — 应用清单契约（契约篇 §5.4 应用面第二纵切，2026-08-25 落码）。
 *
 * 应用 = 插件组装的声明面：**清单文件是应用包唯一源**（第十六批 B 案拍板——
 * 废 named export `apps` 通道，一个包可携带 0..N 份清单，清单引用组件件）。
 * 本文件只定 schema 与校验；yaml 解析、目录发现、组件在场断言归 app 组合层
 * （app/app-registry.ts——冷读裁决：解析归 app 层，yaml 依赖已在 app）。
 *
 * 拒绝式纪律（pre-release 窗口）：未知字段即 APP_INVALID，不做宽容读取——
 * 与 overlay 行校验、插件 config 校验同纪律。
 */

import { AppError, APP_INVALID } from './errors.js';
import { Type, type Static, type TSchema } from './typebox.js';
import { Value } from 'typebox/value';

/**
 * 应用 id 形状：小写段（字母数字开头，可含 . _ -），可选单层 `/` 域前缀。
 * 官方清单可用裸名（保留字——chat/hermes 等）；第三方清单强制含 `/`
 * （防撞官方裸名 = APP_DUPLICATE 碰撞域）。「第三方必含 /」由第三方发现面
 * 执法（装载身份串规则同源），schema 层两形皆合法。
 */
const APP_ID_PATTERN = '^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)?$';

/** 应用清单 schema（契约篇 §5.4——拒绝式，additionalProperties: false 全层贯穿） */
export const AppManifestSchema = Type.Object(
  {
    /** 应用 id（裸名 = 官方保留字；含 / = 第三方域前缀。会话域打标 sessions.app 用此值） */
    id: Type.String({ minLength: 1, pattern: APP_ID_PATTERN }),
    /** 人读标签（UI 文案位——/app 清单、dump-config 打印） */
    label: Type.String({ minLength: 1 }),
    /**
     * 组件清单（按装载身份串解析：`builtin:<name>` / npm 包名——匹配键 = 组合树
     * 行 plugin 字段的值域，不按行 id、不按 module.name）。在场断言装载期执行：
     * 缺场 = 应用级隔离（不拒启），诊断走 dump-config + debug 日志。
     */
    components: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    /** 代理装配默认位（model/persona/toolFilter 已于第三纵切落码消费——chat 件 open 装配；skills 键已收未消费） */
    agent: Type.Optional(
      Type.Object(
        {
          /** 缺省模型标识（"provider/model-id"） */
          model: Type.Optional(Type.String({ minLength: 1 })),
          /** 人格提示词（对应面 SubagentStart.persona——第三纵切起消费于 chat 件 open 装配） */
          persona: Type.Optional(Type.String()),
          /** 工具白名单（对应面 SubagentStart.toolFilter——工具名数组） */
          toolFilter: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          /** 技能集（装配默认位——技能 id 数组） */
          skills: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        },
        { additionalProperties: false },
      ),
    ),
    /** 启动面声明（三形态：前台 /app 与委派 delegable 已消费；后台 jobs 消费面挂账——见 background 注） */
    entry: Type.Optional(
      Type.Object(
        {
          /** 前台命令名（TUI `/app <command>` 进入；缺省无前台入口） */
          command: Type.Optional(Type.String({ minLength: 1 })),
          /** 是否可被委派启动（true = 自动注册为委派目标） */
          delegable: Type.Optional(Type.Boolean()),
          /** 是否可作为后台 job 常驻（消费面挂账：清单→job 启动导线 v1 未接，接线窗 = 真实后台应用需求 / ctx.schedule 落地） */
          background: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    /** 授权申请（装载期与守门行 grants 交集；approval 预设槽位已收键〔第二十四批案 C〕——§5.4 第 4 条；writableRoots 交集导线 v1 挂账，随 D2 或首个真实第三方应用清单接线） */
    grants: Type.Optional(
      Type.Object(
        {
          /** 申请的可写根（绝对路径；与 safety 守门行安装面交集后生效——交集导线 v1 未接，挂账见上） */
          writableRoots: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          /**
           * 审批预设槽位申请（第二十四批案 C）：应用申请 (sandboxMode, approvalPolicy)
           * 打包预设，装配层解析为两 knob 装配参数。词汇镜像 safety 面
           * SandboxMode / ApprovalPolicyMode（contracts 不依赖 safety——DAG 反向；
           * 装配点类型收窄双保险）。优先序 = 显式旗标 > 应用预设 > 全局缺省。
           */
          approval: Type.Optional(
            Type.Object(
              {
                /** 沙箱档预设（'read-only' | 'workspace-write' | 'danger-full-access'） */
                sandboxMode: Type.Optional(
                  Type.Union([
                    Type.Literal('read-only'),
                    Type.Literal('workspace-write'),
                    Type.Literal('danger-full-access'),
                  ]),
                ),
                /** 审批策略预设（'ask' | 'never'） */
                approvalPolicy: Type.Optional(Type.Union([Type.Literal('ask'), Type.Literal('never')])),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    /** 预算声明（canAfford app 维数据源——未声明 = 恒 true 不闸） */
    budget: Type.Optional(
      Type.Object(
        {
          /** 当日 tokens 限额（in+out 合计；跨运行聚合 = subagent per-child tokenBudget 的日聚合版） */
          dailyTokens: Type.Integer({ minimum: 1 }),
          /**
           * 内存维度预算（MB，正整数）：应用组件命中 worker 行时装载期映射
           * resourceLimits.maxOldGenerationSizeMb（Node 原生执法）；多应用共享
           * 组件取最严（min）；main 域组件无硬执行面（声明性）。缺省 = 宿主
           * 全局 512MB 兜底。
           */
          memoryMb: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** 应用清单（schema 静态推导类型——校验通过的产物形状） */
export type AppManifest = Static<typeof AppManifestSchema>;

/**
 * 校验应用清单（拒绝式——坏清单 APP_INVALID 响亮拒绝，message 载位置与首错路径）。
 * @param raw yaml 解析产物（unknown——调用方保证来自解析器）
 * @param where 诊断位置串（如 `apps/hermes.app.yaml`——错误信息锚点）
 * @returns 通过校验的清单（原对象引用——schema 无默认值填充，零拷贝）
 */
export function validateAppManifest(raw: unknown, where: string): AppManifest {
  if (!Value.Check(AppManifestSchema as TSchema, raw)) {
    // typebox 1.x 错误载荷字段是 instancePath（JSON 指针）——首错位置进诊断（与加载器 config 校验同惯例）
    const first = [...Value.Errors(AppManifestSchema as TSchema, raw)].at(0);
    const loc = first ? first.instancePath || first.schemaPath || '(根)' : '(根)';
    throw new AppError(
      APP_INVALID,
      `${where}：应用清单校验失败（首错位置 ${loc}：${first?.message ?? '形状不符'}——拒绝式 schema，未知字段/缺字段/类型错皆拒）`,
    );
  }
  return raw as AppManifest;
}

/* ------------------------------------------------------------------ */
/* prompts 服务面（契约篇 §1.5 服务行 + §1.2 注记④——类型单一来源住     */
/* contracts，2026-08-25 Hermes 探针 #11 落码；app/prompts.ts 实现之，  */
/* 第三方经 ctx.get<PromptsService>('prompts') 取全类型）              */
/* ------------------------------------------------------------------ */

/** 具名提示词段（pi-4(a) 拍板）：id 小写含 `/` 插件域前缀（宿主自留地为无 `/`） */
export interface PromptSection {
  /** 段 id（插件域前缀防撞；分节序按 id 字典序——/reload 稳定） */
  readonly id: string;
  /**
   * 内容渲染：仅在重建时点求值一次，产物随快照冻结（抛错不杀重建——渲染诊断占位）。
   *
   * 语境参数（S2，契约篇 §1.3 落码形态①）：`sessionId` = 本次物化归属的会话键——
   * 会话键控段（如记忆简报）用它冻结**该会话**的基线（多驱动并存各归各纪元）；
   * `undefined` = 诊断物化（无会话语界——只渲染内容，不冻结任何基线）。
   */
  render(sessionId?: string): string;
}

/** ctx.prompts 服务面（注册 systemPrompt 具名追加段） */
export interface PromptsService {
  /**
   * 注册具名段；返回注销函数（挂调用方作用域 effect 由插件侧负责）。
   * 注册/注销均广播 prompts_change（载荷 = 现行段 id 清单，字典序）。
   */
  registerSection(section: PromptSection): () => void;
  /** 现行段 id 清单（字典序——载荷与诊断面同源） */
  listSections(): readonly string[];
  /**
   * 具名段物化（id 字典序拼接，段间空行分隔）：render() 抛错 = 插件 bug，
   * 宿主捕获后渲染诊断占位 + log error，不杀重建（与失败行不杀进程同根）。
   * 无段返回 ''（调用方 filter 掉——不产生空分节）。
   *
   * `sessionId` 透传给各段 render（语境参数——会话键控段冻结该会话基线；
   * 缺省 = 诊断物化，不冻结）。
   */
  materialize(sessionId?: string): string;
}
