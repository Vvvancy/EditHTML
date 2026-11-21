---
title: 提示框与折叠
created: 2026-11-22
tags: [callout, toggle]
theme: default
---

:::callout 提示 Info {#c1 kind=info}
所有修改都必须经过 `Transaction`。 ^c1a
:::

:::callout 警告 Warning {#c2 kind=warn}
不要直接修改 DOM。 ^c2a

- DOM 不是数据源 ^c2b
- 以模型为准 ^c2c
:::

:::callout {#c3 kind=tip}
没有标题的 tip。A tip without a title. ^c3a
:::

:::toggle 点击展开答案 Show answer {#g1 open=false}
答案是 **42**。 ^g1a

```js {#g1b}
console.log(6 * 7);
```
:::

:::toggle 默认展开 Open by default {#g2 open=true}
这个折叠区默认是打开的。 ^g2a
:::

:::toggle 空折叠区 Empty toggle {#g3 open=false}
:::
