# obsidian/ — 预期

`vault/` 是一个小型 Obsidian 库，用来测试 06 §5（Markdown 导入）和 §6（批量导入、链接重写）。本文件放在 `vault/` **之外**，避免被当作笔记导入。

## 库结构

```
vault/
├── .obsidian/app.json            # Obsidian 配置：导入器必须忽略整个 .obsidian/
├── Home.md
├── assets/
│   ├── image.png                 # 1×1 PNG
│   ├── photo.png                 # 1×1 PNG
│   ├── My Photo.png              # 1×1 PNG，文件名含空格
│   └── diagram.svg               # 1×1 SVG
├── archive/2025/会议记录.md       # 与 projects/EditHTML/会议记录.md 同名
├── inbox/快速记录.md
├── journal/2026-11-20.md
├── journal/2026-11-21.md
├── notes/Callouts.md
├── notes/Dataview.md
├── notes/Diagrams.md
├── notes/Embeds.md
├── notes/Footnotes and highlights.md   # 文件名含空格
├── notes/Lists and tables.md
├── notes/Math.md
├── notes/Raw HTML.md
├── people/张三.md
└── projects/EditHTML/
    ├── Roadmap.md
    └── 会议记录.md
```

共 16 篇笔记、4 个资源文件。**故意缺失**的目标：`还没写的笔记`、`2026-11-30`、`missing.png`、`manual.pdf`。

## 通用约定

- **单文件往返**（`md → ehtml → md`，不做批量导入）：链接**不**改写；导出结果应与原文逐字节一致，只允许下面这几类"空白规范化"差异：
  1. 行尾空白；
  2. 连续多个空行合并为一个；
  3. 文件末尾恰好一个 `\n`；
  4. GFM 表格单元格内首尾的填充空格。
  其他任何差异（列表标记 `* + -`、围栏字符 `` ` ``/`~`、强调字符 `*`/`_`、转义、段落内的换行、YAML 写法）都算失败，除非下文"不能往返"中明确列出。
- **不能输出自动分配的块 ID**：导入时每个块都会得到 `data-eh` ID，但导出回 Obsidian Markdown 时，只写回原文中已有的 `^blockid`。（`md/` 中的 EHMD 样本会给每个块都写 `^id`，这里的导出目标不是 EHMD。）**歧义**，见 README。
- **frontmatter → `#eh-meta`**：保留原 YAML 的值。为了逐字节往返，还需要保留原 YAML 文本或它的写法（块序列/流序列、键的顺序）；`#eh-meta` 的规范形式（§6.1，键按字典序）会改变顺序。本样本预期：导出时用保存下来的原 YAML 文本。**歧义**。YAML 日期 `2026-11-01` 必须保持为字符串 `2026-11-01`，不能变成 `2026-11-01T00:00:00.000Z`。
- 双链行内元素保存三部分：目标（原文写法，如 `projects/EditHTML/Roadmap.md`）、子目标（`#标题` / `#^块id`）、别名。导出时按原写法输出。

## 批量导入（06 §6）

`eh import vault/ → out/`：

- 每个 `.md` 输出为相对路径相同的 `.ehtml`；`assets/` 中的文件复制到 `out/assets/`（位置不变）；`.obsidian/` 忽略；原文件不修改。
- 第一遍：建立"文件名（不含扩展名）→ 路径"表和别名表。第二遍：改写双链、嵌入和相对链接。
- **链接解析规则**（与 Obsidian 一致）：带路径的链接按路径解析；只有文件名时，若唯一则直接解析；若有多个候选，**先选与当前笔记同一文件夹的，否则选路径最短的（再按字典序）**，并且**一律在报告中标为"有歧义"**。别名**不**参与解析（Obsidian 中 `[[Zhang San]]` 是未解析的链接），但报告中可以提示"与 `people/张三.md` 的别名匹配"。
- 缺失的目标：链接保留为未解析的双链（不能删除，也不能变成纯文本），报告中列出。

