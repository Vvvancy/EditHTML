# 03-echarts.html — 预期

ECharts 页面，库用占位路径 `./vendor/echarts.min.js` 引入（测试中不存在该文件，也不能联网）。三个图表覆盖三种情况：一条链式调用的字面量配置、先赋值给变量再 `setOption` 的配置、运行时计算数据的配置（无法识别）。

## 保真模式（06 §2）

- 页面脚本照常运行；测试环境中 `echarts` 未定义，脚本报错，三个容器保持为空。编辑器不能因此崩溃，也不能把报错写进文件。
- **可编辑**：`h1`、两个 `h2`、三个 `p`。
- **由脚本生成 / 不可编辑**：`#pv-chart`、`#source-chart`、`#heat` 内部由 ECharts 生成的 `canvas`/`div`（不在源码中，MutationObserver 标灰）。
- `#heat` 的 `style.height` 是运行时设置的属性：保存时**不能**写回源码（属性变更来自脚本，不是用户编辑）。
- 编辑图表数据只能通过"编辑此处 HTML 源码"修改对应 `<script>` 的区间。
- **不做任何编辑直接保存：逐字节一致**。

## 转换模式（06 §3）

| 原块 | 原生块 |
| --- | --- |
| `<script src="./vendor/echarts.min.js">`（head） | 不进入文档；识别为图表库，被后续三个图表消费。报告中列为"已识别的库引用" |
| `<style>.chart{…}` | `#eh-user-style`（加 `#eh-doc` 前缀） |
| `h1`、`p` | heading 1、paragraph |
| `div#pv-chart` + 紧随的 `<script>`（`echarts.init(…).setOption({…})`） | `chart` 组件：`{type:"line", data:{x:["周一","周二","周三","周四","周五","周六","周日"], series:[{name:"PV", y:[820,932,1290,1130,990,610,540]}]}, options:{title:"每日 PV", smooth:true}}`。具体 JSON 键名以 `packages/blocks` 的 chart schema 为准；这里断言的是数据值 |
| `h2 来源构成` | heading 2 |
| `div#source-chart` + `<script>`（`var option = {…}; chart.setOption(option)`） | `chart` 组件：`{type:"pie", data:[{name:"搜索引擎",value:1048},{name:"直接访问",value:735},{name:"邮件",value:580},{name:"社交媒体",value:300}]}`。识别器要能跟踪"同一脚本内对变量赋值的对象字面量"，`style="width:480px;height:320px"` → `options.height=320`（宽度丢弃，写入报告） |
| `h2 每小时热力…` | heading 2 |
| `div#heat` + `<script>`（数据由循环生成、`heatmap` 类型） | 无法识别（不是对象字面量；`heatmap` 不在 chart 支持的 bar/line/pie/scatter 中）→ 容器与脚本一起成为**一个** `eh-html` 块，脚本进入沙箱，库引用作为该块的依赖保留 |
| 最后的 `p` | paragraph |

- 识别出的图表：容器 `div` 和它的 `<script>` 都被消费，不再单独出现。
- **转换报告**：原生块 7 个（5 个文本块：1 h1、2 h2、2 p；2 个 chart 组件），HTML 块 1 个（`#heat`）；已识别图表 2/3，未识别 1（原因：数据不是字面量、heatmap 类型不支持）；丢弃：`#source-chart` 的宽度、`tooltip` 等 chart schema 中没有的选项（逐项列出）。06 §3 要求"丢弃应为空"，与"识别成 chart 会丢失 ECharts 专有选项"冲突。**歧义**：是把未知选项原样存进 `options`，还是放弃识别、退回 `eh-html`，见 README。
