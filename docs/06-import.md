# 06 · 导入与兼容：任何 HTML、任何 Markdown 都能编辑

## 0. 原则

> **所有 HTML 都是 EditHTML 的一部分，所有 Markdown 也是。**

- 任意 `.html` 文件（手写笔记、AI 生成的页面、保存下来的网页、带 CSS/JS 的单页）都能**直接打开、就地编辑、保存**，不要求先符合 `.ehtml` 规范；
- 任意 `.md` 文件（CommonMark / GFM / Obsidian 方言）都能**无损导入**成原生块，并可再导出回 `.md`；
- 导入不丢内容：识别不了的部分**原样保留**，并且**依然可以编辑**（至少能改文字和源码），而不是变成只读的死块。

## 1. 两种打开方式

| 模式 | 适用 | 行为 | 保存结果 |
| --- | --- | --- | --- |
| **保真模式**（Preserve） | 打开现有 `.html`，想保持原样 | 不改结构，只把页面里的文字、图片、链接、属性变成可编辑 | 原文件，**只修改改动处的字节**，其他字节一个不动 |
| **转换模式**（Convert） | 想把它变成原生 EditHTML 笔记 | 尽可能映射为原生块；映射不了的变成"HTML 块" | 规范形式的 `.ehtml` |

- 打开任意 `.html` 默认进入**保真模式**；工具栏提供"转换为 EditHTML 笔记"（生成新文件，原文件不动，可预览转换报告）。
- 已经是 `.ehtml`（有 `data-eh-version`）的文件直接走原生路径。
- `.md` 总是走转换模式（Markdown 本身结构简单，可以做到无损）。

## 2. 保真模式：源码区间补丁（Source-Span Patching）

目标：编辑任意 HTML，保存时 git diff 只显示真正改动的地方，缩进、注释、属性顺序、脚本全部原样。

**算法**：
1. 用带位置信息的解析器（`parse5` 的 `sourceCodeLocationInfo`）解析原文，每个元素、属性、文本节点都记录在原文中的 `[start, end)` 偏移；
2. 渲染页面时，在每个可编辑的文本节点 / 元素上挂一个映射：`DOM 节点 → 源码区间`（用 `WeakMap`，不污染 DOM）；
3. 可编辑判定：叶子文本所在的"文本容器"元素（`p h1-h6 li td th span a figcaption blockquote …`）开启 `contenteditable`；`script/style/svg 内部/canvas/表单控件` 不开启；
4. 用户编辑后，把该容器新内容序列化为 HTML 片段，生成补丁 `{start, end, replacement}`；
5. 保存时把所有补丁**按 start 降序**依次应用到原文字符串（降序保证前面的偏移不受后面替换影响），O(原文长度 + 补丁总长)；
6. 重叠补丁先合并（区间排序后线性扫描合并）；
7. 结构性操作（插入/删除/移动段落）同样转成区间补丁：在相邻节点的 `end` 处插入新片段，新片段用最接近的兄弟节点的缩进风格格式化。

**页面脚本的处理**：
- 保真模式下，页面原有 `<script>` 照常运行，以保证图表等效果正常（用户自己的文件，默认信任；来源不明的文件先询问）；
- 脚本运行后动态生成的 DOM **不可编辑**（它不在源码里，无对应区间）——编辑器通过 `MutationObserver` 识别这些节点并标灰提示"由脚本生成，请编辑其数据/源码"；
- 每个顶层区域都提供"编辑此处 HTML 源码"入口（CodeMirror 弹出层），改的同样是对应源码区间。
  - 区域 = `<body>`（或 `<main>`/`<article>`/唯一包装 `div`）的已配对子元素，加上含标灰内容的最近已配对元素；
    图表占位（标灰或无文字）连同紧随其后的行内 `<script>` 算一个区域，编辑的是「容器 + 生成它的脚本」的原始源码；
  - 应用 = 把区域的源码区间整段换成用户写的 HTML：新 HTML 在原位置上下文中按片段解析、**单独建区间索引**，
    新节点与片段区间配对（仍可就地编辑，之后打字只改动那几个字，用户的写法保留）；保存结果中该区间逐字节等于新 HTML，
    做不到（如表格寄养文本）时拒绝应用。作为一步记入撤销历史；实时预览是「先替换、下次预览/取消前撤销」；
  - 脚本生成的 DOM、脚本改过的属性/文本不属于源码：序列化时跳过或沿用原文（父元素被重新输出时也不会写进文件）；
  - 按钮与弹层放在宿主页面（打开器），不在被编辑的文档里插入任何节点。见 `importer/src/preserve/source-popover.ts`。

