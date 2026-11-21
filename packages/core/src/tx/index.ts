/**
 * 操作 / 事务 / 逆操作 / 位置映射（T1.4）。
 *
 * @module
 */
export { TxError, type TxErrorCode } from './errors.js';
export type * from './ops.js';
export { Mapping, type Assoc, type MapResult, type MapStep, type Pos } from './mapping.js';
export { applyPatch, parsePointer, formatPointer } from './patch.js';
export { isInlineBoundary } from './inline.js';
export { apply, tr, TxBuilder, TEXT_BLOCK_TYPES, HEAD_KEYS, type TxResult } from './apply.js';
export { invert, invertOps, invertTransaction, mapOp } from './invert.js';
