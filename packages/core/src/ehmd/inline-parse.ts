/**
 * mdast 行内节点 → 模型行内内容。
 *
 * 原始行内 HTML 按标签配对：`strong b em i s del strike mark sub sup kbd code a` 映射为标记，
 * `span[data-eh-inline]` 映射为原子，`br` 为换行；其他标签去壳保留内容（告警 `unwrapped-element`），
 * HTML 注释丢弃（EHMD 用 `<!---->` 作为空占位）。
 *
 * @module
 */
import type { Html, PhrasingContent } from 'mdast';
import { decodeEntities } from '../parse/entities.js';
import { sortMarks, type InlineNode, type Mark, type MarkType } from '../model.js';
import type { BlockContext, InlineHandler } from './types.js';

/** `javascript:` / `vbscript:` 链接（忽略大小写、空白与控制字符），与 HTML 解析器一致。 */
export function isScriptUrl(href: string): boolean {
  let s = '';
  for (let i = 0; i < href.length && s.length < 11; i++) {
    const c = href.charCodeAt(i);
    if (c <= 0x20) continue;
    s += href[i]?.toLowerCase();
  }
  return s.startsWith('javascript:') || s.startsWith('vbscript:');
}

interface Tag {
  readonly name: string;
  readonly close: boolean;
  readonly attrs: Record<string, string>;
}

const TAG_RE =
  /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>$/;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** 解析单个 HTML 标签（micromark 的 html-text 每个节点恰好是一个标签/注释）。 */
export function parseTag(html: string): Tag | null {
  const m = TAG_RE.exec(html.trim());
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const a of (m[3] ?? '').matchAll(ATTR_RE)) {
    const name = (a[1] as string).toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '', true);
  }
  return { name: (m[2] as string).toLowerCase(), close: m[1] === '/', attrs };
}

const TAG_MARKS: Readonly<Record<string, MarkType>> = {
  strong: 'strong',
  b: 'strong',
  em: 'em',
  i: 'em',
  s: 's',
  del: 's',
  strike: 's',
  mark: 'mark',
  sub: 'sub',
  sup: 'sup',
  kbd: 'kbd',
  code: 'code',
  a: 'link',
};

const VOID = new Set(['br', 'img', 'wbr', 'hr', 'input', 'area', 'col', 'embed', 'source', 'track', 'meta', 'link']);

/** 行内节点的纯文本。 */
export function phrasingText(nodes: readonly PhrasingContent[]): string {
  let s = '';
  for (const n of nodes) {
    if ('value' in n && n.type !== 'html') s += n.value;
    else if (n.type === 'break') s += '\n';
    else if (n.type === 'image') s += n.alt ?? '';
    else if ('children' in n) s += phrasingText(n.children as PhrasingContent[]);
  }
  return s;
}

/** 行内转换器。 */
export class InlineConverter {
  constructor(
    private readonly ctx: BlockContext,
    private readonly handlers: ReadonlyMap<string, readonly InlineHandler[]>,
    private readonly definitions: ReadonlyMap<string, { url: string; title: string | null }>,
  ) {}

