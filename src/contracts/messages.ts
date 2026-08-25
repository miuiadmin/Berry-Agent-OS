/**
 * L0 contracts — AgentMessage 与自定义消息角色注册表（骨架篇 §2.3；2026-08-25
 * #16 重拍后自 agent 模块迁入——单一来源住 contracts，ctx 实现者（context）与
 * convert/renderer 消费方零 agent 依赖可取，与 ToolsService 进 contracts 同款）。
 *
 * AgentMessage = 标准角色（user/assistant/toolResult，llm 三角色）∪ 自定义角色
 * （显式注册，不用 declaration merging——读码综合反模式 #4）。loop 全程使用
 * AgentMessage；仅在 LLM 调用边界经 convertToLlm 转换。
 *
 * 双入口纪律（与 prompt 段两入口同构，骨架篇 §2.3 落码注记）：
 * - 插件面 `ctx.registerMessageRole` → registerPluginMessageRole：角色名必含
 *   `/` 域前缀（`memory/recall` 式）——第三方与官方件同走此面，官方非特权；
 * - 宿主面 registerHostMessageRole：无 `/` 单段名（`bash-execution` 式），
 *   宿主自留地（装配层注册内置角色）。
 */

import { AGENT_ROLE_EXISTS, AGENT_ROLE_INVALID, AppError } from './errors.js';
import type { Message } from './llm.js';

/** 自定义角色消息（role 必须已经注册——插件面或宿主面之一） */
export interface CustomMessage {
  /** 已注册的自定义角色名（非标准三角色） */
  role: string;
  /** 载荷（形状由角色定义约定；进入 LLM 前经 toLlm 转换） */
  content: unknown;
  /** Unix 毫秒时间戳 */
  timestamp: number;
}

/** AgentMessage = 标准三角色 ∪ 自定义角色（骨架篇 §2.3 唯一消息词汇） */
export type AgentMessage = Message | CustomMessage;

/**
 * 自定义角色定义。toLlm 承担 LLM 边界转换（→ user 消息或过滤丢弃），
 * render 声明渲染意图（通道层据此决定展示形态，内核不消费）。
 */
export interface MessageRoleDefinition {
  /** LLM 边界转换：返回单条/多条 Message，返回 null = 过滤丢弃（不进模型上下文） */
  toLlm?: (message: CustomMessage) => Message | Message[] | null;
  /** 渲染意图（UI 展示形态声明；内核不消费，通道层读取） */
  render?: {
    /** inline=时间线内联 / status=状态行 / hidden=不渲染 */
    intent: 'inline' | 'status' | 'hidden';
    /** 展示标签（缺省用角色名） */
    label?: string;
  };
}

/** 标准三角色名（注册表外置的内置词汇，自定义角色不得占用） */
const STANDARD_ROLES = new Set(['user', 'assistant', 'toolResult']);

/** 插件面角色名格式：必含 `/` 域前缀（与 prompt 段 SECTION_ID_FORMAT 同一纪律） */
const PLUGIN_ROLE_FORMAT = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/** 宿主面角色名格式：无 `/` 单段名（宿主自留地——与 prompt 段宿主段同构） */
const HOST_ROLE_FORMAT = /^[a-z][a-z0-9-]*$/;

/** 已注册自定义角色表（模块级单例：显式注册，可枚举生成目录清单） */
const roleRegistry = new Map<string, MessageRoleDefinition>();

/** 共享注册核：占用检查 + 入表（入口各自做格式校验后调用） */
function addRole(name: string, definition: MessageRoleDefinition): () => void {
  if (STANDARD_ROLES.has(name) || roleRegistry.has(name)) {
    throw new AppError(AGENT_ROLE_EXISTS, `消息角色重复注册或与标准角色冲突：${name}`);
  }
  roleRegistry.set(name, definition);
  return () => {
    // 仅当仍是本定义时移除（防误注销后来者）
    if (roleRegistry.get(name) === definition) {
      roleRegistry.delete(name);
    }
  };
}

/**
 * 插件面注册一个自定义消息角色（`ctx.registerMessageRole` 的落点）：角色名必含
 * `/` 域前缀（`memory/recall` 式）——插件域归属从名字可判，与 prompt 段同纪律。
 * @returns 注销函数（ctx 面已自动挂作用域 effect 栈；此处直调则由调用方自理）
 */
export function registerPluginMessageRole(name: string, definition: MessageRoleDefinition): () => void {
  if (!PLUGIN_ROLE_FORMAT.test(name)) {
    throw new AppError(
      AGENT_ROLE_INVALID,
      `插件面消息角色名必含 / 域前缀（memory/recall 式小写两段）：${name}——无 / 单段名是宿主自留地`,
    );
  }
  return addRole(name, definition);
}

/**
 * 宿主面注册一个自定义消息角色：无 `/` 单段名（`bash-execution` 式）——
 * 装配层注册内置角色（bash 执行记录/系统通知/compaction 摘要/子代理结算标注）。
 * @returns 注销函数（装配层测试清理用；运行期角色通常常驻）
 */
export function registerHostMessageRole(name: string, definition: MessageRoleDefinition): () => void {
  if (!HOST_ROLE_FORMAT.test(name)) {
    throw new AppError(
      AGENT_ROLE_INVALID,
      `宿主面消息角色名为无 / 单段小写（bash-execution 式）：${name}——含 / 的域名走插件面`,
    );
  }
  return addRole(name, definition);
}

/** 查角色定义（标准角色与未注册名返回 undefined——消费方自行分派） */
export function getMessageRoleDefinition(name: string): MessageRoleDefinition | undefined {
  return roleRegistry.get(name);
}

/** 枚举全部已注册自定义角色名（目录清单 / 诊断输出用） */
export function listMessageRoles(): string[] {
  return [...roleRegistry.keys()].sort();
}

/** 是否标准角色（convertToLlm 透传分支的判据） */
export function isStandardRole(role: string): boolean {
  return STANDARD_ROLES.has(role);
}

/**
 * 是否标准三角色消息（AgentMessage 联合消费方的窄化守卫）。
 * CustomMessage.role 是宽 string（'user' 等字面量结构上可赋给它），
 * 判负分支无法窄化——守卫取正向：真分支窄化为 Message（user/assistant/
 * toolResult），假分支窄化为 CustomMessage。
 */
export function isStandardMessage(message: AgentMessage): message is Message {
  return isStandardRole(message.role);
}
