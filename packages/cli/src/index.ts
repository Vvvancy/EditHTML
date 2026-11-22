/**
 * @edithtml/cli — `eh convert / check / fmt`（任务 T1.8）。
 *
 * @packageDocumentation
 */
import { parseEhmd, serializeEhmd } from '@edithtml/core';
import { exportMarkdown, importMarkdown } from '@edithtml/importer';
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
 * 默认 Markdown 读写：`@edithtml/importer`（T1.7）——CommonMark + GFM + Obsidian 方言，
 * 未编辑的内容按原文逐字节导回。
 */
export const obsidianMarkdown: MarkdownAdapter = {
  read: (src) => importMarkdown(src),
  write: (doc, flavor) => exportMarkdown(doc, { flavor }),
};

/** 纯 EHMD（T1.6）读写，不含 Obsidian 方言；主要用于测试与对比。 */
export const ehmdMarkdown: MarkdownAdapter = {
  read: (src) => parseEhmd(src),
  write: (doc) => serializeEhmd(doc),
};
