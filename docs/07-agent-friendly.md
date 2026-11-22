# 07 · 对 AI Agent 友好

## 0. 目标

> 人和 AI agent（Claude Code、Cursor、Codex、浏览器 agent、MCP 客户端……）都是 EditHTML 的一等用户。

具体来说：
1. **读得省**：agent 用很少的 token 就能理解一篇笔记的结构，并只读取需要的部分；
2. **改得准**：agent 能按块 ID 精确定位和修改，不需要重写整个文件，也不会误伤其他内容；
3. **写得对**：agent 手写的 `.ehtml` / EHMD 即使不完全规范也能被接受，并得到机器可读的错误与修复建议；
4. **改得安全**：agent 的修改可预览、可整体撤销、可逐块接受/拒绝；与用户同时编辑不丢内容；
5. **多种接入方式**：直接改文件、CLI、MCP、浏览器内 JS API 四条路径，能力一致。

## 1. 格式层：让文件本身适合 agent 用文本工具编辑

大多数编码 agent 用"读文件 + 字符串替换（str_replace）"来改文件，格式要为此优化：

| 设计 | 对 agent 的好处 |
| --- | --- |
| 规范形式：每个顶层块独占一行起始，属性顺序固定（01 §6） | 字符串替换的锚点稳定、唯一；diff 小 |
| 稳定的块 ID `data-eh="k9x"` | 可以直接用 ID 作为定位锚点，不怕前后文相同 |
| 组件数据是单行 JSON，降级内容用 `<!--eh:fallback-->` 包裹 | agent 只改 JSON，不需要也不应该生成降级内容 |
| **降级内容可省略/可过期**：agent 写入时可以不写 fallback，或修改 JSON 后不管旧 fallback | 运行时、编辑器、`eh fmt` 发现 `props` 哈希与 fallback 不符时自动重建（标记 `data-eh-stale`） |
| **宽容解析**：缺 ID 自动分配、缺 JSON 用 schema 默认值、非规范缩进/属性顺序都接受 | agent 写出"差不多对"的内容就能用，`eh fmt` 一键规范化 |
| EHMD 视图（Markdown + 指令块） | 比 HTML 省 50% 以上 token，agent 最熟悉 Markdown |

**大块资源外置**：data URI 图片、超长 SVG fallback 会浪费 agent 的上下文；规范建议资源放 `assets/`，降级内容超过阈值（如 4KB）时外置为 `assets/.eh-cache/<hash>.svg`。【待定，见 05】

## 2. 读取：分层视图，按需取用

所有接入方式（CLI / MCP / JS API）都提供同一组**视图**：

| 视图 | 内容 | 典型大小 |
| --- | --- | --- |
| `outline` | 标题树 + 每块一行摘要：`k9x  chart  "月度支出柱状图"`；含块数、字数 | 原文的 2–5% |
| `ehmd` | EHMD 文本（不含 fallback、不含主题 CSS） | 原文的 30–50% |
| `json` | Doc 模型 JSON（结构化，便于程序处理） | — |
| `html` | 规范 `.ehtml`（可选 `--no-fallback`） | 原文 |

- 都支持**范围读取**：按块 ID（`#k9x`）、按标题小节（`#"## 算法"` 取整节）、按块区间（`k9x..m2a`）；
- 都支持**查询**：按类型（`type=chart`）、按文本（全文/正则）、按标签、按链接目标；
- 读取结果带**版本号**（文档哈希），用于后续修改的并发校验（§3）。

## 3. 修改：基于块的操作，而不是重写全文

### 3.1 操作格式（agent 用的高层操作，编译成 core 的 Op）

```json
{
  "ifMatch": "doc-hash-abc123",
  "ops": [
    { "op": "replaceBlock", "id": "b2", "ehmd": "这是改写后的段落，带 **粗体**。" },
    { "op": "insertAfter",  "id": "b2", "ehmd": ":::callout 提示 {kind=tip}\n记得复习\n:::" },
    { "op": "setProps",     "id": "b3", "patch": [{ "op": "replace", "path": "/data/y/1", "value": 7 }] },
    { "op": "moveBlock",    "id": "t1", "after": "b1" },
    { "op": "removeBlock",  "id": "x9" },
    { "op": "replaceText",  "id": "b5", "find": "旧词", "replace": "新词" }
  ]
}
```

- 新内容用 **EHMD 片段**（或 HTML 片段）描述，agent 不需要手写块 ID 和规范 HTML；
- **原子性**：整批要么全部成功要么全部不生效；
- **乐观并发**：`ifMatch` 与当前文档哈希不符时拒绝，并返回最新 outline，让 agent 重新读取后再改；
- `dryRun: true`：返回将产生的 diff 与新 outline，不写入；
- 返回值：新文档哈希、受影响块 ID、新插入块的 ID、规范化后的 diff。

