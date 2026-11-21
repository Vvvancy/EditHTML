/**
 * 整篇文档的规范输出（01 §6.1「文件骨架」）。
 *
 * @module
 */
import type { Doc } from '../model.js';
import { serializeSegment, segmentBlocks, TOP_LEVEL_DEPTH } from './block.js';
import { escapeAttr, escapeText, serializeMeta } from './escape.js';

/** 文件骨架：顶层块输出夹在 `before` 与 `after` 之间。 */
export interface Skeleton {
  /** 从 `<!doctype html>` 到 `<main id="eh-doc">` 行（含其换行）。 */
  readonly before: string;
  /** 从 `</main>` 行到 `</html>\n`。 */
  readonly after: string;
}

/** 默认 `<html lang>`（`head.lang` 缺省时使用）。 */
export const DEFAULT_LANG = 'zh-CN';

/**
 * 文件骨架（只依赖 `doc.meta` 与 `doc.head`）。可选行在对应字段为 `undefined` 时整行省略：
 * `eh-theme` / `eh-user-style` 的 `<style>`、`eh-runtime` 的 `<script>`；`head.extra`
 * 为 `undefined` 或空字符串时省略。`<title>` 与 `#eh-meta` 行总是输出。
 * `<style>` 内容与 `head.extra` 原样输出（`extra` 以 4 空格缩进开头，内部换行不处理）。
 */
export function serializeSkeleton(doc: Doc): Skeleton {
  const { head, meta } = doc;
  const metaTitle = typeof meta.title === 'string' ? meta.title : '';
  let before =
    '<!doctype html>\n' +
    `<html lang="${escapeAttr(head.lang ?? DEFAULT_LANG)}" data-eh-version="0.1">\n` +
    '  <head>\n' +
    '    <meta charset="utf-8">\n' +
    '    <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `    <title>${escapeText(head.title ?? metaTitle)}</title>\n` +
    `    <script type="application/json" id="eh-meta">${serializeMeta(meta)}</script>\n`;
  if (head.themeCss !== undefined) before += `    <style id="eh-theme">${head.themeCss}</style>\n`;
  if (head.userCss !== undefined) before += `    <style id="eh-user-style">${head.userCss}</style>\n`;
  if (head.extra !== undefined && head.extra !== '') before += `    ${head.extra}\n`;
  if (head.runtimeSrc !== undefined)
    before += `    <script id="eh-runtime" src="${escapeAttr(head.runtimeSrc)}" defer></script>\n`;
  before += '  </head>\n  <body>\n    <main id="eh-doc">\n';
  return { before, after: '    </main>\n  </body>\n</html>\n' };
}

/**
 * 把文档序列化为规范形式的 `.ehtml` 文件内容（01 §6 / §6.1）。
 *
 * 纯函数、确定性：只依赖 `meta`、`head`、`root`、各容器块的 `slots` 与块内容，
 * 不依赖 `doc.blocks` 的迭代顺序。结果满足
 * `serialize(doc) === before + segmentBlocks(doc, doc.root).map((s) => serializeSegment(doc, s, 3)).join('') + after`，
 * 其中 `{ before, after } = serializeSkeleton(doc)`。
 *
 * @throws 引用的块不存在时。
 */
export function serialize(doc: Doc): string {
  const { before, after } = serializeSkeleton(doc);
  const parts: string[] = [before];
  for (const s of segmentBlocks(doc, doc.root)) parts.push(serializeSegment(doc, s, TOP_LEVEL_DEPTH));
  parts.push(after);
  return parts.join('');
}
