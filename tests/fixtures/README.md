# tests/fixtures

解析/序列化往返测试样本（任务 T0.3）。纯数据文件，不含代码。规范依据：[`docs/01-format-spec.md`](../../docs/01-format-spec.md)，尤其是 §6.1 规范形式细则（下文 "§n" 均指该文档章节）；`html/` 与 `obsidian/` 的依据是 [`docs/06-import.md`](../../docs/06-import.md)（写作"06 §n"）。

- `ehtml/NN-name.ehtml`：完整的 `.ehtml` 文档。运行时统一写作占位路径 `./.ehtml/runtime.js`，不引用外部脚本（16、27 号样本中的 `*.example.invalid` 是被测的外来内容）。
- `md/NN-name.md`：EHMD / 纯 Markdown 源（§7）。
- `html/NN-name.html`：真实风格的任意 HTML，**不是** `.ehtml`（没有 `data-eh*`），供保真模式（06 §2）和转换模式（06 §3）使用。每个样本有一个 `NN-name.expected.md`，说明保真模式下哪些区域可编辑、哪些由脚本生成，以及转换模式下逐块的预期映射和转换报告。第三方库一律写作占位路径 `./vendor/…`（文件不存在，测试不能联网）；外部 URL 都用 `*.example.invalid`。
- `obsidian/vault/`：一个小型 Obsidian 库（16 篇笔记、4 个资源文件），供 Markdown 导入（06 §5）和批量导入（06 §6）使用。预期写在 [`obsidian/EXPECTED.md`](obsidian/EXPECTED.md) 中（放在 `vault/` 之外，避免被当作笔记导入）。
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
| `ehtml/22-kitchen-sink.ehtml` | canonical | 大型综合笔记：几乎所有块类型和组件、多层嵌套、所有行内扩展、一个 `eh-html` 块 | 全部 | 配对 md（md 中的外来块是没有 ID 的原始 HTML，TBD）；也可以用作渲染和性能的冒烟样本 |
| `ehtml/23-canonical-form.ehtml` | canonical | §6.1 各条规则的集中样本：骨架缩进、属性顺序与转义、只做最小转义、字面 U+00A0、MARK_ORDER 与共享前缀、嵌套列表、带对齐的表格、`eh-html` 块、槽位、JSON 中的 `<\/` | §6.1 | 序列化器的首要回归样本 |
| `ehtml/24-bom-crlf.ehtml` | **non-canonical input** | UTF-8 BOM 加 CRLF 换行（代码块内也是 CRLF） | §6.1 | 输出 `\n` 换行。TBD：是否去掉 BOM；代码块内的 CRLF 是否也转成 LF |
| `ehtml/25-legacy-no-meta.ehtml` | **non-canonical input** | `data-eh-version="0.0"`，没有 `#eh-meta`，没有运行时脚本 | §2, §10 | 可以解析；保存时升级到 0.1。TBD：meta 是 `{}` 还是从 `<title>` 推出 |
| `ehtml/26-plain-html.ehtml` | **non-canonical input** | 普通 HTML 页面：没有 `data-eh-version`、没有 `main#eh-doc`、没有块 ID | §6.1, §10 | 按 §6.1 规则解析 `body` 的子元素并分配 ID；`div.sidebar` 变成外来块 |
| `ehtml/27-html-block.ehtml` | canonical | 16 号首次保存后的形态：`<eh-html data-eh>`（HTML 块，06 §4；旧名 `eh-foreign` 仍可读取）包住 div、外部 script、iframe、details、多行 `dl`，容器槽位中也有一个外来块 | §6.1, §10 | 外来块 HTML 原样保存（包括内部的换行） |

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

## `html/` 样本（任意 HTML）

所有样本的保真模式预期都包括：**不做任何编辑直接保存，输出与输入逐字节一致**；只编辑一处时，diff 只包含这一处。转换模式的预期是逐块映射和转换报告，测试时应断言块的类型和关键数据，而不是与某个 `.ehtml` 逐字节比较（还没有对应的 `.ehtml` 期望文件）。

