<div align="center">

# ✍️ EditHTML

**像 Markdown 一样随手编辑，像网站一样好看。**

一种面向个人笔记的文档格式与编辑器 —— 文件本身就是网页，打开就能直接在页面上改。

[![CI](https://github.com/Vvvancy/EditHTML/actions/workflows/ci.yml/badge.svg)](https://github.com/Vvvancy/EditHTML/actions/workflows/ci.yml)
![status](https://img.shields.io/badge/status-M1%20开发中-orange)
![spec](https://img.shields.io/badge/spec-v0.1%20草案-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-workspace-f69220?logo=pnpm&logoColor=white)

[设计文档](docs/) · [格式规范](docs/01-format-spec.md) · [路线图](docs/04-roadmap.md) · [参与开发](AGENTS.md)

</div>

---

## 为什么

在 Obsidian 里记笔记，表现力只有标题、列表、代码和图片；想要图表、标签页、折叠区、交互演示，只能靠各家插件的私有语法。
换成 HTML 网站，表现力无上限，可改一个字都得回源码里翻。

**EditHTML 想要两边的好处：**

| 来自 Markdown | 来自 HTML / 网站 |
| :-- | :-- |
| ⚡ 随时修改、即时生效 | 🎨 展示效果好、样式自由 |
| ⌨️ `#` `-` `` ` `` `/` 快捷输入 | 📊 图表、交互组件、自定义脚本 |
| 🗂️ 纯文本友好、git diff 干净 | 🌐 任何浏览器双击即开 |

> 打开一个笔记 = 打开一个漂亮的网页；在这个网页上直接点、直接改、直接存。

## ✨ 核心特性

- **文件即网页** —— `.ehtml` 是合法、自包含的 HTML5，没有编辑器也能完整阅读
- **就地编辑** —— 在渲染好的页面上所见即所得地修改，包括图表数据和组件配置
- **Markdown 手感** —— 输入规则兼容 Markdown 习惯；`.md` 可无损导入、导出
- **块是一等公民** —— 文本块 + 可扩展的组件块：`chart` `mermaid` `math` `callout` `tabs` `columns` `toggle` `embed` `script`
- **稳定的序列化** —— 同样的内容永远保存成同样的字节，改一个字 git diff 只动一行
- **快** —— 目标：万块长文档按键响应 p95 < 16ms，打开 < 500ms
- **安全** —— 自定义脚本运行在 `iframe sandbox` 中，来源不明的文件默认不执行脚本

## 👀 长什么样

一个 `.ehtml` 文件就是普通 HTML，加了几个 `data-eh` 属性和 `<eh-*>` 组件：

```html
<main id="eh-doc">
  <h1 data-eh="b1">二分查找</h1>
  <p data-eh="b2">时间复杂度 <strong>O(log n)</strong>，前提是数组<mark>有序</mark>。</p>
  <ul>
    <li data-eh="b3" data-eh-task="done">理解循环不变量</li>
    <li data-eh="b4" data-eh-task="todo">刷 10 道变体题</li>
  </ul>
  <eh-chart data-eh="b5">
    <script type="application/json">{"type":"bar","data":{"x":["线性","二分"],"y":[1000,10]}}</script>
    <!--eh:fallback--><img src="data:image/svg+xml;..." alt="柱状图"><!--eh:fallback-->
  </eh-chart>
</main>
```

- **JSON 是真相，降级内容是缓存**：没有运行时也能看到静态 SVG；有运行时则是可交互的图表
- 喜欢敲源码？还有等价的 **EHMD** 文本视图（Markdown + `:::chart` 指令块），双向无损转换

详见 [格式规范](docs/01-format-spec.md)。

## 🏗️ 架构

```
 宿主   apps/web · obsidian-plugin · runtime（文件内嵌加载器）
          │  HostAdapter
 editor   选区 · 输入规则 · 斜杠菜单 · 工具栏     ← ProseMirror 适配层
 renderer Doc → DOM 增量更新 · 懒加载 · 虚拟化
 blocks   组件块注册表（schema + render + fallback）
 core     文档模型 · 解析器 · 序列化器 · 事务/撤销  ← 零 DOM 依赖，可跑在 Node / Worker
```

依赖只能自上而下；DOM 不是数据源，一切修改都经过 `Transaction`。详见 [架构](docs/02-architecture.md) 与 [算法](docs/03-algorithms.md)。

## 🗺️ 进度

| 里程碑 | 内容 | 状态 |
| :-- | :-- | :-: |
| **M0** 工程脚手架 | monorepo、CI、测试样本 | ✅ |
| **M1** 核心读写 | 模型 ✅ · 序列化器 ✅ · 事务 ✅ · 解析器 🚧 · 撤销 · EHMD · CLI | 🚧 |
| **M2** 阅读与编辑 MVP | 增量渲染、编辑器、输入规则、斜杠菜单、组件、运行时、主题 | ⏳ |
| **M3** 富组件与性能 | 图表、容器块、沙箱脚本、懒渲染、虚拟化、增量保存 | ⏳ |
| **M4** 笔记库体验 | Web 应用、全库搜索、双链、外部修改合并、源码模式、导出 | ⏳ |
| **M5** 生态 | Obsidian 插件、自定义组件、模板库 | ⏳ |

任务拆分与验收标准见 [路线图](docs/04-roadmap.md)。

## 🚀 本地开发

需要 Node ≥ 22.12 与 pnpm。

```bash
git clone https://github.com/Vvvancy/EditHTML.git
cd EditHTML
pnpm install

pnpm test       # Vitest 单元 + fast-check 属性测试
pnpm lint       # 类型检查 + ESLint + Prettier
pnpm build      # tsc 项目引用 + Vite
pnpm --filter @edithtml/web dev   # Web 应用开发服务器
```

## 📁 仓库结构

```
EditHTML/
├── packages/
│   ├── core/        文档模型、解析器、序列化器、事务、撤销重做、EHMD 转换
│   ├── renderer/    只读渲染（增量 DOM 更新、懒加载、虚拟化）
│   ├── editor/      就地编辑：选区、输入规则、斜杠菜单、工具栏
│   ├── blocks/      富组件块：chart / mermaid / math / tabs / callout / embed / script
│   ├── runtime/     嵌入 .ehtml 的轻量加载器（< 8KB gzip）
│   └── cli/         eh convert / check / fmt
├── apps/
│   ├── web/              独立 Web 编辑器
│   └── obsidian-plugin/  Obsidian 插件（M5）
├── docs/            设计文档
├── examples/        示例笔记
└── tests/
    ├── fixtures/    48 个解析/序列化往返样本
    ├── e2e/         Playwright 端到端测试
    └── bench/       性能基准
```

## 📚 文档

| 文档 | 内容 |
| :-- | :-- |
| [00 · 愿景](docs/00-vision.md) | 动机、目标用户、设计原则、非目标 |
| [01 · 格式规范](docs/01-format-spec.md) | `.ehtml` 文件格式（草案 v0.1），含规范序列化细则 |
| [02 · 架构](docs/02-architecture.md) | 分层、数据模型、数据流、插件接口 |
| [03 · 算法](docs/03-algorithms.md) | 流式解析、增量渲染、虚拟化、增量保存、合并 |
| [04 · 路线图](docs/04-roadmap.md) | 里程碑与可分派任务 |
| [05 · 待决问题](docs/05-open-questions.md) | 尚未拍板的设计选择 |

## 🤝 参与开发

项目按 [路线图](docs/04-roadmap.md) 中的任务编号推进，每个任务一个分支、一个 PR。开工前请阅读 [AGENTS.md](AGENTS.md)：

- `core` 禁止使用 DOM API；依赖方向 `editor → renderer → blocks → core`
- TypeScript strict，不用 `any`；公共 API 写 TSDoc
- 解析 / 序列化 / 事务改动必须附 fast-check 属性测试
- 合并前 `pnpm lint && pnpm test && pnpm build` 全部通过
