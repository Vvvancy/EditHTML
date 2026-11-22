# 14-notion-paste.html — 预期

从 Notion 复制得到的剪贴板 HTML 片段（以 `<meta charset>` 开头，没有 `html/head/body`，写在一行，带大量内联 `style`）：标题、行内代码、嵌套列表、to-do 列表（`div.checkbox`）、callout（`figure.callout` + emoji 图标）、toggle（`details`）、引用、颜色文字与背景色、指向 notion.so 的页面链接、带 UUID `id` 的 `hr`、`simple-table`。

## 保真模式（06 §2）

- 以文件形式打开时：**可编辑** `h1`、`p`、`li` 中的文字、callout 正文 `div`、`summary`、`blockquote`、单元格。`div.checkbox` 是空元素，不可编辑。
- 解析器隐式补出的 `html/head/body` 没有源码位置，绝不能写回文件。
- **不做任何编辑直接保存：逐字节一致**（文件只有一行加末尾换行）。

## 转换模式 / 粘贴（06 §3、§7）

| 原片段 | 原生块 |
| --- | --- |
| `meta[charset]` | 丢弃（不是内容） |
| `h1.notion-header-block` | heading 1（`style` 丢弃） |
| `p`（含两个 `code`，带内联样式） | paragraph，`code` 样式丢弃 |
| `ul` 嵌套 | 列表：2 项 + 1 项 `indent=1`；`span[font-weight:600]` → `strong`。**歧义**：06 §3 只列出了 `span style="color"`，没有说 `font-weight` 是否映射为 `strong`；本样本预期映射（≥600 视为粗体） |
| `ul.to-do-list` + `div.checkbox-on/off` | 任务列表：`done` "写 PRD"、`todo` "评审"。**歧义**：Notion 的 to-do 结构不在 06 §3 表中；如果不识别，就变成 `eh-html` |
| `figure.callout`（💡） | `callout` `{kind:"tip", title:""}` > paragraph（内含 `mark` "50 MB"）。class 是 `callout`，符合 06 §3；图标 💡 → `tip` 是启发式规则。`mark.highlight-yellow` → `mark` |
| `details open` + `summary` | `toggle` `{title:"技术方案（toggle）", open:true}` > paragraph |
| `blockquote.quote` | quote |
| `p` 中的 `span[color:rgb(68,131,97)]` | 颜色 mark（`#448361`） |
| `span[background-color:rgb(251,243,219)]` | `mark`（背景色高亮；颜色值丢失，报告） |
| 指向 notion.so 的 `a` | 普通链接，原样保留（`style` 丢弃）；**不**改写成双链 |
| `hr[id=UUID]` | 分割线（`id` 丢弃） |
| `table.simple-table`（只有 `tbody`，`tr` 带 `id`） | 原生 table，没有表头 |

- **转换报告**：顶层原生块 13 个（h1、p、3 个列表项、2 个任务项、callout、toggle、quote、p、hr、table），HTML 块 0 个；清洗：内联 `style` 全部丢弃；有损：背景色具体值。
