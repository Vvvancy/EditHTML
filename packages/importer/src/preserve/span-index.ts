/**
 * 源码区间索引（T2.1，docs/06-import.md §2 第 1 步）。
 *
 * 用 parse5 的 `sourceCodeLocationInfo` 解析任意 HTML，为每个元素、属性、文本、注释记录它在
 * **原文字符串**中的 `[start, end)` 偏移（UTF-16 下标，可直接 `source.slice`）。
 * 偏移基于原文：CRLF、BOM、实体都不做预处理，所以补丁可以按字节原样写回。
 *
 * 浏览器与 parse5 都实现 WHATWG 解析算法，脚本运行前两边得到同一棵树，
 * 因此挂载层（T2.3）可以按 {@link SpanNode.path} 把 DOM 节点与区间一一配对。
 *
 * @module
 */
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];
type P5Location = NonNullable<P5Element['sourceCodeLocation']>;

/** 原文中的半开区间 `[start, end)`。 */
export interface Span {
  readonly start: number;
  readonly end: number;
}

interface SpanBase {
  /** 前序遍历序号，等于在 {@link SpanIndex.nodes} 中的下标。 */
  readonly id: number;
  readonly parent: ElementSpan | DocumentSpan | null;
  /** 从文档根到本节点的子节点下标路径（`template` 的内容按其子节点计）。 */
  readonly path: readonly number[];
  /** 整个节点在原文中的区间；解析器隐式创建的节点（如省略的 `<body>`）为 `null`。 */
  readonly span: Span | null;
}

/** 文档根。 */
export interface DocumentSpan extends SpanBase {
  readonly kind: 'document';
  readonly children: readonly SpanNode[];
}

/** 元素。 */
export interface ElementSpan extends SpanBase {
  readonly kind: 'element';
  /** 小写标签名。 */
  readonly tag: string;
  readonly namespace: string;
  readonly startTag: Span | null;
  /** 省略结束标签（`<li>x<li>y`）或空元素时为 `null`。 */
  readonly endTag: Span | null;
  /** 属性名 → 整个 `name="value"` 的区间，保持原文顺序。 */
  readonly attrs: ReadonlyMap<string, Span>;
  /**
   * 内容区间：开始标签之后、结束标签之前；可就地替换以改写元素内容。
   * 空元素（`<br>`、`<img>`）以及没有开始标签的隐式元素为 `null`。
   */
  readonly inner: Span | null;
  readonly children: readonly SpanNode[];
}

/** 文本节点。`value` 为解码后的文本（实体已解码、CRLF 已归一）。 */
export interface TextSpan extends SpanBase {
  readonly kind: 'text';
  readonly value: string;
}

/** 注释。 */
export interface CommentSpan extends SpanBase {
  readonly kind: 'comment';
  readonly value: string;
}

/** 索引中的任意节点。 */
export type SpanNode = DocumentSpan | ElementSpan | TextSpan | CommentSpan;

/** {@link buildSpanIndex} 的结果。 */
export interface SpanIndex {
  readonly source: string;
  readonly root: DocumentSpan;
  /** 全部节点，前序遍历。 */
  readonly nodes: readonly SpanNode[];
  /** 按路径取节点。 */
  byPath(path: readonly number[]): SpanNode | undefined;
  /** 覆盖 `offset` 的最内层有区间的节点（`start <= offset < end`）。 */
  at(offset: number): SpanNode | undefined;
}

/** 原样文本元素：其文本节点的原文即值（不解码实体）。 */
export const RAW_TEXT_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'plaintext',
]);

/** 开始标签后紧跟的一个换行会被解析器丢弃的元素。 */
const LEADING_NEWLINE_TAGS: ReadonlySet<string> = new Set(['pre', 'textarea', 'listing']);

