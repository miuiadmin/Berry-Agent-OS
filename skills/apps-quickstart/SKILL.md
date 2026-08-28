---
name: apps-quickstart
description: berry 应用开发起步。用户要写应用、扩展现有应用、贡献工具/命令/技能/事件时使用：最小应用形状、import 白名单三道、组合树挂载与验证闭环。
---

# berry 应用起步

为 berry 宿主写一个应用。最小形态：一个入口模块 + 一个 default export 函数。

## 最小应用骨架

```ts
// <应用目录>/index.ts（入口解析序：harness.extensions → extensions/index → index）
import { Type } from 'typebox'; // 宿主实例经虚拟注入，勿自装第二份

export const name = 'my-app';            // 必填：日志归因标识
export const inject = ['tools'];            // 硬依赖服务：全就绪才激活
export const config = Type.Object({});      // 可选：行配置 schema

export default async function apply(ctx, cfg) {
  const tools = ctx.get('tools');
  // 一切注册走 ctx.effect——作用域 LIFO 回卷即注销，/reload 卸载半边自动干净
  ctx.effect(() =>
    tools.register({
      name: 'my-tool',
      description: '干一件事',
      parameters: Type.Object({}),
      async execute(input, context) {
        return { output: JSON.stringify(input) };
      },
    }),
  );
}
```

## import 白名单三道（装载期门禁执法，越界拒载）

1. **虚拟面**：`berryagent`（ctx/服务契约类型、AppError、事件常量）、`typebox`（宿主同实例）、`berryagent/llm`（provider 工厂）、`berryagent/sqlite`（自管库）；
2. **`node:` 内建**（裸名 `path` 等同放行）；
3. **应用目录树内**（相对路径与自带 `node_modules`——自身依赖自捆分发是正路）。

import 了宿主内部实现或任何树外包 = `APP_IMPORT_FORBIDDEN` 拒载，import 未使用也拦。

## 挂载与验证

1. 本地目录装机：`/apps-install <路径>`——组合树 overlay 加一行（`pkg: my-app` + `apps: [chat]`，insert 行必须自带 pkg 字段）；
2. 验证闭环：`berry dump-config` 看行状态（activated/failed/skipped）→ `/apps` 看装载详情 → 会话里直接用新工具；
3. 改代码后 `/reload` 热重载（卸载→重读组合树→重装），无需重启。

## 常见错因对照

| 症状 | 原因 |
|------|------|
| `APP_SHAPE_INVALID` | default 非函数 / name 缺失 / inject 非字符串数组 |
| `APP_CONFIG_INVALID` | 行 config 不过你声明的 schema |
| `APP_INJECT_UNRESOLVED` | inject 里的服务名拼错或无提供方（Kahn 轮次耗尽） |
| `APP_IMPORT_FORBIDDEN` | import 越界（见白名单三道） |

## 深入

完整服务面（`ctx.get` 能拿什么）、扩展点词汇、数据目录契约、反模式清单见宿主仓库 `docs/应用开发指南.md`。
