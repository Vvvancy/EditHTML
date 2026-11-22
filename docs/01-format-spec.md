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

**外来块**（实现中的名称，待迁移为 §3.5 的 `eh-html` 块，见 05 #21）：包一层 `<eh-foreign data-eh="id">{html 原样}</eh-foreign>`，使外来块的 ID 在往返中保持稳定。解析器遇到未包裹的规范外内容时生成外来块（首次保存后即被包裹）。

**解析器的宽容规则**（非规范输入 → 规范模型）：
- 标签名大小写不敏感；属性顺序、缩进、引号风格任意；
- `b`→`strong`、`i`→`em`、`del`/`strike`→`s`；其他白名单外的行内元素去壳保留文本；文本块内的 `script`/`style` 丢弃；
- `on*` 属性一律剔除；`javascript:`（忽略大小写与空白）链接去掉链接标记、保留文本；
- 缺失或重复的块 ID 在扫描结束后按文档顺序用 `createIdGenerator` 重新分配（首次出现者保留原 ID）；
- 没有 `main#eh-doc` 时解析 `body` 的子元素；
- 实体：支持数字实体与常用命名实体，未知命名实体按字面保留；
- **原样保留的切片必须自包含**（外来块 html、降级内容、`head.extra`）：文件在原始文本（`script`/`style`…）或注释中途结束时先补上终止符再解析；外来块中被识别为标签的 `<eh-foreign>`/`</eh-foreign>` 改写为 `&lt;…`、末尾未写完的标签截掉；不自包含的降级内容直接丢弃（它只是可重建的缓存）。告警码 `unsafe-slice`。这保证了 `serialize ∘ parse` 对任意输入幂等；
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
