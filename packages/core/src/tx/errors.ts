/**
 * 事务错误。
 *
 * @module
 */

/**
 * {@link TxError} 的错误码：
 * - `unknownBlock`：引用的块不存在；
 * - `wrongKind`：块种类不支持该操作（如对组件块 `insertText`、对外来块 `setAttrs`）；
 * - `range`：偏移 / 下标 / 槽位越界，或 `from > to`；
 * - `boundary`：偏移落在 UTF-16 代理对中间；
 * - `duplicateId`：插入的块 ID 已存在（或子树内重复）；
 * - `cycle`：把块移动到自身或其后代中；
 * - `invalid`：载荷无效（非法块 ID / 类型 / JSON Patch 路径 / 子树不完整……）；
 * - `notResolved`：`invert` 的 Op 缺少应由 `apply` 填入的捕获数据；
 * - `finished`：事务构建器已提交或因先前错误失效。
 */
export type TxErrorCode =
  | 'unknownBlock'
  | 'wrongKind'
  | 'range'
  | 'boundary'
  | 'duplicateId'
  | 'cycle'
  | 'invalid'
  | 'notResolved'
  | 'finished';

/**
 * 无效 Op 抛出的类型化错误。`apply` 抛出时输入 `Doc` 不受任何影响（不会半应用）。
 */
export class TxError extends Error {
  override readonly name = 'TxError';
  /** 错误码。 */
  readonly code: TxErrorCode;
  /** 出错的 Op 在事务中的下标（由 `apply` / 构建器填入）。 */
  opIndex?: number;

  constructor(code: TxErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** 抛出 {@link TxError}。 */
export function fail(code: TxErrorCode, message: string): never {
  throw new TxError(code, message);
}
