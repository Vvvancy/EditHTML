---
title: 引用、代码与分割线
created: 2026-11-22
tags: [代码]
theme: default
---

> 学而不思则罔，思而不学则殆。\
> — 《论语》

^q1

> Simple things should be *simple*, complex things should be **possible**.

^q2

---

^r1

```ts {#c1}
export function add(a: number, b: number): number {
  return a + b;
}
```

```html {#c2}
<p data-eh="b1">Hello &amp; bye</p>
```

``` {#c3}
没有语言标注的代码块
    保留缩进 4 spaces
	和制表符 tab
```

```python {#c4}
def f(xs):
    return [x for x in xs if x < 10]  # 中文注释
```

---

^r2

代码块之后的段落。 ^p1
