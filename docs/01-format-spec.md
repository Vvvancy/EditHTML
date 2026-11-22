# 01 · `.ehtml` 文件格式规范（草案 v0.1）

> 状态：草案。凡标注 **【待定】** 的条目见 [05-open-questions.md](05-open-questions.md)。

## 1. 总体思路

`.ehtml` 是一个**合法的 HTML5 文件**，在 HTML 之上加了一层约定：

- 用少量 `data-eh-*` 属性和自定义元素 `<eh-*>` 把页面划分为**块（block）**；
- 文本块使用**受限的语义 HTML 子集**（像 Markdown 能表达的那些）；
- 组件块把**数据与配置**放在块内的 `<script type="application/json">` 中，把**渲染结果**作为降级内容放在块内，保证没有运行时也能看；
- 文件头部嵌入一个很小的**运行时加载器**，负责"阅读模式 → 编辑模式"的切换。

为什么以 HTML 而不是 Markdown 作为存储格式：
1. 双击即可在浏览器阅读，这是"文件即网页"原则的硬要求；
2. 组件块的结构化数据放在 Markdown 里只能靠各家私有扩展语法，可移植性差；
3. 通过"受限子集 + 确定性序列化"（见 §6），可以把 HTML 的 diff 噪音压到接近 Markdown。

另外提供一种**文本源码视图（EHMD）**：Markdown + 指令块语法，供喜欢敲源码的人使用，与 `.ehtml` 双向无损转换（见 §7）。

## 2. 文件骨架

```html
<!doctype html>
<html lang="zh-CN" data-eh-version="0.1">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>笔记标题</title>

  <!-- 文档元数据（frontmatter 等价物） -->
  <script type="application/json" id="eh-meta">
  {"title":"笔记标题","created":"2026-11-21","tags":["学习","算法"],"theme":"default"}
  </script>

  <!-- 主题样式：内联（自包含）或引用 -->
  <style id="eh-theme">/* ... */</style>
  <!-- 用户自定义样式，可选 -->
  <style id="eh-user-style">/* ... */</style>

  <!-- 运行时加载器（~5KB），见 §8 -->
  <script id="eh-runtime" src="https://.../eh-runtime.js" defer></script>
</head>
<body>
  <main id="eh-doc">
    <h1 data-eh="b1">笔记标题</h1>
    <p data-eh="b2">一段正文，支持 <strong>粗体</strong>、<code>代码</code>、<a href="...">链接</a>。</p>

    <eh-chart data-eh="b3">
      <script type="application/json">{"type":"bar","data":{"x":["A","B"],"y":[3,5]}}</script>
      <img src="data:image/svg+xml;..." alt="柱状图：A=3, B=5">  <!-- 降级渲染 -->
    </eh-chart>
  </main>
</body>
</html>
```

## 3. 块（Block）

### 3.1 块标识

- 每个顶层块元素带 `data-eh="<id>"`，`id` 为文档内唯一的短 ID（base36，如 `b1`、`k9x`）。
- ID 用途：增量渲染的 key、块级链接（`note.ehtml#k9x`）、双链/引用、撤销历史定位。
- ID 一旦分配不再改变；复制粘贴的块重新分配。

### 3.2 文本块（受限语义子集）

| 块类型 | HTML | Markdown 对应 |
| --- | --- | --- |
| 段落 | `<p>` | 普通段落 |
| 标题 | `<h1>`–`<h6>` | `#` … `######` |
| 列表 | `<ul>` / `<ol>` / `<li>`，任务项 `<li data-eh-task="done|todo">` | `-` / `1.` / `- [ ]` |
| 引用 | `<blockquote>` | `>` |
| 代码 | `<pre data-lang="ts"><code>…</code></pre>` | ```` ``` ```` |
| 分割线 | `<hr>` | `---` |
| 表格 | `<table>`（仅 thead/tbody/tr/th/td） | GFM 表格 |
| 图片 | `<figure><img><figcaption></figure>` | `![]()` |

行内元素白名单：`strong em code a s mark sub sup kbd br span[data-eh-inline]`。
`span[data-eh-inline]` 用于扩展行内元素（行内公式、双链 `[[...]]`、标签 `#tag`、颜色高亮等）。

