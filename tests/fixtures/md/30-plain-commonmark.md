# 纯 CommonMark 笔记

没有 frontmatter、没有块 ID、没有指令块——导入时应为每个块分配新 ID。

Setext 风格标题
===============

二级 Setext
-----------

段落可以
跨越多行（软换行 soft break），
合并为一个段落。

硬换行用两个尾随空格  
或者反斜杠\
结尾。

* 星号列表
* 第二项

+ 加号列表（与上一个列表不同的标记 → 新列表）

1) 括号编号
2) 第二项

- 松散列表 loose list

- 项之间有空行

- 第三项

- 嵌套
    - 4 空格缩进的子项
        1. 更深一层
        2. 第二个

> 引用中的列表：
> - 一
> - 二
>
> ```js
> console.log("引用中的代码块");
> ```

    缩进代码块 indented code block
    第二行

~~~
波浪线围栏 tilde fence
~~~

````md
```
嵌套的围栏 nested fence
```
````

***

___

[引用式链接 reference link][ref] 与 <https://example.com/autolink>。

![引用式图片][img]

行内 HTML：<span class="x">span</span>、<!-- 注释 -->。

转义字符：\*not em\* \_not em\_ \# not heading \[not link\] \`not code\` 1\. not list

[ref]: https://example.com/reference "标题"
[img]: assets/ref.png
