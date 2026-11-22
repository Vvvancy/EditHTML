import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { defaultTreeAdapter, parseFragment, type html } from 'parse5';
import { describe, expect, it } from 'vitest';
import { buildSpanIndex, type ElementSpan, type Span, type SpanIndex, type TextSpan } from './span-index.js';

const FIXTURES = fileURLToPath(new URL('../../../../tests/fixtures/html/', import.meta.url));
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.html'))
  .map((f) => [f, readFileSync(FIXTURES + f, 'utf8')] as const);

function req<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('missing');
  return v;
}

const cut = (src: string, s: Span | null | undefined): string => (s ? src.slice(s.start, s.end) : '<no span>');

/** 在父元素的上下文里重新解析一段原文，取其文本值（实体解码、CRLF 归一、原样文本元素按原样）。 */
function textOf(slice: string, parent: ElementSpan | null): string {
  // html/head 层级只会出现空白文本，片段解析会把它吞掉，直接比较归一化后的原文。
  if (!parent || parent.tag === 'html' || parent.tag === 'head') return slice.replace(/\r\n?/g, '\n');
  const ctx = defaultTreeAdapter.createElement(parent.tag, parent.namespace as html.NS, []);
  const frag = parseFragment(ctx, slice, {});
  return frag.childNodes.map((n) => ('value' in n ? n.value : '')).join('');
}

function checkTexts(idx: SpanIndex): number {
  let n = 0;
  for (const node of idx.nodes) {
    if (node.kind !== 'text' || !node.span) continue;
    const t: TextSpan = node;
    const parent = t.parent?.kind === 'element' ? t.parent : null;
    expect(textOf(cut(idx.source, t.span), parent), `text #${t.id} in <${parent?.tag}>`).toBe(t.value);
    n++;
  }
  return n;
}

describe('buildSpanIndex', () => {
  it.each(fixtures)('%s: every text node’s source slice re-parses to its value', (_name, src) => {
    const idx = buildSpanIndex(src);
    expect(checkTexts(idx)).toBeGreaterThan(0);
  });

  it.each(fixtures)('%s: element spans are well-formed and nested', (_name, src) => {
    const idx = buildSpanIndex(src);
    for (const n of idx.nodes) {
      if (n.kind !== 'element' || !n.span) continue;
      expect(n.span.start).toBeLessThanOrEqual(n.span.end);
      if (n.startTag) {
        expect(src.slice(n.startTag.start, n.startTag.start + 1 + n.tag.length).toLowerCase()).toBe(`<${n.tag}`);
        expect(n.startTag.start).toBe(n.span.start);
      }
      if (n.endTag) {
        expect(src.slice(n.endTag.start, n.endTag.end).toLowerCase().replace(/\s+/g, '')).toBe(`</${n.tag}>`);
        expect(n.endTag.end).toBe(n.span.end);
      }
      for (const [name, a] of n.attrs)
        expect(src.slice(a.start, a.end).toLowerCase().startsWith(name.toLowerCase())).toBe(true);
      // `</body>` 之后的空白按规范会被追加进 body，所以 html/body 的子节点可能越过其结束标签。
      if (n.inner && n.tag !== 'html' && n.tag !== 'body')
        for (const c of n.children)
          if (c.span) {
            expect(c.span.start).toBeGreaterThanOrEqual(n.inner.start);
            expect(c.span.end).toBeLessThanOrEqual(n.inner.end);
          }
      expect(idx.byPath(n.path)).toBe(n);
    }
  });

  it('records offsets in the original string (BOM, CRLF, entities, omitted end tags)', () => {
    const src = '﻿<p class="a">x\r\ny &amp; z</p>\r\n<ul><li>one<li>two</ul><br>';
    const idx = buildSpanIndex(src);
    const els = idx.nodes.filter((n): n is ElementSpan => n.kind === 'element');
    const p = req(els.find((e) => e.tag === 'p'));
    expect(cut(src, p.inner)).toBe('x\r\ny &amp; z');
    expect(cut(src, p.attrs.get('class'))).toBe('class="a"');
    const lis = els.filter((e) => e.tag === 'li');
    expect(lis.map((l) => cut(src, l.span))).toEqual(['<li>one', '<li>two']);
    expect(lis.every((l) => l.endTag === null)).toBe(true);
    const br = req(els.find((e) => e.tag === 'br'));
    expect(br.inner).toBeNull();
    const body = req(els.find((e) => e.tag === 'body'));
    expect(body.startTag).toBeNull();
    expect(idx.at(src.indexOf('two'))).toMatchObject({ kind: 'text', value: 'two' });
    expect(idx.at(src.indexOf('class'))).toBe(p);
  });

  it('indexes template content and raw-text elements verbatim', () => {
    const src = '<template><p>t</p></template><script>if (a < b && c) x("&amp;")</script>';
    const idx = buildSpanIndex(src);
    const script = req(idx.nodes.find((n): n is ElementSpan => n.kind === 'element' && n.tag === 'script'));
    const text = script.children[0] as TextSpan;
    expect(cut(src, text.span)).toBe(text.value);
    expect(idx.nodes.some((n) => n.kind === 'text' && n.value === 't')).toBe(true);
  });

  it('head 中的空白文本后紧跟字符引用时，两段文本区间不重叠', () => {
    for (const src of ['<script></script>\r\n&#x41;', '<title>t</title>\n&amp;']) {
      const texts = buildSpanIndex(src).nodes.filter((n): n is TextSpan => n.kind === 'text');
      const ws = req(texts.find((t) => t.parent?.kind === 'element' && t.parent.tag === 'head'));
      expect(cut(src, ws.span)).toBe(src.includes('\r\n') ? '\r\n' : '\n');
      const body = req(texts.find((t) => t.parent?.kind === 'element' && t.parent.tag === 'body'));
      expect(cut(src, body.span)).toMatch(/^&/);
    }
  });

  it('<pre> 首文本包在重建的格式元素里时，同样剔除被丢弃的开头换行', () => {
    for (const src of ['<b><pre>\n x</b>', '<p><i><pre>\n x']) {
      const t = req(buildSpanIndex(src).nodes.find((n): n is TextSpan => n.kind === 'text'));
      expect(t.value).toBe(' x');
      expect(cut(src, t.span)).toBe(' x');
    }
  });

  it('表格寄养拼成的不连续文本没有区间', () => {
    const src = '<table>a<!-- c -->b</table>';
    const t = req(buildSpanIndex(src).nodes.find((n): n is TextSpan => n.kind === 'text' && n.value === 'ab'));
    expect(t.span).toBeNull();
  });

  it('property: arbitrary tag soup never throws and text slices re-parse to their values', () => {
    const piece = fc.constantFrom(
      '<p>',
      '</p>',
      '<li>',
      '<b>',
      '</b>',
      '<i>',
      '</div>',
      '<div class=x>',
      '<table>',
      '<tr>',
      '<td>',
      '</table>',
      '<script>',
      '</script>',
      '<!-- c -->',
      '&amp;',
      '&lt;',
      '&#x41;',
      '&nbsp;',
      '\r\n',
      ' ',
      'a',
      '<',
      '>',
      '"',
      '<br>',
      '< ',
      '</',
      '&gt',
      '&#1;',
      '<img src=a>',
      '<svg><text>s</text></svg>',
      '<textarea>',
      '</textarea>',
      '<pre>\n',
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 40 }), (parts) => {
        const idx = buildSpanIndex(parts.join(''));
        checkTexts(idx);
      }),
      { numRuns: 3000 },
    );
  });
});
