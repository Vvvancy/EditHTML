# 09-iframe-embeds.html — 预期

`iframe` 的各种写法：视频（宽高属性，URL 中有 `&amp;`）、地图（在 `p` 中，旁边还有文字链接；尺寸写在 `style` 里）、响应式包裹 `div`、`srcdoc`、没有 `src` 的命名 iframe，以及 `video` / `audio` / `object` 这几种非 iframe 的嵌入元素。所有 URL 都用 `*.example.invalid`，测试不能联网。

## 保真模式（06 §2）

- **可编辑**：`h1`、所有 `h2`、`small>a` 的文字和 `href`、`object` 降级内容中的 `p`。
- **不可编辑**：iframe 的内容（跨文档）、`video`/`audio` 控件。可以通过属性面板修改 `src`/`height`，补丁只覆盖该属性值的区间（保留 `&amp;` 的原始写法）。
- iframe 加载失败（网络不可用）不能影响编辑器，也不能修改文件。
- **不做任何编辑直接保存：逐字节一致**。

## 转换模式（06 §3：`iframe`（视频、地图等）→ `embed`）

| 原块 | 原生块 |
| --- | --- |
| `h1`、`h2` | heading（共 7 个） |
| 视频 `iframe` | `embed` `{url:"https://video.example.invalid/embed/kyoto-123?start=30&rel=0", height:315}`（`&amp;` 解码；`width`、`allow`、`allowfullscreen`、`title` 丢弃 → 报告） |
| `p` > 地图 `iframe` + `br` + `small>a` | 拆成两块：`embed` `{url:"https://maps.example.invalid/embed?bbox=…&layer=mapnik&marker=…", height:400}`（从 `style` 中取 height）+ paragraph，内含链接 "查看大地图"（`small` 去壳）。**歧义**：段落中的 iframe 是拆块，还是让整段成为 `eh-html` |
| `div.video-wrapper` > `iframe` | `embed` `{url:"https://player.example.invalid/video/998877"}`，height 无法从百分比得到 → 使用默认值；外层包裹 `div` 丢弃（纯布局） |
| `iframe[srcdoc]` | 没有 URL → `eh-html` 块（或 `script` 组件 `{html}`）。**歧义**，见 README |
| `iframe[name]`（无 src） | `eh-html` 块（空 iframe；可能是表单/链接的 `target`） |
| `video` | `eh-html` 块。06 §3 只列出了 `iframe`；`video`/`audio` 没有原生组件（`embed` 的数据是 `{url, height}`，按定义是网页 iframe）。**歧义** |
| `audio` | `eh-html` 块 |
| `object[type=application/pdf]` + 降级 `p` | `eh-html` 块 |

- **转换报告**：embed 3 个，heading 7 个，paragraph 1 个，HTML 块 5 个；丢弃：iframe 的 `width/allow/allowfullscreen/title/loading/frameborder` 属性、包裹 div 的布局样式。
