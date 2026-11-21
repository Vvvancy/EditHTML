/**
 * @edithtml/core — 文档模型、解析器、序列化器、事务与撤销重做。
 *
 * 约束：本包禁止使用任何 DOM / 浏览器 API（tsconfig 中未引入 DOM lib），
 * 必须能在 Node 与 Web Worker 中运行。
 *
 * @packageDocumentation
 */

/** 当前实现的 `.ehtml` 规范版本（见 docs/01-format-spec.md §10）。 */
export const SPEC_VERSION = '0.1';

export * from './model.js';
export * from './ids.js';
export * from './serialize/index.js';
export * from './tx/index.js';
