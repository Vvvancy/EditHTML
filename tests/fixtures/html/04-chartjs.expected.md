# 04-chartjs.html — 预期

Chart.js 画在 `<canvas>` 上（库为占位路径 `./vendor/chart.umd.min.js`）：一个多系列柱状图、一个用 `getContext('2d')` 的散点图，外加一个没有脚本的手绘内联 SVG。

## 保真模式（06 §2）

- **可编辑**：`h1`、两个 `h2`、`p`。
- **不可编辑**：两个 `canvas`（06 §2 第 3 步明确不开启）、`svg` 内部（包括 `<text>去年</text>`，06 §2 第 3 步"svg 内部"不开启；只能通过源码弹出层修改）。
- Chart.js 运行时会给 `canvas` 设置 `style`/`width`/`height` 属性：这些属于脚本改动，保存时**不能**写回源码。
- **不做任何编辑直接保存：逐字节一致**。

## 转换模式（06 §3）

| 原块 | 原生块 |
| --- | --- |
| head 中的 `<script src>` | 识别为图表库，被图表消费；报告中列出 |
| `h1`、`p` | heading 1、paragraph |
| `canvas#sales` + `new Chart(ctx, {type:'bar', …})` | `chart` 组件：`type:"bar"`，x=`["华北","华东","华南","西部"]`，series=`[{name:"7月",y:[120,190,150,80]},{name:"8月",y:[135,210,160,95]},{name:"9月",y:[128,230,171,102]}]`。识别器要跟踪 `const ctx = getElementById('sales')` 这个变量 |
| `h2 转化率与客单价` | heading 2 |
| `canvas#scatter` + `new Chart(getElementById('scatter').getContext('2d'), {type:'scatter',…})` | `chart` 组件：`type:"scatter"`，points=`[[2.1,310],[3.4,280],[1.8,402],[4.0,255]]`，series 名为"门店" |
| `h2 手绘的 SVG…` | heading 2 |
| 内联 `svg`（没有生成它的脚本） | **`eh-html` 块**（06 §3 中 canvas/svg 那一行要求"有生成它的 `<script>`"；没有脚本的 svg 落入"其他任何东西"）。不能转成 figure（svg 不是 `img`）。**歧义**：是否应包成 `<img src="data:image/svg+xml,…">` 变成 figure，见 README |

- **转换报告**：原生块 6 个（4 个文本块 + 2 个 chart 组件），HTML 块 1 个；已识别图表 2/2；丢弃：`options.responsive`、`plugins.legend.position`、canvas 的 `width/height`（若 chart schema 中没有对应项）。