| 文件 | 内容 | 重点 | 预期 |
| --- | --- | --- | --- |
| `html/01-handwritten-notes.html` | 手写读书笔记：混乱的缩进（空格/tab）、单行和多行注释、省略的 `</p>`、`pre`、`figure`、裸 `img` | 06 §3 第 1 行（原生文本块）；保真模式下的隐式结束标签 | [expected](html/01-handwritten-notes.expected.md) |
| `html/02-ai-generated-page.html` | AI 生成的单页：大段 `<style>`（CSS 变量、grid）、卡片网格、按钮、末尾的内联 `<script>`（改写已有文字、往空元素填文字） | 页面级 style/script；由脚本生成的节点；卡片 → `eh-html` | [expected](html/02-ai-generated-page.expected.md) |
| `html/03-echarts.html` | ECharts：链式 `init().setOption({…})`、变量中的配置（饼图）、循环生成数据的 heatmap | canvas/svg + script → chart；无法识别时 → `eh-html` | [expected](html/03-echarts.expected.md) |
| `html/04-chartjs.html` | Chart.js：`canvas` + `new Chart(ctx, {…})` 柱状图（3 个系列）、`getContext('2d')` 散点图、没有脚本的手绘 SVG | canvas → chart；没有脚本的 svg | [expected](html/04-chartjs.expected.md) |
| `html/05-katex.html` | KaTeX 输出：行内公式、`katex-display`（在 `p` 中和裸放在 body 下）、annotation 中的 `&amp;` `&lt;`、没有 annotation 的 `output:"html"` | KaTeX → math（取回 TeX） | [expected](html/05-katex.expected.md) |
| `html/06-mathjax.html` | MathJax：未渲染的 `\(…\)`/`$…$`/`\[…\]`、MathJax 2 的 `script[type=math/tex]`、MathJax 3 的 `mjx-container`（没有 TeX）、带 annotation 的裸 MathML、`$5` 价格 | MathJax → math；TeX 丢失时 → `eh-html` | [expected](html/06-mathjax.expected.md) |
| `html/07-details-callouts.html` | `details`（关闭、`open`、嵌套、没有 summary）；`.callout`、`.callout-warning`、`.alert.alert-danger`、`.admonition.tip`、`aside.note`、反例 `.callout-container` | details → toggle；提示框 → callout | [expected](html/07-details-callouts.expected.md) |
| `html/08-mermaid.html` | `pre.mermaid`、`div.mermaid`、`pre>code.language-mermaid`、已渲染为 SVG 的 `pre.mermaid[data-processed]`；ES module 引入的库 | mermaid → mermaid 组件 | [expected](html/08-mermaid.expected.md) |
| `html/09-iframe-embeds.html` | 视频 iframe、`p` 中的地图 iframe、响应式包裹 div、`srcdoc`、没有 src 的 iframe、`video`、`audio`、`object` | iframe → embed | [expected](html/09-iframe-embeds.expected.md) |
| `html/10-legacy-inline.html` | 没有 doctype；`b i u strike del ins tt big small font center`、大写标签、`span style="color/background-color/font-weight"`、`abbr cite q dfn var samp time`、`nobr blink marquee` | 非白名单行内 → `strong em …`；`span[color]` → 颜色 mark | [expected](html/10-legacy-inline.expected.md) |
| `html/11-saved-webpage.html` | 浏览器"另存为"的网页：`saved from url` 注释、`_files/` 资源（含空格）、`nav`、搜索表单、`article`、Prism 高亮代码、`srcset`、评论表单（`input textarea select checkbox`）、`aside`、`footer`、分析脚本 | 来源不明的文件（06 §8）；nav/footer/form → `eh-html`；表单控件不可编辑 | [expected](html/11-saved-webpage.expected.md) |
| `html/12-tables.html` | 简单表格（两种对齐写法）、没有 thead、`colspan/rowspan`、`caption/tfoot/colgroup`、单元格中有块级内容、嵌套的布局表格 | table → 原生 table 或 `eh-html`；隐式 `tbody` | [expected](html/12-tables.expected.md) |
| `html/13-word-paste.html` | Word 导出/复制的 HTML：Office 命名空间、条件注释、`mso-*`、`<o:p>`、`MsoListParagraph` 伪列表、`MsoTableGrid`、`v:shape` 与 `file:///C:/` 图片 | 粘贴清洗（06 §7）；伪列表重建 | [expected](html/13-word-paste.expected.md) |
| `html/14-notion-paste.html` | Notion 剪贴板片段（一行，没有 html/body）：to-do、`figure.callout`、`details`、颜色/背景色 span、`simple-table` | 粘贴清洗；片段解析 | [expected](html/14-notion-paste.expected.md) |
| `html/15-unsafe-handlers.html` | `on*`（含大写）、`javascript:`（大小写、空格、实体、tab）、`vbscript:`、`data:`、`form[action]`、`formaction`、CSS `url(javascript:)`、`iframe[src=javascript:]`、SVG 中的链接和处理器 | 保真模式不清洗；转换/粘贴时清洗（01 §9、06 §7） | [expected](html/15-unsafe-handlers.expected.md) |
| `html/16-bom-crlf.html` | UTF-8 BOM + CRLF（`pre` 中也是），混入一个单独的 LF，行尾空格 | 保真模式下的字节偏移；新插入内容的换行风格 | [expected](html/16-bom-crlf.expected.md) |
| `html/17-minified-oneline.html` | 压缩成一行、没有末尾换行、无引号属性、压缩的 CSS/JS、`&#10;` 实体换行 | 超长单行的区间补丁；布局 div 去壳 | [expected](html/17-minified-oneline.expected.md) |

