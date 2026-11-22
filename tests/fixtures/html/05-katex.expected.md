# 05-katex.html — 预期

KaTeX 服务端渲染输出（`renderToString` 的默认 `htmlAndMathml` 模式）：行内公式、`katex-display` 块公式（一个在 `p` 中，一个直接在 `body` 下）、TeX 中含实体编码的 `&amp;` `&lt;`，以及一个没有 MathML/annotation 的 `output:"html"` 公式。样式表为占位路径 `./vendor/katex.min.css`。

## 保真模式（06 §2）

- **可编辑**：`h1`、各 `p` 中公式之外的文字、`code`。
- **不可编辑**：所有 `.katex` 子树。它们是"渲染产物"，在里面逐字修改毫无意义（`katex-html` 中的字形）。编辑器应把 `.katex` 作为一个原子行内节点，并提供"编辑 TeX"入口：从 `annotation` 读出 TeX，修改后的补丁区间是**整个** `span.katex`（需要重新渲染 KaTeX；没有 KaTeX 时只更新 annotation，并提示"显示未更新"）。**歧义**，见 README。
- `math`/`semantics` 是 MathML 外来内容（foreign content），parse5 的位置信息必须正确，区间补丁不能破坏其中的命名空间。
- **不做任何编辑直接保存：逐字节一致**（包括非常长的单行 `span` 和 `&amp;`/`&lt;` 实体）。

## 转换模式（06 §3：KaTeX/MathJax 输出 → `math`）

| 原块 | 原生块 |
| --- | --- |
| `<link rel=stylesheet href=./vendor/katex.min.css>` | 被 math 识别消费，不进入文档；报告中列出 |
| `h1` | heading 1 |
| 第一个 `p`（含行内 `.katex`） | paragraph，公式变成行内公式 `span[data-eh-inline=math]`，TeX=`y = X\beta + \varepsilon` |
| `p` "闭式解：" | paragraph |
| `p > span.katex-display` | `math` 组件，`{tex:"\\hat\\beta = (X^\\top X)^{-1} X^\\top y"}`。`p` 中只有块公式时，`p` 本身不保留 |
| `p` "矩阵形式…" | paragraph，`code` 中的 `&amp;`/`&lt;` 解码为 `&`/`<` |
| `body > span.katex-display`（裸行内元素在 body 下） | `math` 组件，`{tex:"\\begin{cases} 1 & x < 0 \\\\ 0 & \\text{otherwise} \\end{cases}"}`：annotation 中的实体必须**解码**后存入 JSON |
| 最后一个 `p` 中没有 annotation 的 `.katex` | TeX 无法取回 → 该公式成为行内 `eh-html`？行内没有 `eh-html` → 整段 `p` 成为 `eh-html` 块。**歧义**：06 §4 的 `eh-html` 只定义了块级形态，见 README |

- **转换报告**：原生块 6 个（4 个文本块、2 个 math 组件；行内公式 1 个），HTML 块 1 个（原因：KaTeX 输出缺少 TeX annotation）；丢弃：所有 `katex-html` 渲染产物（属于可再生成的降级内容，不算丢失）。
