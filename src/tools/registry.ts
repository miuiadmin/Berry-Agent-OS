/**
 * L2 tools — 工具注册表（ctx.tools 服务；插件契约篇 §3.2 动态注册）。
 *
 * 职责：
 * - register(ToolDefinition, opts?) → Disposer：即时生效（刷新注册表 → 广播
 *   tools_change → 下次模型请求即见新工具；无需 reload）；
 * - 把 ToolDefinition 适配成 loop 面的 AgentTool（execute = 三段管道）；
 * - defineTool 类型 helper（插件侧获得参数/结果类型推断）。
 *
 * 三层注册表（域键升级批，契约篇 §5.4「域键升级（appId 批）射面细化」，2026-08-27；
 * S2 两层模型的解缠升级——「域键升 appId」实为解缠非改名）：
 * - 全局层：单表 Map（缺省注册面——caller 无关纯机制，全部会话可见）；
 * - 应用域层：`Map<appId, Map<name, def>>`（`domain` 键注册——组合域 = 应用清单
 *   声明的工具面运行时投影的本义归宿；v1 空层，首批住客随清单投影批到达）；
 * - 驱动层：`Map<sessionId, Map<name, def>>`（`driver` + `domain` 双键注册——
 *   fs 四名 + bash 的诚实归宿：观察态 per-driver + 升权闭包绑本驱动 approval，
 *   它们不是应用清单声明的，是驱动基建）。
 * - 查重碰撞域三层推广（「任何单一组合面内不得双名」——组合面 = 一个 toolView
 *   的组成集）：全局层注册查「全局 ∪ 全部应用域 ∪ 全部活驱动层」（全局进一切面）；
 *   应用域[A] 注册查「全局 ∪ 应用域[A] ∪ app=A 的活驱动层」；驱动层注册（双键）
 *   查「全局 ∪ 应用域[本 app] ∪ 驱动层[本 sessionId]」。跨应用同名合法（永不同面）。
 * - 注册表本体**随组合根构造存续**（本服务挂 ring1 锚，/reload 不回卷）；
 *   驱动层条目生死挂调用方（chat 件 DriverEntry——open 注册、retire 回卷）。
 * - tools_change 载荷 `{ kind, name, domain?, driver? }`：`domain`（appId）=
 *   应用域层变更（刷该应用全部非退役条目）；`driver`（sessionId）= 驱动层变更
 *   （刷单条目）；缺省 = 全局层变更（刷全部条目）。
 *
 * 注册经 ctx.provide('tools', …) 挂进服务注册表，随作用域 LIFO 回卷；
 * 注销器同时撤注册表条目（幂等）。
 */

import {
  APP_INVALID,
  AppError,
  CONTEXT_SERVICE_NOT_FOUND,
  TOOL_DESCRIPTION_REJECTED,
  TOOL_DUPLICATE,
  TOOL_REGISTRY_LIMIT,
  TOOL_REGISTRY_RATE,
  TOOL_TIMEOUT_INVALID,
} from '../contracts/errors.js';
import type { AgentTool, ToolDefinition, ToolsService } from '../contracts/tools.js';
import { TOOLS_CHANGE_EVENT } from '../contracts/tools.js';
import type { RowAppProbe } from '../contracts/plugin.js';
import { RateLimiter } from '../context/rate-limit.js';
import { chainCaller } from '../context/chain.js';
import type { Disposer } from '../context/types.js';
import type { Context } from '../context/types.js';
import type { ToolPipelineExecutor } from './pipeline.js';

/** ctx.tools 服务面（契约篇 §1.5 服务行；接口单一来源在 contracts——本文件实现） */
export type { ToolsService } from '../contracts/tools.js';

/**
 * 工具归属旁表（P1-1 导入者归因，会话篇 §5.1）：normalized 定义 → 注册者插件名。
 * 注册时从 caller 链记（装载器 apply 段内注册 = runInCallerChain 罩着，身份天然
 * 已知；宿主/builtin 直注册无链不记 = 'host' 兜底）——归因由宿主推导，插件无
 * 自报入参面、不可伪造。WeakMap 键 = normalized 副本（管道执行收到的即它），
 * 注销后无引用自然 GC，无需显式清理。模块级单表：键是对象身份，跨实例无冲突。
 */
