/**
 * Markdown 导入/导出（T1.7，docs/06-import.md §5）：CommonMark + GFM + Obsidian 方言 ↔ Doc。
 *
 * 本模块不使用任何 DOM API（在 Node / Worker 中运行）。
 *
 * @module
 */
export { importMarkdown } from './import.js';
export type {
  MarkdownImportOptions,
  MarkdownImportReport,
  MarkdownImportResult,
  MarkdownLinkRef,
  PreservedSpan,
  ReportIssue,
} from './import.js';
export { exportMarkdown, generateMarkdown, type MarkdownExportOptions, type MarkdownFlavor } from './export.js';
export { formatWikiTarget, obsidianExtension, parseWikiTarget, type WikiParts } from './extension.js';
export { readSourceInfo, stripSourceInfo, type MarkdownSourceInfo, type SegmentInfo } from './source-info.js';
export { normalizeMarkdownWhitespace } from './normalize.js';
