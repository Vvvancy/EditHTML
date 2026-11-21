---
title: 标签页与多栏
created: 2026-11-22
tags: [tabs, columns]
theme: default
---

::::tabs {#t1}
:::tab 概念
二分查找在有序数组中每次排除一半。 ^t1a
:::
:::tab 例子
```ts {#t1b}
while (lo <= hi) { const mid = (lo + hi) >> 1; }
```
:::
::::

::::tabs {#t2}
:::tab macOS
按 <kbd>Cmd</kbd> + <kbd>S</kbd> 保存。 ^t2a
:::
:::tab Windows
按 <kbd>Ctrl</kbd> + <kbd>S</kbd> 保存。 ^t2b
:::
:::tab Linux
:::
::::

::::columns {#k1 ratio="1,2"}
:::column
![头像](assets/avatar.png) ^k1a
:::
:::column
### 关于我 About me {#k1b}

左栏占 1/3，右栏占 2/3。 ^k1c
:::
::::

::::columns {#k2 ratio="1,1,1"}
:::column
一 ^k2a
:::
:::column
二 ^k2b
:::
:::column
三 ^k2c
:::
::::
