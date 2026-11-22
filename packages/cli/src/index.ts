/**
 * @edithtml/cli — `eh convert / check / fmt`（任务 T1.8）。
 *
 * @packageDocumentation
 */
import { parseEhmd, serializeEhmd } from '@edithtml/core';
import type { MarkdownAdapter } from './formats.js';

export { helpText, run, type CliEnv, type Io } from './cli.js';
export {
  detectFormat,
  extensionFor,
  lineColumn,
  readDoc,
  writeDoc,
  type Diagnostic,
  type Format,
  type MarkdownAdapter,
  type MarkdownFlavor,
} from './formats.js';

/**
 * 基于 EHMD（CommonMark + GFM + 指令块，T1.6）的 Markdown 读写。
 * Obsidian 方言与按风格导出由 `@edithtml/importer`（T1.7）提供后替换。
 */
export const ehmdMarkdown: MarkdownAdapter = {
  read: (src) => parseEhmd(src),
  write: (doc) => serializeEhmd(doc),
};
