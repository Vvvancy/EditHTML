/**
 * 解析器公共 API（T1.2）：`.ehtml` → {@link Doc}。
 *
 * @module
 */
export { parse, type ParseOptions, type ParseResult } from './parser.js';
export type { ParseWarning, ParseWarningCode } from './warnings.js';
