/**
 * EHMD（Markdown + 指令块）↔ {@link Doc} 转换（T1.6，docs/01-format-spec.md §7）。
 *
 * - {@link parseEhmd}：EHMD 文本 → `{ doc, warnings }`，从不抛错；
 * - {@link serializeEhmd}：`Doc` → EHMD 文本，确定且 `serializeEhmd ∘ parseEhmd` 幂等；
 *   `ids: 'all'` 时 `parseEhmd(serializeEhmd(doc))` 与 `doc` 相等（忽略 fallback 与 head，
 *   见 {@link ehmdDocEquals}；已知例外见 01 §7"实现约定"）。
 *
 * 扩展点（{@link EhmdExtension}，T1.7 的 Obsidian 方言与 `.md` 导出在此之上构建）：
 * - `micromark` / `fromMarkdown`：追加 micromark 语法与 mdast 构建扩展；
 * - `transforms`：转换前改写 mdast 树；
 * - `blockHandlers` / `inlineHandlers`：按 mdast 节点类型接管转换，可调用 `next()` 回落到内置实现；
 * - `directives`：注册/覆盖组件 ↔ 指令映射（{@link DirectiveSpec}）；
 * - `serializeBlock`：接管某些块的输出。
 *
 * @module
 */
export { parseEhmd } from './parse.js';
export { serializeEhmd } from './serialize.js';
export { ehmdComparable, ehmdDocEquals, type EhmdCompareOptions } from './compare.js';
export {
  BUILTIN_DIRECTIVES,
  type ContainerDecoding,
  type ContainerEncoding,
  type DirectiveHead,
  type DirectiveSpec,
} from './directives.js';
export { ehmdFromMarkdown, ehmdSyntax, type EhMarkNode, type EhTagNode, type EhWikiLinkNode } from './syntax.js';
export { serializeInline as serializeEhmdInline, type InlineContext } from './inline-serialize.js';
export { emitYaml, loadYaml } from './yaml.js';
export type {
  BlockContext,
  BlockHandler,
  BlockSerializer,
  EhmdExtension,
  EhmdIdMode,
  EhmdParseOptions,
  EhmdParseResult,
  EhmdSerializeOptions,
  EhmdWarning,
  EhmdWarningCode,
  InlineHandler,
  PendingBlock,
  SerializeContext,
} from './types.js';