### 链接解析表

| 来源笔记 | 链接 | 解析为 | 备注 |
| --- | --- | --- | --- |
| Home | `[[Roadmap]]` `[[Roadmap#目标]]` `[[Roadmap#^goal-1]]` `[[Roadmap\|路线图]]` | `projects/EditHTML/Roadmap.ehtml`（+ 标题 `目标` / 块 `goal-1`） | 唯一 |
| Home | `[[projects/EditHTML/Roadmap]]`、`[[projects/EditHTML/Roadmap.md\|带扩展名]]` | 同上 | 带 `.md` 扩展名的写法也要识别 |
| Home | `[[projects/EditHTML/会议记录]]`、`[[archive/2025/会议记录]]` | 对应文件 | 路径明确 |
| Home | `[[会议记录]]` | `archive/2025/会议记录.ehtml` | **有歧义**；根目录没有同名文件，按"路径最短"选 archive |
| Home | `[[张三]]` `[[张三\|老张]]` | `people/张三.ehtml` | |
| Home | `[[Zhang San]]` | **未解析** | 只匹配别名；报告提示 |
| Home | `[[2026-11-20]]`、`[[2026-11-21#晚上]]` | `journal/…` | |
| Home | `[[Callouts]]` … `[[Lists and tables]]` | `notes/…` | 文件名含空格 |
| Home | `[[inbox/快速记录\|快速记录]]` | `inbox/快速记录.ehtml` | |
| Home | `[[还没写的笔记]]`、`[[还没写的笔记#某节]]` | **缺失** | |
| Home | `[Roadmap](projects/EditHTML/Roadmap.md)`、`[带空格](<notes/Lists and tables.md>)`、`[编码的空格](notes/Raw%20HTML.md)` | 改写为对应的 `.ehtml`（保持原来的写法风格：`<…>` 或 `%20`） | 标准 Markdown 相对链接 |
| Roadmap | `[[会议记录]]` | `projects/EditHTML/会议记录.ehtml` | **有歧义**；同一文件夹优先 |
| Roadmap | `[[#^milestones]]`、`[[#目标]]` | 本文件 | 只有子目标的链接 |
| archive/2025/会议记录 | `[[会议记录]]` | **本文件自己** | **有歧义**；同一文件夹优先 |
| archive/2025/会议记录 | `[[projects/EditHTML/会议记录#^decision]]` | projects 中的那篇 + 块 `decision` | |
| projects/…/会议记录 | frontmatter `attendees: ["[[张三]]", …]` | `people/张三.ehtml`？ | **歧义**：YAML 字符串中的双链是否改写（Obsidian 的属性面板会把它当作链接） |
| Dataview | `due:: [[2026-11-30]]` | **缺失** | |
| Embeds | `![[image.png]]` `![[photo.png\|200]]` `![[assets/diagram.svg]]` | `assets/…` | 附件只用文件名就能在整个库中解析 |
| Embeds | `![[missing.png]]`、`![[还没写的笔记]]`、`![[manual.pdf#page=3]]` | **缺失** | |
| Embeds | `![编码的路径](assets/My%20Photo.png)` | `assets/My Photo.png` | `%20` 要解码后再查找文件 |
| journal/2026-11-21 | `[[2026-11-20#^morning]]`、`![[2026-11-20#^morning]]` | `journal/2026-11-20.ehtml` 块 `morning` | |

- **批量导入报告**：16 篇笔记已转换；4 个资源已复制；有歧义的链接 3 处；未解析的链接 7 处（`还没写的笔记` ×3 处、`Zhang San`、`2026-11-30`、`missing.png`、`manual.pdf`）；忽略的目录 `.obsidian/`。
- 增量：第二次执行时所有文件的哈希都没有变化 → 0 个文件被转换。

## 每篇笔记

下文"→"表示原生映射（06 §5），"往返"一栏说明单文件 `md → ehtml → md` 的预期。

