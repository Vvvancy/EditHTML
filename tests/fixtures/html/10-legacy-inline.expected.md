# 10-legacy-inline.html — 预期

老式 HTML 的行内写法：`b i u strike del ins tt big small font center`、大写标签、`span style="color/background-color/…"`、其他语义行内元素（`abbr cite q dfn var samp time`），以及已废弃的 `nobr blink marquee`。没有 `<!DOCTYPE>`（怪异模式）。

## 保真模式（06 §2）

- **可编辑**：所有 `p`，以及 `center>font>b` 中的标题文字（`font`/`center`/`b` 中的文字都在文本容器中）。
- `marquee` 会滚动：仍然可编辑，但编辑器可以暂停动画。
- 新输入的文字继承所在元素（例如 `font`），编辑器**不能**把 `font` 改写成 `span style`。
- 怪异模式：编辑器渲染时**不能**自行补上 doctype。
- **不做任何编辑直接保存：逐字节一致**（大写 `<B>`、`bgcolor`、`<center>` 都不变）。

## 转换模式（06 §3 第 2 行：`b i u font` 等 → `strong em …`；`span style="color"` → 高亮 mark）

| 原写法 | 规范化为 |
| --- | --- |
| `center>font[size=5]>b`（没有块级标签） | heading 1 "2008 年的学习笔记"？还是 paragraph+strong？**歧义**：06 §3 没有"视觉上是标题"的启发式。本样本预期为 **paragraph**，内容为 `<strong>2008 年的学习笔记</strong>`（`center`、`font` 去壳），报告中提示 |
| `b` / `B` | `strong` |
| `i` / `I` | `em` |
| `u` | 白名单中没有下划线 → 去壳保留文字，报告中提示有损。**歧义**：`u` 是丢掉、映射为 `em`，还是用 `span[data-eh-inline]` 表示 |
| `strike`、`del` | `s` |
| `ins` | 去壳保留文字（同 `u`） |
| `tt` | `code` |
| `big`、`small` | 去壳保留文字 |
| `font[color=red]`、`font[color=#0000ff][size=4]` | 颜色高亮 mark（`span[data-eh-inline]` 的颜色写法，01 §3.2 未定义具体格式）；`size` 丢弃 |
| `font[face]`（只改字体） | 去壳保留文字 |
| `span style="color: red"` | 颜色高亮 mark（red） |
| `span style="background-color:#ffff00"` | `mark`（黄色背景就是高亮） |
| `span style="color:#16a34a; font-weight:bold"` | 颜色 mark + `strong`，按 MARK_ORDER 嵌套 |
| `span style="font-size"`、`span.hl` | 去壳保留文字 |
| `<b><i>…</i></b>` 与 `<i><b>…</b></i>` | 两者都输出为相同的规范嵌套顺序（`strong` 在 `em` 外） |
| `<b>相邻</b><b>粗体</b>` | 合并为一个 `strong`：`相邻粗体` |
| 白名单元素 `em strong mark s sub sup kbd code` | 原样 |
| `abbr cite q dfn var samp time` | 去壳保留文字；`q` 的引号是 CSS 生成的，转换后**引号消失** → 报告提示（或者补上字面引号 `“”`）。`abbr[title]` 丢失 |
| `br` | `br` |
| `nobr blink marquee` | 去壳保留文字 |
| `body[bgcolor]` | 丢弃（报告） |

- 所有段落都是原生 paragraph，没有 HTML 块。
- **转换报告**：原生块 8 个（7 个段落 + 标题段落），HTML 块 0 个；规范化：`b→strong` ×N、`i→em` ×N……；有损：`u`、`ins`、`big`、`small`、`font[size/face]`、`abbr[title]`、`q` 的引号、`time[datetime]`、`body[bgcolor]`、`center`。
