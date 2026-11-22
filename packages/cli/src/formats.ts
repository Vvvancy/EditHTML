/**
 * 文件格式识别与读写适配（`eh convert` 的核心）。
 *
 * @module
 */
import { parse, parseEhmd, serialize, serializeEhmd, type Doc } from '@edithtml/core';

/** CLI 支持的格式。 */
export type Format = 'ehtml' | 'html' | 'md' | 'ehmd';

/** 读取结果中的一条告警（已换算为行列号）。 */
export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

/** 读取结果。 */
export interface ReadResult {
  readonly doc: Doc;
  readonly diagnostics: Diagnostic[];
}

/**
 * Markdown（CommonMark + GFM + Obsidian 方言）读写，由 `@edithtml/importer` 提供（T1.7）。
 * 抽象成接口便于测试替换。
 */
export interface MarkdownAdapter {
  read(src: string): { doc: Doc; warnings: readonly { code: string; message: string; offset?: number }[] };
  write(doc: Doc, flavor: MarkdownFlavor): string;
}

/** 导出 Markdown 的风格。 */
export type MarkdownFlavor = 'obsidian' | 'commonmark';

/** 按扩展名识别格式；`.html` 若含 `data-eh-version` 视为 `ehtml`。 */
export function detectFormat(path: string, content?: string): Format | null {
  const p = path.toLowerCase();
  if (p.endsWith('.eh.html') || p.endsWith('.ehtml')) return 'ehtml';
  if (p.endsWith('.ehmd')) return 'ehmd';
  if (p.endsWith('.md') || p.endsWith('.markdown')) return 'md';
  if (p.endsWith('.html') || p.endsWith('.htm'))
    return content !== undefined && /<html[^>]*\sdata-eh-version\s*=/i.test(content) ? 'ehtml' : 'html';
  return null;
}

/** 目标格式的默认扩展名。 */
export function extensionFor(format: Format): string {
  switch (format) {
    case 'ehtml':
    case 'html':
      return '.eh.html';
    case 'md':
      return '.md';
    case 'ehmd':
      return '.ehmd';
  }
}

/** 把源码偏移换算为 1 起始的行列号。 */
export function lineColumn(src: string, offset: number | undefined): { line: number; column: number } {
  if (offset === undefined || offset < 0) return { line: 0, column: 0 };
  let line = 1;
  let last = -1;
  const end = Math.min(offset, src.length);
  for (let i = 0; i < end; i++)
    if (src.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  return { line, column: end - last };
}

function diagnostics(
  src: string,
  warnings: readonly { code: string; message: string; offset?: number }[],
): Diagnostic[] {
  return warnings.map((w) => ({ code: w.code, message: w.message, ...lineColumn(src, w.offset) }));
}

/** 读取任意支持格式为 `Doc`。 */
export function readDoc(src: string, format: Format, md: MarkdownAdapter): ReadResult {
  switch (format) {
    case 'ehtml':
    case 'html': {
      // 普通 HTML 走同一个宽容解析器：识别的部分成为原生块，其余成为 HTML 块（06 §3 的完整转换在 T4.1）。
      const r = parse(src);
      return { doc: r.doc, diagnostics: diagnostics(src, r.warnings) };
    }
    case 'ehmd': {
      const r = parseEhmd(src);
      return { doc: r.doc, diagnostics: diagnostics(src, r.warnings) };
    }
    case 'md': {
      const r = md.read(src);
      return { doc: r.doc, diagnostics: diagnostics(src, r.warnings) };
    }
  }
}

/** 把 `Doc` 写为目标格式。 */
export function writeDoc(doc: Doc, format: Format, md: MarkdownAdapter, flavor: MarkdownFlavor): string {
  switch (format) {
    case 'ehtml':
    case 'html':
      return serialize(doc);
    case 'ehmd':
      return serializeEhmd(doc);
    case 'md':
      return md.write(doc, flavor);
  }
}
