---
name: skill-authoring
description: 编写与进化 SKILL.md 技能的操作知识。用户要求沉淀经验、把做法固化为技能、Agent 判断某做法值得复用时使用：SKILL.md 双层结构与 frontmatter 字段、description 触发条件写法、skill_manage 工具（list/create/patch）与记忆晋升（provenance + memory_forget promotedToSkill）的完整链路。
---

# 技能编写与自进化

技能 = 一份 SKILL.md 文件（YAML frontmatter + Markdown 指令体）。写好后进入渐进披露清单（系统提示词只带 name + description 一行）；模型按 description 判断命中后自行 read 全文照做。

## 最小骨架

```markdown
---
name: my-skill # 小写字母/数字/连字符；≤64；与父目录同名
description: 一句话——写清「什么时候用」而非「这是什么」
---

# 指令体（Markdown）

做什么 / 为什么 / 怎么验
```

## description 是技能的生死线

渐进披露下模型只见这一行——写**触发条件**，别写主题概括：

- ❌ `TDD 测试驱动开发知识`（模型不知道何时该取用）
- ✅ `测试驱动开发纪律。写新功能或修 bug 时使用：先写失败测试再写实现，红-绿-重构循环，测试不过不算完成`

## 用 skill_manage 工具操作（对话中直接调）

| 动作     | 参数                                            | 说明                                                                                            |
| -------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `list`   | —                                               | 全部技能 + 来源层（项目/用户/出厂）+ 溯源标注                                                   |
| `create` | name / description / content（可选 provenance） | 新建到项目层 `.agents/skills/<名>/SKILL.md`，frontmatter 自动生成，**立即生效**（无需 /reload） |
| `patch`  | name / find / replace                           | 定点改正文（find 须恰好命中一处；仅项目层可改）                                                 |

名称规则：小写字母/数字/连字符，≤64，无连续/首尾连字符。同名已存在会被拒绝——先 list 查重。

## 写什么、怎么写（通用化纪律）

- 写「**做什么 / 为什么 / 怎么验**」——通用知识才跨模型、跨项目可复用；
- **勿编码模型自身癖性**（「我容易忘记 X」类自述）——那是记忆不是技能，跨模型负迁移的头号根因；
- **修改范围尽量小**：最小可用修改，说明哪些反馈触发；勿整篇重写既有技能（用 patch 定点改）;
- 技能是文档不是代码：SKILL.md 零执行权，指令体写给「将来读到它的模型」。

## 记忆晋升（经验 → 技能的搬家）

简报尾行出现「可晋升候选」（反复命中的 failure/insight/convention 记忆）时：

1. `skill_manage create` 写技能，frontmatter 带 `provenance: memories: [源记忆完整 id]`（溯源声明）；
2. 经用户确认技能落位后，调 `memory_forget` 带 `promotedToSkill: <技能名>` 让源记忆退场——知识搬家进技能，不是复制两份。

## 边界

- 模型只写**项目层**；用户层/出厂层技能的修改属用户本人操作；
- 晋升是显式动作（提议权在模型、确认权在用户）——绝不自动写技能、绝不绕过审批。
