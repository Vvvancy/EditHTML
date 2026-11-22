# 08-mermaid.html — 预期

Mermaid 的四种形态：`pre.mermaid`（06 §3 原文）、`div.mermaid`、Markdown 渲染器输出的 `pre>code.language-mermaid`、以及已经被渲染成 SVG 的 `pre.mermaid[data-processed]`。库为占位路径 `./vendor/mermaid.esm.min.mjs`（`type="module"`）。

## 保真模式（06 §2）

- mermaid.js 运行后会把 `pre.mermaid` / `div.mermaid` 的文本替换成 SVG → 这些块的显示内容"由脚本生成"，不可直接编辑；提供"编辑 Mermaid 源码"入口，补丁修改的是源码中元素的文本区间（`flowchart LR …`）。
- `pre>code.language-mermaid` 没有被 mermaid.js 选中（选择器是 `.mermaid`），作为代码文本可编辑。
- 最后一个已渲染的 SVG：`svg` 内部不可编辑。
- **可编辑**：`h1`、所有 `p`。
- **不做任何编辑直接保存：逐字节一致**（mermaid 渲染后的 SVG 绝不能写回前三个块）。

## 转换模式（06 §3：`<pre class="mermaid">`、Mermaid 代码块 → `mermaid`）

| 原块 | 原生块 |
| --- | --- |
| head 中的 `<script type="module">`（import + initialize） | 识别为 mermaid 库加载，被 mermaid 组件消费，不作为 script 组件保留；`theme:'neutral'` 丢弃（写入报告） |
| `h1`、各 `p` | heading 1、paragraph ×4 |
| `pre.mermaid` | `mermaid` 组件，source=`flowchart LR\n    U[用户] --> G{网关}\n…\n    S --> D[(数据库)]`（去掉首尾的换行，保留内部缩进） |
| `div.mermaid` | `mermaid` 组件，source 为 sequenceDiagram 文本。**歧义**：06 §3 只写了 `pre.mermaid`；`div.mermaid` 也是 mermaid.js 官方支持的写法，本样本预期同样识别 |
| `pre>code.language-mermaid` | `mermaid` 组件（06 §3 中的"Mermaid 代码块"），source=`stateDiagram-v2\n…\n    已发布 --> [*]`（`-->` 在源码中是字面量，`&gt;` 实体需解码） |
| `pre.mermaid[data-processed]` + 内联 SVG | 源码已丢失 → `eh-html` 块（不要从 SVG 反推 mermaid） |

- **转换报告**：原生块 5 个文本块 + 3 个 mermaid 组件，HTML 块 1 个（原因：mermaid 已渲染，源码丢失）；丢弃：`theme` 配置。
