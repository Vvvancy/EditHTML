# tests/fixtures

解析/序列化往返测试样本（任务 T0.3）。纯数据文件，不含代码。规范依据：[`docs/01-format-spec.md`](../../docs/01-format-spec.md)，尤其是 §6.1 规范形式细则（下文 "§n" 均指该文档章节）。

> 路线图（04）中 T0.3 现要求 `ehtml/ md/ html/ obsidian/` 四类样本：`html/`（任意真实风格 HTML，供保真模式与 HTML 转换）与 `obsidian/`（Obsidian 方言）尚待补充。

- `ehtml/NN-name.ehtml`：完整的 `.ehtml` 文档。运行时统一写作占位路径 `./.ehtml/runtime.js`，不引用外部脚本（16、27 号样本中的 `*.example.invalid` 是被测的外来内容）。
- `md/NN-name.md`：EHMD / 纯 Markdown 源（§7）。
- **同名配对**：`md/NN-x.md` 与 `ehtml/NN-x.ehtml` 基名相同时互为等价物，供 T1.6 做转换测试。比较时应**忽略降级内容**（EHMD 中没有 fallback，由渲染器重新生成），以及 `<head>` 中的 `eh-theme`、`eh-user-style`、`eh-runtime`。无法用 Markdown 表达的块在 `.md` 中省略或近似表示，已在备注中列出。
- `.gitattributes` 设置了 `* -text`，保证 CRLF/BOM 样本按字节保存。

## 两类样本

| 类别 | 含义 | 测试方式 |
| --- | --- | --- |
| **canonical** | 已经是 §6.1 规范形式 | `serialize(parse(x)) === x`，逐字节相等 |
| **non-canonical input** | 故意写得不规范，或含需要清洗的内容 | 断言能解析、清洗结果符合"预期"，并且 `serialize(parse(serialize(parse(x)))) === serialize(parse(x))`；**不**与输入逐字节比较 |

"预期"列描述 §6.1 宽容规则或 §9/§10 规定的行为；**TBD** 表示规范仍未定义（见文末"规范歧义"）。

## `.ehtml` 样本