## `obsidian/` 样本（Obsidian 库）

详细预期（每篇笔记的映射、链接解析表、不能往返的情况）见 [`obsidian/EXPECTED.md`](obsidian/EXPECTED.md)。往返测试：单文件 `md → ehtml → md` 逐字节一致，只允许空白规范化（行尾空白、连续空行、末尾换行、表格单元格填充），EXPECTED.md 末尾的表格列出了例外。

| 文件 | 内容 |
| --- | --- |
| `vault/.obsidian/app.json` | Obsidian 配置；导入器必须忽略 `.obsidian/` |
| `vault/Home.md` | frontmatter（aliases、tags 块序列、嵌套标签、YAML 日期、cssclasses）；双链的全部四种形式；带路径和 `.md` 扩展名的双链；有歧义的同名链接；通过别名的链接；缺失的笔记；标准 Markdown 相对链接（`<…>`、`%20`）；标题段落嵌入 |
| `vault/projects/EditHTML/Roadmap.md` | 段落、嵌套列表项、表格上的 `^blockid`；三层混合嵌套列表；带对齐和 `[[a\|b]]` 的表格；同一文件夹优先的歧义链接；`[[#^id]]`、`[[#标题]]` |
| `vault/projects/EditHTML/会议记录.md` | 与 archive 中的笔记**同名**；任务列表 + 块 ID；YAML 中的双链；`> [!info]` |
| `vault/archive/2025/会议记录.md` | 同名的另一篇；指向自己的裸链接；带路径和块 ID 的链接 |
| `vault/people/张三.md` | 中文文件名；aliases（含空格的 `Zhang San`） |
| `vault/notes/Callouts.md` | `> [!note] 标题`、可折叠 `[!tip]-` / `[!warning]+`、没有标题、大写类型、v1 中没有的类型、三层嵌套 callout、callout 中的列表和代码、普通引用 |
| `vault/notes/Math.md` | `$…$`、多行 `$$…$$`、单行 `$$…$$`、`aligned` + `^id`、`$5` 价格、`\$`、代码中的 `$`、表格中的公式 |
| `vault/notes/Diagrams.md` | ```` ```mermaid ````（flowchart、sequence）、`~~~mermaid`、普通代码块、没有语言的围栏 |
| `vault/notes/Dataview.md` | ```` ```dataview ````、```` ```dataviewjs ````、```` ```tasks ````、```` ```query ````；行内字段 `key:: value`、`[k:: v]`、`(k:: v)`；行内查询 |
| `vault/notes/Embeds.md` | `![[image.png]]`、带尺寸、带路径的 SVG、带 alt、标准 Markdown 图片（含 `%20`）、缺失图片、整篇笔记嵌入、标题嵌入、块嵌入、缺失笔记嵌入、PDF 嵌入、指向附件的普通双链 |
| `vault/notes/Footnotes and highlights.md` | `==高亮==`（含嵌套和未闭合）、`[^1]` 重复引用、命名脚注、多段脚注、行内脚注 `^[…]`、`%%注释%%`、其他强调 |
| `vault/notes/Raw HTML.md` | 跨空行的 `<details>`、单行 `<details open>`、`<div style>`、`div.callout`、行内 HTML（`kbd sub sup mark u font`）、`center`、`iframe`、`img[width]`、HTML 注释、`colspan` 表格、`onclick`/`javascript:` |
| `vault/notes/Lists and tables.md` | 任务列表（`[X]`、`[-]`、`[>]`、混合、嵌套 + `^id`）；有序/无序嵌套、松散列表、列表中的代码块、`*`/`+` 标记；四种对齐的表格；缺少/多出单元格的行 |
| `vault/inbox/快速记录.md` | `#tag`、`#nested/tag/deep`、`-`/`_`、纯数字（不是标签）、`#2026年计划`、URL 中的 `#`、代码中的 `#`、行首标签与 ATX 标题、`学习#读书` |
| `vault/journal/2026-11-20.md` | 日记：中文 frontmatter、`^morning`、带路径+块 ID+别名的双链、两行引用、日语和韩语 |
| `vault/journal/2026-11-21.md` | 标题链接和块链接、块嵌入、正文中的 `---`、全角标点、ZWJ emoji、很长的中文段落（全角空格、中英文间距） |
| `vault/assets/{image,photo,My Photo}.png`、`diagram.svg` | 1×1 占位图片 |

