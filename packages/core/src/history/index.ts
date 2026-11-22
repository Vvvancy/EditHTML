/**
 * 撤销重做（T1.5，docs/03-algorithms.md §4）：块模型的 {@link History}，以及可供保真补丁层（T2.6）
 * 复用的通用部件（{@link UndoStack}、输入合并规则、块哈希快照）。
 *
 * @module
 */
export { History, approxSize, type HistoryOptions, type HistoryResult, type RecordOptions } from './history.js';
export { UndoStack, DEFAULT_STACK_LIMITS, type StackEntry, type StackLimits } from './stack.js';
export {
  DEFAULT_MERGE_WINDOW,
  extendGroup,
  isBreakChar,
  startGroup,
  type GroupOptions,
  type InputGroup,
  type InputGroupKind,
  type TextEdit,
} from './group.js';
export { takeSnapshot, verifySnapshot, type HashSnapshot, type VerifyResult } from './snapshot.js';
