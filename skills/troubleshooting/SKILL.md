---
name: troubleshooting
description: berry 装配与插件行为异常排查。插件没生效、工具缺失、组合树可疑、启动报错时使用：dump-config 看全貌 → /plugins 看行状态 → 日志与错误码对照定位。
---

# berry 排查三步

装配类问题（插件没生效 / 工具缺失 / 启动报错）按序走三步，多数问题第一步就有答案。

## 1. `berry dump-config` 看全貌

一屏答案：模型、组合树逐行装载状态（activated / failed / skipped / unresolved）、应用清单、工具清单、技能发现位置。不落盘（`:memory:` 全装配即弃），所见即实装。

先看三处：

- **某行 failed** → 启动断言会聚合失败清单，dump 输出带具体错误——按错误码对照（见第 3 步表）；
- **某行 skipped** → 括号里是原因（行 disabled / 平台不符等）；
- **工具清单里没有预期工具** → 贡献它的插件行是否 activated？行 activated 但工具不在 = 插件自身的注册逻辑没走到，看日志。

## 2. `/plugins` 与 overlay 核对

TUI 里 `/plugins` 看每行状态与原因；组合树覆写在 `<数据目录>/overlay.yaml`（缺省 `~/.berry/`）。

- 预期行不在树上 = overlay 没写对（insert 新行必须自带 `plugin:` 字段；`builtin:` 前缀行是官方件）；
- 行被意外禁用 = overlay 里该行 `disabled: true` 后写胜出；
- `unresolved` = 入口解析不到（路径写错 / 包未安装——unresolved 永不自动安装）。

## 3. 日志与错误码

`APP_LOG_LEVEL=debug` 重现一遍。durable 事件与日志双轨：装载类问题看启动段日志，行为类问题看会话事件。

| 错误码 | 含义与方向 |
|--------|-----------|
| `PLUGIN_IMPORT_FORBIDDEN` | 插件 import 越界（白名单三道外）——看插件依赖图里有没有逃逸说明符 |
| `PLUGIN_MAIN_DB_FORBIDDEN` | 插件经 `berryagent/sqlite` 开了宿主主库——改开自管库路径 |
| `PLUGIN_SHAPE_INVALID` | 插件形状违例（default 非函数 / name 缺失等） |
| `PLUGIN_CONFIG_INVALID` | 行配置不过插件声明的 schema |
| `COMPOSITION_ROW_INVALID` | overlay.yaml 行非法（未知字段 / 缺 id / insert 缺 plugin） |

## 边界

- 改了插件代码不生效 → 先 `/reload`（jiti 缓存驱逐随重载）再判断；
- 会话数据/记忆类问题与装配无关 → 走会话库诊断，不是本技能范围。
