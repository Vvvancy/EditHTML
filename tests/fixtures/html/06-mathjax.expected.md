# 06-mathjax.html — 预期

MathJax 风格的四种常见形态：
- A：源码中是未渲染的 `\(…\)` / `$…$` / `\[…\]`，由 MathJax 运行时替换；
- B：MathJax 2 的 `<script type="math/tex">`（行内和 `mode=display`），带 `MathJax_Preview`；
- C：MathJax 3 CHTML 的 `mjx-container`，只有辅助 MathML，**没有 TeX annotation**；
- D：带 `annotation encoding="application/x-tex"` 的裸 MathML。

脚本为占位路径 `./vendor/mathjax/tex-chtml.js`。

## 保真模式（06 §2）

- 情况 A：源码中 TeX 是**普通文本**，所以在源码层面可编辑；但 MathJax 运行后 DOM 中的文本节点被 `mjx-container` 替换，没有区间 → 标为"由脚本生成"。编辑器应把 A 中的分隔符文本当作可编辑区间（编辑时显示 TeX 源码），保存时修改的是这段源码文本。**歧义**：脚本改写了源码中**存在**的文本节点时如何处理（与 02 号的 `#count` 同一个问题），见 README。
- 情况 B：`script[type^=math/tex]` 不执行、不可编辑，通过源码弹出层编辑；`MathJax_Preview` 中的文字可编辑，但没有意义（MathJax 运行后隐藏）。
- 情况 C：整个 `mjx-container` 不可编辑（自定义元素、MathML）。
- 情况 D：MathML 不可编辑（svg/MathML 内部都不开启），可以提供"编辑 TeX"入口，补丁只修改 annotation 的文本区间。
- 文字段落（h1、最后一个 p）可编辑。
- **不做任何编辑直接保存：逐字节一致**（MathJax 运行时插入的 DOM 绝不能被序列化回文件）。

## 转换模式（06 §3：KaTeX/MathJax 输出 → `math`）

| 原块 | 原生块 |
| --- | --- |
| head 中的 MathJax 配置 `<script>` 和库 `<script src>` | 被 math 识别消费；配置中的 `inlineMath` 分隔符决定情况 A 如何切分。报告中列出 |
| `h1` | heading 1 |
| A：`p` 中的 `\(…\)`、`$P(B) &gt; 0$` | paragraph + 2 个行内公式：`P(A \mid B) = \frac{P(A \cap B)}{P(B)}`、`P(B) > 0`（实体解码）。**歧义**：06 §3 只提到"KaTeX/MathJax **输出**"，没有提到未渲染的分隔符文本；本样本预期按页面中的 MathJax 配置识别 |
| A：`p` 中只有 `\[…\]` | `math` 组件，tex=`P(A \mid B) = \frac{P(B \mid A)\,P(A)}{P(B)}`（去掉首尾换行） |
| B：`p` "全概率公式" + `script[mode=display]` | paragraph "全概率公式：" + `math` 组件 `P(B) = \sum_i P(B \mid A_i)\,P(A_i)`（块公式把段落拆开）；`MathJax_Preview` 丢弃（属于降级内容） |
| B：`p` "期望 …" + 行内 `script[type=math/tex]` | paragraph，内含行内公式 `\mathbb{E}[X]` |
| C：`mjx-container`（没有 TeX） | TeX 无法取回 → `eh-html` 块（保留辅助 MathML 作为可读内容）。不应尝试 MathML→TeX 反推 |
| D：`p` + `math>semantics>annotation[x-tex]` | paragraph + 行内公式 `\varphi(x) = \frac{1}{\sqrt{2\pi}} e^{-x^2/2}` |
| 最后一个 `p`：`$5 和 $10` | paragraph，**不**识别为公式（两个 `$` 之间是 `5 和 `，不满足 TeX 规则：开头的 `$` 后面紧跟数字、结尾的 `$` 前面是空格）。与 open question #7 一致 |

- **转换报告**：原生块 8 个（6 个文本块、2 个 math 组件；行内公式 4 个），HTML 块 1 个（原因：MathJax 3 输出不含 TeX）；页面脚本：MathJax 配置和库已识别并消费，**不**作为 script 组件保留；丢弃：`MathJax_Preview` 1 处、注释 4 条。