| 文件 | 类别 | 覆盖内容 | 规范 | 预期 / 备注 |
| --- | --- | --- | --- | --- |
| `ehtml/01-empty.ehtml` | canonical | 空文档：`main#eh-doc` 内没有任何块 | §2, §6.1 | `root = []`。TBD：空 main 的确切写法（本样本为 `<main id="eh-doc">` 后紧跟 `</main>`） |
| `ehtml/02-minimal.ehtml` | canonical | 只有一个 `<p>` 的最小文档 | §2, §6.1 | 配对 md |
| `ehtml/03-headings-paragraphs.ehtml` | canonical | `h1`–`h6`、`p`、`#eh-theme`、`#eh-user-style`（按 `[data-eh]` 定制单块样式） | §3.2, §5 | 配对 md |
| `ehtml/04-lists.ehtml` | canonical | 每个 `li` 都是块（`data-eh` 在 `li` 上）；ul→ol 类型变化时新开列表；任务项 `data-eh-task=done\|todo`；三层嵌套（ul→ul→ol），子列表紧跟父项内容（`内容<ul>`…`</ul></li>`） | §3.2, §6.1 | 配对 md。两个同类型列表之间用段落隔开，否则会被归为一组 |
| `ehtml/05-quote-code-hr.ehtml` | canonical | `blockquote`（只含行内内容，用 `<br>` 换行）、`pre[data-lang]>code`（转义后的 `<`、无语言、制表符缩进）、`hr` | §3.2, §6.1 | 配对 md。多段引用和嵌套引用放在 20 号 |
| `ehtml/06-table.ehtml` | canonical | `table`：单行 `<thead><tr>…</tr></thead>`，用 `th`/`td` 上的 `data-eh-align` 表示对齐，单元格含行内标记、空单元格、含 `\|` 的单元格；无表头的表格 | §3.2, §6.1 | 配对 md；`t2`（无表头）在 GFM 中无法表达，md 中省略 |
| `ehtml/07-figure.ehtml` | canonical | `figure>img+figcaption`、无 caption、data URI 图片、URL 编码的中文路径 | §3.2, §4 | 配对 md；`f3`（figcaption 中有 `<em>`）在 md 中省略 |
| `ehtml/08-inline-marks.ehtml` | canonical | 全部行内白名单：`strong em code a s mark sub sup kbd br`；`span[data-eh-inline]` 的 math、wikilink（含别名）、tag；按 MARK_ORDER 嵌套（`a` 在 `strong` 外、`s` 在 `mark` 外）；共享外层前缀（`<strong>a<em>b</em></strong><em>c</em>`） | §3.2, §6.1 | 配对 md |
| `ehtml/09-chart.ehtml` | canonical | `eh-chart`：bar、line、pie、scatter；降级内容分别是内联 SVG、data URI `img`、静态表格；`ch4` 没有降级内容 | §3.3, §6.1 | 配对 md。`ch4` 往返时继续省略 fallback 行 |
| `ehtml/10-mermaid-math.ehtml` | canonical | `eh-mermaid`（flowchart、sequence，JSON 中有 `-->`）、`eh-math`（TeX 含 `\\`、`&`、`<`）；降级内容为多行 `pre`、MathML、SVG | §3.3 | 配对 md |
| `ehtml/11-callout-toggle.ehtml` | canonical | `eh-callout` info/warn/tip（含空 title；槽位内有列表）、`eh-toggle` open=false/true、空槽位单行写法 | §3.3, §3.4, §6.1 | 配对 md |
| `ehtml/12-tabs-columns.ehtml` | canonical | `eh-tabs`（2 个和 3 个标签，含空标签页）、`eh-columns`（ratio [1,2] 和 [1,1,1]） | §3.3, §3.4 | 配对 md |
| `ehtml/13-embed-script.ehtml` | canonical | `eh-embed`（URL 含 `&`）、`eh-script`（html/css/js；JSON 中 `</` 全部转义为 `<\/`） | §3.3, §6.1, §9 | 配对 md。md 的 YAML 中是原始 `</…>`，转换后必须输出 `<\/` |
| `ehtml/14-nesting.ehtml` | canonical | 容器嵌套：深度 2（callout→tabs）、深度 4（callout→tabs→columns→toggle，最内层是 math）、深度 5（toggle×4→callout） | §3.4 | 配对 md。TBD：深度 5 超过建议上限（open question #5） |
| `ehtml/15-unknown-component.ehtml` | canonical（`u3` 除外：TBD） | 未知组件 `eh-foo`（带 `data-eh-variant`）、带槽位的未知容器 `eh-kanban`、没有 JSON 的 `eh-bar` | §3.3, §10 | 原样保留，只读显示降级内容。TBD：没有 JSON 的组件（`u3`）是 ComponentBlock 还是外来块 |
| `ehtml/16-foreign-content.ehtml` | **non-canonical input** | 未包裹的外来内容：任意 `div`、外部 `<script src>`、内联非 JSON 脚本、`iframe`、`details`、`form`、`video`、body 中的 `style`、带 `data-eh` 的 `section`、`dl`、带 caption/tfoot 的 table、段落中的非白名单行内元素（`u img small abbr`）、`main` 下的裸文本、HTML 注释、`main` 之外的 `footer`、head 中额外的 `link`/`meta` | §6.1, §10 | 每个外来元素都变成 ForeignBlock，保存后包成 `<eh-foreign data-eh>`（规范形态见 27）。`f3`：白名单外的行内元素去掉标签、保留文本（`img` 会因此丢失）。额外的 head 元素进入 `head.extra`。TBD：裸文本、注释、`main` 之外的内容、带 caption/tfoot 的 table |
| `ehtml/17-security-strip.ehtml` | **non-canonical input** | `onclick`/`onmouseover`/大写 `ONFOCUS`/`onerror`/`onload`；`javascript:`（大小写混合、前导空格、实体编码的 tab、数字实体）、`vbscript:`、`data:text/html` 链接；组件元素和 `eh-slot` 上的 `on*`；不受信任的 `eh-script` | §6.1, §9 | 所有 `on*` 属性都剔除；`javascript:` 链接去掉链接标记、保留文本；脚本组件默认不执行。TBD：`vbscript:`、`data:` 链接 |
| `ehtml/18-entities-escaping.ehtml` | **non-canonical input** | `&amp; &lt; &gt; &quot;`、`&nbsp;` 与字面 U+00A0、十进制/十六进制数字实体（含辅助平面字符）、命名实体、属性中的 `"` 和 `'`；代码块中的 `<`、`&`；`#eh-meta` 和组件 JSON 中的 `<\/script>`；JSON 中未转义的 `<!--` | §6.1 | 文本中的 `&quot;` 输出为 `"`，`&nbsp;` 输出为字面 U+00A0，命名/数字实体解码后输出字面字符；JSON 中的 `<!--` 输出为 `<!--` |
| `ehtml/19-unicode-whitespace.ehtml` | canonical | 简体/繁体中文、日文、韩文；emoji（ZWJ 序列、肤色修饰、国旗）、辅助平面字符、组合字符（NFD）、零宽字符；阿拉伯语/希伯来语 RTL、双向混排；空段落、只含空格或制表符的段落、只含 U+00A0 的段落、只含 `<br>` 的段落、首尾空格、连续空格、空标题；约 4600 字符的超长单行；全角空格 | §3.2, §6.1 | 文本不重排，也不做 Unicode 规范化（NFD 保持 NFD）。TBD：空段落和只含空白的段落是否保留、首尾空白是否修剪 |
| `ehtml/20-noncanonical-format.ehtml` | **non-canonical input** | 大写 `<!DOCTYPE HTML>`、大写标签和属性名；乱序属性；8 空格与 tab 缩进；无引号、单引号属性值，`=` 两侧有空格；省略 `</p>` `</li>`；自闭合 `<hr/>` `<br/>`；`b i strike del`；未转义的 `&` `<` `>`；pre 开头的换行；多行且键乱序的组件 JSON（含 meta）；没有 `<!--eh:fallback-->` 标记的降级内容；大写组件标签；一行多个块；`ol[start][reversed]`；多段引用和嵌套引用；相邻的同类标记；顺序不对的 `<mark><s>`；旧写法 `<ul data-eh>`；文本块中的 `script`/`style`；未知命名实体 `&foobar;`；非法任务状态值 `DONE` | §6.1 | 按 §6.1 宽容规则处理：`b→strong`、`i→em`、`del/strike→s`，相邻标记合并，文本块中的 script/style 丢弃，未知实体按字面保留。TBD：`ol[start]`、多段/嵌套引用（模型中的 quote 只有行内内容）、没有标记的 fallback、`DONE` |
| `ehtml/21-noncanonical-ids.ehtml` | **non-canonical input** | 缺少 `data-eh`；重复 ID（顶层之间、顶层与子块之间、文本块与组件之间、`li` 与顶层之间）；空 ID、无值属性、非 base36 字符、带空白的 ID、中文 ID；没有 ID 的组件；槽位乱序、超出范围、缺 `data-eh-slot`、容器中不在槽位里的子块；同一元素上重复的属性 | §3.1, §3.4, §6.1 | 缺失或重复的 ID 按文档顺序重新分配，首次出现者保留原 ID。TBD：非 base36 ID 是否合法；乱序、越界、缺失槽位的处理 |
| `ehtml/22-kitchen-sink.ehtml` | canonical | 大型综合笔记：几乎所有块类型和组件、多层嵌套、所有行内扩展、一个 `eh-foreign` | 全部 | 配对 md（md 中的外来块是没有 ID 的原始 HTML，TBD）；也可以用作渲染和性能的冒烟样本 |
| `ehtml/23-canonical-form.ehtml` | canonical | §6.1 各条规则的集中样本：骨架缩进、属性顺序与转义、只做最小转义、字面 U+00A0、MARK_ORDER 与共享前缀、嵌套列表、带对齐的表格、`eh-foreign`、槽位、JSON 中的 `<\/` | §6.1 | 序列化器的首要回归样本 |
| `ehtml/24-bom-crlf.ehtml` | **non-canonical input** | UTF-8 BOM 加 CRLF 换行（代码块内也是 CRLF） | §6.1 | 输出 `\n` 换行。TBD：是否去掉 BOM；代码块内的 CRLF 是否也转成 LF |
| `ehtml/25-legacy-no-meta.ehtml` | **non-canonical input** | `data-eh-version="0.0"`，没有 `#eh-meta`，没有运行时脚本 | §2, §10 | 可以解析；保存时升级到 0.1。TBD：meta 是 `{}` 还是从 `<title>` 推出 |
| `ehtml/26-plain-html.ehtml` | **non-canonical input** | 普通 HTML 页面：没有 `data-eh-version`、没有 `main#eh-doc`、没有块 ID | §6.1, §10 | 按 §6.1 规则解析 `body` 的子元素并分配 ID；`div.sidebar` 变成外来块 |
| `ehtml/27-foreign-wrapped.ehtml` | canonical | 16 号首次保存后的形态：`<eh-foreign data-eh>` 包住 div、外部 script、iframe、details、多行 `dl`，容器槽位中也有一个外来块 | §6.1, §10 | 外来块 HTML 原样保存（包括内部的换行） |

