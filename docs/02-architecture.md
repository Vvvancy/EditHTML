# 02 · 架构

## 1. 分层

```
┌────────────────────────────────────────────────────────────┐
│  宿主 (Host)                                                │
│  apps/web  ·  apps/obsidian-plugin  ·  runtime（文件内嵌）   │
│  职责：文件读写、文件夹/笔记列表、设置、快捷键注册             │
└──────────────┬─────────────────────────────────────────────┘
               │ HostAdapter 接口（read/write/listAssets/…）
┌──────────────▼─────────────────────────────────────────────┐
│  editor        选区 · 输入规则 · 斜杠菜单 · 浮动工具栏        │
│                组件块属性面板 · 源码模式 · 拖拽排序            │
├────────────────────────────────────────────────────────────┤
│  renderer      Doc → DOM 增量更新 · 懒加载 · 虚拟化           │
├────────────────────────────────────────────────────────────┤
│  importer      任意 HTML → 原生块 / 保真模式区间补丁          │
│                Markdown(含 Obsidian 方言) → 原生块 · 批量导入  │
├────────────────────────────────────────────────────────────┤
│  blocks        组件块注册表（chart/mermaid/math/tabs/…）     │
│                每个组件 = schema + render + fallback + editor │
├────────────────────────────────────────────────────────────┤
│  core          文档模型 · 解析器 · 序列化器 · 操作/事务        │
│                撤销重做 · 块索引 · EHMD 转换                  │
└────────────────────────────────────────────────────────────┘
```

依赖方向**只能自上而下**：`core` 不依赖任何 DOM API（可在 Node / Worker 中运行），`renderer` 不依赖 `editor`。

## 2. 核心数据模型（packages/core）

```ts
type BlockId = string;

interface Doc {
  meta: DocMeta;
  root: BlockId[];                 // 顶层块顺序
  blocks: Map<BlockId, Block>;     // 扁平存储，便于 O(1) 查找
  version: number;                 // 每次事务 +1
}

type Block = TextBlock | ComponentBlock | HtmlBlock;

interface TextBlock {
  id: BlockId; kind: 'text';
  type: 'p' | 'h1' | … | 'code' | 'list' | 'table' | 'quote' | 'hr' | 'figure';
  attrs: Record<string, string>;
  content: InlineNode[];           // 行内富文本（文本 + marks）
  hash: number;                    // 内容哈希，见 03-algorithms §2
}

interface ComponentBlock {
  id: BlockId; kind: 'component';
  type: string;                    // 'chart' | 'tabs' | …
  props: unknown;                  // 经 schema 校验的 JSON
  slots?: BlockId[][];             // 容器块的子块
  fallback?: string;               // 降级 HTML 缓存
  hash: number;
}

// 原样保留的任意 HTML（eh-html 块），可编辑，见 06-import.md §4
interface HtmlBlock { id: BlockId; kind: 'html'; html: string; spans?: SourceSpanIndex; hash: number }
```

> **实现说明（T1.1）**：完整定义见 `packages/core/src/model.ts`，以代码为准。相对上面的草图有以下细化：
> - **列表项是独立块**：`type: 'li'`，`attrs.list = 'ul'|'ol'`、`attrs.indent`（嵌套层级）、`attrs.task = 'done'|'todo'`；连续 `li` 序列化时归组为 `<ul>`/`<ol>`，`data-eh` 写在 `<li>` 上。这样所有文本编辑都是"块 + 偏移"，与 ProseMirror/Notion 的扁平列表一致。
> - **表格**：`type: 'table'`，结构放在 `TextBlock.table`（`head` / `body` / `align`），`content` 为空。
> - **引用** `quote` 为单段行内内容（多行用 `br`）；需要多段/嵌套内容时用 `callout`。
> - **行内节点** = `text`（带 marks）| `br` | `atom`（`span[data-eh-inline]`，偏移长度 1）。偏移以 UTF-16 码元计；marks 按 `MARK_ORDER` 排序，行内内容始终规范化（`normalizeInline`）。
> - `Doc` 增加 `head`（lang / title / 主题与用户样式 / 运行时 src / 其他 head 内容），用于文件往返；`ComponentBlock` 增加 `attrs`。
> - 哈希：FNV-1a 32 位，覆盖除 `hash` 外的所有字段（`computeBlockHash`）；容器块只覆盖自身 `slots` 的 ID 列表。
> - 模型对象不可变；`docEquals` / `validateDoc` 用于测试；`src/testing/arbitraries.ts` 提供 fast-check 随机文档生成器。

**一切修改都通过 `Transaction`**：

```ts
type Op =
  // 文本（偏移 = UTF-16 码元，br/atom 计 1）
  | { t: 'insertText';    block; offset; text; marks? }
  | { t: 'insertContent'; block; offset; content }      // br / atom / 粘贴；也是 deleteText 的逆
  | { t: 'deleteText';    block; from; to }
  | { t: 'setMark';       block; from; to; mark; value }
  // 块
  | { t: 'insertBlock'; parent; slot; index; block; descendants? }  // parent null = 顶层
  | { t: 'removeBlock'; id }                            // 连同子树
  | { t: 'moveBlock';   id; parent; slot; index }
  | { t: 'setType';     id; type }
  | { t: 'setProps';    id; patch }                     // JSON Patch 子集（add/remove/replace）
  | { t: 'setAttrs';    id; attrs }                     // 值为 null 表示删除
  | { t: 'setTable';    id; table } | { t: 'setCell'; id; section; row; col; content }
  | { t: 'setFallback'; id; fallback }
  | { t: 'insertSlot';  id; slot } | { t: 'removeSlot'; id; slot }
  // 文档级
  | { t: 'setMeta'; patch } | { t: 'setHead'; head }
```