### 3.3 组件块

组件块统一形态：

```html
<eh-{type} data-eh="{id}" [data-eh-props...]>
  <script type="application/json">{ 组件数据 }</script>   <!-- 唯一真实数据源 -->
  …降级内容…                                              <!-- 由组件渲染器生成，可丢弃重建 -->
</eh-{type}>
```

规则：
- **JSON 是真相，降级内容是缓存**。编辑器只读 JSON；降级内容在保存时由渲染器重新生成。
- 降级内容必须是静态 HTML/SVG（不依赖 JS），保证无运行时可读。
- 未知 `type` 的组件：保留原样，只读显示降级内容，可编辑其 JSON 源码。

### 3.5 HTML 块（`eh-html`）

任何无法映射为原生块的 HTML 都包在 `<eh-html data-eh="id">…</eh-html>` 中原样保留：直接渲染、块内文字可就地编辑、可打开源码编辑、可尝试"拆解为原生块"。详见 [06-import.md §4](06-import.md)。

v1 内置组件（详见 `packages/blocks/`）：

| type | 用途 | 数据 |
| --- | --- | --- |
| `chart` | 柱/折线/饼/散点图 | `{type, data, options}` |
| `mermaid` | 流程图、时序图 | `{source}` |
| `math` | 块级公式 | `{tex}` |
| `callout` | 提示框（info/warn/tip） | `{kind, title}` + 子块 |
| `tabs` | 标签页 | `{tabs:[{title}]}` + 子块 |
| `columns` | 多栏布局 | `{ratio:[1,2]}` + 子块 |
| `toggle` | 折叠区 | `{title, open}` + 子块 |
| `embed` | 嵌入网页/视频 | `{url, height}` |
| `script` | 用户自定义 HTML/CSS/JS 小组件 | `{html, css, js}`（沙箱运行，见 §9） |

### 3.4 容器块

`callout / tabs / columns / toggle` 是**容器块**，可以包含子块：

```html
<eh-tabs data-eh="t1">
  <script type="application/json">{"tabs":[{"title":"概念"},{"title":"例子"}]}</script>
  <eh-slot data-eh-slot="0"><p data-eh="t1a">…</p></eh-slot>
  <eh-slot data-eh-slot="1"><p data-eh="t1b">…</p></eh-slot>
</eh-tabs>
```

嵌套深度上限 **【待定】**（建议 4 层）。

## 4. 资源

- 图片等资源默认以**相对路径**引用同目录下的 `assets/`（与 Obsidian 习惯一致）；
- 导出"单文件分享版"时可内联为 data URI；
- 组件依赖的第三方库（如图表库）由运行时按需加载，**不写进文件**。

## 5. 主题

- 主题 = 一组 CSS 变量 + 块样式，`#eh-meta.theme` 指定；
- 用户样式写在 `#eh-user-style`，可以针对 `[data-eh="id"]` 定制单块样式。

## 6. 确定性序列化（Canonical Form）

保存时必须产出**规范形式**，保证 git diff 干净：

1. 每个顶层块独占一行起始；容器块的子块缩进 2 空格；
2. 属性按固定顺序输出：`data-eh` → `data-eh-*` → 其余按字母序；
3. 组件 JSON：键按 schema 定义顺序，单行紧凑输出；超过 120 字符时按规则换行；
4. 文本内容不做重排（不自动折行），只做必要的实体转义（`& < >`，属性中加 `"`）；
5. 降级内容整体放在单独一行，前后加 `<!--eh:fallback-->` 注释标记，diff 工具可配置忽略。

保证：`serialize(parse(serialize(doc))) === serialize(doc)`（幂等）。

### 6.1 规范形式细则（v0.1，T1.2 解析器与 T1.3 序列化器共同遵守）

以下 `␣` 表示空格。缩进一律 2 空格；行尾 `\n`，文件以 `\n` 结尾。

**文件骨架**（可选部分不存在时整行省略）：

