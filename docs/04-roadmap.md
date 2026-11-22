# 04 · 路线图与任务拆分

每个任务都写成**可以直接交给一个 Claude Code 会话 / 子 Agent / Thread 独立完成**的粒度：有明确输入、产出和验收标准。任务编号 `T{里程碑}.{序号}`，依赖写在"依赖"列。开始前请阅读 [AGENTS.md](../AGENTS.md)。

状态标记：⬜ 未开始 · 🟨 进行中 · ✅ 完成（完成时在 PR 中把 ⬜ 改为 ✅）。

## 总览

| 里程碑 | 目标 | 完成后能做什么 |
| --- | --- | --- |
| M0 | 工程脚手架 | 能 build / test |
| M1 | 核心格式 + Markdown 导入 | `.md ↔ .ehtml` 命令行互转 |
| **M2** | **保真模式：任意 HTML 就地编辑** | **打开已有的 HTML 笔记直接改字并保存（第一个可用版本）** |
| M3 | 原生编辑器 MVP | 新建/编辑 `.ehtml` 笔记，Markdown 快捷输入 |
| M4 | HTML 转换 + 富组件 + 性能 | 任意 HTML 一键转原生；图表、标签页等；长文档流畅 |
| M5 | 笔记库体验 + 批量导入 | 整个 Obsidian 库导入，搜索、双链 |
| M6 | 生态 | Obsidian 插件、自定义组件 |

> 把"保真模式"放在原生编辑器之前：它实现相对简单（不需要完整文档模型），却能立刻让现有的 HTML 笔记变得可编辑。

---

## M0 · 工程脚手架

| ID | 任务 | 产出 | 验收 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- |
| T0.1 | pnpm monorepo + TS strict + Vite + Vitest + ESLint/Prettier；为 `packages/*`、`apps/*` 建 `package.json`/`tsconfig` | 根配置 + 各包空壳（导出一个占位函数） | `pnpm install && pnpm build && pnpm test && pnpm lint` 全通过 | — | ✅ |
| T0.2 | GitHub Actions CI：lint、test、build | `.github/workflows/ci.yml` | PR 上自动运行且通过 | T0.1 | ✅ |
| T0.3 | 测试样本 | `tests/fixtures/{ehtml,md,html,obsidian}/` 共 ≥ 30 个样本：规范内各种块；CommonMark/GFM/Obsidian 方言（双链、callout、嵌入、块 ID、frontmatter）；真实风格的任意 HTML（手写笔记、AI 生成带 CSS/JS 的页面、含 ECharts、含 KaTeX、含 `details`） | 覆盖 01 规范每种块与 06 每张映射表的每一行；每个样本附 `.expected.*` 或说明 | — | ✅ |

## M1 · 核心格式 + Markdown 导入

| ID | 任务 | 产出 | 验收 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- |
| T1.1 | 文档模型与类型定义（含 `HtmlBlock`） | `core/src/model.ts` | 与 02 §2 一致 | T0.1 | ✅ |
| T1.2 | 流式分词器 + 解析器（受限子集；规范外内容 → `HtmlBlock` 切片保留） | `core/src/parse/` | fixtures/ehtml 全部解析；10k 块 < 100ms（Node） | T1.1 | ✅ |
| T1.3 | 确定性序列化器 | `core/src/serialize/` | 往返 + 幂等属性测试 | T1.1 | ✅ |
| T1.4 | Op / Transaction / invert / Mapping | `core/src/tx/` | 随机 Op 序列 apply+invert 回到原文档 | T1.1 | ✅ |
| T1.5 | 撤销重做（输入合并） | `core/src/history.ts` | 03 §4 规则单测 | T1.4 | ✅ |
| T1.6 | EHMD（Markdown + 指令块）↔ Doc | `core/src/ehmd/` | 往返无损 | T1.2, T1.3 | ✅ |
| T1.7 | **Markdown 导入器**：CommonMark + GFM + Obsidian 方言 → Doc（06 §5 全表）；Doc → `.md` 导出 | `importer/src/markdown/` | `md→ehtml→md` 对 fixtures/md、fixtures/obsidian 逐字节一致（空白规范化除外）；内嵌 HTML 落入 `HtmlBlock` | T1.2, T1.3 | ✅ |
| T1.8 | CLI：`eh convert / eh check / eh fmt` | `packages/cli` | `eh convert note.md` 产出可在浏览器打开的 `.ehtml` | T1.7 | ✅ |

## M2 · 保真模式：任意 HTML 就地编辑（第一个可用版本）

实现 [06-import.md §2](06-import.md)。

