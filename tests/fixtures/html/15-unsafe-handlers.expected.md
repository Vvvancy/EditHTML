# 15-unsafe-handlers.html — 预期

`on*` 事件处理器（`body onload`、`h1 onclick`、`p onmouseover`、大写的 `ONMOUSEOUT`、`img onerror`、`form onsubmit`、`input onfocus`、SVG 中的 `onclick`）和各种 `javascript:` 写法（大小写混合、前导空格、数字实体 `&#106;`、实体编码的 tab、`form[action]`、`formaction`、CSS 中的 `url()`、`iframe[src]`、SVG 中的 `a[href]`），以及 `vbscript:`、`data:text/html`、`data:image`、`mailto:`、锚点、相对链接。与 ehtml/17 互补：那个样本是 `.ehtml`，这个是普通 HTML。

## 保真模式（06 §2、§8）

- 本地文件默认信任时，脚本和 `on*` 照常运行；来源不明时**不执行**（06 §8）。无论哪种情况，**编辑态**下点击链接都不能导航，也不能执行 `javascript:` URL（编辑器拦截链接的默认行为）。`h1` 的 `onclick` 在编辑点击时**不能**触发。**歧义**：信任文件时，编辑态下是否执行 `on*` 处理器，06 §2 没有规定，见 README。
- **可编辑**：`h1`、所有 `p`、`a` 的文字。
- **不可编辑**：`button`、`input`、`svg` 内部。
- 保真模式**不**清洗：`on*` 和 `javascript:` 链接原样保留在文件中（这是用户自己的文件）。
- **不做任何编辑直接保存：逐字节一致**。
- 编辑带 `onclick` 的 `h1` 的文字：补丁只覆盖 `h1` 的内部区间，`onclick` 属性保留。

## 转换模式 / 粘贴（06 §3、§7；01 §9）

| 原写法 | 转换结果 |
| --- | --- |
| `body[onload]`、`h1[onclick]`、`p[onmouseover][ONMOUSEOUT]` | 属性全部剔除；`h1` → heading 1，`p` → paragraph |
| `a[href=javascript:…]`（第 1 段中 2 个，第 2 段中 3 个；含大小写、空格、实体、tab） | 去掉链接、保留文字（"这里""什么都不做""链接 1""链接 2""链接 3"）。检测前要先解码实体、去掉 ASCII 空白和控制字符，再不区分大小写匹配 |
| `vbscript:`、`data:text/html` | 去掉链接、保留文字（本样本预期；ehtml/17 中仍是 TBD） |
| `data:image/png` 链接 | **歧义**：是否允许。本样本预期保留（不能执行脚本） |
| `mailto:`、`#local`、`./other.html` | 保留。`#local` 指向的 `p#local` 在转换后 `id` 丢失 → 锚点断开，报告中提示（或者改写为块 ID `#<blockid>`） |
| `img[onerror]` | figure，`onerror` 剔除 |
| `button[onclick]` | `eh-html` 块，`onclick` 剔除（`eh-html` 也要清洗，01 §9） |
| `form[action=javascript:][onsubmit]` + `input[onfocus]` + `input[formaction=javascript:]` | `eh-html` 块；`on*`、`action="javascript:…"`、`formaction="javascript:…"` 剔除 |
| `div[style=background:url('javascript:…')]` | `eh-html` 块；包含 `javascript:` 的 `style` 声明剔除。**歧义**：01 §9 只提到 `on*` 和 `javascript:` 链接，没有提到 CSS 中的 URL |
| `iframe[src=javascript:…]` | **不能**变成 `embed`（不是 http(s) URL）→ `eh-html` 块且 `src` 剔除 |
| `svg > a[href=javascript:] > circle[onclick]` | `eh-html` 块；SVG 中的 `href`/`xlink:href` 和 `on*` 同样剔除 |
| `p#local` | paragraph |
| 内联 `<script>` | 页面脚本 → `script` 组件（沙箱）。函数 `init/toggleAll/validate` 原本由已经剔除的处理器调用，在沙箱中不会执行 → 报告提示 |

- **转换报告**：剔除的 `on*` 属性 10 个，剔除/去掉的危险 URL 12 处（5 个 `javascript:` 链接、`vbscript:`、`data:text/html`、`form[action]`、`formaction`、CSS `url()`、`iframe[src]`、SVG `a[href]`，逐项列出位置）；HTML 块 5 个；页面脚本 1 段。粘贴时（06 §7）结果相同，只是页面脚本直接丢弃。**歧义**：粘贴时 `<script>` 是丢弃还是放进 script 组件。