## 覆盖矩阵：06 映射表的每一行 → 样本

### 06 §3 HTML → 原生块

| 06 §3 的行 | 样本 |
| --- | --- |
| `p h1-h6 ul ol blockquote pre hr table figure img`，仅含白名单行内 → 对应原生文本块 | html/01（全部类型）、02、12（表 1、2）、14、16、17 |
| `b i u font` 等 → `strong em …`；`span style="color"` → 高亮 mark | html/10（全部）、13（`b`、`span[color]`、`mso-highlight`）、14（`span[color]`、`background-color`、`font-weight`）、11（`time`）、obsidian/Raw HTML |
| `details/summary` → `toggle` | html/07（关闭、open、嵌套、无 summary）、14、17、obsidian/Raw HTML |
| `.callout .alert .note .admonition` → `callout` | html/07（全部四种 + 反例）、14（`figure.callout`）、17、obsidian/Raw HTML |
| `<pre class="mermaid">`、Mermaid 代码块 → `mermaid` | html/08（`pre.mermaid`、`div.mermaid`、`code.language-mermaid`、已渲染） |
| KaTeX/MathJax 输出（`annotation encoding="application/x-tex"`）→ `math` | html/05（KaTeX）、06（MathJax 2/3、裸 MathML） |
| `iframe`（视频、地图等）→ `embed` | html/09（视频、地图、包裹、srcdoc、无 src）、15（`javascript:` src）、obsidian/Raw HTML |
| `canvas/svg` + `<script>`（ECharts/Chart.js）→ `chart` | html/03（ECharts ×2 可识别）、04（Chart.js ×2） |
| 其他任何东西 → `eh-html` | html/02（卡片、hero）、03（heatmap）、04（无脚本 svg）、05/06（缺 TeX）、08（已渲染 SVG）、09（video/audio/object）、11（nav/form/aside/footer）、12（合并单元格等）、15（button/form/svg） |
| 页面级 `<style>` → `#eh-user-style`（`#eh-doc` 作用域） | html/02、03、07、12、17；11（`<link rel=stylesheet>`，歧义）；13（只有 `mso-*` → 不生成） |
| 页面级 `<script>` → `script` 组件 / 页面脚本 | html/02、11（来源不明，不执行）、15、17；03/04/05/06/08 中的库脚本被组件消费 |
| 转换报告（原生化数、HTML 块数、丢弃项应为空） | 每个 `html/*.expected.md` 的最后一条 |
| 06 §2 保真模式：区间补丁、逐字节一致 | 全部 html 样本；特别是 01（隐式结束标签）、12（隐式 tbody）、14（隐式 html/body）、16（BOM/CRLF）、17（单行） |
| 06 §2 由脚本生成的 DOM 不可编辑 | html/02、03、04、06、08、17 |
| 06 §2 第 3 步：`script/style/svg/canvas/表单控件` 不可编辑 | html/04（canvas、svg）、11（表单）、09（video/audio）、15 |
| 06 §7 粘贴清洗（`on*`、`javascript:`、`mso-*`） | html/13、14、15 |
| 06 §8 来源不明的 HTML 默认不执行脚本 | html/11、15 |

