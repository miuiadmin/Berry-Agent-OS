# BerryAgent 真实 AI 测试报告

> 日期: 2026-05-24  
> 模型: mimo-v2-pro  
> 基URL: https://token-plan-cn.xiaomimino.com/anthropic

## 测试方法

- CLI: `node dist/index.js test real run "<message>" --session <id> --json --timeout 120000`
- 每个场景用相同 session ID 串联多轮对话
- 临时 BERRY_HOME，自动清理

## 评分标准

| 评级 | 说明 |
|------|------|
| ✅ 完全通过 | 回答正确，有实质内容 |
| ⚠️ 部分通过 | 有内容但不够准确或完整 |
| ❌ 失败 | 错误、无内容、超时 |
