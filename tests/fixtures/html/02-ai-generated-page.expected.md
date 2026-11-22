# 02-ai-generated-page.html — 预期

典型的 AI 生成单页：`<head>` 中一大段 `<style>`（CSS 变量、grid），`body` 末尾一个内联 `<script>`，脚本改写已有元素的文字（`#count`）并往空元素里填文字（`#generated-tip`）。

## 保真模式（06 §2）

- 页面脚本照常运行（本地用户文件默认信任；来源不明时先询问，见 06 §8）。
- **可编辑**：`h1`、`h2`、`h3`、各段落 `p`、`li`、`.badge` 的文字（`span` 是文本容器）、按钮文字（`button` 是表单控件 → **不**开 contenteditable，只能通过"编辑此处 HTML 源码"修改）。
- **由脚本生成 / 不可编辑**：
  - `#count` 的显示值（源码中是 `0`，运行时是 localStorage 中的数字）。脚本改写的是**已有**文本节点，MutationObserver 必须把这个节点标为"由脚本生成"，即使源码中存在对应区间——否则用户的编辑会被写回到 `0` 的位置，而显示值又被脚本覆盖。
  - `#generated-tip` 中的文字：源码中是空元素，没有区间 → 标灰，提示"由脚本生成，请编辑其数据/源码"。
- `<style>` 和 `<script>` 只能通过源码弹出层编辑。
- **不做任何编辑直接保存：逐字节一致**（4 空格缩进、`&amp;`、emoji 均不变）。
- 编辑卡片 "移动 Move" 的段落：补丁只覆盖该 `p` 的内部区间。

## 转换模式（06 §3）

| 原块 | 原生块 |
| --- | --- |
| `<head><style>` | `#eh-user-style`，所有选择器加作用域前缀 `#eh-doc`（`:root`/`body`/`*` 需改写为 `#eh-doc`，否则会污染编辑器 UI） |
| `section.hero`（含 h1、p、span.badge） | `eh-html` 块（非白名单结构 + class 样式）。可选：拆解后 `h1`、`p` 成为原生块，`span.badge` 仍是 `eh-html` |
| `h2 三条规则` | heading 2 |
| `ol` | 有序列表 3 项，`strong`、`code` 保留 |
| `div.grid`（三张 `.card`） | `eh-html` 块。**不能**被识别为 `columns`（`.card` 不是 06 §3 列出的结构），也不是 callout |
| `h2 你已经复习了` | heading 2 |
| 计数器 `div.card` | `eh-html` 块（含 `button`、被脚本引用的 `id`） |
| `p#generated-tip`（空） | 空 paragraph；因为被脚本通过 `id` 引用，`id` 必须保留，否则改为 `eh-html`。**歧义**，见 README |
| `<script>` | 页面脚本 → 一个文档级 `script` 组件（`{js}`），沙箱运行。注意：沙箱中脚本拿不到 `#count`/`#inc`（它们在宿主 DOM 中），计数器在转换后失效 → 报告必须提示 |

- **转换报告**：原生块 6 个（2 标题、1 列表组 3 项、1 空段落），HTML 块 3 个，页面样式 1 段（已加作用域），页面脚本 1 段（已进入沙箱，**行为可能改变**：依赖宿主 DOM）；丢弃：无。
