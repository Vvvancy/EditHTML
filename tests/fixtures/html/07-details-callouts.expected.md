# 07-details-callouts.html — 预期

`details/summary`（关闭、`open`、嵌套、没有 summary）和几种常见提示框写法：`.callout`（带或不带标题元素、带类型修饰符）、Bootstrap 的 `.alert.alert-danger`、MkDocs/Sphinx 的 `.admonition.tip`、`aside.note`、没有类型的 admonition，以及一个 class 名只是包含 "callout" 子串的普通容器（反例）。

## 保真模式（06 §2）

- **可编辑**：`h1`、`summary` 的文字（编辑 summary 时**不能**触发展开/收起，编辑器需拦截 summary 的默认点击行为）、所有 `p`、`li`、`h4`、`.callout-title`、`aside` 中的裸文本、`code`、`kbd`。
- 折叠状态：用户在编辑器中展开或收起 `details` **不算编辑**，不能写回 `open` 属性（运行时状态）。**歧义**：用户是否可以显式地"把默认状态设为展开"，见 README。
- `pre>code` 按源码文本编辑，保留换行。
- **不做任何编辑直接保存：逐字节一致**。

## 转换模式（06 §3）

| 原块 | 原生块 |
| --- | --- |
| `<style>` | `#eh-user-style`（加作用域前缀）。转换后，被识别成 callout 的元素不再带这些 class，样式实际上不再生效，报告中提示 |
| `h1` | heading 1 |
| `details`（关闭） | `toggle` `{title:"前置条件（点击展开）", open:false}`，子块：列表 2 项 |
| `details open`（summary 含 `strong`，内含嵌套 `details`） | `toggle` `{title:"常见问题：构建失败怎么办？", open:true}`；title 是纯文本，`strong` 丢失 → 写入报告。子块：paragraph、code（`lang=bash`，从 `class="language-bash"` 取得）、嵌套 `toggle` `{title:"还是失败？", open:false}` > paragraph |
| `details` 没有 summary | `toggle` `{title:"", open:false}`。**歧义**：title 用空串还是浏览器默认的"详情/Details" |
| `div.callout`（无标题元素，`strong` 开头） | `callout` `{kind:"info", title:""}` > paragraph（`strong 提示` 保留在正文中，不提升为标题） |
| `div.callout.callout-warning` + `.callout-title` | `callout` `{kind:"warn", title:"注意"}` > paragraph |
| `div.alert.alert-danger`（`h4.alert-heading`） | `callout` `{kind:"warn", title:"危险操作"}` > paragraph。`danger` 在 v1 中没有对应 kind（只有 info/warn/tip），映射为 `warn`，报告中提示**有损** |
| `div.admonition.tip`（`p.admonition-title`） | `callout` `{kind:"tip", title:"技巧"}` > paragraph（`kbd` 保留） |
| `aside.note`（裸文本） | `callout` `{kind:"info", title:""}` > paragraph（裸文本包成段落）。06 §3 列出了 `.note` |
| `div.admonition`（无类型） | `callout` `{kind:"info", title:"没有类型的 admonition"}` > paragraph |
| `div.callout-container` | **不是** callout（按 class 名精确匹配，而不是子串匹配）→ `eh-html` 块 |

- **转换报告**：toggle 4 个（含嵌套 1 个）、callout 6 个、HTML 块 1 个；有损项：`summary` 中的 `strong`、`danger`→`warn`；页面样式 1 段。