| ID | 任务 | 产出 | 验收 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- |
| T2.1 | 源码区间索引：用 parse5（`sourceCodeLocationInfo`）解析任意 HTML，建立 节点 → `[start,end)` 索引 | `importer/src/preserve/span-index.ts` | 对 fixtures/html 每个文本节点，`source.slice(start,end)` 与其序列化一致 | T0.1 | ✅ |
| T2.2 | 补丁引擎：补丁合并（区间排序线性合并）、按 start 降序应用、补丁可逆 | `importer/src/preserve/patch.ts` | 属性测试：随机补丁集应用结果 = 朴素逐个重建；无改动时输出与原文**逐字节相同** | T2.1 | ✅ |
| T2.3 | 可编辑判定 + 挂载：为文本容器开启 contenteditable，WeakMap 映射 DOM → 区间；脚本生成的节点用 MutationObserver 识别并标灰 | `importer/src/preserve/mount.ts` | E2E：AI 生成的带 ECharts 页面中，正文可改、图表区标灰且不可改（目前为 happy-dom 模拟：离线无法加载 ECharts，用脚本函数往图表容器插入 canvas；真实浏览器 E2E 随 T2.7 补） | T2.1 | ✅ |
| T2.4 | 编辑 → 补丁：容器内容变化时序列化片段生成补丁；结构操作（新增/删除段落）转插入/删除补丁并沿用兄弟缩进 | `importer/src/preserve/edit.ts` | 改一个字保存后 `git diff` 只有 1 行变化 | T2.2, T2.3 | ⬜ |
| T2.5 | 区域源码编辑器：任意元素"编辑 HTML 源码"弹层（CodeMirror），改的是对应区间 | `importer/src/preserve/source-popover.ts` | 修改后即时预览、保存正确 | T2.4 | ⬜ |
| T2.6 | 撤销重做（补丁层），复用 T1.5 的历史框架 | — | 连续编辑后撤销到底 = 原文件字节 | T2.4, T1.5 | ⬜ |
| T2.7 | 运行时 / 打开器：浏览器中打开任意 `.html`（文件选择或拖入）→ 保真模式编辑 → File System Access API 写回；来源不明文件脚本默认不执行 | `packages/runtime` + `apps/web` 最小页面 | 手动验收：打开本机一个现有 HTML 笔记、改字、保存、刷新可见 | T2.4 | ⬜ |
| T2.8 | 基础格式工具栏（粗体/斜体/链接/标题级别）在保真模式中可用 | `editor/src/ui/toolbar.ts` | E2E | T2.4 | ⬜ |

## M3 · 原生编辑器 MVP

| ID | 任务 | 产出 | 验收 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- |
| T3.1 | 渲染器：Doc → DOM，块级哈希 + dirty patch + LIS 列表 diff | `renderer/src/` | "增量 = 全量"属性测试 | T1.4 | ⬜ |
| T3.2 | 编辑器基础（路线 A：ProseMirror 适配层，见 05 Q1） | `editor/src/pm/` | 文本块全部可编辑，中文 IME 正常 | T3.1 | ⬜ |
| T3.3 | Markdown 输入规则 | `editor/src/input-rules.ts` | 02 §5 规则全部生效 | T3.2 | ⬜ |
| T3.4 | 斜杠菜单 + 模糊匹配 | `editor/src/slash/` | 03 §7 打分算法单测 | T3.2 | ⬜ |
| T3.5 | 浮动工具栏（复用 T2.8）、块拖拽手柄 | `editor/src/ui/` | E2E | T3.2 | ⬜ |
| T3.6 | 组件插件接口 + `callout` `toggle` `math` `mermaid` | `blocks/src/` | 每个组件 render/fallback/EHMD 测试 | T3.1 | ⬜ |
| T3.7 | `eh-html` 块：渲染原 HTML、块内就地编辑（复用 M2 补丁引擎，区间相对块内源码）、源码弹层 | `blocks/src/html/` | 从 md 导入的内嵌 HTML 可编辑 | T3.6, T2.4 | ⬜ |
| T3.8 | 运行时加载器：`.ehtml` 阅读模式、编辑按钮、保存；按文件类型分流到原生/保真路径 | `packages/runtime` | 双击 `.ehtml` → 编辑 → 保存；体积 < 8KB gzip | T3.2, T2.7 | ⬜ |
| T3.9 | 主题系统（默认亮/暗） | `renderer/themes/` | 无运行时下样式完整 | T3.1 | ⬜ |
| T3.10 | 粘贴：HTML（网页/Word/Notion，先清洗）→ 原生块；含 Markdown 的纯文本 → 原生块 | `editor/src/paste/` | 06 §7；E2E（HTML 粘贴先做清洗 + 白名单映射，完整转换在 T4.1 完成后接入） | T3.2, T1.7 | ⬜ |

