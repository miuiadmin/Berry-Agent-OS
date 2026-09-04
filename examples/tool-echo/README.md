# tool-echo

最小扩展型应用教学例：注册一个 `tool_echo` 回显工具，示范工具注册 / config schema / durable 事件三面（代码见同目录 `index.ts`，注释即教程）。

全链参照两件（API 治理进化刀 K）：
- `tsconfig.json`——类型直取示范：虚拟键 `berryagent` 经 paths 映射真类型面，`npx tsc -p .` 全绿（ctx/服务面类型从虚拟键导入，type import 不进运行时产物）；
- `tool-echo.app.yaml`——带 `api` 块的应用清单（API 装载门消费位；三必填 + api 协商块全形）。

装载（源码仓形态）：`/apps-install <仓库根>/examples/tool-echo` → `/apps-mount tool-echo --apps chat` → `/reload`
装载（npm 装机形态）：`/apps-install $(npm root)/berry-agent-os/examples/tool-echo` → `/apps-mount tool-echo --apps chat` → `/reload`
