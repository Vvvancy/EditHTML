/**
 * 确定性序列化器（T1.3）：`Doc` → 规范形式 `.ehtml`（01 §6 / §6.1）。
 *
 * 结构：`serialize(doc) = skeleton.before + Σ serializeSegment(段) + skeleton.after`。
 *
 * **增量序列化（T3.6）指引**：
 * - 缓存单位是**段**（{@link segmentBlocks}），而不是块：非 `li` 块单独成段，连续 `li` 块组成
 *   一个列表组段。列表组的输出依赖组内每一项（`<ul>`/`</ul></li>` 的位置取决于相邻项的层级与类型），
 *   因此列表组必须整体缓存，缓存键取组内全部 `id:hash`；任一项变化、或组边界变化
 *   （插入/删除/改类型使相邻块变为/不再是 `li`）都使该组失效。
 * - 每次保存先用 {@link segmentBlocks} 重新分段（O(顶层块数)，不做序列化），再按段键查缓存。
 * - 容器块的 `hash` 只覆盖其 `slots` 的 ID 列表，不含子块内容；其段的缓存键必须包含全部后代的哈希
 *   （或在后代变化时显式失效）。
 * - 骨架只依赖 `meta` 与 `head`，可单独缓存。
 *
 * @module
 */
export { serialize, serializeSkeleton, DEFAULT_LANG, type Skeleton } from './doc.js';
export {
  serializeBlock,
  serializeListGroup,
  serializeSegment,
  serializeSequence,
  segmentBlocks,
  indent,
  TOP_LEVEL_DEPTH,
  type Segment,
} from './block.js';
export { serializeInline } from './inline.js';
export {
  escapeText,
  escapeAttr,
  embedJson,
  escapeJsonForScript,
  serializeMeta,
  serializeAttrs,
  compareCodeUnits,
  META_KEY_ORDER,
} from './escape.js';