## M4 · HTML 转换 + 富组件 + 性能

| ID | 任务 | 产出 | 验收 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- |
| T4.1 | **HTML → 原生块转换器**（06 §3 全表；页面级 style 加作用域；脚本进沙箱组件）+ 转换报告 | `importer/src/html/` | fixtures/html 全部转换，"丢弃内容"为空；报告列出原生化比例 | T1.2, T3.6, T3.7 | ⬜ |
| T4.2 | 保真模式中"转换为 EditHTML 笔记"按钮（新文件 + 预览报告） | — | E2E | T4.1, T2.7 | ⬜ |
| T4.3 | `eh-html` 块"拆解为原生块" | — | 单测 + E2E | T4.1 | ⬜ |
| T4.4 | `chart` 组件 + 表格式数据编辑器；识别 ECharts/Chart.js 配置的转换规则 | `blocks/src/chart/` | 双击图表改数据；SVG 降级 | T3.6 | ⬜ |
| T4.5 | 容器块 `tabs` `columns`（嵌套子块编辑） | `blocks/src/` | 子块可编辑、可拖入拖出 | T3.6 | ⬜ |
| T4.6 | `script` / `embed` 沙箱组件 + 信任机制 | `blocks/src/script/` | 脚本无法访问宿主（安全测试） | T3.6 | ⬜ |
| T4.7 | 组件懒渲染 + 渲染缓存（LRU + IndexedDB） | `renderer/src/lazy/` | 100 个图表文档首屏 < 200ms | T4.4 | ⬜ |
| T4.8 | 块虚拟化（Fenwick 树高度索引 + 滚动锚定） | `renderer/src/virtual/` | 10k 块输入 p95 < 16ms | T3.1 | ⬜ |
| T4.9 | 增量序列化 + Worker 保存 + 防抖自动保存 | `core/src/serialize/incremental.ts` | 增量与全量逐字节一致 | T1.3 | ⬜ |
| T4.10 | 性能基准套件（含保真模式：2MB HTML 打开 < 300ms、保存 < 30ms） | `tests/bench/` | 03 §0 指标进 CI | T4.8 | ⬜ |

## M5 · 笔记库体验 + 批量导入

| ID | 任务 | 产出 | 验收 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- |
| T5.1 | Web 应用：打开文件夹、文件树、多标签（`.ehtml` `.md` `.html` 都显示、都能打开） | `apps/web` | 可管理一个混合格式笔记库 | T3.8 | ⬜ |
| T5.2 | **批量导入** `eh import <dir>` / Web"导入文件夹"：两遍链接重写、资源复制到 `assets/`、按内容哈希增量导入、默认不改原文件 | `importer/src/batch/` + `cli` | 一个真实 Obsidian 库（≥ 500 篇）导入后双链 0 断链；二次执行只处理变化文件 | T1.7, T4.1 | ⬜ |
| T5.3 | 全库搜索（倒排索引，中文 bigram） | `apps/web/src/search/` | 1000 篇搜索 < 50ms | T5.1 | ⬜ |
| T5.4 | 双链 `[[note#block]]` + 反向链接面板 | — | 重命名自动更新链接 | T5.1 | ⬜ |
| T5.5 | 外部修改检测 + 块级三方合并（保真模式用区间级合并） | `core/src/merge/` | git pull 后打开不丢编辑 | T4.9 | ⬜ |
| T5.6 | 源码模式（EHMD 分屏/切换） | `editor/src/source/` | 两侧实时同步 | T1.6 | ⬜ |
| T5.7 | 导出：单文件分享版、纯 md、PDF（打印样式） | `cli` + `apps/web` | — | T1.8 | ⬜ |

## M6 · 生态

- T6.1 Obsidian 插件（`.ehtml`/`.html` 视图 + 与 md 互转命令）
- T6.2 用户自定义组件目录 `.ehtml/plugins/`
- T6.3 组件模板库（时间线、对比表、知识卡片、闪卡……）
- T6.4 （可选）基于 CRDT 的多端同步/协作

## 并行建议

- M0 完成后：**M1（T1.1→T1.2/T1.3/T1.4 并行）与 M2（T2.1→T2.2/T2.3 并行）可以同时推进**，两者只在 T2.6 处汇合；
- M3 中 T3.6（组件）与 T3.2–T3.5（编辑器）可并行；
- M4 中每个组件一个 Agent，T4.8 / T4.9 独立并行。
