---
title: GFM 特性
tags: [gfm]
---

# GFM 扩展 GitHub Flavored Markdown

## 表格对齐 Table alignment

| 左对齐 Left | 居中 Center | 右对齐 Right | 默认 |
| :--- | :---: | ---: | --- |
| a | b | 1.00 | x |
| 中文 | **粗体** | 100.5 | `code \| pipe` |
| 只有一格 |

列对齐信息在 `.ehtml` 中没有对应（规范表格只允许 thead/tbody/tr/th/td）。

## 任务列表 Task lists

- [ ] 未完成 todo
- [x] 已完成 done
- [X] 大写 X 也算完成
- 普通项（混在任务列表中）
  - [ ] 嵌套任务

1. [ ] 有序任务列表 ordered task
2. [x] 第二项

## 删除线与自动链接

~~删除线~~ 与 ~单波浪线~，自动链接 www.example.com 与 https://example.com/path?q=1。

## 代码块与语言

```typescript
type Block = TextBlock | ComponentBlock | ForeignBlock;
```

```diff
- old line
+ new line
```

```
没有语言 no language
```

## 脚注 Footnotes

这里有个脚注[^1]。

[^1]: 脚注内容（GFM 支持，但规范 §3 中没有对应块类型）。
