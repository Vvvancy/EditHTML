---
title: 流程图与公式
created: 2026-11-22
tags: [mermaid, math]
theme: default
---

## 保存流程 Save flow {#h1}

:::mermaid {#m1}
source: |-
  graph TD
    A[用户输入] --> B{是否合并?}
    B -->|是| C[history.push]
    B -->|否| D[新事务]
:::

:::mermaid {#m2}
source: |-
  sequenceDiagram
    Editor->>Core: apply(tx)
    Core-->>Renderer: dirtySet
:::

## 公式 Math {#h2}

:::math {#x1}
tex: '\int_0^1 x^2\,dx = \frac{1}{3}'
:::

:::math {#x2}
tex: '\begin{aligned} a &= b + c \\ d &< e \end{aligned}'
:::
