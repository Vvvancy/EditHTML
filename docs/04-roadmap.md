# 04 · 路线图与任务拆分

每个任务都写成**可以直接交给一个 Claude Code 会话 / 子 Agent / Thread 独立完成**的粒度：有明确输入、产出和验收标准。任务编号 `T{里程碑}.{序号}`，依赖写在"依赖"列。开始前请阅读 [AGENTS.md](../AGENTS.md)。

## M0 · 工程脚手架（约 1 天）

| ID | 任务 | 产出 | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| T0.1 | pnpm monorepo + TS strict + Vite + Vitest + ESLint/Prettier | 根配置、各 package 的 `package.json`/`tsconfig` | `pnpm build && pnpm test` 通过 | — |
| T0.2 | CI（GitHub Actions）：lint、test、build | `.github/workflows/ci.yml` | PR 上自动运行 | T0.1 |
| T0.3 | 准备测试样本 | `tests/fixtures/` 下 ≥ 20 个 `.ehtml`/`.md` 样本（含边界情况） | 覆盖 01 规范中每种块 | — |

## M1 · 核心：格式能读能写（约 1 周）

| ID | 任务 | 产出 | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| T1.1 | 文档模型与类型定义 | `core/src/model.ts` | 与 02 §2 一致 | T0.1 |
| T1.2 | 流式分词器 + 解析器（受限子集，外来块切片保留） | `core/src/parse/` | fixtures 全部解析；10k 块 < 100ms（Node） | T1.1 |
| T1.3 | 确定性序列化器 | `core/src/serialize/` | 往返 + 幂等属性测试通过 | T1.1 |
| T1.4 | Op / Transaction / invert / Mapping | `core/src/tx/` | 随机 Op 序列 apply+invert 回到原文档 | T1.1 |
| T1.5 | 撤销重做（输入合并） | `core/src/history.ts` | 03 §4 规则的单元测试 | T1.4 |
| T1.6 | EHMD ↔ Doc、Doc → 纯 Markdown | `core/src/ehmd/` | 纯 md 往返无损（CommonMark 测试集子集） | T1.2, T1.3 |
| T1.7 | CLI：`eh convert / eh check / eh fmt` | `packages/cli` | 能把一个 Obsidian 文件夹批量转换 | T1.6 |

## M2 · 阅读与编辑 MVP（约 2 周）

| ID | 任务 | 产出 | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| T2.1 | 渲染器：Doc → DOM，块级哈希 + dirty patch + LIS 列表 diff | `renderer/src/` | "增量 = 全量"属性测试 | T1.4 |
| T2.2 | 编辑器基础（路线 A：ProseMirror 适配层） | `editor/src/pm/` | 文本块全部可编辑，中文 IME 正常 | T2.1 |
| T2.3 | Markdown 输入规则 | `editor/src/input-rules.ts` | 02 §5 列出的规则全部生效 | T2.2 |
| T2.4 | 斜杠菜单 + 模糊匹配 | `editor/src/slash/` | 03 §7 打分算法单测 | T2.2 |
| T2.5 | 浮动格式工具栏、块拖拽手柄 | `editor/src/ui/` | E2E 测试 | T2.2 |
| T2.6 | 组件插件接口 + `callout` `toggle` `math` `mermaid` | `blocks/src/` | 每个组件有 render/fallback/EHMD 测试 | T2.1 |
| T2.7 | 运行时加载器：阅读模式、编辑按钮、File System Access 保存 | `packages/runtime` | 双击 `.ehtml` → 点编辑 → 改字 → 保存成功；体积 < 8KB | T2.2 |
| T2.8 | 主题系统（默认亮/暗主题） | `renderer/themes/` | 无运行时下样式完整 | T2.1 |

**M2 完成即可开始自用（dogfooding）。**

## M3 · 富组件与性能（约 2 周）

| ID | 任务 | 产出 | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| T3.1 | `chart` 组件 + 表格式数据编辑器 | `blocks/src/chart/` | 双击图表可改数据，SVG 降级 | T2.6 |
| T3.2 | 容器块 `tabs` `columns`（嵌套子块编辑） | `blocks/src/` | 子块可编辑、可拖入拖出 | T2.6 |
| T3.3 | `script` / `embed` 沙箱组件 + 信任机制 | `blocks/src/script/` | 脚本无法访问宿主（安全测试） | T2.6 |
| T3.4 | 组件懒渲染 + 渲染缓存（LRU + IndexedDB） | `renderer/src/lazy/` | 100 个图表文档首屏 < 200ms | T3.1 |
| T3.5 | 块虚拟化（Fenwick 树高度索引 + 滚动锚定） | `renderer/src/virtual/` | 10k 块输入 p95 < 16ms | T2.1 |
| T3.6 | 增量序列化 + Worker 保存 + 防抖自动保存 | `core/src/serialize/incremental.ts` | 增量与全量逐字节一致；保存不阻塞主线程 | T1.3 |
| T3.7 | 性能基准套件 | `tests/bench/` | 03 §0 全部指标可测、进 CI | T3.5 |

## M4 · 笔记库体验（约 2 周）

| ID | 任务 | 产出 | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| T4.1 | Web 应用：打开文件夹、文件树、多标签 | `apps/web` | 可管理一个笔记库 | T2.7 |
| T4.2 | 全库搜索（倒排索引，中文 bigram） | `apps/web/src/search/` | 1000 篇笔记搜索 < 50ms | T4.1 |
| T4.3 | 双链 `[[note#block]]` + 反向链接面板 | — | 重命名文件自动更新链接 | T4.1 |
| T4.4 | 外部修改检测 + 块级三方合并 | `core/src/merge/` | git pull 后打开不丢编辑 | T3.6 |
| T4.5 | 源码模式（EHMD 分屏/切换） | `editor/src/source/` | 两侧实时同步 | T1.6 |
| T4.6 | 导出：单文件分享版（资源内联）、纯 md、PDF（打印样式） | `cli` + `apps/web` | — | T1.7 |

## M5 · 生态（之后）

- T5.1 Obsidian 插件（`.ehtml` 视图 + 与 md 互转命令）
- T5.2 用户自定义组件目录 `.ehtml/plugins/`
- T5.3 组件模板库（时间线、对比表、知识卡片、闪卡……）
- T5.4 （可选）基于 CRDT 的多端同步/协作

## 并行建议

- M1 中 T1.2 / T1.3 / T1.4 可由三个 Agent 并行，接口以 T1.1 为准；
- M2 中 T2.6（组件）与 T2.2–T2.5（编辑器）可并行；
- M3 中每个组件一个 Agent，T3.5 / T3.6 独立并行。
