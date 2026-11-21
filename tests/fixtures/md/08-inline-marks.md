---
title: 行内元素
created: 2026-11-22
tags: [inline]
theme: default
---

**粗体 bold**、*斜体 italic*、`code()`、~~删除线 strike~~、==高亮 highlight==。 ^i1

水的化学式 H<sub>2</sub>O，爱因斯坦 E = mc<sup>2</sup>，脚注<sup>[1]</sup>。 ^i2

按 <kbd>Ctrl</kbd> + <kbd>/</kbd> 切换源码模式，按 <kbd>E</kbd> 进入编辑。 ^i3

链接 [外部链接 external](https://example.com/docs?a=1&b=2)、[块级链接 block link](other-note.ehtml#k9x)、[页内锚点](#i1)、[邮件](mailto:someone@example.com)。 ^i4

第一行 line one\
第二行 line two\
第三行 line three ^i5

行内公式 $e^{i\pi} + 1 = 0$，双链 [[快速排序]]，带别名 [[algorithms/quicksort|快排]]，标签 #算法 #todo/later。 ^i6

嵌套标记 nested: **粗体里有 *斜体和 `代码`***，[**粗体链接**](https://example.com)，~~==删除+高亮（MARK_ORDER: s 在 mark 外）==~~。 ^i7

共享外层前缀 shared prefix: **a*b***_c_ —— a=[strong]、b=[strong,em]、c=[em]，strong 对 a/b 保持打开。 ^i8
