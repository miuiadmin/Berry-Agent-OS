/**
 * Echo 金样应用（契约篇 §1.7「Echo 金样应用」段——第二十七批刀二/三测试资产）。
 *
 * 宿主自养、官方 authored 的哑应用：apply 面刻意覆盖「双拓扑共通面」全族
 * （服务 provide / 事件订阅 / effect LIFO / 工具注册），是**同一份 authored
 * 码在两类运行时（main 域直载 / worker 域桥接）行为不漂移**的金样判据源——
 * 桥协议或装载管线任何一侧漂移，本件的 parity 测试先红。
 *
 * 装载身份纪律（冷读 blocker 处置）：**测试资产非产品件**——不进任何默认
 * 组合树、无 builtin: 前缀行 id（机器执法保持前缀纯：builtin: 行声明 worker
 * 恒拒绝，本件经测试装配面以普通第三方形态注入组合树）；「官方件永 main」
 * 拍板管的是产品官方件不为隔离陪迁——Echo 恰要付税跑 worker 验证协议。
 *
 * 类型面：从 `berryagent` 虚拟面取 AppContext/ToolsService（与第三方作者
 * 同一导入面——宿主自养 gated 件不搞特权后门；`import type` 编译期擦除，
 * worker 域 jiti 转译后零运行时 import，双域装载管线同一份源码）。tsconfig
 * paths 把 berryagent 指向 contracts——类型面唯一源；运行时由加载器虚拟注入。
 */
import type { AppContext, ToolsService } from 'berryagent';

// 事件词汇 echo/tick 唯一声明在 LIVE_EVENT_CATALOG（宿主目录，contracts/events.ts）：
// 本件**不**以 named export events 再声明——双拓扑 parity 同源两行（echo-main /
// echo-worker）装载，行级声明第二行即撞 EVENT_DUPLICATE；目录级声明天然单源。
// 收窄面探针（parallel/serial/waterfall）与事件往返订阅复用同一词。

export const name = 'echo';

/**
 * 金样 apply：共通面全族一次挂齐。服务方法按 config.slot 参数化命名防跨用例
 * 撞名（真注册表 CONTEXT_SERVICE_EXISTS/TOOL_DUPLICATE 执法面——与
 * bootstrap/bridge-fleet 测试 fixture 同纪律）。
 *
 * @param ctx 装载器注入的作用域（main = 真 fork 作用域 / worker = 桥接代理桩）
 * @param config 组合树行 config（slot = 服务/工具命名参数，缺省 'x'）
 */
export default async function apply(ctx: AppContext, config?: Readonly<Record<string, unknown>>): Promise<void> {
  /** 行内轨迹（effect 上下/事件往返的观测面——trace() 过界取快照） */
  const trace: string[] = [];
  const rawSlot = config?.['slot'];
  const slot = typeof rawSlot === 'string' ? rawSlot : 'x';

  ctx.provide(`echo/taps-${slot}`, {
    /** 回声：原样返回（结构化克隆可过界——双域等值断言的主载荷） */
    echo: (x: unknown) => x,
    /** 轨迹快照（只读副本——数组过界克隆，宿主侧改不动行内态） */
    trace: () => trace.slice(),
    /**
     * 收窄面探针（同步收窄清单 v1 逐项核——契约篇 §1.7）：五面在 worker 桩上
     * 应 throw BRIDGE_SURFACE_NARROWED；main 域真面可用（返回各面真实结局）。
     * async + await：main 域派发三面（parallel/serial/waterfall）返回 Promise
     * ——reject 与同步 throw 都收敛到同一 catch（裸 void 会变 unhandled
     * rejection）；worker 桩同步 throw，await 照收。parity 测试断言：worker
     * 全 NARROWED、main 无一 NARROWED（差分即文档）。
     */
    narrowed: async () => {
      const probes: Record<string, () => unknown> = {
        // 三派发面用模式各就的探针词（echo/par|ser|wf，目录 mode 与派发方式
        // 一致——check-events 双向断言执法面）：主域真跑通记 ok；worker 桩
        // 在触达词汇执法前即同步 throw NARROWED（差分判据）
        parallel: () => ctx.parallel('echo/par', 'p'),
        serial: () => ctx.serial('echo/ser', 's'),
        waterfall: () => ctx.waterfall('echo/wf', 'w', (v: unknown) => v),
        registerMessageRole: () => ctx.registerMessageRole(`echo/role-${slot}`, {}),
        registerSessionEventType: () =>
          ctx.registerSessionEventType({ type: `echo/evt-${slot}`, category: 'log-only', ignorable: true }),
      };
      const out: Record<string, string> = {};
      for (const [surface, probe] of Object.entries(probes)) {
        try {
          await probe(); // 同步 throw / 异步 reject 一站收敛；不 throw = 真面在场（返回值不问——两域返回形态本就分叉）
          out[surface] = 'ok';
        } catch (err) {
          // AppError 家族保码透出（NARROWED 判据）；非 AppError 原样字符串化
          const code = (err as { code?: unknown } | null | undefined)?.code;
          out[surface] = typeof code === 'string' ? code : String(err);
        }
      }
      return out;
    },
  });

  // 事件往返：宿主 emit echo/tick → 行内轨迹打点（worker 域经 sub 转发器过桥）
  ctx.on('echo/tick', (v: unknown) => {
    trace.push(`tick:${String(v)}`);
  });
  // effect LIFO：上下行都进轨迹（行回卷次序的观测面）
  ctx.effect(() => {
    trace.push('up');
    return () => {
      trace.push('down');
    };
  });
  // 工具注册：声明面本地、execute 过桥（worker 域）——回声工具。
  // 注册即 effect（契约篇 §3.2）：main 域 register 返回注销器，挂行作用域
  // LIFO 回卷（/reload 摘旧再装新——裸调用会在重装载撞 TOOL_DUPLICATE）；
  // worker 域桩 register 无返回值，宿主侧 bootstrap 的 tools-register 处理方
  // 已代系行作用域 effect——同一段码两域各自正确收尾（parity 收敛点之一）
  ctx.effect(() =>
    ctx.get<ToolsService>('tools').register({
      name: `echo/echo-${slot}`,
      description: 'Echo 金样回声工具（双拓扑 parity 面——text 原样回传）',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: async (args: Record<string, unknown>) => ({ content: [{ type: 'text', text: String(args['text']) }] }),
    }),
  );
}