## 3. 转换模式：HTML → 原生块

逐个顶层子树分类（自顶向下，遇到能识别的就停）：

| 原 HTML | 转换为 |
| --- | --- |
| `p h1-h6 ul ol blockquote pre hr table figure img` 且内部仅含白名单行内元素 | 对应原生文本块 |
| 含常见非白名单行内（`b i u font` 等） | 规范化为 `strong em …`；带样式的 `span style="color"` → 高亮 mark |
| `details/summary` | `toggle` 组件 |
| 常见提示框结构（`.callout .alert .note .admonition`） | `callout` 组件 |
| `<pre class="mermaid">`、Mermaid 代码块 | `mermaid` 组件 |
| KaTeX/MathJax 输出（含 `annotation encoding="application/x-tex"`） | `math` 组件（取回原 TeX） |
| `iframe`（视频、地图等） | `embed` 组件 |
| `canvas/svg` + 生成它的 `<script>`（如 ECharts/Chart.js 配置可识别时） | 尝试识别为 `chart` 组件；否则见下一行 |
| 其他任何东西 | **HTML 块**（`eh-html`），见 §4 |

- 页面级 `<style>` → 保留为 `#eh-user-style`（必要时加作用域前缀 `#eh-doc` 防止污染编辑器 UI）；
- 页面级 `<script>` → 打包进一个 `script` 组件或保留为"页面脚本"（文档级，沙箱运行）；
- 生成**转换报告**：多少块原生化、多少变成 HTML 块、丢弃了什么（应为空），供用户确认。

## 4. HTML 块（`eh-html`）：识别不了也能编辑

替代 01 规范中原先只读的 `ForeignBlock`：

```html
<eh-html data-eh="h7">
  <!-- 原样保留的任意 HTML -->
  <div class="card fancy"><h3>标题</h3><p>内容</p></div>
</eh-html>
```

- 渲染：直接渲染原 HTML（带样式）；
- 编辑：块内文字**就地可编辑**（复用 §2 的区间补丁，区间相对于块内源码）；
- 源码：双击边框或快捷键打开源码编辑器，改完即时预览；
- 可以"拆解"：用户选择"转为原生块"时，按 §3 规则再尝试一次，或手动选择子元素提升为原生块。

## 5. Markdown 导入

基于 CommonMark + GFM 解析器（建议 `micromark`/`mdast`，带位置信息），映射到原生块：