const toolOwners = new WeakMap<ToolDefinition, string>();

/**
 * 查工具注册归属（管道执行段包裹 runInCallerChain 的取数口）。
 * 未记（宿主/builtin/测试直注册）返回 undefined——调用方兜底 'host'。
 */
export function toolOwnerOf(def: ToolDefinition): string | undefined {
  return toolOwners.get(def);
}

/** 注册表选项 */
export interface ToolRegistryOptions {
  /** 工具执行管道（缺省不接——注册出的 AgentTool 执行会响亮失败，装配层必须接） */
  pipeline?: ToolPipelineExecutor;
  /**
   * 行挂载目标投影（契约篇 §5.1 D1 注册面路由，2026-08-27）：无显式键注册经
   * caller 链归因行挂载目标——挂应用的行落该应用域层（「挂到哪层」由组合树行
   * 声明，非注册时自选）。缺省不接 = 无隐式路由（子装配/诊断面/测试——全部
   * 落全局层，与既有行为同构）。
   */
  rowApp?: RowAppProbe;
}

/**
 * v1 注入模式最小词表（契约篇 §3.2 描述扫描——2026-08-26 轮九 #27 修法）。
 * 描述是进模型上下文的文本：`curl … | sh` 形态 = 让模型照描述执行任意下载，
 * 是描述面执行漏洞（轮九实证：外部服务器描述原样注册即可被调）。
 * 词表随真实生态扩充——规范只钉「注册面扫描」这个位置，不在此堆正则。
 */
const DESCRIPTION_INJECTION_PATTERNS: readonly RegExp[] = [/\b(curl|wget)\b[^\n|]*\|[^\n]*\b(ba|z|da)?sh\b/i];

/**
 * 插件面注册 timeoutMs 下限（毫秒——契约篇 §1.6 注册预算下限，2026-08-27 刀〇a）：
 * 正数过小钳至此值（存归一副本），<= 0 拒绝（TOOL_TIMEOUT_INVALID）。
 * 「0 = 自管取消」语义保留给宿主内部合成 def（exec 内部 def 不经注册面——
 * 事实豁免通道，冷读 CR-2-F9 裁决）。
 */
export const TOOL_TIMEOUT_FLOOR_MS = 1000;

/**
 * 三层注册表合计件数帽（契约篇 §1.6 资源护栏族 #10①，2026-08-27 刀〇b）：
 * 全局层 + 全部应用域层 + 全部驱动层求和。良性行为距阈值两个数量级（官方全家桶
 * ~10¹ 量级），超限 = 失控或泄漏，fail-loud 拒绝而非静默顶住。
 */
const REGISTRY_TOTAL_LIMIT = 1_000;
/**
 * register/unregister 变更频率桶（#10②）：容量 240 吃下 boot + 两连 /reload 的
 * 合法重注册序列（官方件全量 ~35 工具 → 每波注销+重注 ~70 op，MCP 在场另计；
 * 2026-08-27 memory 持有面 5→9 后实测该序列 ≈175 op 顶穿旧容 120，随量调参）；
 * 回填 600/min = 10 op/s 持续供给，热迭代（30-40s 一 reload + 会话开关注册）
 * 不触顶，武器化（>10/s 持续）容量耗尽即拦。
 * 全局键——registry 无 scope 概念（冷读确认，不为频率帽引入 scope）。
 */
const REGISTRY_RATE: Readonly<{ capacity: number; perMinute: number }> = { capacity: 240, perMinute: 600 };

/**
 * 扫描工具描述是否命中注入模式（注册面统一防线——任何来源的工具同一执法）。
 * @returns 命中的模式串（用于错误归因）；干净描述返回 undefined
 */
export function scanToolDescription(description: string): string | undefined {
  for (const pattern of DESCRIPTION_INJECTION_PATTERNS) {
    if (pattern.test(description)) return pattern.source;
  }
  return undefined;
}

/**
 * 组装工具注册表并挂进 ctx（provide('tools')，随作用域回卷）。
 * app 装配层调用一次；插件作用域经 ctx.get 共享同一注册表。
 */