### 3.2 任意 HTML（保真模式）同样可操作

对没有 `data-eh` 的普通 HTML，用保真模式的源码区间索引（06 §2）提供等价能力：
- `outline` 视图按 DOM 结构给每个可编辑容器分配**临时路径 ID**（如 `p:main>section[2]>p[1]`，基于结构路径 + 文本哈希，文档不变则 ID 不变）；
- 操作 `setText / setHtml / insertAfter / remove` 编译为区间补丁，**未改动字节保持不变**。

## 4. 诊断：机器可读的错误与修复建议

`eh check --json`（以及 MCP 的 `validate`）输出：

```json
{ "ok": false, "diagnostics": [
  { "code": "EH102", "severity": "error", "block": "b3", "line": 41, "col": 12,
    "message": "chart.props.data.y 应为数字数组", "fix": { "op": "setProps", "id": "b3", "patch": [...] } }
]}
```

- 错误码稳定、有文档（`docs/diagnostics.md`，按码列出含义与示例）；
- 能自动修复的给出 `fix`（就是一个合法的 §3 操作），`eh fmt --fix` 一键应用；
- 消息简短、指向具体块与位置，避免 agent 反复试错。

## 5. 自描述：agent 不需要先读全部文档

- `eh schema [type]`：输出全部块类型及其 JSON Schema、EHMD 写法示例、默认值；
- `eh guide`：输出一份**精简格式指南**（< 2000 token），可直接放进 agent 的 system prompt；仓库根目录同步生成 `llms.txt`；
- 每个笔记库可放 `.ehtml/AGENTS.md`：告诉 agent 这个库的约定（目录结构、标签体系、模板）。

## 6. MCP 服务器（`packages/mcp`）

让 Claude 等 MCP 客户端直接操作笔记库：

| 工具 | 作用 |
| --- | --- |
| `list_notes` | 列出笔记（路径、标题、标签、修改时间），支持过滤 |
| `search` | 全库搜索（复用 T5.3 索引；未就绪时退化为扫描） |
| `read_note` | 读取，参数：`view`（outline/ehmd/json/html）、`range`、`query` |
| `edit_note` | 执行 §3 操作批，支持 `ifMatch` / `dryRun` |
| `create_note` | 从 EHMD 或模板新建 |
| `import` | 导入 `.md` / `.html` / 文件夹（06） |
| `validate` | §4 诊断 |
| `list_block_types` | §5 schema |
| `render_preview` | 渲染某块或整篇为 PNG/SVG，供多模态 agent 检查效果 |

- 资源（resources）：`note://<path>` 暴露笔记 outline；
- 运行方式：`eh mcp --vault <dir>`（stdio），可选只读模式、路径白名单。

## 7. 与正在编辑的用户共存

agent 直接改文件、用户同时在编辑器里打开同一篇时：
- 编辑器监听文件变化 → 块级三方合并（03 §6、T5.5），不覆盖用户未保存的内容；
- 若编辑器正在运行，CLI / MCP 优先通过**本地通道**（编辑器暴露的 localhost WebSocket，需令牌）提交操作，直接进入编辑器的事务系统，避免文件级冲突；
- agent 的修改带作者标记 `author: "agent:<name>"`：
  - 编辑器高亮本次被 agent 修改的块，提供"逐块接受/拒绝"和"整批撤销"；
  - 撤销历史中 agent 的一批操作是**一个**撤销单元。

## 8. 浏览器内 agent（Claude in Chrome、computer use）

页面上暴露稳定的 JS API，agent 不必模拟点击和键盘：

```js
window.EditHTML.outline()                // 同 §2
window.EditHTML.read({ view: 'ehmd', range: '#k9x' })
window.EditHTML.apply({ ops: [...] })    // 同 §3，进入撤销历史
window.EditHTML.save()
```

- DOM 上保留 `data-eh` ID 和语义化 ARIA（工具栏按钮有 `aria-label`），截图型 agent 也能可靠识别；
- 来源不明页面中，API 默认只读，写操作需要用户在页面上确认一次。

## 9. 评估

建立一组 agent 任务基准（`tests/agent-evals/`），例如：
- "在《算法》一节后插入一个对比冒泡/快排复杂度的表格"
- "把所有 `#待办` 标签的任务列表汇总到新笔记"
- "把这个 HTML 页面里的错别字改掉，不要动其他内容"

指标：成功率、所用 token、调用次数、是否误改其他块（与期望文档比对）。分别测"直接改文件""CLI""MCP"三种路径。
