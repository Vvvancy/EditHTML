# 16-bom-crlf.html — 预期

Windows 记事本风格：UTF-8 BOM（`EF BB BF`）+ CRLF 换行（`pre` 中也是 CRLF），一个段落中混入了单独的 LF（混合换行），一个段落末尾有空格。这个文件只能按字节读写：`tests/fixtures/.gitattributes` 中的 `* -text` 保证 git 不会改动它。

## 保真模式（06 §2）

- 源码区间是原始字符串中的偏移（UTF-16 码元）。parse5 内部会把 CRLF 当作一个换行处理，但 `sourceCodeLocationInfo` 必须指向**原始**输入中的位置（测试需验证这一点）。读文件时必须**不**去掉 BOM（注意 `TextDecoder` 默认会去掉 BOM，要用 `ignoreBOM: true`），也**不**转换换行，否则所有偏移都会错位。测试：只编辑"鸡蛋"→"鸭蛋"，输出与输入只有这几个字节不同，BOM 和所有 `\r\n` 保留。
- **可编辑**：`h1`、`p`、`li`、`pre`。
- 在 `ul` 中插入新项：新行使用 **CRLF**（沿用相邻兄弟节点的换行风格）和 2 空格缩进。**歧义**：06 §2 第 7 步只说"缩进风格"，没有说换行符，见 README。
- 编辑 `pre`：用户输入的换行写成 CRLF（与 `pre` 中现有的换行一致）。
- **不做任何编辑直接保存：逐字节一致**（包括 BOM、CRLF、单独的 LF、行尾空格）。

## 转换模式（06 §3）

| 原块 | 原生块 |
| --- | --- |
| `h1` | heading 1 "购物清单" |
| `p` | paragraph |
| `ul` | 列表 2 项 |
| `pre` | code 块，内容 `第一行\n\t第二行（tab 缩进）`（开头的换行丢弃；CRLF → LF；tab 保留） |
| `p` 末尾有空格 | paragraph，末尾空格修剪（与 ehtml/19 的 TBD 相同） |
| `p` 中有单独的 LF | paragraph，换行折叠为空格 |

- 输出 `.ehtml`：LF 换行、无 BOM（与 ehtml/24 的 TBD 一致；本样本预期去掉 BOM）。
- **转换报告**：原生块 7 个（h1、3 段落、2 个列表项、1 个代码块），HTML 块 0 个；提示"已去掉 BOM、换行已转换为 LF"。
