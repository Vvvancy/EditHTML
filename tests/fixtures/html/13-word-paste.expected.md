# 13-word-paste.html — 预期

从 Microsoft Word（中文版）复制或"另存为网页"得到的 HTML：Office 命名空间、`<!--[if gte mso 9]>` 条件注释、`<![if !supportLists]>` 下层条件块、放在注释中的 `<style>`、无引号属性、`mso-*` 样式、`<o:p>`、`MsoListParagraph` 伪列表（项目符号是 Wingdings 字体的 `l`）、`MsoTableGrid`、`v:shape` 与 `file:///C:/…` 临时图片、`<!--StartFragment-->` 标记。

这个样本同时用于**粘贴**（06 §7：先清洗 `on*`、`javascript:`、`mso-*`）和打开文件（保真/转换）。

## 保真模式（06 §2）

- **可编辑**：`h1`、所有 `p.MsoNormal`、伪列表段落中的文字（不包括 `mso-list:Ignore` 中的项目符号 span）、表格单元格中的 `p`。
- `<![if !supportLists]>` 是 parse5 中的"假注释"（bogus comment），`v:shape`、`o:p` 是未知元素；它们都要有正确的源码区间，补丁不能跨越它们。
- `file:///C:/…` 图片在测试环境中不存在：显示为破损图片，不报错。
- **不做任何编辑直接保存：逐字节一致**（无引号属性、单引号 style、tab 缩进的 CSS、条件注释）。

## 转换模式 / 粘贴（06 §3、§7）

清洗：删除所有 `mso-*` 声明、`class=Mso*`、`lang`、`<o:p>`、`v:*`、`w:*`、`<![if …]>` 块、条件注释、`StartFragment` 标记；`<style>` 中只剩 `mso-*` 与 Office 选择器 → **不**生成 `#eh-user-style`（粘贴时从不生成）。

| 原块 | 原生块 |
| --- | --- |
| `div.WordSection1` | 去壳 |
| `h1`（含 `span lang`、`o:p`） | heading 1 "Q4 项目周会纪要" |
| `p` 时间 | paragraph：`<strong>时间：</strong>2026-11-18 14:00`（`b`→`strong`，span 去壳） |
| `p` 参会 | paragraph：`<strong>参会：</strong>张三、李四、` + 颜色 mark(`#C00000`)"王五（请假）" |
| `p` 只含 `<o:p>&nbsp;</o:p>` | 丢弃（Word 的空行）。**歧义**：只含 U+00A0 的段落是否保留（与 README 歧义 8 相同） |
| 3 个 `p.MsoListParagraph[mso-list:l0 level1/level2]` | **列表**：`ul`，2 项 level1 + 1 项 `indent=1`（"二级：先加日志"）；项目符号 span 删除。识别依据是 `mso-list` 中的 `level` 和 `@list l0:level1 {mso-level-number-format:bullet}`（`bullet` → `ul`，`decimal` → `ol`）。**歧义**：06 §3/§7 只说要清洗 `mso-*`，没有说伪列表要重建成列表；本样本预期**重建**（否则会得到行首带 "l" 的段落） |
| `span[background:yellow;mso-highlight:yellow]` | `mark` |
| `p > a > span[color:#0563C1]` | paragraph，链接 "会议资料"；链接默认的蓝色是 Word 的样式 → **不**生成颜色 mark |
| `table.MsoTableGrid`（没有 thead，单元格中只有一个 `p`） | 原生 table，第一行（全是 `b`）提升为表头？**歧义**：`td>b` 是否算表头。本样本预期：保持为 2 行的数据表、没有表头（v1 无表头表格在 md 中无法表达，见 ehtml/06 的 `t2`）；单元格中唯一的 `p` 去壳 |
| `v:shape` + `img[src=file:///…]` | figure，`src` 无法访问 → 报告"本地临时图片缺失，需重新插入"；`v:shape` 丢弃 |

- **转换报告**：原生块 8 个（h1、2 段落、3 列表项、链接段落、表格）+ 1 个图片，HTML 块 0 个；清洗：`mso-*` 声明 N 个、`o:p` N 个、条件注释 2 处；有损：空段落 1 个、缺失图片 1 张。
