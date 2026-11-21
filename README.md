# EditHTML

> 像 Markdown 一样随手编辑，像网站一样好看。

EditHTML 是一种面向**个人笔记**的文档格式与编辑器：

- 文件本身就是**合法的、自包含的 HTML**，双击即可在任意浏览器里阅读，支持图表、交互组件、自定义样式与脚本；
- 打开后能**直接在渲染好的页面上编辑**（所见即所得），不需要回到源码里改；
- 同时保留 Markdown 的输入手感（`#` 标题、`-` 列表、`` ` `` 代码、`/` 命令插入组件），渲染与保存都足够快。

一句话：**Markdown 的编辑体验 + HTML 的表现力**。

## 文档目录

| 文档 | 内容 |
| --- | --- |
| [docs/00-vision.md](docs/00-vision.md) | 动机、目标用户、设计原则、非目标 |
| [docs/01-format-spec.md](docs/01-format-spec.md) | `.ehtml` 文件格式规范（草案 v0.1） |
| [docs/02-architecture.md](docs/02-architecture.md) | 整体架构与模块划分 |
| [docs/03-algorithms.md](docs/03-algorithms.md) | 性能与算法优化方案 |
| [docs/04-roadmap.md](docs/04-roadmap.md) | 里程碑与可分派给 Agent 的任务清单 |
| [docs/05-open-questions.md](docs/05-open-questions.md) | 待决策问题 |
| [AGENTS.md](AGENTS.md) | 给 Claude Code / 子 Agent 的工作约定 |

## 仓库结构（规划）

```
EditHTML/
├── docs/                    设计文档
├── packages/
│   ├── core/                文档模型、解析器、序列化器、操作/事务、撤销重做
│   ├── renderer/            只读渲染（增量 DOM 更新、懒加载、虚拟化）
│   ├── editor/              就地编辑：选区、输入规则、斜杠菜单、工具栏
│   ├── blocks/              富组件块：chart / mermaid / math / tabs / callout / embed / script
│   ├── runtime/             嵌入到 .ehtml 文件中的轻量加载器（阅读→编辑切换、保存）
│   └── cli/                 命令行：md ↔ ehtml 转换、格式校验、批量导出
├── apps/
│   ├── web/                 独立 Web 编辑器（打开/保存本地文件夹）
│   └── obsidian-plugin/     Obsidian 插件（后期）
├── examples/                示例笔记
└── tests/
    ├── fixtures/            解析/序列化往返测试样本
    └── e2e/                 端到端测试
```

## 状态

设计阶段。实现按 [docs/04-roadmap.md](docs/04-roadmap.md) 中的任务拆分推进。