每个 Op 必须可逆，这是撤销重做与将来协作的基础。**实现（T1.4）**：`apply` 时把被删除/被覆盖的数据捕获进 Op（如 `deleteText.deleted`、`removeBlock.removed`），因此 `invert(op): Op[]` 不需要文档；`apply(doc, tx)` 返回新文档、`dirty`（新旧文档中对象不同的块 ID，含被删除块与 slots 变化的父容器）、`rootChanged` 与 `Mapping`。外来块只读，只能插入/删除/移动。完整定义见 `packages/core/src/tx/`。

## 3. 数据流

```
用户输入
  → editor 拦截 beforeinput / keydown，生成 Op[]
  → core.apply(tx)  —— 纯函数，产出新 Doc + 变更集 dirtySet
  → renderer.patch(dirtySet)  —— 只更新受影响的块 DOM
  → history.push(tx)          —— 合并相邻输入
  → saver.schedule()          —— 防抖后在 Worker 中序列化并写回
```

关键点：**DOM 不是数据源**。contenteditable 只作为输入事件来源，内容以模型为准，渲染器负责把模型同步回 DOM（与 ProseMirror / Lexical 同类思路）。

## 3.5 两条文档路径

| 路径 | 文件 | 数据源 | 保存 |
| --- | --- | --- | --- |
| 原生 | `.ehtml` / `.md`（导入后） | `core` 的 `Doc` 模型 | 规范形式序列化 |
| 保真 | 任意 `.html` | **原始源码字符串** + 源码区间索引 | 区间补丁，只改动改过的字节 |

保真路径由 `packages/importer/preserve` 实现：编辑器在其上复用选区、工具栏、输入规则，但事务产出的是"源码补丁"而不是 Doc Op。两条路径共享同一套撤销重做框架（补丁同样可逆）。

## 4. 组件块插件接口（packages/blocks）

```ts
interface BlockPlugin<P> {
  type: string;
  schema: JSONSchema;                     // props 校验 + 默认值
  render(el: HTMLElement, props: P, ctx): Disposable;   // 交互式渲染（可异步加载依赖）
  fallback(props: P): string | Promise<string>;         // 静态降级 HTML/SVG
  editor?: PropsEditor<P>;                // 属性面板（不提供则用 schema 自动生成表单）
  toEHMD?(props: P): string;  fromEHMD?(src: string): P;
  toMarkdown?(props: P): string;          // 导出纯 md 时的降级
}
```

第三方组件通过同一接口注册，用户可以在笔记库的 `.ehtml/plugins/` 中放自定义组件。

## 5. 编辑器（packages/editor）

**技术选型：路线 A（ProseMirror）✅**（决定见 05 #1）。两条路线对比：

| 路线 | 优点 | 缺点 |
| --- | --- | --- |
| A. 基于 ProseMirror，组件块用 NodeView | 选区、IME、输入法、粘贴等坑已被填过；成熟 | 模型需映射到 PM schema；块级优化受其限制 |
| B. 自研块层 + 每个文本块内用轻量行内编辑器 | 块级增量、虚拟化完全可控，契合 03 中的算法 | IME/选区/跨块选择工作量大 |

**决定**：M2 用路线 A 快速跑通；同时 `core` 保持独立模型，PM 只作为"视图+输入层"。若 M3 性能测试不达标，再把块层替换为路线 B，`core` 不受影响。

主要交互：
- Markdown 输入规则：行首 `# `、`- `、`1. `、`> `、```` ``` ````、`---`，行内 `**x**`、`` `x` ``、`[[x]]`；
- `/` 斜杠菜单插入任意块（模糊匹配，见 03 §7）；
- 选中文本浮出格式工具栏；
- 组件块：单击选中显示属性面板，双击进入组件内部编辑（如直接改图表数据表格）；
- 块左侧拖拽手柄排序；`Ctrl/Cmd + /` 切换源码模式（EHMD）。

## 6. 宿主

| 宿主 | 文件访问 | 说明 |
| --- | --- | --- |
| `runtime`（文件内嵌） | File System Access API / 下载 | 零安装：浏览器打开即编辑 |
| `apps/web` | File System Access API 打开整个笔记文件夹 | 带侧边栏、搜索、双链 |
| `apps/obsidian-plugin` | Obsidian Vault API | 注册 `.ehtml` 视图，复用 Obsidian 的同步与文件管理 |
| `cli` | Node fs | 转换、校验、批量导出 |

## 7. 技术栈（建议）

- TypeScript（strict），pnpm workspace monorepo，Vite 构建；
- 测试：Vitest（单元/属性测试，fast-check）+ Playwright（E2E、性能基准）；
- 解析：`core` 自带一个针对受限子集的流式 HTML 分词器（不依赖 DOM，见 03 §1），外来块再交给 `parse5`；
- 图表：ECharts 或 Vega-Lite 【待定】；Mermaid；KaTeX。
