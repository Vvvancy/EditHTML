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

type Block = TextBlock | ComponentBlock | ForeignBlock;

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

interface ForeignBlock { id: BlockId; kind: 'foreign'; html: string; hash: number }
```

**一切修改都通过 `Transaction`**：

```ts
type Op =
  | { t: 'insertText'; block; offset; text; marks? }
  | { t: 'deleteText'; block; from; to }
  | { t: 'setMark';    block; from; to; mark; value }
  | { t: 'insertBlock'; parent; index; block }
  | { t: 'removeBlock'; id }
  | { t: 'moveBlock';  id; parent; index }
  | { t: 'setType';    id; type }
  | { t: 'setProps';   id; patch }        // JSON Patch 子集
```

每个 Op 必须可逆（`invert(op)`），这是撤销重做与将来协作的基础。

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

**技术选型【待定】**，两条路线：

| 路线 | 优点 | 缺点 |
| --- | --- | --- |
| A. 基于 ProseMirror，组件块用 NodeView | 选区、IME、输入法、粘贴等坑已被填过；成熟 | 模型需映射到 PM schema；块级优化受其限制 |
| B. 自研块层 + 每个文本块内用轻量行内编辑器 | 块级增量、虚拟化完全可控，契合 03 中的算法 | IME/选区/跨块选择工作量大 |

**建议**：M1 用路线 A 快速跑通；同时 `core` 保持独立模型，PM 只作为"视图+输入层"。若 M3 性能测试不达标，再把块层替换为路线 B，`core` 不受影响。

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