## `.md` 样本

EHMD 还没有规范形式，所以 `.md` 样本不做"规范 / 非规范"区分。

| 文件 | 覆盖内容 | 规范 | 预期 / 备注 |
| --- | --- | --- | --- |
| `md/02-minimal.md` | frontmatter 加一段带 `^b1` 的段落 | §7 | 配对 ehtml |
| `md/03-headings-paragraphs.md` | ATX 标题用 `{#id}`，段落用 `^id` | §7 | 配对 ehtml |
| `md/04-lists.md` | `-`、`1.`、`- [ ]`、`- [x]`，嵌套列表（混合有序和任务项）；每个列表项行尾写 `^id` | §7 | 配对 ehtml |
| `md/05-quote-code-hr.md` | 用反斜杠硬换行的引用、信息串带 `{#id}` 的围栏代码块、`---` | §7 | 配对 ehtml |
| `md/06-table.md` | GFM 表格对齐（`:---:` `---:` `:---`）、`\|` 转义 | §7 | 配对 ehtml（缺 `t2`） |
| `md/07-figure.md` | `![alt](src "title")`，title 对应 figcaption；用 `<…>` 包住含空格的路径 | §7 | 配对 ehtml（缺 `f3`）。TBD：figure/figcaption 的 Markdown 映射 |
| `md/08-inline-marks.md` | `**` `*` `` ` `` `~~` `==`；原始 HTML `<sub>` `<sup>` `<kbd>`；反斜杠硬换行；`$…$`、`[[…]]`、`[[a\|b]]`、`#tag` | §3.2, §7 | 配对 ehtml |
| `md/09-chart.md` | `:::chart {#id}` 加 YAML（flow/block 序列、嵌套映射、空映射） | §7 | 配对 ehtml |
| `md/10-mermaid-math.md` | `:::mermaid`（`source: \|-` 块标量）、`:::math`（单引号 TeX） | §7 | 配对 ehtml |
| `md/11-callout-toggle.md` | 容器指令 `:::callout 标题 {#id kind=…}`、`:::toggle 标题 {#id open=…}`，容器中有列表和代码块 | §7 | 配对 ehtml。容器语法是本样本自定的约定（见下） |
| `md/12-tabs-columns.md` | `::::tabs` 加 `:::tab 标题`（规范原例）、`::::columns {ratio="1,2"}` 加 `:::column`、空标签页 | §7 | 配对 ehtml |
| `md/13-embed-script.md` | `:::embed`、`:::script`（YAML 中有原始 `</script>`） | §7 | 配对 ehtml |
| `md/14-nesting.md` | 深度 2、4、5 的嵌套指令，外层冒号数逐级增加（最多 9 个） | §3.4, §7 | 配对 ehtml |
| `md/22-kitchen-sink.md` | 大型综合 EHMD 笔记 | 全部 | 配对 ehtml |
| `md/30-plain-commonmark.md` | 纯 CommonMark，没有 frontmatter 和 ID：Setext 标题、软换行与硬换行、`*` `+` `1)` 列表、松散列表、4 空格嵌套、引用中的列表和代码、缩进代码块、`~~~` 围栏、嵌套围栏、`***` `___`、引用式链接和图片、自动链接、行内 HTML、反斜杠转义 | §7 | 为每个块分配新 ID；用于 T1.6"纯 md 往返无损" |
| `md/31-gfm-features.md` | GFM：表格列对齐、缺单元格的行、单元格中的 `\|`、任务列表（`[X]`、与普通项混合、嵌套、有序）、删除线、扩展自动链接、脚注 | §7 | TBD：脚注在 `.ehtml` 中没有对应 |
| `md/32-obsidian-style.md` | Obsidian：复杂 frontmatter（aliases、cssclasses、ISO 时间）、`[[note#^id]]`、`![[embed]]`、`#nested/tag`、作为价格的 `$` 与公式、`$$` 块公式、`> [!note]` 原生 callout、```` ```mermaid ```` 围栏、`%%注释%%` | §7 | TBD：`![[…]]`、`> [!note]`、```` ```mermaid ````、`$$` 是否映射成组件；`$5` 如何转义（open question #7） |
| `md/33-empty.md` | 0 字节文件 | §7 | 空文档 |
| `md/34-frontmatter-only.md` | 只有 frontmatter，值中有引号、冒号、嵌套映射和未知字段 | §7 | `root` 为空。未知字段按 §6.1 的 meta 规则（其余键按字典序）写进 `#eh-meta` |
| `md/35-ehmd-edge-cases.md` | 重复 `^id`；`{#id}` 与 `^id` 同时出现；行中间的 `^`；未知指令；非法 YAML；空指令；YAML 中的 `</script>` 和 `<!--`；`::: callout`（冒号后有空格）；label 与 title 属性冲突；围栏中的指令语法；未闭合的指令 | §7 | 重复 ID 重新分配；围栏中的内容保持原样；非法 YAML 不能让解析器崩溃。TBD：其余见文件中的说明 |
| `md/36-entities-unicode.md` | Markdown 中的 HTML 实体、字面特殊字符、代码中的实体、多语言/emoji/RTL、全角符号、带 `onclick` 的原始 HTML 块、`javascript:` 链接 | §6.1, §9 | `on*` 被剔除；`javascript:` 链接去掉链接、保留文本 |

