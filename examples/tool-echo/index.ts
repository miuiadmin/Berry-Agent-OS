/**
 * 教学例 tool-echo —— 最小扩展型应用（examples/ 首例，应用契约篇 §6.2 三件套纪律）。
 *
 * 三面最小示范（一面一件，全走指南记载的公开面）：
 * ① 工具注册：inject 声明 'tools' 硬依赖（装载器 Kahn 轮次等它就绪再激活本行），
 *    apply 内经 ctx.effect 挂注册——行作用域回卷即自动注销（/reload、卸载零残骸）；
 * ② config schema：named export config 声明行配置形状（启动一次性校验；apply
 *    收到的 cfg 是校验后的唯一样本——缺省值自理，装载器不注水）；
 * ③ durable 事件：ctx.registerSessionEventType 注册自定义 durable 词汇（会话
 *    事件账本的钥匙）+ named export events 声明自定义总线词汇（装载阶段①统一
 *    登记——execute 内 emit 已声明名才不 EVENT_UNKNOWN）。
 *
 * 依赖纪律：typebox 经虚拟键取（宿主同实例注入，防双实例）；本例零外部依赖、
 * 零品牌标识符。装载路径见同目录 README.md（教学例挂官方应用域，两形态命令链）。
 */

import { Type } from 'typebox';

/** 行 id / 日志归因标识（named export name——非空字符串即形状合法） */
export const name = 'tool-echo';

/** 硬依赖：工具注册表服务（宿主 provide 'tools'——Kahn 轮次的排布依据） */
export const inject = ['tools'];

/** 行配置 schema：prefix 可选字符串（缺省 'echo:' 在 apply 内自理） */
export const config = Type.Object({
  prefix: Type.Optional(Type.String({ description: '回显前缀（缺省 echo:）' })),
});

/** 自定义总线词汇声明（名字必含 `/` 防撞宿主词汇域；mode 是事件的公开契约） */
export const events = [
  { name: 'tool-echo/invoked', mode: 'emit', note: 'tool_echo 工具每次执行的广播（教学例）' },
];

/**
 * 应用入口（唯一形状：export default async function apply(ctx, config)）。
 * @param ctx 行作用域（fork 自 apps 锚——LIFO 回卷级联本行全部注册）
 * @param cfg 行配置唯一样本（已过上方 config schema 校验；未给行 config = {}）
 */
export default async function apply(ctx, cfg) {
  // 硬依赖在此兑现（inject 声明保证此刻必在——缺了装载器会先 APP_INJECT_UNRESOLVED）
  const tools = ctx.get('tools');
  // config 缺省自理（装载器只注入校验后的样本，不替应用填默认值）
  const prefix = typeof cfg?.prefix === 'string' ? cfg.prefix : 'echo:';

  // ③ durable 词汇注册：category 'log-only' + ignorable——恢复合成可安全跳过
  // 的轻事件（非 ignorable 词汇缺载会让恢复协议响亮拒，教学例不背这个重担）
  ctx.registerSessionEventType({
    type: 'tool-echo/note',
    category: 'log-only',
    ignorable: true,
  });

  // ① 工具注册挂 effect：返回的注销器由作用域回卷时调用（行卸载零残骸的机制源）
  ctx.effect(() =>
    tools.register({
      name: 'tool_echo',
      description: '回显入参并广播 tool-echo/invoked（教学例）',
      // 参数 schema 同 typebox；根必为 object（顶层 union 会被注册面响亮拒）
      parameters: Type.Object({
        text: Type.String({ description: '要回显的文本' }),
      }),
      // 读性工具显式声明（缺省按 'write' 保守处理——只读工具应显式摘帽）
      effect: 'read',
      execute: async (args) => {
        const text = String(args['text']);
        // 声明过的总线词汇在此使用（emit 未声明名会 EVENT_UNKNOWN 响亮拒——
        // 词汇先声明后使用是装载阶段①登记的意义）
        ctx.emit('tool-echo/invoked', { text });
        return { content: [{ type: 'text', text: `${prefix}${text}` }] };
      },
    }),
  );
}