### 06 §5 Markdown → 原生

| 06 §5 的行 | 样本 |
| --- | --- |
| 标题、段落、列表、任务列表、引用、代码、表格、分割线、图片 → 对应文本块 | obsidian/Lists and tables、Roadmap、会议记录、journal/*、Embeds（图片）；另见 md/30、md/31 |
| YAML frontmatter → `#eh-meta` | obsidian/Home、Roadmap、会议记录、张三、Math、Dataview、Lists and tables、journal/2026-11-20；另见 md/32、md/34 |
| ```` ```mermaid ```` → `mermaid` | obsidian/Diagrams（含 `~~~mermaid`）；另见 md/32 |
| `$$…$$` / `$…$` → `math` / 行内公式 | obsidian/Math（多行、单行、aligned、价格、转义、表格中）、Lists and tables（表格中）；另见 md/32 |
| `> [!note] 标题` callout（含 `[!note]-`）→ `callout`（可折叠时 `toggle`） | obsidian/Callouts（全部变体，含嵌套）、会议记录；另见 md/32 |
| `[[笔记]]`、`[[笔记#标题]]`、`[[笔记#^块id]]`、`[[笔记\|别名]]` → 双链 | obsidian/Home（全部四种 + 路径 + 缺失 + 歧义）、Roadmap、archive/会议记录、journal/*、Lists and tables（表格中） |
| `![[图片.png]]`、`![[笔记]]` → 图片 / 嵌入引用块 | obsidian/Embeds（全部）、Home、journal/2026-11-21 |
| `#标签` → 标签 | obsidian/快速记录（全部边界情况）、Home、journal/2026-11-20、Lists and tables |
| `^块id` → 块 ID | obsidian/Roadmap（段落、列表项、表格）、会议记录、archive/会议记录、Math（公式块）、Lists and tables、journal/2026-11-20 |
| `==高亮==`、脚注 → mark、脚注 | obsidian/Footnotes and highlights；另见 md/31 |
| Markdown 中的原始 HTML → 原生块或 `eh-html` | obsidian/Raw HTML |
| 无法识别的扩展语法（Dataview 代码块）→ 代码块原样保留 | obsidian/Dataview（dataview、dataviewjs、tasks、query、行内字段） |
| 无损保证 `md → ehtml → md` | obsidian/EXPECTED.md 每篇笔记的"往返"条目和末尾的例外表 |
| 06 §6 批量导入：两遍链接重写、同名文件、缺失目标、资源复制、增量 | obsidian/EXPECTED.md "批量导入"一节 |

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

## 06 映射表的歧义（`html/`、`obsidian/` 样本中遇到的）

`.expected.md` 和 `obsidian/EXPECTED.md` 中标为"**歧义**"的地方都在这里。各样本先按"本样本预期"一栏的做法写，等文档定下来后再改。

| # | 06 位置 | 问题 | 样本 | 本样本预期 |
| --- | --- | --- | --- | --- |
| 14 | §2 | 脚本改写了源码中**已存在**的文本节点（`#count`、MathJax 替换 `\(…\)`），这类节点算不算"由脚本生成"？用户编辑写回到哪里？ | html/02、06 | 标为由脚本生成；编辑通过源码入口修改原始文本区间 |
| 15 | §2 | 信任文件时，编辑态下是否执行 `on*` 处理器；`details` 的展开/收起是否写回 `open` | html/07、15 | 编辑态下不执行；展开/收起不写回 |
| 16 | §2 第 7 步 | 插入新节点时，"沿用兄弟节点的风格"是否包括换行符（CRLF）和无空白的压缩风格；修改无引号属性时是否加引号 | html/16、17 | 包括；只在必要时加引号 |
| 17 | §2 | KaTeX 公式、Prism 高亮代码这类"渲染产物"在保真模式下怎么编辑 | html/05、11 | 原子节点 + "编辑 TeX/源码"入口，补丁覆盖整个元素 |
| 18 | §3 第 2 行 | `u`、`ins`、`big`、`small` 等没有白名单对应的元素是去壳还是保留；`span style="color"`（文字颜色）为什么映射成"高亮 mark"；颜色值写在哪里（01 §3.2 未定义）；`font-weight` 是否映射为 `strong` | html/10、13、14 | 去壳并报告有损；颜色 mark 保存颜色值；`font-weight ≥ 600` → `strong` |
| 19 | §3 | 视觉上是标题的结构（`center>font>b`）是否识别成 heading | html/10 | 不识别，成为 paragraph |
| 20 | §3 | 纯布局包裹层（`div.wrap`、`article`、`section`、`.post-content`）是去壳后递归，还是整体成为 `eh-html`；只含行内内容的 `div` 是否当作段落 | html/11、17 | 去壳并递归；只含行内内容的 `div` → paragraph |
| 21 | §3 第 3 行 | `summary` 中的格式（`strong`）丢失；没有 `summary` 时 title 是空串还是"详情" | html/07 | 纯文本 title；空串 |
| 22 | §3 第 4 行 | 提示框类型映射：v1 只有 info/warn/tip，`danger`、`question`、Obsidian 的十几种类型怎么办；是否按 class 精确匹配（`.callout-container` 不算）；Notion 的 emoji 图标能否推断类型 | html/07、14；obsidian/Callouts | 精确匹配 class；danger → warn，其余 → info，原始类型另存为 prop 以便往返 |
| 23 | §3 第 5 行 | 除 `pre.mermaid` 外，`div.mermaid` 是否也识别 | html/08 | 识别 |
| 24 | §3 第 6 行 | 没有 TeX annotation 的 KaTeX/MathJax 输出；源码中未渲染的 `\(…\)` 分隔符文本是否也识别为公式；行内 `eh-html` 不存在时，含无法识别行内内容的段落怎么办 | html/05、06 | 无 TeX → 整段成为 `eh-html`；按页面的 MathJax 配置识别分隔符 |
| 25 | §3 第 7 行 | 段落中的 iframe 是拆块还是让整段变成 `eh-html`；`srcdoc`、没有 src 的 iframe；`video/audio/object` 是否也算 embed | html/09 | 拆块；srcdoc/无 src/video/audio/object → `eh-html` |
| 26 | §3 第 8 行 | 识别为 chart 时，ECharts/Chart.js 专有的选项（tooltip、legend 位置、smooth、尺寸）是放进 `options` 原样保留，还是算作丢弃（与"丢弃应为空"冲突）；没有脚本的内联 SVG 是 `eh-html` 还是转成 figure | html/03、04 | 报告中列出丢弃的选项；无脚本 SVG → `eh-html` |
| 27 | §3 | 页面级 `<link rel=stylesheet>`（本地文件）是否内联进 `#eh-user-style`；库的 `<script src>` 被组件消费后从文档中移除是否算"丢弃" | html/03、05、08、11 | 本地文件存在则内联；被消费的库在报告中单独列出 |
| 28 | §3 | 页面脚本进入沙箱后拿不到宿主 DOM，依赖 `id`/class 的脚本会失效；转换时是否保留元素的 `id`（锚点 `#local` 也会断开） | html/02、15、17 | 报告提示行为改变；`id` 不保留，报告断开的锚点 |
| 29 | §3 / 01 §3.2 | 表格：`colspan/rowspan`、`caption/tfoot/colgroup`、单元格中的块级内容 → `eh-html` 还是有损展开；`td>b` 第一行是否算表头 | html/12、13 | 全部 → `eh-html`；`td>b` 不算表头 |
| 30 | §7 | Word 的 `MsoListParagraph` 伪列表是否重建为列表；只含 `&nbsp;` 的空段落是否保留；粘贴时 `<script>` 是丢弃还是进入 script 组件 | html/13、15 | 重建；空段落丢弃；粘贴时丢弃脚本 |
| 31 | §7 / 01 §9 | `vbscript:`、`data:text/html`、`data:image` 链接，CSS `url(javascript:)`、`form[action]`、`formaction`、`iframe[src=javascript:]`、SVG 中的链接是否都要剔除 | html/15 | 前两者和后五者剔除；`data:image` 保留 |
| 32 | §5 | 导出回 Obsidian Markdown 时，是否只输出原有的 `^blockid`（不输出自动分配的 ID）；EHMD（每块都写 ID）和 Obsidian Markdown 是不是两种导出目标 | obsidian/全部 | 两种目标；Obsidian 导出只写原有 ID |
| 33 | §5 / 01 §6.1 | frontmatter 进入 `#eh-meta` 后键会被排序，YAML 写法也会丢失；无损往返需要保存原 YAML 文本吗；YAML 中的 `[[链接]]` 是否参与批量改写 | obsidian/Home、会议记录 | 保存原 YAML 文本；YAML 中的链接不改写，报告提示 |
| 34 | §5 / 01 §3.1 | Obsidian 块 ID（`goal-1`、`deep-task`）含 `-`，不是 base36 | obsidian/Roadmap、Lists and tables | 原样保留（与 README 歧义 10 相关） |
| 35 | §5 callout 行 | 可折叠 callout 变成 `toggle` 后，原 callout 类型保存在哪里；`+`（默认展开）没有提到 | obsidian/Callouts | `toggle` 上另存原类型和折叠标记 |
| 36 | §5 | 06 §5 没有列出的 Obsidian 语法：`%%注释%%`、行内脚注 `^[…]`、`- [-]` 等自定义任务状态、单行 `$$…$$`、`~~~` 围栏、`![[x.png\|200]]` 尺寸、`![[file.pdf#page=3]]` | obsidian/Footnotes、Lists and tables、Math、Diagrams、Embeds | 都原样保存写法，导出时写回 |
| 37 | §5 原始 HTML 行 | 被识别成原生块的 HTML（`<details>`、`<mark>`、`div.callout`）导出时写回 HTML 还是 Markdown 语法；开始和结束标签被空行分开（属于不同 mdast 节点）的 `<details>` 怎么识别 | obsidian/Raw HTML | 记录"来源是 HTML"并写回 HTML；跨节点配对识别 |
| 38 | §6 | 同名文件的解析规则（同一文件夹优先？最短路径？）；别名是否参与解析；未解析链接的表示 | obsidian/Home、Roadmap、archive/会议记录 | 同文件夹优先 → 最短路径 → 字典序，一律报告歧义；别名不参与；未解析链接保留为双链 |
| 39 | §5 "空白规范化" | 哪些差异算"空白规范化"（表格分隔行 `\| - \|` 与 `\| --- \|`？列表标记？） | obsidian/全部 | 只有行尾空白、连续空行、末尾换行、表格单元格填充 |
