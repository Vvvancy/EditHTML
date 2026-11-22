# 12-tables.html — 预期

六种表格：简单表格（用 `style="text-align"` 和 `align` 两种方式写对齐）、没有 `thead`（`tbody` 由解析器隐式补上）、`colspan`/`rowspan`、`caption`/`tfoot`/`colgroup`、单元格中有块级内容、带嵌套表格的老式布局表格。

## 保真模式（06 §2）

- **可编辑**：所有 `th`、`td`、`caption`、`h1`、`h2`，单元格中的 `p`、`li`、`pre`。
- 表 2 没有写 `<tbody>`：parse5 会补出一个**没有源码位置**的 `tbody` 元素。区间映射必须跳过这类隐式元素，不能为它生成补丁（否则保存时会插入 `<tbody>`）。
- 在表格中插入一行（结构性操作）：新的 `<tr>` 沿用相邻行的缩进风格（表 1 是 4 空格加一行一个 `tr`，表 4 的 `tbody` 是一行写完的）。
- **不做任何编辑直接保存：逐字节一致**。

## 转换模式（06 §3；01 §3.2 表格"仅 thead/tbody/tr/th/td"）

| 原块 | 原生块 |
| --- | --- |
| `<style>` | `#eh-user-style` |
| `h1`、`h2` ×6 | heading |
| 表 1 | 原生 table：表头 3 列，`data-eh-align` = 无 / center / right（`style="text-align"` 和 `align` 属性都要识别）；`strong` 保留 |
| 表 2（没有 thead，第一行全是 `th`） | 原生 table，第一行提升为 thead；`a \| b` 中的 `\|` 保持为字面文本（导出 md 时转义）；空单元格保留 |
| 表 3（`colspan`、`rowspan`） | **`eh-html` 块**：v1 表格模型不能表示合并单元格。**歧义**：是否展开成重复单元格的原生表格（有损），见 README |
| 表 4（`caption`、`tfoot`、`colgroup`） | **`eh-html` 块**（与 ehtml/16 对 caption/tfoot 的处理一致，该处仍是 TBD）。另一种做法：caption → 表格前的段落、`tfoot` 行并入 `tbody`，有损 |
| 表 5（单元格中有 `p`、`ul`、`pre`） | **`eh-html` 块**（单元格只能放行内内容） |
| 表 6（布局表格，嵌套 `table`） | **`eh-html` 块**。不尝试识别为 `columns` |

- **转换报告**：原生 table 2 个，HTML 块 4 个（原因分别是：合并单元格、caption/tfoot、单元格中有块级内容、嵌套表格），heading 7 个，页面样式 1 段。
