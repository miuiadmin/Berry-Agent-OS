---
name: git-commit-helper
description: 辅助生成规范的 git commit message
version: 1.0.0
origin: bundled
when_to_use: 用户请求提交代码或需要 commit message 时
arguments: [type, scope]
---

## 触发条件

- 用户要求提交代码
- 用户请求生成 commit message
- 用户在讨论代码变更并准备提交

## 执行规则

### 1. 获取上下文

当前分支最近提交：!`git log --oneline -5 2>/dev/null || echo no-git-history`

当前工作目录状态：!`git status --short 2>/dev/null || echo no-git-status`

### 2. 生成规范 commit message

使用 Conventional Commits 格式：

```
$type($scope): <简短描述>

<可选正文>

<可选脚注>
```

### 3. type 参考

| type | 用途 |
|------|------|
| feat | 新功能 |
| fix | 修复 bug |
| docs | 文档变更 |
| style | 格式调整 |
| refactor | 重构 |
| perf | 性能优化 |
| test | 测试 |
| chore | 构建/工具 |

### 4. 注意事项

- 描述使用中文，动词开头
- scope 使用模块名或功能区域名
- 如果 $type 和 $scope 未提供，根据 diff 自动推断
- 正文解释 WHY 而非 WHAT
- Breaking change 必须在脚注标注 `BREAKING CHANGE:`