| Markdown | 原生 |
| --- | --- |
| 标题、段落、列表、任务列表、引用、代码、表格、分割线、图片 | 对应文本块 |
| YAML frontmatter | `#eh-meta` |
| ```` ```mermaid ```` | `mermaid` 组件 |
| `$$…$$` / `$…$` | `math` 组件 / 行内公式 |
| Obsidian `> [!note] 标题` callout（含折叠 `[!note]-`） | `callout`（可折叠时 `toggle`） |
| `[[笔记]]`、`[[笔记#标题]]`、`[[笔记#^块id]]`、`[[笔记\|别名]]` | 双链行内元素 |
| `![[图片.png]]`、`![[笔记]]`（嵌入） | 图片 / 嵌入引用块 |
| `#标签` | 标签行内元素 |
| `^块id` | 块 ID（保留，保证外部引用不断） |
| `==高亮==`、脚注 | mark、脚注 |
| Markdown 中内嵌的原始 HTML | 能识别 → 原生块；否则 → `eh-html` 块 |
| 无法识别的扩展语法（如 Dataview 代码块） | 代码块原样保留，导出时原样写回 |

**无损保证**：`md → ehtml → md` 对上表覆盖的语法逐字节一致（空白规范化除外），属性测试 + Obsidian 真实笔记库样本验证。

### 5.1 实现约定（T1.7，暂定）

`packages/importer/src/markdown/`（`importMarkdown` / `exportMarkdown`）在上表未定义处采用的规则。05 #6、#7、#11、#18 仍未决，以下只是可工作的默认值，不代表这些问题已定案。

**架构**：不另写 Markdown 解析器。Obsidian 方言是叠加在 core EHMD（01 §7.1）之上的一个 `EhmdExtension`（micromark 行内语法 + mdast 变换 + 块/行内处理器 + 中间块变换 + 原子/转义钩子）；导出复用 core 的 `serializeEhmd`（以 `fragment` 模式逐段调用，块/原子写法通过钩子定制）。本模块不使用 DOM。

**映射**

| Markdown | 模型 |
| --- | --- |
| `> [!type] 标题` | `callout {kind, title}`，`kind` **原样**保存（`note`、`TIP`、`custom-type` 都不归一化为 info/warn/tip，由渲染端映射） |
| `> [!type]-` / `> [!type]+` | `toggle {title, open: false/true}`，`attrs.kind` 保存原类型；导出时由 `open` 还原 `-`/`+` |
| ```` ```mermaid ```` / `~~~mermaid` | `mermaid {source}`（围栏字符记入来源表） |
| `$$…$$`（块）；`$$ ^id` 结束行 | `math {tex}`；结束行上的 `^id` 是该块的 ID（等长预处理成单独一行） |
| 行内 `$$…$$` | `math` 原子，`attrs.display = 'block'`（不拆段落） |
| 行内 `$…$` | `math` 原子；但 `$` 内侧紧邻空白、或结束 `$` 后紧跟数字时是普通文本（Obsidian 的规则；与 05 #7 相关，待定） |
| `[[t#h\|a]]` | `wikilink` 原子，`attrs = {target, heading? \| block?, alias?}`，`target` 按原文写法保存，拼接即还原原文 |
| `![[x.png\|200]]`（单独成段） | `figure {src, alt, width?, height?, syntax: 'wikilink'}`；`\|` 后是 `N` / `NxM` 时为尺寸，否则为 alt |
| `![[笔记]]` / `![[笔记#标题]]` / `![[笔记#^id]]` / `![[x.pdf#page=3]]`（单独成段） | `note-embed {target, heading?, block?, alias?}` 组件 |
| 段落中的 `![[…]]` | `embed` 原子（属性同 wikilink） |
| `#tag` | `tag` 原子（core 规则） |
| `[^x]` / `[^x]: …` / `^[…]` | `footnote` 原子 `{label}` / `footnote {label}` 容器 / `footnote` 原子 `{inline: 'true'}`（文本为原 Markdown） |
| `%%…%%` | 段落中：`comment` 原子；单独成段或跨段：`markdown {source}` 组件（`attrs.syntax = 'comment'`） |
| `[ref]: url` | `markdown {source}`（`syntax = 'definition'`），原样保留 |
| 被空行拆开的 `<details>…</details>` | `toggle {title, open}`，`attrs.syntax = 'html'`（导出时写回 `<details>`） |
| 其他原始 HTML | core：能识别的成为原生块，其余为 HTML 块 |
| Dataview 等未知代码块 | 普通代码块，`lang` 原样 |

**块 ID**：源码中写明的 ID 一律存入 `attrs['md-id']`。符合 `BLOCK_ID_RE` 且不重复的同时作为块 ID；不符合的（`goal-1`、`deep-task`）由 core 重新分配块 ID，原 ID 只在 `md-id` 中（`BLOCK_ID_RE` 不变）。**导出只写回 `md-id`**，从不写自动分配的 ID（05 #6）。已知限制：HTML 块没有 `attrs`，其后的 `^id` 只在原文中保留。

**来源表与无损导出**：导入时为每个顶层 Markdown 节点（一个"段"）记录其顶层块 ID 和内容指纹；只有按模型重新生成的写法与原文不同时才保存原文；段前空白不是 `\n\n` 时保存。frontmatter 保存原文与 `meta` 指纹。还记录少量写法（围栏字符、分割线写法、标题 ID 写法）、末尾文本、`\r\n` 与 BOM。这些都放在 `doc.head.extra` 的 `<script type="application/json" id="eh-md-source">` 中，不进入块属性。导出时，指纹未变的段按原文输出，其余按模型生成；只有两侧都与原文完全一致时才沿用"无空行"的段间隔。因此**未知语法原样往返**：模型表达不了的写法（`[-]` 任务状态、多段列表项、表格多余单元格等）在未编辑时原样写回；编辑该段后按模型生成，报告的 `lossy` 中列出这类内容。

**安全**：含安全剔除（`on*`、`javascript:`，01 §9）的段不保存原文，导出的是清洗后的内容（故意不往返）。

**导出目标**：`obsidian`（默认，见上）；没有 Obsidian 写法的组件（tabs、columns、chart、没有 `kind` 的 toggle、callout 体中含指令时）写成 EHMD 指令块。`commonmark`：不用原文、不写 ID；mermaid/math → 代码块，chart → 图片（取自降级内容中的 `<img>`）+ YAML 数据代码块，其他组件 → 引用块 + 原始 YAML（+ 槽位内容）；双链 → 普通链接，行内公式 → 行内代码，标签 → 文本，注释 → HTML 注释。

**空白规范化**（往返比较）：只有 `\r\n` → `\n`、行尾空格/制表符、文件末尾恰好一个 `\n`。实际所有样本连这些都不需要。

**转换报告**：原生块数、组件数（按类型）、HTML 块数、保存了原文的段数、原样保留的扩展语法（`preserved`）、模型有损但原文已保存（`lossy`）、安全剔除（`sanitized`）、真正丢失（`dropped`，样本中为空）、全部链接目标（原文写法，含 frontmatter 字符串中的 `[[…]]`，供 T5.2 改写）与源码 ID 表。跨文件的链接解析（同名笔记、缺失目标）留给 T5.2。

**不能往返的样本**：`obsidian/vault/notes/Raw HTML.md`、`md/36-entities-unicode.md`——只有含 `onclick` / `javascript:` 的那一行不同（安全清洗）。

## 6. 批量导入

- `eh import <文件夹>`（CLI）/ Web 应用"导入文件夹"：
  - 递归转换 `.md` 与 `.html`，资源文件复制到 `assets/` 并重写引用；
  - **链接重写**：先扫描全部文件建立"文件名 → 新路径"表，再改写所有双链和相对链接（两遍算法，避免顺序依赖）；
  - 增量导入：按文件内容哈希跳过未变化的文件，可重复执行同步；
  - 默认**不修改原文件**，输出到新目录；也可选择"原地共存"（`.md` 与 `.ehtml` 并存）。
- 拖拽导入：把 `.md/.html` 文件或一段从网页复制的内容拖/粘进编辑器，按 §3/§5 转换。

## 7. 粘贴

- 粘贴 HTML（从网页、Word、Notion 复制）→ 走 §3 转换，先清洗（去掉 `on*`、`javascript:`、Word 的 `mso-*` 样式）；
- 粘贴纯文本中含 Markdown 语法 → 走 §5；
- `Ctrl/Cmd+Shift+V` 粘贴为纯文本。

## 8. 安全

- 来源不明的 HTML（下载的网页）保真打开时，脚本默认**不执行**，顶部提示"启用脚本"；
- 转换模式下所有脚本进入沙箱组件，永远不在编辑器同一上下文执行。
