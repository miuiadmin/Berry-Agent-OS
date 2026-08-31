---
name: apps-quickstart
description: berry 应用开发与自装闭环。用户要写应用、扩展现有能力，或现有工具反复做不到某事（能力缺口）想自己造一个工具应用装上时使用：最小应用形状、import 白名单三道、模型自装全链（apps_install 本地源 → apps_mount → apps_reload → 试调验证）与用户命令路对照。
---

# berry 应用起步（写一个应用并装上）

为 berry 宿主写应用：一个入口模块 + 一个 default export 函数。写好后走「装机 → 挂载 → 重载」三步生效——每步过人工审批，**模型可全程自己走**（见「模型路」）；local 源直引不拷贝，改代码后重载即见。

## 何时走这条路

- 用户开口要写应用 / 扩展现有能力——直接走；
- 现有工具反复做不到某事（能力缺口）——先提议「我写个小应用加上这个工具」，用户同意再动工。

## 最小应用骨架

```ts
// <应用目录>/index.ts（入口解析序：harness.extensions → extensions/index → index）
import { Type } from 'typebox'; // 宿主实例经虚拟注入，勿自装第二份

export const name = 'my-app'; // 必填：日志归因标识
export const inject = ['tools']; // 硬依赖服务：全就绪才激活
export const config = Type.Object({}); // 可选：行配置 schema

export default async function apply(ctx, cfg) {
  const tools = ctx.get('tools');
  // 一切注册走 ctx.effect——作用域 LIFO 回卷即注销，/reload 卸载半边自动干净
  ctx.effect(() =>
    tools.register({
      name: 'my-tool',
      description: '干一件事',
      parameters: Type.Object({ text: Type.String() }),
      effect: 'read', // 读写性声明：只读工具写 'read'（缺省按 'write' 保守处理）
      async execute(args) {
        // execute 返回 AgentToolResult：content 块数组是正形（直接返回任意对象是错的）
        return { content: [{ type: 'text', text: String(args['text']) }] };
      },
    }),
  );
}
```

## import 白名单三道（装载期门禁执法，越界拒载）

1. **虚拟面六键**：`berryagent`（ctx/服务契约类型、AppError、事件常量）、`typebox` 三入口（`typebox` / `typebox/value` / `typebox/compile`，宿主同实例）、`berryagent/llm`（provider 工厂）、`berryagent/sqlite`（自管库）；
2. **`node:` 内建**（裸名 `path` 等同放行）；
3. **应用目录树内**（相对路径与自带 `node_modules`——自身依赖自捆分发是正路）。

import 了宿主内部实现或任何树外包 = `APP_IMPORT_FORBIDDEN` 拒载，import 未使用也拦。

## 装机生效：模型路（自己走，三步各过审批）

把应用写到工作区子目录（如 `./my-app/`——模型可写根之内），然后：

1. **`apps_install`**：`source` = 本地路径（`./my-app`）；审批对必填成对（`sandbox_permissions` 一般 `workspace-write` 够用 + `justification` 一句话理由）。回执给**装机 id**——仓库态**零生效**，不写组合行。
2. **`apps_mount`**：`installId` = 上一步装机 id；`apps` = 挂载目标应用 id 数组（如 `["chat"]`——挂到哪个应用的作用域，跟随用户当前在用的应用，不确定就问；v1 第三方应用必须挂应用；同一装机第二次挂载〔如共享给第二应用〕须带 `rowId` 防撞名）；审批对。**carrier 缺省不写 = external 进程墙（推荐——出生即隔离）**；需要行 config 的应用须显式 `carrier: 'main'`（external 行携 config 被宿主拒）。
3. **`apps_reload`**：`app` = 目标应用可单区重载（他应用运行时不换）；审批对；run 进行中不拒——排队，本次 run 结算后自动执行。

改代码迭代：无需重装（local 直引不拷贝）——改码 → `apps_reload` → 再试调。

## 装机生效：用户路（指引人面）

`/apps-install <路径>` → `/apps-mount <装机id> --apps <应用id>`（自动链 reload）——用户愿意自己跑命令时指这条路。

## 装后验证闭环（必做）

1. `apps_reload` 回执判读：见「重载完成」且无失败行 = 装上；回执报「有失败行：<行名>」= 装载失败——用 `apps_list` 看逐行 code/message（`app/failed` 事件同因同面），修码后 `apps_reload` 即回。注意 `<数据目录>/boot-failures.json` 只记宿主启动（boot）批失败——reload 失败不落此文件，别去读它；
2. 新工具随下一次请求对模型可见（tools_change 原位刷新）——**立即用小入参试调一次**，把结果报告用户；
3. 不达预期就改码 → `apps_reload` → 再试调，直到试调通过。

## 常见错因对照

| 症状                    | 原因                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| `APP_SHAPE_INVALID`     | default 非函数 / name 缺失 / inject 非字符串数组                        |
| `APP_CONFIG_INVALID`    | 行 config 不过你声明的 schema                                           |
| `APP_INJECT_UNRESOLVED` | inject 里的服务名拼错或无提供方（Kahn 轮次耗尽）                        |
| `APP_IMPORT_FORBIDDEN`  | import 越界（见白名单三道）                                             |
| mount 携 config 被拒    | external/分域行的 config 校验面在域侧——需要 config 用 `carrier: 'main'` |

## 深入

完整服务面（`ctx.get` 能拿什么）、扩展点词汇、数据目录契约、反模式清单见宿主仓库 `docs/应用开发指南.md`。