```html
<!doctype html>
<html lang="{head.lang ?? 'zh-CN'}" data-eh-version="0.1">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{head.title ?? meta.title ?? ''}</title>
    <script type="application/json" id="eh-meta">{meta JSON}</script>
    <style id="eh-theme">{head.themeCss}</style>
    <style id="eh-user-style">{head.userCss}</style>
    {head.extra}
    <script id="eh-runtime" src="{head.runtimeSrc}" defer></script>
  </head>
  <body>
    <main id="eh-doc">
      {顶层块，每块从缩进 6 开始}
    </main>
  </body>
</html>
```

- `meta` JSON：键顺序 `title, created, tags, theme`，其余键按字典序；单行紧凑输出。meta 为空对象时输出 `{}`。
- `<style>`、`head.extra` 内容原样输出（不重排）。

**JSON 嵌入**（meta 与组件数据）：`JSON.stringify` 单行输出后，把 `</` 替换为 `<\/`、`<!--` 替换为 `\u003c!--`，保证不会提前闭合 `<script>`。组件 props 键顺序保持模型中的插入顺序（schema 顺序待 T2.6 引入；超 120 字符换行规则暂不实施）。

**属性**：`data-eh` → 其余 `data-eh-*`（字典序）→ 其他属性（字典序）。值用双引号，转义 `& < > "`。布尔属性输出为 `name=""`（`defer` 除外，固定写法见骨架）。

**文本**：只转义 `& < >`；其他字符（含 `\u00a0`、emoji）原样输出。

**行内内容**：marks 按 `MARK_ORDER`（`link strong em s mark sub sup kbd code`）从外到内嵌套；相邻节点共享的**最长外层 mark 前缀**保持同一个元素打开（与 ProseMirror DOMSerializer 相同）。`link` → `<a href="…"[ title="…"]>`；`br` → `<br>`；`atom` → `<span data-eh-inline="{kind}"[ data-eh-{k}="…"]>{text}</span>`。

**文本块**（每块一行，代码块内容中的换行原样保留）：

| 类型 | 规范输出 |
| --- | --- |
| p / h1–h6 / quote | `<p data-eh="id">…</p>`；quote → `<blockquote data-eh="id">…</blockquote>` |
| hr | `<hr data-eh="id">` |
| code | `<pre data-eh="id" data-lang="ts"><code>…</code></pre>`（无 lang 时省略 `data-lang`） |
| figure | `<figure data-eh="id"><img alt="…" src="…"><figcaption>…</figcaption></figure>`（图注为空时省略 figcaption） |
| table | 见下 |
| li | 见下 |

表格（无表头时省略 thead 行；对齐用 `data-eh-align`）：

```html
<table data-eh="id">
  <thead><tr><th>A</th><th data-eh-align="center">B</th></tr></thead>
  <tbody>
    <tr><td>1</td><td data-eh-align="center">2</td></tr>
  </tbody>
</table>
```

列表：连续的 `li` 块归组；同一层级 `list` 类型变化时关闭当前列表、开启新列表。子列表紧跟父项内容开始（`…内容<ul>`），以 `</ul></li>` 收尾，**内容与 `<ul>` 之间不留空白**；标签之间的换行与缩进是格式空白，解析时忽略。

```html
<ul>
  <li data-eh="a">父项<ul>
    <li data-eh="b" data-eh-task="done">子项</li>
  </ul></li>
  <li data-eh="c">下一项</li>
</ul>
```

模型不变量：同一列表组内第一个 `li` 的 `indent` 为 `0`，且每项 `indent ≤ 前一项 indent + 1`。

**组件块**：

```html
<eh-chart data-eh="id">
  <script type="application/json">{"type":"bar"}</script>
  <!--eh:fallback-->{fallback 原样}<!--eh:fallback-->
</eh-chart>
```

容器块的每个槽位：`<eh-slot data-eh-slot="i">` 独占一行，子块缩进 +2，`</eh-slot>` 独占一行；空槽位写成单行 `<eh-slot data-eh-slot="i"></eh-slot>`。槽位在 JSON 行之后、fallback 行之前。无 fallback 时省略该行。

