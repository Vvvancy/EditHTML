---
title: EHMD 边界情况
tags: [edge]
---

# 边界情况 Edge cases {#x1}

重复的块 ID（应重新分配第二个）。 ^dup

第二个使用相同 ID 的段落。 ^dup

ID 两种写法同时出现 {#both} ^both2

不是 ID 的文本：价格 ^ 上涨，邮件 a^b，行中间的 ^mid 不算块 ID。 ^x2

:::unknown-thing {#x3}
foo: bar
:::

:::chart {#x4}
type: bar
data: [this is: not valid yaml
:::

:::chart {#x5}
:::

:::math {#x6}
tex: '</script><script>alert(1)</script>'
:::

:::script {#x7}
html: '<p>JSON 中的 </script> 必须序列化为 <\/script></p>'
js: 'console.log("<!-- <script>")'
:::

::: callout 冒号后有空格 {#x8 kind=info}
指令名前有空格，是否识别？
:::

:::callout 属性值带空格 {#x9 kind="warn" title="覆盖 label 的 title"}
label 与 title 属性同时存在时谁优先？
:::

```
:::chart
围栏代码块内的指令语法应保持原样，不被解析。
:::
```

:::toggle 未闭合的指令块 {#x10 open=false}
这个指令块没有结束标记，一直到文件末尾。

- 列表项
