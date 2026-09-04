# API 兼容性档案（COMPATIBILITY）

> 本文件由 `tools/generate-compatibility.mjs` 生成（`npm run build` 尾挂再生，check-api 查 8 drift 守护）——勿手编。
> 面真值 = `src/contracts/api-surface.json`；语义权威 = 设计文档「应用契约与扩展点」API 治理章（§6.13）。

## 当前面盘点（apiVersion 1.0）

| 模块 | stable | experimental | deprecated | 合计 |
|---|---|---|---|---|
| `berryagent` | 270 | 0 | 0 | 270 |
| `berryagent/llm` | 4 | 0 | 0 | 4 |
| `berryagent/sqlite` | 1 | 0 | 0 | 1 |
| `data-keys` | 3 | 0 | 0 | 3 |
| `live-events` | 28 | 0 | 0 | 28 |
| `manifest` | 10 | 0 | 0 | 10 |
| `services` | 108 | 0 | 0 | 108 |
| `session-events` | 28 | 0 | 0 | 28 |
| `typebox` | 3 | 0 | 0 | 3 |
| `typebox/compile` | 2 | 0 | 0 | 2 |
| `typebox/value` | 1 | 0 | 0 | 1 |
| **合计** | 458 | 0 | 0 | **458** |

能力面（capabilities）共 14 项。

执法纪元：`pre-ignition`（兼容执法未点火——清单 api 块缺席为 legacy 容忍态，仅聚合 warn）。

## 废弃登记（DEP 注册簿）

现役零废弃登记（首个真实废弃日起本节逐行生成——登记纪律见 §6.13.6）。

## 变更史（快照 diff 自动判级）

基线形成前——首个 release 归档首版快照（`api/snapshots/`）即基线，此后逐版生成本节。