/** 以字符引用结尾（含末尾字符）的一段原文，`;` 可省略（历史实体）。 */
const ENTITY_TAIL = /&(?:#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,8}|[A-Za-z][A-Za-z0-9]{0,31});?$/;

/**
 * 修正 parse5 的文本起点。
 *
 * 当文本节点紧跟在被解析器丢弃的空白之后（如 `<pre>\n…`、文档开头的 `\r\n…`），且以字符引用或
 * 一个当作文本的 `<` 开头时，parse5 报告的起点落在该单元之后（`&nbsp;` 报成从 `;` 开始，`< b`
 * 报成从空格开始）。文本节点不可能从实体中间或一个文本 `<` 之后开始——那里没有标记，就不会有节点边界——
 * 所以遇到这两种情况就把起点退回到 `&` 或 `<`。
 */
function textStart(source: string, start: number, end: number): number {
  const from = Math.max(0, start - 40);
  const m = ENTITY_TAIL.exec(source.slice(from, Math.min(start + 1, end)));
  if (m && m.index + from < start) return m.index + from;
  if (source[start - 1] === '<') return start - 1;
  if (source[start - 1] === '/' && source[start - 2] === '<') return start - 2;
  return start;
}

const span = (start: number, end: number): Span => ({ start, end });

function toSpan(loc: { startOffset: number; endOffset: number } | null | undefined): Span | null {
  return loc ? span(loc.startOffset, loc.endOffset) : null;
}

function childNodesOf(n: P5Node): readonly P5Node[] {
  if (n.nodeName === 'template') return (n as DefaultTreeAdapterMap['template']).content.childNodes;
  return 'childNodes' in n ? (n as P5Parent).childNodes : [];
}

/**
 * 解析任意 HTML 并建立 节点 → 区间 索引。永不抛错（parse5 是宽容解析器）。
 *
 * @param source 原文（不做任何预处理）。
 */
export function buildSpanIndex(source: string): SpanIndex {
  const ast = parse(source, { sourceCodeLocationInfo: true });
  const nodes: SpanNode[] = [];

  const visit = (n: P5Node, parent: ElementSpan | DocumentSpan, path: number[]): SpanNode | null => {
    const id = nodes.length;
    if (n.nodeName === '#text') {
      const t = n as DefaultTreeAdapterMap['textNode'];
      const loc = t.sourceCodeLocation;
      const raw = parent.kind === 'element' && RAW_TEXT_TAGS.has(parent.tag);
      const textSpan = loc
        ? span(raw ? loc.startOffset : textStart(source, loc.startOffset, loc.endOffset), loc.endOffset)
        : null;
      const rec: TextSpan = { kind: 'text', id, parent, path, span: textSpan, value: t.value };
      nodes.push(rec);
      return rec;
    }
    if (n.nodeName === '#comment') {
      const c = n as DefaultTreeAdapterMap['commentNode'];
      const rec: CommentSpan = { kind: 'comment', id, parent, path, span: toSpan(c.sourceCodeLocation), value: c.data };
      nodes.push(rec);
      return rec;
    }
    if (!('tagName' in n)) return null; // doctype 等
    const el = n as P5Element;
    const loc: P5Location | null | undefined = el.sourceCodeLocation;
    const attrs = new Map<string, Span>();
    if (loc?.attrs)
      for (const a of el.attrs) {
        const l = loc.attrs[a.name];
        if (l) attrs.set(a.name, span(l.startOffset, l.endOffset));
      }
    const startTag = toSpan(loc?.startTag);
    const endTag = toSpan(loc?.endTag);
    const whole = toSpan(loc);
    const isVoid =
      startTag !== null &&
      whole !== null &&
      whole.end === startTag.end &&
      endTag === null &&
      childNodesOf(el).length === 0;
    const inner = startTag && whole && !isVoid ? span(startTag.end, endTag ? endTag.start : whole.end) : null;
    const children: SpanNode[] = [];
    const rec: ElementSpan = {
      kind: 'element',
      id,
      parent,
      path,
      span: whole,
      tag: el.tagName,
      namespace: el.namespaceURI,
      startTag,
      endTag,
      attrs,
      inner,
      children,
    };
    nodes.push(rec);
    walkChildren(el, rec, path, children);
    // 被丢弃的开头换行不属于任何文本节点：把它从第一个文本的区间里剔除，替换文本时才不会吃掉它。
    const first = children[0];
    if (inner && LEADING_NEWLINE_TAGS.has(rec.tag) && first?.kind === 'text' && first.span?.start === inner.start) {
      const lf = source.startsWith('\r\n', inner.start) ? 2 : /[\r\n]/.test(source[inner.start] ?? '') ? 1 : 0;
      if (lf > 0) (first as { span: Span }).span = span(inner.start + lf, first.span.end);
    }
    return rec;
  };

  const walkChildren = (n: P5Node, parent: ElementSpan | DocumentSpan, path: number[], out: SpanNode[]): void => {
    for (const c of childNodesOf(n)) {
      const r = visit(c, parent, [...path, out.length]);
      if (r) out.push(r);
    }
  };

  const rootChildren: SpanNode[] = [];
  const root: DocumentSpan = {
    kind: 'document',
    id: 0,
    parent: null,
    path: [],
    span: span(0, source.length),
    children: rootChildren,
  };
  nodes.push(root);
  walkChildren(ast, root, [], rootChildren);

  return {
    source,
    root,
    nodes,
    byPath(path) {
      let cur: SpanNode = root;
      for (const i of path) {
        if (cur.kind !== 'document' && cur.kind !== 'element') return undefined;
        const next: SpanNode | undefined = cur.children[i];
        if (!next) return undefined;
        cur = next;
      }
      return cur;
    },
    at(offset) {
      let best: SpanNode | undefined;
      // 前序遍历中后出现且包含 offset 的节点更深。
      for (const n of nodes) {
        if (n.kind === 'document' || !n.span) continue;
        if (n.span.start <= offset && offset < n.span.end) best = n;
      }
      return best;
    },
  };
}
