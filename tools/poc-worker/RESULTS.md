# PoC 结论记档：worker 分域三可证伪项（第二十七批刀一）

> 2026-08-26 实跑。环境：Node v24.18.0 / darwin（本机）。判定基准 = 契约篇 §1.7「PoC 闸」。
> 三炮全 PASS → **go**：刀二（worker 分域运行时）解除阻塞（仍待规范冷读闸关闭）。
>
> 运行方式：`node tools/poc-worker/1-jiti.mjs`（②③ 同款），退出码 0/1 = PASS/FAIL。

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

## hello 过界演示（闸门第四项）

> 规范要求 PoC 含「最小 hello 过界」演示（投影协议雏形）。三项已各自覆盖其机制面
> （jiti 装载/schema 过界/连接隔离），完整 hello 过界（ctx 桩 RPC 往返）属刀二
> transport 桥首测试——届时以 Echo 金样应用形态交付，不在此预造。