export function registerToolsService(ctx: Context, opts: ToolRegistryOptions = {}): ToolsService {
  /** 全局层：name → 定义（Map 保注册序——全部会话可见的注册面） */
  const tools = new Map<string, ToolDefinition>();
  /** 应用域层：appId → (name → 定义)（组合域分片——v1 空层，仅 listFor(appId) 面可见；Map 保注册序） */
  const appDomains = new Map<string, Map<string, ToolDefinition>>();
  /** 驱动层：sessionId → (name → 定义)（fs 四名 + bash 的驱动基建分片——仅组成面可见；Map 保注册序） */
  const driverLayers = new Map<string, Map<string, ToolDefinition>>();
  /** 驱动层归属旁账：sessionId → appId（驱动层注册双键时记——组成面计算与「app=A 的活驱动层」碰撞域界定的键源） */
  const driverApps = new Map<string, string>();
  /** 注册面打点（B2 P5）：开机以来累计注册/注销次数（高频注册武器化监控数据源） */
  let totalAdds = 0;
  let totalRemoves = 0;
  /** 变更频率桶（#10②）：register 侧 fail-loud 先于变更；unregister 侧见注销器内注 */
  const changeRate = new RateLimiter(REGISTRY_RATE);

  const service: ToolsService = {
    // 管道执行器随服务携带（Ring 1 行树化批）：bash 工具与 ctx.exec 两层并存
    // 时经它同源——无管道诊断形态为 undefined（toAgentTool 执行响亮失败）
    executor: opts.pipeline,
    register(def, registerOpts) {
      // 描述扫描（契约篇 §3.2，2026-08-26）：任何来源的工具同一防线——
      // 第三方插件与 MCP 外部工具的风险同源，防线在树上不在枝上
      const injectionHit = scanToolDescription(def.description);
      if (injectionHit !== undefined) {
        throw new AppError(
          TOOL_DESCRIPTION_REJECTED,
          `工具描述命中注入模式（/${injectionHit}/）：${def.name}——描述是进模型上下文的文本，拒绝注册`,
        );
      }
      // 注册面预算下限执法（§1.6 时钟族之四，2026-08-27 刀〇a）：<= 0 拒绝——
      // 拒绝式而非钳到 0：钳制会静默改变行为（插件以为 0 = 无预算，长任务被杀
      // 还以为自管取消有效）。0 的自管取消语义保留给宿主内部合成 def（不经本面）
      if (def.timeoutMs !== undefined && def.timeoutMs <= 0) {
        throw new AppError(
          TOOL_TIMEOUT_INVALID,
          `工具 ${def.name} timeoutMs <= 0（${def.timeoutMs}）——插件面注册不许自管取消语义；` +
            `不设预算请省略该字段（走管道缺省 60s），正数过小将钳至 ${TOOL_TIMEOUT_FLOOR_MS}ms 下限`,
        );
      }
      // 读写性归一（契约篇 §3.1，2026-08-24 第十一批）：未声明 effect 按 'write'
      // 保守处理——只读类守门策略不放过未声明工具（fail-closed 方向）。存归一副本，
      // 注销身份护栏随迁到副本（对调用方原对象零改动）；timeoutMs 正数过小同副
      // 本钳至下限（§1.6：500ms 类微小预算 = 变相自杀钟，钳而非拒——值仍合法）。
      const normalized: ToolDefinition = {
        ...def,
        effect: def.effect ?? 'write',
        ...(def.timeoutMs !== undefined ? { timeoutMs: Math.max(def.timeoutMs, TOOL_TIMEOUT_FLOOR_MS) } : {}),
      };
      const driverKey = registerOpts?.driver;
      // domainKey 经显式键或 D1 隐式路由确定（let——隐式路由可补值）
      let domainKey = registerOpts?.domain;
      /* ---- D1 隐式路由（契约篇 §5.1 挂载目标两档，2026-08-27）----
       * 无显式键注册经 caller 链归因行挂载目标：装载器 apply 段注册天然带行 id
       * 帧（runInCallerChain(row.id)），行带 app 键 → 注册落该应用域层（「挂到
       * 哪层」由组合树行声明，非注册时自选）。显式键（驱动层双键 / 测试注入
       * domain）优先——隐式路由只补缺省注册面。无探针（子装配/诊断面）零路由。 */
      if (driverKey === undefined && domainKey === undefined && opts.rowApp !== undefined) {
        const rowId = chainCaller();
        if (rowId !== undefined) {
          const appId = opts.rowApp.get(rowId);
          if (appId !== undefined) domainKey = appId;
        } else if (opts.rowApp.size() > 0) {
          /* 异步注册窗口（第三十四批拍板 42 / 契约篇 §5.1 注记）：apply 返还后
           * 裸调 register——ALS 帧已失、无行籍可查，拒绝不可执法。v1 = 落全局层
           * + warn：warn 只在组合树存在应用行时发（零应用行 = 无隔离语义可破坏，
           * mcp 异步注册〔合法时序〕零噪声；warn 语义 = 「可能有隔离泄漏」）。
           * 行为兜底不靠 warn：本注册的 tools_change 总线事件（domain 键缺席 =
           * 全局层变更的运行时事实）+ 后续任何调用经三段管道落 durable 账。 */
          ctx.logger.warn(
            `无行籍注册落全局层（异步窗口）：${def.name}——apply 返还后的注册无法归因行挂载目标；` +
              `若本工具来自挂应用的行，其能力将进一切组成面（隔离泄漏面），契约篇 §5.1 异步注册窗口注记`,
          );
        }
      }
      let layer: Map<string, ToolDefinition>;
      if (driverKey !== undefined) {
        // 驱动层注册（fs 四名 + bash 的归宿）：须双键同携——driver（sessionId）+
        // domain（本驱动 appId），碰撞域界定需要（查「全局 ∪ 应用域[本 app] ∪
        // 驱动层[本 sessionId]」缺一不可算）；缺 domain = 调用方装配缺陷，响亮拒
        if (domainKey === undefined) {
          throw new AppError(
            APP_INVALID,
            `驱动层注册须双键同携：${def.name}（driver: ${driverKey}）缺 domain（本驱动 appId）——` +
              `碰撞域界定需要，契约篇 §5.4 域键升级（appId 批）射面细化`,
          );
        }
        const existing = driverLayers.get(driverKey);
        layer = existing !== undefined ? existing : new Map();
        if (existing === undefined) {
          driverLayers.set(driverKey, layer);
          driverApps.set(driverKey, domainKey);
        }
        // 碰撞域 = 全局层 ∪ 应用域[本 app] ∪ 驱动层[本 sessionId]（三层执法形状）
        if (tools.has(def.name) || appDomains.get(domainKey)?.has(def.name) || layer.has(def.name)) {
          throw new AppError(
            TOOL_DUPLICATE,
            `工具重复注册：${def.name}（驱动层 ${driverKey}〔app ${domainKey}〕；与全局层/应用域/本驱动层已有工具同名）`,
          );
        }
      } else if (domainKey !== undefined) {
        // 应用域层注册（组合域本义归宿）：碰撞域 = 全局层 ∪ 应用域[A] ∪ app=A 的
        // 活驱动层（应用域工具进该应用全部驱动的组成面——与任一驱动层条目同名
        // 即同面双名，照拒）
        const existing = appDomains.get(domainKey);
        layer = existing !== undefined ? existing : new Map();
        if (existing === undefined) appDomains.set(domainKey, layer);
        for (const [sid, driverLayer] of driverLayers) {
          if (driverApps.get(sid) === domainKey && driverLayer.has(def.name)) {
            throw new AppError(
              TOOL_DUPLICATE,
              `工具重复注册：${def.name}（应用域 ${domainKey}；与该应用活驱动 ${sid} 的驱动层工具同名）`,
            );
          }
        }
        if (tools.has(def.name) || layer.has(def.name)) {
          throw new AppError(
            TOOL_DUPLICATE,
            `工具重复注册：${def.name}（应用域 ${domainKey}；与全局层或本应用域已有工具同名）`,
          );
        }
      } else {
        // 全局层注册：碰撞域 = 全局层 ∪ 全部应用域 ∪ 全部活驱动层（全局进一切
        // 组合面——mcp 后台异步落全局层晚于驱动 open 注册是真实时序，任何面双名都拒）
        for (const [key, layerTools] of appDomains) {
          if (layerTools.has(def.name)) {
            throw new AppError(
              TOOL_DUPLICATE,
              `工具重复注册：${def.name}（与应用域 ${key} 的工具同名——全局层注册须避开全部应用域）`,
            );
          }
        }
        for (const [key, layerTools] of driverLayers) {
          if (layerTools.has(def.name)) {
            throw new AppError(
              TOOL_DUPLICATE,
              `工具重复注册：${def.name}（与活驱动 ${key} 的驱动层工具同名——全局层注册须避开全部活驱动层）`,
            );
          }
        }
        if (tools.has(def.name)) {
          throw new AppError(TOOL_DUPLICATE, `工具重复注册：${def.name}`);
        }
        layer = tools;
      }
      /* ---- 资源护栏族 #10 双帽（契约篇 §1.6，2026-08-27 刀〇b）----
       * 查重等既有拒绝先过（不消耗频率配额——拼错重试不被限流噪音掩盖），
       * 双帽随后、layer.set 之前：任一拒绝都不留半套注册状态。 */
      // ①总量帽：三层注册表合计（失控或泄漏——良性行为距阈值两个数量级）
      let registered = tools.size;
      for (const appLayer of appDomains.values()) registered += appLayer.size;
      for (const driverLayer of driverLayers.values()) registered += driverLayer.size;
      if (registered >= REGISTRY_TOTAL_LIMIT) {
        throw new AppError(
          TOOL_REGISTRY_LIMIT,
          `工具注册表合计已达上限 ${REGISTRY_TOTAL_LIMIT}（全局层 ${tools.size} + 分片层 ${registered - tools.size}；契约篇 §1.6 资源护栏族 #10）`,
        );
      }
      // ②变更频率帽：register/unregister 合计令牌桶（R4 高频注册武器化 header 快照）
      if (!changeRate.tryCharge('registry')) {
        throw new AppError(
          TOOL_REGISTRY_RATE,
          `工具注册/注销变更超频：${def.name}（令牌桶：突发上限 ${REGISTRY_RATE.capacity}、回填 ${REGISTRY_RATE.perMinute}/min；` +
            `每次变更触 tools_change 快照广播，fail-loud 拒绝非静默丢弃——热迭代节奏不受影响，契约篇 §1.6 #10）`,
        );
      }
      layer.set(def.name, normalized);
      // 归属旁表记账（P1-1）：注册时链上有插件身份才记——装载器 apply 段注册
      // 自然带身份；宿主/builtin 直注册无链不记（toolOwnerOf 查 miss → 'host'）
      const owner = chainCaller();
      if (owner !== undefined) toolOwners.set(normalized, owner);
      totalAdds += 1;
      // 载荷键分流：driver（sessionId）= 驱动层变更（刷单条目）；domain（appId）=
      // 应用域层变更（刷该应用全部条目）；缺省 = 全局层变更（刷全部）。
      // 驱动层注册只发 driver 键（不带 domain——防路由双判）
      ctx.emit(TOOLS_CHANGE_EVENT, {
        kind: 'add',
        name: def.name,
        ...(driverKey !== undefined ? { driver: driverKey } : domainKey !== undefined ? { domain: domainKey } : {}),
      });
      let done = false;
      return () => {
        if (done) return;
        done = true;
        // 仅当仍是本定义时删除（防误撤他者后来的同位注册——与 provide 同款护栏）
        if (layer.get(def.name) === normalized) {
          layer.delete(def.name);
          totalRemoves += 1;
          // 分片层清空即拆层（活层集合收缩——全局层/应用域层查重的遍历面随之收窄）
          if (layer !== tools && layer.size === 0) {
            if (driverKey !== undefined && driverLayers.get(driverKey) === layer) {
              driverLayers.delete(driverKey);
              driverApps.delete(driverKey); // 归属旁账随层同灭（防悬空 sessionId→appId）
            } else if (domainKey !== undefined && appDomains.get(domainKey) === layer) {
              appDomains.delete(domainKey);
            }
          }
          ctx.emit(TOOLS_CHANGE_EVENT, {
            kind: 'remove',
            name: def.name,
            ...(driverKey !== undefined ? { driver: driverKey } : domainKey !== undefined ? { domain: domainKey } : {}),
          });
          /* 变更频率帽 unregister 侧计费（#10②）：删除与广播先行、计费殿后——
           * 注销器可能在作用域回卷路径跑（dispose 内同步循环），此处抛错会被
           * 回卷异常隔离吞成日志，若计费在先则「删除没做成但配额已耗」留下
           * 半套状态；殿后则不变式完整（集变更即快照），桶满仅记 error。 */
          if (!changeRate.tryCharge('registry')) {
            ctx.logger.error(
              `工具注册/注销变更超频（unregister 侧：${def.name}）——桶容量 ${REGISTRY_RATE.capacity}/回填 ${REGISTRY_RATE.perMinute} 每 min，` +
                `本次已照常删除广播（回卷路径计费只记不阻）；后续 register 将被 fail-loud 拒绝（契约篇 §1.6 #10）`,
            );
          }
        }
      };
    },

    get(name) {
      // 全局层同口径：只查全局层（域层工具按名直达 = 绕过组合域投影，不开此面）
      return tools.get(name);
    },

    list() {
      return [...tools.values()];
    },

    listFor(appId) {
      // 应用域视角 = 全局层 ∪ 该应用域层（键义升级：参数从 sessionId 改 appId——
      // 组合域读面本义归位；驱动层内容结构上不在本面 = 子装配排除集退役的机制源）。
      // 未知应用键 = 空应用域层，只返回全局层（合法形态）
      const layer = appDomains.get(appId);
      return layer === undefined ? [...tools.values()] : [...tools.values(), ...layer.values()];
    },

    compositionFor(sessionId) {
      // 驱动组成面 = 全局层 ∪ 本驱动应用域层 ∪ 本驱动层（域键升级批新增读面——
      // goal 续跑 wakeToolFilter 等运行期消费方与 chat 件 open 同一投影）。
      // 归属旁账查无（子代理会话/退役条目/persist:false 诊断形态）= 无驱动语境
      // → 全局层口径（与 list() 同源回落——诊断面不虚假拼装驱动面）
      const appId = driverApps.get(sessionId);
      if (appId === undefined) return [...tools.values()];
      const appLayer = appDomains.get(appId);
      const driverLayer = driverLayers.get(sessionId);
      return [...tools.values(), ...(appLayer?.values() ?? []), ...(driverLayer?.values() ?? [])];
    },

    toAgentTool(def, bindOpts) {
      // 执行绑定面（S5 冷读闸 F2）：显式注入优先（驱动 fresh 作用域管道），
      // 缺省回落服务构造时的全局管道——既有调用点（子工厂/诊断面）零改动
      const pipeline = bindOpts?.pipeline ?? opts.pipeline;
      return {
        name: def.name,
        description: def.description,
        label: def.label,
        parameters: def.parameters,
        // 执行全走三段管道（工具执行唯一合法路径——绕管道直调 execute 即违规）
        execute: async (toolCallId, args, signal, onUpdate) => {
          if (!pipeline) {
            // 管道是执行唯一合法路径：未装配即调 = 装配层缺陷，响亮失败
            throw new AppError(
              CONTEXT_SERVICE_NOT_FOUND,
              `[CONTEXT_SERVICE_NOT_FOUND] 工具管道未装配（registerToolsService 缺 pipeline 选项）`,
            );
          }
          // origin='model'（P1-2 增补 7③）：loop 模型工具路的显式判别词——
          // 守门行按面别分叉（模型面 vs 服务面）不靠名字嗅探
          return pipeline(def, toolCallId, args, signal, onUpdate, 'model');
        },
      };
    },

    stats() {
      // 现存件数 = 全局层 + 全部应用域层 + 全部驱动层求和（不缓存——查询低频且各层 Map 已是常量级遍历）
      let registered = tools.size;
      for (const layer of appDomains.values()) registered += layer.size;
      for (const layer of driverLayers.values()) registered += layer.size;
      return { registered, totalAdds, totalRemoves };
    },
  };

  ctx.provide('tools', service);
  return service;
}

/**
 * defineTool 类型 helper（插件契约篇 §3.1：ctx.tools.defineTool 定义工具）。
 * identity 函数——只为让插件侧书写时获得 parameters/execute 的完整类型检查。
 */
export function defineTool<T extends ToolDefinition>(def: T): T {
  return def;
}