## 本样本采用的 EHMD 约定（§7 尚未完全定义）

- 块 ID：标题、指令块、围栏代码块用 `{#id}`；段落和列表项用行尾的 ` ^id`；表格、引用、分割线用紧跟其后、单独一行的 `^id`。
- 叶子组件（chart、mermaid、math、embed、script）写成 `:::type {#id}`，正文是 YAML，以 `:::` 结束。
- 容器组件：类型名后面写标签（标题），其余 props 写在 `{}` 中，如 `:::callout 标题 {#id kind=info}`、`:::toggle 标题 {#id open=false}`、`::::columns {#id ratio="1,2"}` 加 `:::column`、`::::tabs {#id}` 加 `:::tab 标题`（规范原例）。
- 外层指令的冒号必须比内层多。

## 规范歧义（§6.1 更新后仍未解决）

1. 空的 `main#eh-doc` 怎么写（空行？`</main>` 的缩进？）。
2. `ol[start]`、`ol[reversed]` 以及列表项中的块级内容（列表项里的段落、代码块）：模型中的 `li` 只有行内内容加 `indent`，这些信息会丢失。
3. quote 只有行内内容，多段引用和嵌套引用（Markdown 中很常见）无法往返。
4. 白名单外的行内元素"去壳保留文本"之后，段落中的 `<img>` 会直接消失，是否应该改成外来块。
5. `span[data-eh-inline]` 中 math、wikilink、tag 的载荷（文本 vs `data-eh-{k}`）和"颜色高亮"的写法没有具体规定；`a` 之外的行内元素允许哪些属性也没有列出。
6. 任务项是否需要静态复选框，让没有运行时的阅读者也能看到（`input` 不在白名单中）；`data-eh-task` 取非法值时如何处理。
7. 除 `javascript:` 外，`vbscript:` 和 `data:` 链接是否也要剔除。
8. 是否做 Unicode 规范化；BOM 的处理；代码块中的 CRLF 是否也转成 LF；空段落和只含空白的段落是否保留。
9. 没有 JSON 的组件元素、槽位乱序/越界/缺失、容器中不在槽位里的子块如何处理；嵌套超过上限时的行为（open question #5）。
10. ID 字符集只说是"base36 短 ID"：大写、`-`、`_`、非 ASCII 的 ID 是否合法、是否要重新分配。
11. 外来块的边界：`main` 下的裸文本、HTML 注释、`main` 之外的内容（`footer`）、`body` 中的 `style` 怎么处理。
12. EHMD：容器 props 的写法、label 与属性的关系、列表/表格/分割线的 ID 位置、figure 的映射、外来块（原始 HTML）的 ID 写法、Obsidian 原生语法（`> [!note]`、```` ```mermaid ````、`$$`）是否识别成组件。§7 都没有定义。
13. 缺少 `#eh-meta` 时的 meta 内容（`{}`，还是从 `<title>` 推出）。
