/**
 * 往返比较允许的"空白规范化"（tests/fixtures/obsidian/EXPECTED.md"通用约定"的子集，刻意更窄）：
 *
 * 1. `\r\n` / `\r` → `\n`；
 * 2. 去掉每行行尾的空格与制表符；
 * 3. 文件末尾恰好一个 `\n`（空文件为空串）。
 *
 * 不合并空行、不改表格填充。
 *
 * @module
 */

/** 按上述规则规范化 Markdown 文本，用于往返比较。 */
export function normalizeMarkdownWhitespace(s: string): string {
  const t = s
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/, '');
  return t === '' ? '' : `${t}\n`;
}