### `Home.md`

- frontmatter（`aliases` 块序列、`tags` 块序列中有嵌套标签 `meta/hub`、YAML 日期、`cssclasses` 流序列）→ `#eh-meta`（`title`、`aliases`、`tags`、`created`、`cssclasses`）。
- `#`/`##` → heading；列表 → 列表（每个 `li` 一个块）；所有 `[[…]]` → 双链行内元素（四种形式：普通、`#标题`、`#^块id`、`|别名`）；`![[Roadmap#目标]]` → 嵌入引用块（标题段落）；`#index #meta/hub` → 标签行内元素；标准 Markdown 链接 → `a`。
- 往返：逐字节一致。

### `projects/EditHTML/Roadmap.md`

- frontmatter（流序列、数字 `priority: 1`）→ `#eh-meta`（`priority` 保持为数字）。
- `^goal-1`、`^goal-2`（段落末尾）、`^m0-spec`（嵌套的有序列表项）、`^milestones`（表格之后单独一行）→ 对应块的 ID 就是 `goal-1` 等。**歧义**：这些 ID 含 `-`，不是 base36（01 §3.1），见 README 歧义 10。外部引用不能断，所以本样本预期原样保留。
- 有序列表嵌套有序列表和无序列表（第三层）→ 列表项，带 `indent` 和列表类型。
- GFM 表格（三种对齐、单元格中有 `[[张三\|老张]]`）→ 原生 table；单元格中的 `\|` 属于双链的别名分隔符，不是单元格边界。
- 往返：逐字节一致。

### `projects/EditHTML/会议记录.md`

- frontmatter 中有包含 `[[…]]` 的 YAML 字符串 → 原样进入 `#eh-meta`。
- 任务列表 `[x]`/`[ ]` → 任务项 `done`/`todo`；`^task-import` → 块 ID；`📅 2026-11-30`（Tasks 插件语法）→ 普通文本。
- `> [!info] 背景` → `callout {kind:"info", title:"背景"}`，内含带双链的段落。
- 往返：逐字节一致。

### `archive/2025/会议记录.md`

- 没有 frontmatter；`^old-plan` 块 ID；带路径和块 ID 的双链；有歧义的裸链接。
- 往返：逐字节一致（单文件往返不改写链接）。

### `people/张三.md`

- frontmatter 中 `aliases` 含中文和空格（`Zhang San`），供别名表使用。
- 往返：逐字节一致。

### `notes/Callouts.md`

