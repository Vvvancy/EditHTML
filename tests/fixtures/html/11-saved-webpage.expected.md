# 11-saved-webpage.html — 预期

浏览器"另存为（完整网页）"得到的文件：`<!-- saved from url=… -->` 标记、资源放在带空格的 `…_files/` 目录中（测试中这些文件不存在）、外部分析脚本、`nav`、搜索表单、`article`（`header` + `.post-content`）、评论表单（`input textarea select checkbox`）、侧边栏、`footer`、Prism 语法高亮后的代码块、带 `srcset` 的 figure、`javascript:void(0)` 链接。

## 保真模式（06 §2、§8）

- **来源不明**（有 `saved from url` 标记）：脚本默认**不执行**，顶部提示"启用脚本"（06 §8）。
- **可编辑**：`h1 h2 h3 h4`、所有 `p`、`li`、`a` 的文字、`figcaption`、`label` 的文字、`.post-meta` 中的文字（`time` 在文本容器中）、`pre>code` 的文字（跨越 Prism 的 `span.token`；编辑会破坏高亮 span，补丁覆盖整个 `code` 区间并保留现有 span 结构 → **歧义**，见 README）。
- **不可编辑**：`input`、`textarea`（它的默认文本只能通过源码修改）、`select`/`option`、`button`、checkbox（06 §2 第 3 步：表单控件不开启）。在表单控件中输入**不算编辑**，不能写回 `value`/`checked`。
- 资源路径中的空格和中文：保存时原样保留，不做 URL 编码。
- **不做任何编辑直接保存：逐字节一致**（包括 `saved from url` 注释、`async=""`、`</body></html>` 写在同一行）。

## 转换模式（06 §3）

| 原块 | 原生块 |
| --- | --- |
| `<link rel=stylesheet>`（本地 `_files/main.css`） | 页面级样式：内联进 `#eh-user-style`（如果文件存在）；文件不存在 → 报告"缺少资源"。**歧义**：06 §3 只说了页面级 `<style>`，没有提到 `<link>` |
| `link[rel=icon]`、`meta[og:*]` | 进入 `head.extra` 或丢弃，报告 |
| `a.skip-link` | `eh-html` 块（或者因为纯导航而丢弃？不能丢弃，06 §3 要求丢弃为空 → `eh-html`） |
| `header.site-header > nav`（含搜索 `form`） | **`eh-html` 块**（一个） |
| `article > header.post-header` 中的 `h1` | heading 1 |
| `.post-meta`（`time` + 文字 + tag 链接） | paragraph（`div` 中只有行内内容 → 视为段落；`time` 去壳）。**歧义**：只含行内内容的 `div` 是 paragraph 还是 `eh-html` |
| `.post-content` 中的 `p`、`h2`（`id` 丢弃）、`figure`（`srcset`、`loading` 丢弃，`src` 指向 `_files/` → 批量导入时复制到 `assets/` 并重写引用）、`p` | 对应原生文本块。`article`、`.post-content` 包裹层去壳 |
| `pre.language-sql > code.language-sql` + Prism 的 `span.token` | code 块，`lang=sql`，文本 = `PRAGMA journal_mode=WAL;`（高亮 span 去壳） |
| `.share-buttons`（含 `javascript:void(0)`） | `eh-html` 块；`javascript:` 链接按 §9 剔除 `href`、保留文字 |
| `section.comments`（`h3` + 评论 `form`） | `h3` → heading 3；`form` → `eh-html` 块。**歧义**：是把整个 section 作为一个 `eh-html`，还是递归到能识别的子元素（本样本预期**递归**：06 §3 说"逐个顶层子树分类（自顶向下，遇到能识别的就停）"，`section` 无法识别，所以继续向下） |
| `aside.sidebar` | `eh-html` 块（不是 callout：`aside` 没有提示框 class） |
| `footer.site-footer` | `eh-html` 块 |
| `<script async src=analytics.js>`、`<script src=main.js>`、内联 gtag 脚本 | 页面脚本 → 一个文档级 `script` 组件（沙箱），且因为来源不明默认不执行。**建议**报告中把分析脚本标出来，供用户删除 |
| `<title>` | `#eh-meta.title` = "SQLite WAL 模式详解 \| 某某技术博客" |
| `saved from url` 注释 | `#eh-meta.source`（如果 meta 有这个字段）或丢弃并报告 |

- **转换报告**：原生块 10 个（h1、meta 段落、2×h2、3×p、figure、code、h3），HTML 块 6 个（skip-link、nav、share、form、sidebar、footer），页面脚本 3 段（来源不明，未执行），缺少的本地资源 6 个（`main.css`、`analytics.js`、`logo.svg`、`wal-diagram.png`、`wal-diagram@2x.png`、`main.js`；测试中都不存在，必须报告而不是报错）；丢弃：无（属性层面的丢弃单独列出）。
