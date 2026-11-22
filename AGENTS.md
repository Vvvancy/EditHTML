# AGENTS.md — 给 Claude Code / 子 Agent 的工作约定

## 开始任何任务前

1. 阅读 `README.md`，以及与任务相关的 `docs/` 文档（至少 `01-format-spec.md` 和 `02-architecture.md`）；
2. 在 `docs/04-roadmap.md` 中找到你的任务编号（如 `T1.2`），确认依赖已完成；
3. 每个任务一个分支：`feat/T1.2-parser`，一个 PR，PR 标题带任务编号。

## 架构约束（不可违反）

- `packages/core` **禁止**使用任何 DOM / 浏览器 API，必须能在 Node 和 Web Worker 中运行；
- 依赖方向：`editor → renderer → blocks → core`，`importer → core`（`importer/preserve` 可依赖 DOM），不得反向依赖；
- **导入不丢内容**：任何导入/转换路径中，识别不了的内容必须原样保留为 `eh-html` 块或保真区间，禁止静默丢弃；
- 保真模式下，未被编辑的字节必须与原文件**逐字节相同**；
- 所有文档修改必须经过 `Transaction`，禁止直接修改 `Doc` 或把 DOM 当作数据源；
- 每个 `Op` 必须实现 `invert`；
- 序列化输出必须符合 `01-format-spec.md §6` 的规范形式且幂等。
- **agent 接口一致**：同一能力在 CLI、MCP、浏览器 JS API 中的参数与返回格式必须一致，统一实现在 `core`（或 `importer`）中，各入口只做薄封装（见 `docs/07-agent-friendly.md`）；
- agent 可见的输出（视图、诊断、错误信息）要简短、稳定、机器可读，默认不包含 fallback 和主题 CSS。

## 代码约定

- TypeScript strict，不用 `any`（确需时用 `unknown` 并收窄）；
- 公共 API 写 TSDoc；
- 新增组件块必须实现 `schema / render / fallback / toEHMD / fromEHMD`，并附测试；
- 性能敏感路径（解析、渲染 patch、序列化、输入处理）修改时须跑 `tests/bench/` 并在 PR 中贴结果。

## 测试要求

- 单元测试与源码同目录：`foo.ts` ↔ `foo.test.ts`；
- 解析/序列化/事务相关改动必须包含属性测试（fast-check）；
- UI 交互改动补充 `tests/e2e/` 下的 Playwright 用例；
- 合并前：`pnpm lint && pnpm test && pnpm build` 全部通过。

## 文档

- 实现与设计文档不一致时：要么改实现，要么在 PR 中同时修改文档并说明原因；
- 遇到 `docs/05-open-questions.md` 中未决的问题，不要自行拍板，在 PR 描述中提出并给出建议。
