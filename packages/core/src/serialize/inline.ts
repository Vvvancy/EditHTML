/**
 * 行内内容的规范输出（01 §6.1「行内内容」）。
 *
 * @module
 */
import { markEquals, type InlineNode, type Mark } from '../model.js';
import { compareCodeUnits, escapeAttr, escapeText } from './escape.js';

/** 标记的开始标签。`link` → `<a href="…"[ title="…"]>`（缺失的属性省略）。 */
function openMark(m: Mark): string {
  if (m.type !== 'link') return `<${m.type}>`;
  const href = m.attrs?.href;
  const title = m.attrs?.title;
  return `<a${href !== undefined ? ` href="${escapeAttr(href)}"` : ''}${
    title !== undefined ? ` title="${escapeAttr(title)}"` : ''
  }>`;
}

/** 快速路径的 {@link markEquals}：多数标记无属性，避免 stableStringify。 */
function sameMark(a: Mark, b: Mark): boolean {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  if (a.attrs === undefined && b.attrs === undefined) return true;
  return markEquals(a, b);
}

function closeMark(m: Mark): string {
  return m.type === 'link' ? '</a>' : `</${m.type}>`;
}

/**
 * 行内原子：`<span data-eh-inline="{kind}"[ data-eh-{k}="…"]>{text}</span>`。
 * `data-eh-inline` 固定在最前，其余 `data-eh-{k}` 按 `k` 的字典序（键 `inline` 被忽略）。
 */
function atomHtml(kind: string, attrs: Readonly<Record<string, string>>, text: string): string {
  let out = `<span data-eh-inline="${escapeAttr(kind)}"`;
  const keys = Object.keys(attrs);
  if (keys.length > 0) {
    keys.sort(compareCodeUnits);
    for (const k of keys) if (k !== 'inline') out += ` data-eh-${k}="${escapeAttr(attrs[k] as string)}"`;
  }
  return `${out}>${escapeText(text)}</span>`;
}

/**
 * 序列化行内内容为单行 HTML（不含换行与缩进；`br` 输出为 `<br>`）。
 *
 * 标记按节点上的顺序（规范化内容即 `MARK_ORDER`）从外到内嵌套；相邻节点共享的
 * **最长外层标记前缀**保持同一个元素打开（与 ProseMirror DOMSerializer 相同），例如
 * `[**a**, ***b***]` → `<strong>a<em>b</em></strong>`。
 *
 * 要求 `content` 已规范化（见 `normalizeInline`）；结果只依赖 `content`。
 */
export function serializeInline(content: readonly InlineNode[]): string {
  let out = '';
  const open: Mark[] = [];
  for (const node of content) {
    const marks = node.marks;
    let keep = 0;
    while (keep < open.length && keep < marks.length && sameMark(open[keep] as Mark, marks[keep] as Mark)) keep++;
    while (open.length > keep) out += closeMark(open.pop() as Mark);
    for (let i = keep; i < marks.length; i++) {
      const m = marks[i] as Mark;
      out += openMark(m);
      open.push(m);
    }
    if (node.t === 'text') out += escapeText(node.text);
    else if (node.t === 'br') out += '<br>';
    else out += atomHtml(node.kind, node.attrs, node.text);
  }
  while (open.length > 0) out += closeMark(open.pop() as Mark);
  return out;
}
