# LLM 规则

> ⚠️ **2026-08-22：1.0 重置起草中**。本文描述 old-v2（当前运行代码）的现状与规范，开发照常适用；1.0 落地时是否沿用待重审（[设计文档索引](../设计文档/index.md)）。

## 分层架构

```
Agent 代码（agents/skills/plugins）
        ↓ 只能调用
src/llm/ 统一 API（ModelRequest → ModelResponse）
        ↓ 内部实现
Backend Adapter（claude-adapter / opencode-adapter）+ Provider Catalogs（anthropic/openai/openai-compat/gemini）
        ↓
外部 API
```

**核心约束：**
- 所有模型调用只能走 `src/llm/` 的 BerryAgent 契约
- Claude Agent SDK、Anthropic SDK、AI SDK、OpenAI SDK 禁止被 `agents/`、`skills/`、`plugins/` 直接 import
- SDK 产生的 tool call 必须归一化为 BerryAgent `tool_call` / `approval_request`，再经 permission token 执行
- `code-agent` 编码执行必须通过 `CodeAgentRunner -> Claude Agent SDK runner`

## 核心类型

**ModelRequest** — 统一请求结构：
- `agent` / `purpose` / `modelTier` / `mode` / `backend`
- `system` / `messages` / `tools` / `options`
- `promptHash` / `toolsHash`（用于 replay 匹配和审计）
- `stepIndex`（每 agent+session 递增）

**ModelResponse**：
- `content` / `contentBlocks` / `toolCalls`
- `stopReason`：`end_turn` | `tool_use` | `max_tokens` | `stop_sequence`
- `usage`：inputTokens / outputTokens / cacheReadTokens / cacheCreationTokens

## 模型分层

| Purpose | Tier | 说明 |
|---------|------|------|
| brain_review, learning_review | fast | 快速审核，低延迟优先 |
| brain_routing | fast | Brain 路由决策（route.request），短文本快速分类 |
| brain_checkpoint | default | Brain 中途干预（checkpoint.evaluate），判断是否需要纠偏 |
| brain_drift_check | fast | Brain 漂移检测（drift.check.request），意图对齐评分 |
| conversation, skill_generation | default | 标准对话 |
| code_task, plugin_generation | high | 复杂推理，质量优先 |

配置中可为每个 tier 指定不同模型：`config.llm.models.fast/default/high`

### Brain 三段式 LLM 消耗模型

| 阶段 | LLM 消耗 | 说明 |
|------|---------|------|
| **OBSERVE**（观察） | 零 | 所有 Agent 消息自动抄送 Brain 观察队列，只写 SQLite，不调 LLM |
| **INTERVENE**（干预） | 条件性 | checkpoint.evaluate 每次触发都调 LLM（判断 continue/adjust/stop）；dialogue.observe 走纯规则（无 LLM），仅每 3 轮可选调 LLM 做语义漂移检测 |
| **REVIEW**（审核） | 必须 | 每轮回复必经 Brain 审核，A 级用 fast、B/C 级用 default |

## Token 预算

| 范围 | 默认限制 |
|------|---------|
| session | 500,000 |
| agent（per session） | 200,000 |
| task | 100,000 |
| daily | 2,000,000 |

超出阈值（50%/75%/90%/100%）通过 EventBus 发出告警。

## 四种运行模式

| 模式 | 用途 | 行为 |
|------|------|------|
| `live` | 生产/真实测试 | 真实调用模型 API |
| `mock` | 单元模块/1-to-1 测试 | 预设响应队列，耗尽返回空 |
| `replay` | 确定性回放 | 预设响应，耗尽抛错 |
| `takeover` | 外部接管 | 请求排队等待外部响应 |

所有模式在 LLM API 边界截断，包括 Claude Agent SDK runner。

## 测试模型配置

开发测试使用 Anthropic 兼容代理：

```yaml
llm:
  base_url: https://token-plan-cn.xiaomimimo.com/anthropic
  api_key: tp-cfsaictrld41h6ece31xn8gca9avvr1rqv22gsgzj6h5d9qk
  model: mimo-v2-pro
```

环境变量覆盖优先级：`APP_TEST_LIVE_*` > `LLM_*` > 配置文件默认值。
