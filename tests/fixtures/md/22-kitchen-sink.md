---
title: 算法学习笔记 · Kitchen Sink
created: 2026-11-21
tags: [学习, 算法, kitchen-sink]
theme: default
---

# 算法学习笔记 Algorithm Notes {#ks1}

本笔记整理了 **排序** 与 *查找* 的要点，参见 [[数据结构]] 和 #算法。复杂度用 $O(n \log n)$ 表示。 ^ksi

:::callout 阅读指南 How to read {#ks2 kind=info}
按 <kbd>E</kbd> 进入编辑模式；按 <kbd>Ctrl</kbd>+<kbd>/</kbd> 查看 EHMD 源码。 ^ks2a
:::

## 1. 学习计划 Plan {#ks3}

- [x] 复习大 O 记号 ^ks4a
- [x] 实现 `quickSort` ^ks4b
- [ ] 实现 `mergeSort` ^ks4c
  - [ ] 自顶向下 top-down ^ks4d
  - [ ] 自底向上 bottom-up ^ks4e
- [ ] 刷题 20 道 ~~10 道~~ ^ks4f

## 2. 排序 Sorting {#ks5}

::::tabs {#ks6}
:::tab 思路
1. 选一个基准 pivot ^ks6a
2. 分区：小于 pivot 的放左边，其余放右边 ^ks6d
3. 递归处理两侧 ^ks6e
:::
:::tab 代码
```ts {#ks6b}
function quickSort(xs: number[]): number[] {
  if (xs.length <= 1) return xs;
  const [p, ...rest] = xs;
  return [...quickSort(rest.filter(x => x < p)), p, ...quickSort(rest.filter(x => x >= p))];
}
```
:::
:::tab 复杂度
| 情况 | 时间 | 空间 |
| --- | --- | --- |
| 平均 | `O(n log n)` | `O(log n)` |
| 最坏 | `O(n²)` | `O(n)` |

^ks6c
:::
::::

:::chart {#ks7}
type: line
data:
  x: [1k, 10k, 100k]
  y: [0.2, 2.6, 31]
options:
  title: quickSort 耗时 (ms)
:::

## 3. 查找 Searching {#ks8}

:::::columns {#ks9 ratio="1,1"}
::::column
### 二分查找 {#ks9a}

前提：数组==有序==。 ^ks9b

:::math {#ks9c}
tex: 'T(n) = T(n/2) + O(1) \Rightarrow O(\log n)'
:::
::::
::::column
### 哈希查找 {#ks9d}

平均 O(1)，最坏 O(n)；H<sub>2</sub>O 只是个下标示例，x<sup>2</sup> 是上标示例。 ^ks9e
::::
:::::

:::mermaid {#ks10}
source: |-
  graph LR
    Q[查询] --> S{有序?}
    S -->|是| B[二分]
    S -->|否| H[哈希]
:::

## 4. 参考 References {#ks11}

> Premature optimization is the root of all evil. —— Donald Knuth

^ks12

![排序可视化](assets/sorting.gif "排序过程可视化 Sorting visualization") ^ks13

:::embed {#ks14}
url: https://www.example.com/watch?v=sorting
height: 315
:::

::::toggle 练习题答案 Answers {#ks15 open=false}
:::callout 先自己做！ {#ks15a kind=warn}
第 1 题：稳定排序有 **归并**、**插入**、**冒泡**。 ^ks15b
:::
::::

:::script {#ks16}
html: <input id="n" type="number" value="8"> <output id="o"></output>
css: output{font-weight:bold}
js: const f=n=>n<2?n:f(n-1)+f(n-2);n.oninput=()=>o.textContent=f(+n.value);n.oninput();
:::

<details><summary>延伸阅读（原生 details，外来块）</summary><p>《算法导论》第 7 章</p></details>

---

^ks17

更新于 2026-11-21 · [返回目录](index.ehtml)\
© 2026 & 保留所有权利 😀 ^ks18