**HTML 块**（§3.5）：`<eh-html data-eh="id">{html 原样}</eh-html>`，单行包裹，使块 ID 在往返中保持稳定。解析器遇到未包裹的规范外内容时生成 HTML 块（首次保存后即被包裹）；旧名 `<eh-foreign>` 仍按 §10 读取，保存时升级为 `eh-html`。

**解析器的宽容规则**（非规范输入 → 规范模型）：
- 标签名大小写不敏感；属性顺序、缩进、引号风格任意；
- `b`→`strong`、`i`→`em`、`del`/`strike`→`s`；其他白名单外的行内元素去壳保留文本；文本块内的 `script`/`style` 丢弃；
- `on*` 属性一律剔除；`javascript:`（忽略大小写与空白）链接去掉链接标记、保留文本；
- 缺失或重复的块 ID 在扫描结束后按文档顺序用 `createIdGenerator` 重新分配（首次出现者保留原 ID）；
- 没有 `main#eh-doc` 时解析 `body` 的子元素；
- 实体：支持数字实体与常用命名实体，未知命名实体按字面保留；
- **原样保留的切片必须自包含**（HTML 块的 html、降级内容、`head.extra`）：文件在原始文本（`script`/`style`…）或注释中途结束时先补上终止符再解析；HTML 块中被识别为标签的 `<eh-html>`/`</eh-html>`（及旧名 `eh-foreign`）改写为 `&lt;…`、末尾未写完的标签截掉；不自包含的降级内容直接丢弃（它只是可重建的缓存）。告警码 `unsafe-slice`。这保证了 `serialize ∘ parse` 对任意输入幂等；
- 等于默认值的 head 字段不写入模型：`lang === 'zh-CN'` 时省略 `head.lang`，`<title>` 等于 `meta.title` 时省略 `head.title`。

保证：对任意有效 `Doc`，`docEquals(parse(serialize(doc)), doc)`；对任意输入，`serialize(parse(serialize(parse(x)))) === serialize(parse(x))`。

## 7. EHMD 文本源码视图

用于源码模式和 `.md` 互通。在 CommonMark + GFM 基础上加**指令块**：

````markdown
---
title: 笔记标题
tags: [学习, 算法]
---

# 笔记标题

一段正文。^b2

