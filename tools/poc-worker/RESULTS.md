# PoC 结论记档：worker 分域三可证伪项（第二十七批刀一）

> 2026-08-26 实跑。环境：Node v24.18.0 / darwin（本机）。判定基准 = 契约篇 §1.7「PoC 闸」。
> 三炮全 PASS → **go**；同日冷读闸回写闭合 + **hello 过界补票兑现**（见末节）——双闸全关，
> 刀二（worker 分域运行时）只待刀〇b 落地即可动工。
>
> 运行方式：`node tools/poc-worker/1-jiti.mjs`（②③④ 同款），退出码 0/1 = PASS/FAIL。

## 可证伪项①：jiti 能否在 worker_threads 内装载 TS 插件 → **PASS**

- worker realm 自建 `createJiti(import.meta.url, { moduleCache: false })`，与宿主装载器（`src/context/loader.ts`）同款配置。
- 阶段一：装载 TS 金样插件（named + default 导出）并调用 → 全对。
- 阶段二：改写插件文件后**同实例**再 import → 拿到新代码（`moduleCache:false` 重载语义在 worker 域成立）——`/reload` 语义基底可用。
- 结论：刀二「worker 内 jiti」路径成立，装载器核心机制可原样搬进 worker realm。

## 可证伪项②：typebox schema 跨 MessagePort 结构化克隆保真 → **PASS**

- 双 realm 各自 import 同一物理包（跨 realm 双实例——正是 §1.7「每 realm 单实例」要验证的形态）。
- 方向一（worker 造 schema → 主 realm 用自己实例 `Value.Check`）：合法值过、非法值拒。
- 方向二（主 realm 造 → worker 校验）：同上。
- **symbol 键存活数 = 0**（两侧皆是）：typebox 1.3.7 schema 是纯 JSON 形对象，结构化克隆无损——「schema 对象直接过界」路径成立，无需退到 JSON 描述串化形态。
- 踩坑记档：typebox 1.x 校验面在 `typebox/value` 子路径（`import { Value } from 'typebox/value'`），根导出无 `Value`——与宿主再导出面（`src/contracts/typebox.ts`）一致。

## 可证伪项③：better-sqlite3 worker 多线程 + WAL 互见 → **PASS**

- 连接不跨线程（不可克隆），主线程与 worker **各自打开自己的连接**指向同一文件——正是落码形态。
- WAL 跨连接可见性双向实证：worker 读到主线程已提交行；主线程回读 worker 提交行。
- worker 内 `:memory:` 纯内存库建表读写正常（future 插件自带内存库形态）。
- native 模块在 worker_threads 内加载、运行、close 全程无崩溃。

## 对刀二的直接输入

1. **bootstrap 形态定案**：worker 内 jiti + 自 import typebox/better-sqlite3 全部可用——worker realm 可以完整重建 `berryagent` 虚拟面（jiti 虚拟注入照搬 `src/context/loader.ts` 现行机制）。
2. **schema 过界零折损**：工具 parameters/config schema 可作为消息 payload 直接过界，宿主侧守门管道用自己实例校验。
3. **物理面不需要跨线程连接**：worker 侧插件若用 SQLite，自开连接即可（WAL 互见）；宿主连接永不外借。

## hello 过界补票（闸门第四项·完整性尾款）→ **PASS**

> 冷读裁决：完整 hello 过界（ctx 桩 RPC 往返，含一次同步面调用 + 一次 signal→cancel 取消传播）
> 为刀二桥模块首 commit 前置——三炮只证机制件可用，协议本体的两隐性假设只有过界才能暴露。
> 已于同日兑现（`4-hello.mjs` 三件：宿主编排面 / worker 桩侧 / TS 金样插件过 jiti），六断言全 PASS。

- **① 同步面调用（同步阻抗）**：插件（TS，worker 域内 jiti 装载）经桩 `await ctx.tools.call('echo', …)`
  过界往返——调用点同步形态、底层 ask/result 两跳。**同步函数过界结构性不可能**，Promise 面是唯一形态——
  这不是实现限制是物理限制（结构化克隆无函数），刀二代理桩的 API 面据此定形。
- **② 取消传播（signal→cancel）**：`AbortSignal` 不可克隆——**信号本体永不过界，过界的是 `{kind:'cancel', callId}`**。
  桩在 abort 监听器里**本地立即结算**（拒绝 `BRIDGE_CANCELLED`，实测 4ms，不等宿主往返）+ 发取消消息；
  宿主收 cancel 掐断在途工作（slow 工具 workedMs=108 < 1000——编排 80ms 档 + 25ms 档间隔，量级正合）；
  宿主随后仍发出的迟到 result 由桩侧**迟到丢弃分支**吸收（lateResults 恰 1，无二次结算、无未处理拒绝）。
- **对刀二的直接定形**：迟到纪律（迟到不复活）与「本地结算不等往返」两条桩语义，就是 §1.7 桥接协议 v0
  cancel 条款的执行面；错误信封 `{code, message}` 纯 JSON 可克隆，与宿主 AppError 面同构。
- **边界注记（教学点）**：协作式 yield（25ms 档查 signal）才可取消；**紧密同步循环收不到任何消息**——
  协议 cancel 对其无效，那是 watchdog terminate（刀〇b 四时钟族）的辖区。cancel 与 terminate 分工即此。
