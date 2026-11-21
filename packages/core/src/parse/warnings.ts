/**
 * 解析告警类型。解析器从不抛错：所有非规范或损坏的输入都以告警形式报告，并尽力恢复。
 *
 * @module
 */

/**
 * 告警代码。
 *
 * - `stripped-event-handler`：剔除了 `on*` 事件属性；
 * - `stripped-javascript-url`：`javascript:`（或 `vbscript:`）链接被去掉链接标记，保留文本；
 * - `missing-id` / `duplicate-id` / `invalid-id`：块 ID 缺失、重复或不合法，已在扫描结束后重新分配；
 * - `foreign-content`：规范外内容被保留为外来块（原文切片）；
 * - `content-outside-main`：存在 `main#eh-doc` 时，其外部的 body 内容被并入顶层块；
 * - `unknown-entity`：未知命名实体，按字面保留；
 * - `unwrapped-element`：白名单外的行内元素被去壳（保留文本）；
 * - `dropped-element`：文本块中的 `script` / `style` 等被丢弃；
 * - `dropped-attribute`：规范外的属性被丢弃；
 * - `dropped-content`：无法放入模型的内容（如列表中的裸文本）被丢弃；
 * - `unclosed-element` / `stray-end-tag`：未闭合元素、多余的结束标签；
 * - `eof-in-tag` / `eof-in-comment` / `eof-in-raw-text`：文件在标签/注释/原始文本中途结束；
 * - `invalid-json`：组件 JSON 无法解析（整个组件改为外来块）；
 * - `invalid-meta`：`#eh-meta` 不是合法的 JSON 对象（原样放入 `head.extra`）；
 * - `missing-props`：组件缺少 JSON 数据（`props` 取 `{}`）；
 * - `missing-fallback-end`：缺少结束的 `<!--eh:fallback-->` 标记；
 * - `depth-limit`：嵌套超过安全上限，按外来块/扁平化处理；
 * - `unsafe-slice`：原样保留的外来块/降级内容会破坏外层边界（含 `</eh-foreign>`、`<!--eh:fallback-->` 或未终止的原始文本/注释），已修补（外来块）或丢弃（降级内容）。
 */
export type ParseWarningCode =
  | 'stripped-event-handler'
  | 'stripped-javascript-url'
  | 'missing-id'
  | 'duplicate-id'
  | 'invalid-id'
  | 'foreign-content'
  | 'content-outside-main'
  | 'unknown-entity'
  | 'unwrapped-element'
  | 'dropped-element'
  | 'dropped-attribute'
  | 'dropped-content'
  | 'unclosed-element'
  | 'stray-end-tag'
  | 'eof-in-tag'
  | 'eof-in-comment'
  | 'eof-in-raw-text'
  | 'invalid-json'
  | 'invalid-meta'
  | 'missing-props'
  | 'missing-fallback-end'
  | 'depth-limit'
  | 'unsafe-slice';

/** 一条解析告警。 */
export interface ParseWarning {
  /** 告警代码，见 {@link ParseWarningCode}。 */
  readonly code: ParseWarningCode;
  /** 人类可读的说明（英文）。 */
  readonly message: string;
  /** 相关位置在源字符串中的偏移（UTF-16 码元下标）。 */
  readonly offset: number;
}

/** 告警回调。 */
export type WarnFn = (code: ParseWarningCode, message: string, offset: number) => void;