:::chart {#b3}
type: bar
data:
  x: [A, B]
  y: [3, 5]
:::

::::tabs {#t1}
:::tab 概念
…
:::
:::tab 例子
…
:::
::::
````

- 块 ID 以 `{#id}` 或行尾 `^id`（兼容 Obsidian 块引用）表示；
- 组件数据在指令块内用 YAML 书写；
- 导出纯 `.md` 时，组件块降级为：mermaid/math → 对应代码块；chart → 图片 + 数据代码块；其他 → 引用块 + 原始 YAML。

### 7.1 实现约定（T1.6，暂定）

以下是 `packages/core/src/ehmd/`（`parseEhmd` / `serializeEhmd`）在 §7 未定义处采用的具体规则。05 #6、#7、#18 仍为待决问题，这里只是可工作的默认值，待负责人确认后再改为正式规范。

**总体**

- 基于 CommonMark + GFM（表格、删除线、任务列表、自动链接字面量、脚注语法）+ `$`/`$$` 公式；读取时去掉 BOM、`\r\n`/`\r` 统一为 `\n`。
- EHMD **不承载** `head`（lang、`<title>`、主题/用户样式、运行时、其他 head 内容）与组件降级内容（fallback）；`parseEhmd` 的 `opts.head` 可以把原文档的 head 带回来。往返比较忽略这两部分。
- 解析从不抛错；所有降级都有告警（`EhmdWarning`）。输出是确定的，`serializeEhmd ∘ parseEhmd` 幂等；`ids: 'all'` 时 `parseEhmd(serializeEhmd(doc))` 与 `doc` 相等（例外见文末"已知有损"）。

**frontmatter ↔ `meta`**

- 文件第一行是 `---` 时，到下一行 `---`（或 `...`）为止是 YAML frontmatter，按 YAML 1.2 Core schema 解析（`2026-11-22` 是字符串，不是日期）。必须是映射；否则整段保留为 `yaml` 代码块并告警 `invalid-frontmatter`。
- 输出时键顺序同 `#eh-meta`（`title, created, tags, theme`，其余按字典序）；`meta` 为空时不写 frontmatter。没有 frontmatter 而第一个块是分割线时，该分割线写成 `***`（避免被读成 frontmatter）。
- YAML 输出：块映射；全为标量的数组写成流式 `[a, b]`；多行字符串写成 `|-` / `|` / `|+` 块标量；字符串能作 plain 标量时不加引号，否则用 JSON 风格双引号；每次输出都用解析器校验，校验失败时整体退回 JSON（JSON 是 YAML 的子集）。

**块 ID**（05 #6 的默认值）

- 段落、列表项、figure：行尾 ` ^id`（`^` 前必须是空白或行首）；标题：行尾 ` {#id}`（也接受 ` ^id`）；围栏代码块：信息串末尾的属性块 `{#id}`；组件/HTML 指令：`{#id}`。段落中的 `{#id}` 不是 ID（只认行尾最后一个 `^id`）。
- 表格、引用、分割线、原样输出的 HTML 块：紧跟其后、单独成段的 `^id`。读取时，单独成段的 `^id` 附着到前一个"不能内联 ID"的块（以上几类，以及没有 `{#id}` 的代码块、`$$` 公式）；否则它表示一个**带该 ID 的空段落**。空段落总是写成单独的 `^id`。
- ID 语法上接受 `[A-Za-z0-9_-]+`（兼容 Obsidian），但只有符合 `BLOCK_ID_RE` 的才保留；不合法（`invalid-id`）或重复（第二次起，`duplicate-id`）的按文档顺序用 `createIdGenerator` 重新分配，没写 ID 的块也按此分配。
- `serializeEhmd` 的 `ids`：`'referenced'`（默认）只写被文档内链接引用的块（链接 `#id`、双链 `[[#^id…]]`）、`keepIds` 中的块，以及结构上必须写的 ID（空段落，及其前面那个只能把 ID 写在其后的块）；`'all'` 写全部；`'none'` 不写（空段落随之省略）。

**文本块**

- 段落：一个 Markdown 段落；软换行对应文本中的 `\n`。以图片开头的段落是 figure；段落中间的图片会把段落拆开（`split-paragraph`）。
- 标题：ATX `#`…`######`（读取也接受 Setext）。标题只能是一行，其中的 `br` 写成 `<br>`。
- 列表：连续的扁平 `li` 块 ↔ 嵌套的 Markdown 列表。无序项写 `-`，有序项按组内序号写 `1.` `2.`…；子列表缩进 = 父项标记宽度（`- ` 为 2，`1. ` 为 3）；任务项 `- [ ]` / `- [x]`。空的任务项写成 `- [ ] <!---->`（`- [ ]` 单独一行不是任务项）。读取时列表项第一段之后的段落用 `br` 并入该项、其他块移到列表之外（`flattened-list-item`）。
- 引用：`> ` + 单段行内内容，硬换行续行以 `> ` 开头。多段或嵌套的引用读成多个 `quote` 块，引用中的其他块原样放在相应位置（`flattened-quote`）。
- 代码：围栏代码块。非空内容 = 围栏之间的各行，**每行都以 `\n` 结尾**（与 CommonMark 的 HTML 输出一致）；空内容 = 围栏之间没有行。信息串 = 语言 + 可选属性块；语言含空白以外的特殊字符（`` ` `` `~` `{}` `\` `&`、连续空白）时写进属性块 `{lang="…"}`。围栏比内容中行首最长的同字符序列多一个（至少 3 个）；信息串含反引号时用 `~~~`。缩进代码块读成无语言的代码块。
- 分割线：`---`。
- 表格：GFM 表格；对齐写在分隔行（`:---` `:---:` `---:` `---`）；单元格中的 `|` 写成 `\|`，`br` 写成 `<br>`。**表头行所有单元格都为空 ↔ 无表头**（`head = []`）。列数以分隔行为准，多余单元格丢弃、缺少的补空。
- figure：`![alt](src "图注")`——图注是无标记的纯文本时写成标题；否则写在图片之后：`![alt](src) *图注*`。读取时图片后有内容则以其为图注，否则用标题。`src` 原样保存（不做 URL 编码）；`alt` 总是写入（缺省读回为空串）。

**行内内容**

- 标记优先用 Markdown：`**strong**`、`*em*`、`~~s~~`、`==mark==`、`` `code` ``、`[text](href "title")`、`<https://…>`（文本与目标相同的绝对 URL）；定界符可能失效时（内侧首/尾字符是空白或标点，或外侧紧邻同一定界符字符）改用等价的行内 HTML `<strong>` `<em>` `<s>` `<mark>` `<code>` `<a href title>`。`sub` / `sup` / `kbd` 总是行内 HTML。读取时行内 HTML 按标签配对：`b`→strong、`i`→em、`del`/`strike`→s 等，`br` 为换行；白名单外的标签去壳保留内容（`unwrapped-element`），注释丢弃。
- 硬换行写成行尾 `\`；位于末尾的 `br` 或单行语境（标题、表格单元格）中写成 `<br>`。
- 转义（保守，宁多勿少）：`\ ` `` ` `` `* [ ] < $ ~` 总是转义；`_ = # ^ { ! & : . @` 按上下文转义（如 `#` 后接标签字符、`^` 在空白后、`{#`、形如实体的 `&`、`http:/`、`www.`、邮箱中的 `@`，以防误识别为标签/ID/自动链接）；表格中的 `|`。行首（含软换行、硬换行之后）的 ASCII 标点与 `1.` 转义；行首、行尾的空白，以及不能写成软换行的 `\n`（两侧有空白、在开头/结尾、单行语境）写成数字字符引用（`&#x20;`、`&#xA;`）。
- 原子：`math` → `$tex$`（tex 非空、不含 `$` 与换行；两端都是空格时各补一个空格；相邻两个公式时后者用 span）；`wikilink` → 原子文本本身（含方括号，如 `[[a|b]]`；表格中 `|` 写成 `\|`，读取时还原）；`tag` → `#标签`（`#` 后是一个或多个字母/数字/`_`/`-`/`/`，至少一个非数字；`#` 前不能是标签字符或 `#`）。不满足这些条件、带 `attrs` 或其他 `kind` 的原子写成 `<span data-eh-inline="kind" data-eh-k="v">文本</span>`。单个 `$` 也会开始公式（05 #7 未决），因此文本中的 `$` 一律转义。
- 脚注语法读成字面文本（`[^1]`）；引用式链接/图片按定义解析，定义本身不保留。

**指令块（组件）**

- 开始行：顶格 `:::`（三个或更多冒号）+ 可选空白 + 组件类型 + 可选标签 + 可选属性块；结束行：冒号数**恰好相同**、其后只有空白的行；没有结束行时延伸到文末（`unclosed-directive`）。外层冒号数 = 1 + 体内最长的顶格冒号串（至少 3），所以嵌套时外层冒号逐级增加。只在围栏代码块之外识别开始行。`::name …`（恰好两个冒号）是体为空的单行指令。
- 标签：类型名之后到属性块之前的文本（`:::callout 标题 {…}`），也接受 `:::callout[标题]{…}`。属性块：`{#id key=val key="含空格的值" .class flag}`，引号内用 `\"` `\\` `\n` 转义。
- 叶子组件（没有专门规格的类型）：`:::type {#id 其余块属性}` + YAML 体 = `props`；`props` 为 `{}` ↔ 体为空。YAML 不合法时整个指令原文保留为 `ehmd` 代码块（`invalid-yaml`）。叶子组件的标签被忽略（告警）。
- 内置容器规格：
  - `callout`：`:::callout 标题 {#id kind=info}`，体是槽位 0 的内容；`props = {kind?, title}`，无标签时 `title` 为 `''`；
  - `toggle`：`:::toggle 标题 {#id open=true|false}`；
  - `tabs`：`::::tabs {#id}` + 每个槽位一个 `:::tab 标题`；`props = {tabs:[{title}]}`；
  - `columns`：`::::columns {#id ratio="1,2"}` + 每个槽位一个 `:::column`；`props = {ratio:[…]}`。
  
  标签不能安全书写（首尾空白、含 `{}`、换行、以 `[` 开头）时改用 `title="…"` 属性；同时有标签和 `title` 属性时属性优先（告警）。规格中未用到的属性 → 组件块 `attrs`。
- 通用形式：props/attrs 不符合规格（或类型没有规格却有槽位）时写成 `::::type {#id 块属性}` + `:::props`（YAML）+ 每个槽位一个 `:::slot`。`html`、`props`、`slot` 是保留的指令名。容器中不在槽位子指令里的内容并入相邻槽位（`stray-slot-content`）。

**HTML 块**

- `HtmlBlock` 能被读回为恰好一个、且在其后空行处结束的原始 HTML 块时原样写出（需要 ID 时其后单独一段 `^id`）；否则写成 `:::html {#id}` + 原文（不经 Markdown 解析）。
- Markdown 中的原始 HTML 块交给 `.ehtml` 解析器：能识别的成为原生块（`data-eh` 写明的 ID 保留，`on*` 被剔除），其余为 HTML 块；会丢内容（产生 head/meta）的整段保留为 HTML 块。
- `$$…$$` 读成 `math` 组件（写出时用 `:::math`）；```` ```mermaid ```` 等仍是代码块（Obsidian 方言留给 T1.7）。

**已知有损**（往返测试中显式约束/记录）

- 非空代码块内容不以 `\n` 结尾时，读回会补上 `\n`；表头全空的表格读回为无表头；figure 缺 `alt` 读回为 `alt=""`；
- `ol` 的起始编号、列表松紧、项目符号种类、Setext/ATX、缩进/围栏代码、`***`/`___` 等写法差异不保留；多段引用、列表项中的块级内容被拆平；
- 行内 HTML 注释被丢弃，白名单外的行内标签去壳，行内内容中的图片只保留 alt 文本；未使用的链接定义被丢弃；
- `ids: 'referenced' | 'none'` 时未写出的 ID 在读回时重新分配；`'none'` 时空段落被省略；
- 原样写出的 HTML 块若含有顶格的围栏/指令行，可能干扰预扫描（写出端会改用 `:::html` 规避，手写的 Markdown 中仍可能出现）；
- `head` 与降级内容不在 EHMD 中。

## 8. 运行时加载器

文件中嵌入的 `eh-runtime.js` 职责：

1. 阅读模式：给组件块挂载交互（图表 hover、标签页切换），未加载完成时显示降级内容；
2. 显示一个不显眼的"编辑"按钮（或快捷键 `E`），点击后按需加载完整编辑器包；
3. 保存：优先 File System Access API 写回原文件；不可用时下载新文件；在 Web 应用/插件内由宿主接管。

**离线要求**：运行时加载失败时，页面仍然完整可读（只是不可交互、不可编辑）。【待定】是否默认内联运行时以支持完全离线编辑。

## 9. 安全模型

- `eh-script` 组件与 `embed` 在 `<iframe sandbox="allow-scripts">` 中运行，通过 `postMessage` 与宿主通信，无法访问宿主 DOM、Cookie、文件系统；
- 文本块中的 HTML 在解析时按白名单清洗，`on*` 事件属性、`javascript:` 链接一律剔除；
- 打开来源不明的文件时，脚本组件默认不执行，需用户点击"信任此文件"。

## 10. 版本与兼容

- `html[data-eh-version]` 标明规范版本；
- 解析器必须能读取所有旧版本，并在保存时升级到当前版本；
- 规范外的内容（未知元素、外部脚本）：在 `.ehtml` 中包为 `eh-html` 块（§3.5），保留原样且可编辑；
- 完全不符合本规范的普通 `.html` 文件：以**保真模式**打开（[06-import.md §2](06-import.md)），不强制转换。
