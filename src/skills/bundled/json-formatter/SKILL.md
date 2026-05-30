---
name: json-formatter
description: 格式化、验证和转换 JSON 数据
version: 1.0.0
origin: bundled
source: bundled
---

# json-formatter

## 触发条件

- 用户请求格式化、美化或压缩 JSON 数据时使用。
- 用户需要验证 JSON 是否合法，或者需要从嵌套结构中提取特定字段。
- 用户提供了一段 JSON 并需要转换为其他格式（如 YAML、CSV）。

## 执行规则

- 默认使用 2 空格缩进美化 JSON。
- 验证 JSON 时，明确指出语法错误的位置和原因。
- 提取字段时使用 JSONPath 语法说明路径。
- 转换格式时保持数据完整性，不丢失嵌套结构。
- 超过 100 行的 JSON 只展示前 50 行并标注省略。
