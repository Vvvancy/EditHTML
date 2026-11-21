---
title: 图表
created: 2026-11-22
tags: [chart]
theme: default
---

## 月度支出 Monthly spending {#h1}

:::chart {#ch1}
type: bar
data:
  x: [一月, 二月, 三月]
  y: [320, 280, 410]
options:
  title: 支出（元）
:::

:::chart {#ch2}
type: line
data:
  x: [1, 2, 3, 4]
  y: [1.5, 2.25, -0.5, 3]
options: {}
:::

:::chart {#ch3}
type: pie
data:
  labels: [阅读 Reading, 编码 Coding, 睡觉 Sleep]
  values: [2, 6, 8]
:::

:::chart {#ch4}
type: scatter
data:
  points:
    - [0, 0]
    - [1, 2.5]
    - [2, 1]
    - [3, 4]
options:
  xLabel: x
  yLabel: y
:::

上面最后一个图表没有降级内容（ch4），纯 parse→serialize 往返时保持无 fallback（省略该行）；带渲染器保存时才补生成。 ^p1