  convert(nodes: readonly PhrasingContent[], marks: readonly Mark[] = []): InlineNode[] {
    const out: InlineNode[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i] as PhrasingContent;
      if (n.type === 'html') {
        i = this.html(nodes, i, marks, out);
        continue;
      }
      out.push(...this.node(n, marks));
    }
    return out;
  }

  private node(n: PhrasingContent, marks: readonly Mark[]): InlineNode[] {
    const hs = this.handlers.get(n.type) ?? [];
    const run = (k: number): InlineNode[] => {
      const h = hs[k];
      if (!h) return this.builtin(n, marks);
      return h(n, marks, this.ctx, () => run(k + 1)) ?? run(k + 1);
    };
    return run(0);
  }

  private add(marks: readonly Mark[], m: Mark): Mark[] {
    return sortMarks([...marks.filter((x) => x.type !== m.type), m]);
  }

  private link(url: string, title: string | null | undefined, offset: number): Mark | null {
    if (isScriptUrl(url)) {
      this.ctx.warn('stripped-javascript-url', 'stripped script link, kept text', offset);
      return null;
    }
    return { type: 'link', attrs: title != null ? { href: url, title } : { href: url } };
  }

  private builtin(n: PhrasingContent, marks: readonly Mark[]): InlineNode[] {
    const off = this.ctx.offset(n);
    switch (n.type) {
      case 'text':
        return [{ t: 'text', text: n.value, marks: [...marks] }];
      case 'strong':
        return this.convert(n.children, this.add(marks, { type: 'strong' }));
      case 'emphasis':
        return this.convert(n.children, this.add(marks, { type: 'em' }));
      case 'delete':
        return this.convert(n.children, this.add(marks, { type: 's' }));
      case 'ehMark':
        return this.convert(n.children, this.add(marks, { type: 'mark' }));
      case 'inlineCode':
        return [{ t: 'text', text: n.value, marks: this.add(marks, { type: 'code' }) }];
      case 'break':
        return [{ t: 'br', marks: [...marks] }];
      case 'link': {
        const m = this.link(n.url, n.title, off);
        return this.convert(n.children, m ? this.add(marks, m) : marks);
      }
      case 'linkReference': {
        const def = this.definitions.get(n.identifier);
        const m = def ? this.link(def.url, def.title, off) : null;
        return this.convert(n.children, m ? this.add(marks, m) : marks);
      }
      case 'image':
      case 'imageReference':
        this.ctx.warn('dropped-content', 'image inside inline content kept as its alt text', off);
        return n.alt ? [{ t: 'text', text: n.alt, marks: [...marks] }] : [];
      case 'inlineMath':
        return [{ t: 'atom', kind: 'math', attrs: {}, text: n.value, marks: [...marks] }];
      case 'ehWikiLink':
        return [{ t: 'atom', kind: 'wikilink', attrs: {}, text: `[[${n.value}]]`, marks: [...marks] }];
      case 'ehTag':
        return [{ t: 'atom', kind: 'tag', attrs: {}, text: n.value, marks: [...marks] }];
      case 'footnoteReference':
        return [{ t: 'text', text: `[^${n.label ?? n.identifier}]`, marks: [...marks] }];
      default: {
        this.ctx.warn('unsupported-node', `unsupported inline node ${n.type}; kept its text`, off);
        const t = phrasingText([n]);
        return t ? [{ t: 'text', text: t, marks: [...marks] }] : [];
      }
    }
  }

  /** 处理位于 `nodes[i]` 的 HTML 节点，返回最后消耗的下标。 */
  private html(nodes: readonly PhrasingContent[], i: number, marks: readonly Mark[], out: InlineNode[]): number {
    const node = nodes[i] as Html;
    const off = this.ctx.offset(node);
    const v = node.value;
    if (v.startsWith('<!--')) {
      if (!/^<!--+>$/.test(v)) this.ctx.warn('dropped-content', 'dropped inline HTML comment', off);
      return i;
    }
    const tag = parseTag(v);
    if (!tag) {
      out.push({ t: 'text', text: v, marks: [...marks] });
      return i;
    }
    if (tag.close) {
      this.ctx.warn('stray-end-tag', `stray </${tag.name}>`, off);
      return i;
    }
    if (tag.name === 'br') {
      out.push({ t: 'br', marks: [...marks] });
      return i;
    }
    if (VOID.has(tag.name) || v.endsWith('/>')) {
      this.ctx.warn('unwrapped-element', `dropped <${tag.name}>`, off);
      return i;
    }
    // 找配对的结束标签（同层、同名、计数嵌套）
    let depth = 0;
    let j = i + 1;
    for (; j < nodes.length; j++) {
      const c = nodes[j] as PhrasingContent;
      if (c.type !== 'html') continue;
      const t = parseTag(c.value);
      if (!t || t.name !== tag.name) continue;
      if (!t.close) depth++;
      else if (depth === 0) break;
      else depth--;
    }
    if (j >= nodes.length) {
      this.ctx.warn('unclosed-element', `unclosed <${tag.name}>`, off);
      return i;
    }
    const inner = nodes.slice(i + 1, j);
    if (tag.name === 'span' && tag.attrs['data-eh-inline'] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const [k, val] of Object.entries(tag.attrs))
        if (k.startsWith('data-eh-') && k !== 'data-eh-inline') attrs[k.slice(8)] = val;
      out.push({
        t: 'atom',
        kind: tag.attrs['data-eh-inline'] as string,
        attrs,
        text: phrasingText(inner),
        marks: [...marks],
      });
      return j;
    }
    const mt = TAG_MARKS[tag.name];
    let inner2 = marks;
    if (mt === 'link') {
      const href = tag.attrs.href;
      const m = href !== undefined ? this.link(href, tag.attrs.title, off) : null;
      if (m) inner2 = this.add(marks, m);
    } else if (mt) inner2 = this.add(marks, { type: mt });
    else this.ctx.warn('unwrapped-element', `unwrapped <${tag.name}>, kept its content`, off);
    out.push(...this.convert(inner, inner2));
    return j;
  }
}