| 原文 | 原生 |
| --- | --- |
| `> [!note] 普通笔记`（两段，含双链） | `callout {kind:"info", title:"普通笔记"}`，子块 2 个段落 |
| `> [!tip]- 可折叠，默认收起` | `toggle {title:"可折叠，默认收起", open:false}`（06 §5："可折叠时 toggle"）。callout 的类型 `tip` 必须保留下来，否则无法往返（见下文"不能往返"） |
| `> [!warning]+ 可折叠，默认展开` | `toggle {title:…, open:true}`，类型 `warning` 同样需要保留 |
| `> [!info]`（没有标题） | `callout {kind:"info", title:""}`；导出时**不能**补上 "Info" |
| `> [!TIP] 大写类型` | `callout {kind:"tip"}`；原文的大小写需要保留才能往返 |
| `> [!danger]`、`> [!question]`、`> [!abstract]`、`> [!example]`、`> [!quote]`、`> [!custom-type]` | v1 只有 info/warn/tip：danger → warn，question/abstract/example/quote/custom-type → info；原始类型字符串必须保存下来（例如作为额外的 prop），否则无法往返。**歧义** |
| 嵌套 callout（三层，最内层可折叠） | `callout > callout > toggle`，深度 3（不超过建议的 4 层） |
| `> [!abstract]` 中的列表和 ```` ```js ```` | callout 的子块：列表 2 项 + code 块（`lang=js`） |
| 普通引用（两行软换行） | quote（不是 callout） |

- 往返：在原始类型被保存的前提下逐字节一致。

### `notes/Math.md`

- `$e^{i\pi} + 1 = 0$` 等 → 行内公式；`$$…$$`（多行）→ `math` 组件；`$$a^2 + b^2 = c^2$$`（同一行，在段落中）→ 段落 + 行内公式？还是 math 组件？Obsidian 把它渲染为块公式。本样本预期为 **math 组件**，并且需要记录"单行写法"才能往返。**歧义**。
- `aligned` 环境（含 `&`、`\\`）→ `math`，后面同一行的 `^eq-expand` → 该 math 块的 ID。
- `苹果 $5，香蕉 $3` → 纯文本（开头的 `$` 后紧跟数字、结尾的 `$` 前面是空格，不是公式；open question #7）。`\$100` → 文本 `$100`，导出时必须写回 `\$100`。`` `echo $HOME` `` → 行内代码。
- `$|x| < 1$` → 行内公式（含 `|` 和 `<`）；表格单元格中的 `$…$` → 单元格中的行内公式。
- 往返：逐字节一致（前提是记录了 `$$` 的单行写法）。

### `notes/Diagrams.md`

- ```` ```mermaid ````（flowchart、sequenceDiagram）→ `mermaid` 组件，source 原样（含中文、`-->|是|`）。
- ```` ```python ```` → code 块（`lang=python`）；没有语言的围栏 → code 块（`lang` 为空）。
- `~~~mermaid`（波浪线围栏）→ `mermaid` 组件。
- 往返：`~~~` 必须写回 `~~~`（要记录围栏字符）；否则只有这一处不同。

### `notes/Dataview.md`

- ```` ```dataview ````、```` ```dataviewjs ````、```` ```tasks ````、```` ```query ````（Obsidian 内置搜索）→ code 块原样保留（`lang` 分别为 `dataview` 等），导出时原样写回（06 §5 最后一行）。不执行。
- 行内字段 `status:: active`、`due:: [[2026-11-30]]`、`[rating:: 4]`、`(mood:: 😊)` → 普通段落文本（其中的 `[[…]]` 仍是双链）。`[rating:: 4]` 不能被转义成 `\[rating:: 4\]`。
- `` `= this.file.name` ``、`` `$= dv.current()…` `` → 行内代码。
- 往返：逐字节一致。

### `notes/Embeds.md`

| 原文 | 原生 |
| --- | --- |
| `![[image.png]]`（单独一段） | figure，src → `assets/image.png` |
| `![[photo.png\|200]]`、`![[photo.png\|120x80]]`（同一段中） | 段落中的图片：figure 只能是块，所以这里要么拆块，要么用行内图片。**歧义**（同 README 歧义 4）。尺寸 `200`/`120x80` 需要保存 |
| `![[assets/diagram.svg]]` | figure（SVG） |
| `![[image.png\|示意图]]` | figure，alt = `示意图`（`\|` 后不是数字 → alt） |
| `![一张图](assets/image.png)`、`![编码的路径](assets/My%20Photo.png)` | figure / 行内图片，标准 Markdown 写法 |
| `![[missing.png]]` | 未解析的图片嵌入，保留原文，渲染为占位符 |
| `![[张三]]` | 嵌入引用块（整篇笔记） |
| `![[Roadmap#里程碑]]` | 嵌入引用块（标题段落） |
| `![[Roadmap#^goal-1]]` | 嵌入引用块（单个块） |
| `![[还没写的笔记]]` | 未解析的嵌入引用块 |
| `![[manual.pdf#page=3]]` | 嵌入引用块（PDF，缺失）；06 §5 没有 PDF 嵌入这一类 |
| `[[image.png]]` | 双链（指向附件，不是嵌入） |

- 往返：逐字节一致（`![[…]]` 的写法和 `|` 后的参数原样保存）。

### `notes/Footnotes and highlights.md`

- `==高亮==`、中文高亮、`**==…==**`、`==*…*==` → `mark`（以及 `strong`/`em` 嵌套）；`没闭合的 ==` → 纯文本。
- `[^1]`（引用两次）、`[^note]`、`[^long]`（多段，第二段缩进 4 空格）→ 脚注。**歧义**：01 中没有脚注块（同 md/31 的 TBD）。
- 行内脚注 `^[…]`（Obsidian 扩展，不是 GFM）→ 06 §5 没有列出。本样本预期为 **脚注**（和 `[^n]` 一样），并记录"行内写法"。**歧义**。
- `%%…%%`（单行和多行）→ Obsidian 注释，06 §5 没有列出。本样本预期：原样保留为隐藏的"原始 Markdown"片段，导出时写回。**歧义**：用什么块承载（`eh-html` 只能放 HTML）。
- `~~删除线~~` `` `code` `` `*斜体*` `**粗体**` `***粗斜体***` → `s code em strong`。`***x***` 导出时必须仍是 `***x***`，不能变成 `**_x_**` 之类的写法。
- 往返：在脚注、行内脚注和注释都被保存的前提下逐字节一致。

### `notes/Raw HTML.md`

| 原文 | 原生 |
| --- | --- |
| `<details>` + 空行 + Markdown 内容 + `</details>` | CommonMark 把它切成 4 段：HTML 块 `<details><summary>…</summary>`、段落、列表、HTML 块 `</details>`。本样本预期识别成对的 `<details>…</details>` → `toggle {title:"点击展开（HTML details）", open:false}`，子块是段落和列表。**歧义**：06 §5 说"能识别 → 原生块"，没有说明 HTML 开始和结束标签分属不同 mdast 节点时怎么办 |
| `<details open><summary>…</summary>…</details>`（一行） | `toggle {open:true}` > 段落 |
| `<div style="…">`（含 `<b>`、`<span style="color">`） | `eh-html` 块 |
| `<div class="callout">` | `callout {kind:"info"}`（06 §3 的规则同样适用于 Markdown 中的 HTML） |
| 段落中的 `<kbd> <sub> <sup> <mark>` | 对应的白名单 mark；`<u>`、`<font color>` 按 06 §3 第 2 行规范化 |
| `<center>` | `eh-html` 块 |
| `<iframe>` | `embed {url, height:315}` |
| `<img width=100>` | figure（`width` 需要保留才能往返） |
| `<!-- HTML 注释 -->` | `eh-html` 块（原样保存注释） |
| `<table>` 带 `colspan` | `eh-html` 块 |
| `<button onclick>`、`<a href="javascript:">` | `eh-html` 块；`onclick` 剔除；`javascript:` 链接去掉链接、保留文字（01 §9） |

- 往返：**不能**逐字节一致，以下差异是允许的（见下文）：被识别成原生块的 HTML 在导出时必须写回**原来的 HTML**，而不是 `:::toggle`、`> [!info]` 或 `==…==`。要做到这一点，原生块需要记录"来源写法"。如果不记录，`<mark>` 会变成 `==…==`，`<details>` 会变成 callout 语法。被剔除的 `onclick`/`javascript:` 是故意的安全差异，永远不能往返。

### `notes/Lists and tables.md`

- `- [ ]` `- [x]` `- [X]` → 任务项（`[X]` 需要记录大写才能往返）。
- `- [-]`、`- [>]`（主题自定义状态，不是 GFM）→ 普通列表项，文本为 `[-] …`。导出时**不能**转义成 `\[-\]`。**歧义**：`data-eh-task` 只允许 `done|todo`。
- 混合列表、三层嵌套的任务项（`^deep-task`）。
- 有序列表嵌套无序和有序列表；松散列表项（第二段）；列表项中的围栏代码块 → 06/01 中的列表项只有行内内容 → **歧义**（README 歧义 2）。
- `*` 列表和 `+` 列表 → 两个独立的列表；导出时必须保留标记字符。
- 表格（四种对齐、单元格中有 `code`、`**`、`[[Home]]`、`\|`、`[[Roadmap\|别名]]`、`$x^2$`、`#tag`、空单元格）→ 原生 table。
- 缺少单元格的行 → 按 GFM 补成空单元格；**多出**的单元格（`4`）→ 按 GFM 丢弃。
- 往返：除了下文列出的几项，逐字节一致。

### `inbox/快速记录.md`

- 没有 frontmatter，第一行就是标签。
- 是标签：`#inbox` `#待整理` `#idea` `#产品/编辑器` `#nested/tag/deep` `#multi-word_tag` `#kebab-case` `#2026年计划` `#标签在行首`。
- **不是**标签：`#2026`、`#123`（纯数字）、URL 中的 `#section`、行内代码中的 `` `#not-a-tag` ``、`# 这是一个标题`（ATX 标题）、`学习#读书`（`#` 前面没有空白）。
- 往返：逐字节一致。

### `journal/2026-11-20.md`

- frontmatter 中有中文值（`weather: 晴`）。
- 段落末尾的 `^morning`；双链别名、带路径、块 ID 和别名的组合 `[[projects/EditHTML/会议记录#^decision|决议]]`；列表项中的标签 `#meeting`。
- 两行的引用（含 `「」`、`——`）→ quote，软换行保留。
- 日语、韩语。
- 往返：逐字节一致。

### `journal/2026-11-21.md`

- `[[2026-11-20#早上]]`、`[[2026-11-20#^morning]]`、`![[2026-11-20#^morning]]`（块嵌入）。
- `---` → 分割线（在正文中，不是 frontmatter）。
- 全角标点、ZWJ emoji、国旗；很长的中文段落，其中有全角空格 U+3000、中英文之间有空格和没有空格的情况 → 不重排、不自动加空格、全角空格不转换。
- 往返：逐字节一致。

## 不能往返（或依赖额外记录）的情况

| 笔记 | 内容 | 原因 | 预期 |
| --- | --- | --- | --- |
| 全部 | frontmatter 的键顺序和 YAML 写法 | `#eh-meta` 规范形式按键排序 | 保存原 YAML 文本，原样导出 |
| 全部 | 自动分配的块 ID | 导入时每个块都有 ID | 只导出原有的 `^id` |
| Callouts | 原始 callout 类型（danger/question/abstract/example/quote/custom-type、大写 `TIP`）、`-`/`+` 折叠标记 | v1 只有 info/warn/tip；可折叠 callout 变成 toggle | 把原始类型和折叠标记存为额外 prop |
| Math | 单行 `$$…$$` | 块公式通常导出为多行 | 记录写法 |
| Diagrams | `~~~` 围栏 | 导出时通常用 `` ``` `` | 记录围栏字符 |
| Footnotes | 行内脚注 `^[…]`、`%%注释%%` | 不在 06 §5 表中 | 记录写法 / 原样保留 |
| Raw HTML | 被识别成原生块的 HTML（details、div.callout、mark、kbd、iframe、img[width]） | 原生块默认用 Markdown 语法导出 | 记录"来源是 HTML"，按原 HTML 导出 |
| Raw HTML | `onclick`、`javascript:` | 安全清洗（01 §9） | **永远不能往返**（故意的） |
| Lists and tables | `[X]` 大写；`[-]` `[>]`；列表项中的段落和代码块 | 任务状态只有 done/todo；列表项只有行内内容 | 记录大小写；自定义状态作为文本；块级内容见 README 歧义 2 |
| Lists and tables | 表格行中多出的单元格 `4` | GFM 解析时就丢弃了 | **不能往返**（解析阶段已丢失）；报告提示 |
| Embeds | `![[photo.png\|200]]` 等尺寸参数 | figure 没有宽度属性 | 原样保存 `\|` 后的参数 |
