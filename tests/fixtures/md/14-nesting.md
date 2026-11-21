---
title: 容器嵌套
created: 2026-11-22
tags: [nesting]
theme: default
---

## 深度 2：callout 内的 tabs {#n0}

:::::callout 两种写法 {#n1 kind=tip}
::::tabs {#n2}
:::tab 递归
递归版本更直观。 ^n3
:::
:::tab 迭代
迭代版本不会爆栈。 ^n4
:::
::::
:::::

## 深度 4：callout → tabs → columns → toggle {#d0}

:::::::::callout 第 1 层 Level 1 {#d1 kind=info}
::::::::tabs {#d2}
:::::::tab 第 2 层 Level 2
::::::columns {#d3 ratio="1,1"}
:::::column
::::toggle 第 4 层 Level 4 {#d4 open=true}
最深处的段落（深度 4，建议上限）。 ^d5

:::math {#d6}
tex: a^2+b^2=c^2
:::
::::
:::::
:::::column
第 3 层右栏 Level 3 right column ^d7
:::::
::::::
:::::::
::::::::
:::::::::

## 深度 5：超过建议上限（open question #5） {#o0}

:::::::toggle L1 {#o1 open=true}
::::::toggle L2 {#o2 open=true}
:::::toggle L3 {#o3 open=true}
::::toggle L4 {#o4 open=true}
:::callout L5 {#o5 kind=warn}
深度 5 —— 预期行为待定。 ^o6
:::
::::
:::::
::::::
:::::::
