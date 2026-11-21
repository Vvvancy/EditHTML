import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeInline, text, type InlineNode, type Mark } from '../model.js';
import { arbInline } from '../testing/arbitraries.js';
import { serializeInline } from './inline.js';

const strong: Mark = { type: 'strong' };
const em: Mark = { type: 'em' };
const code: Mark = { type: 'code' };
const link = (href: string, title?: string): Mark => ({ type: 'link', attrs: title ? { href, title } : { href } });
const ser = (nodes: InlineNode[]): string => serializeInline(normalizeInline(nodes));

describe('serializeInline', () => {
  it('serializes plain and escaped text', () => {
    expect(ser([text('a < b & c > "d"')])).toBe('a &lt; b &amp; c &gt; "d"');
    expect(ser([])).toBe('');
  });

  it('nests marks in MARK_ORDER regardless of input order', () => {
    expect(ser([text('x', [code, em, strong])])).toBe('<strong><em><code>x</code></em></strong>');
  });

  it('keeps the longest shared outer prefix open', () => {
    expect(ser([text('a', [strong]), text('b', [strong, em]), text('c', [strong])])).toBe(
      '<strong>a<em>b</em>c</strong>',
    );
  });

  it('closes and reopens when an inner mark is shared but outer is not', () => {
    // em is shared but strong (outer) differs → em must be reopened.
    expect(ser([text('a', [strong, em]), text('b', [em])])).toBe('<strong><em>a</em></strong><em>b</em>');
  });

  it('treats links with different attrs as different marks', () => {
    expect(ser([text('a', [link('x')]), text('b', [link('y')])])).toBe('<a href="x">a</a><a href="y">b</a>');
    expect(ser([text('a', [link('x')]), text('b', [link('x'), strong])])).toBe('<a href="x">a<strong>b</strong></a>');
  });

  it('writes link title after href and escapes attrs', () => {
    expect(ser([text('t', [link('a?b=1&c="2"', 'T<')])])).toBe(
      '<a href="a?b=1&amp;c=&quot;2&quot;" title="T&lt;">t</a>',
    );
  });

  it('serializes br and atoms, with marks', () => {
    expect(ser([text('a'), { t: 'br', marks: [strong] }, text('b', [strong])])).toBe('a<strong><br>b</strong>');
    expect(
      ser([{ t: 'atom', kind: 'math', attrs: { z: '1', a: 'x"y', inline: 'skip' }, text: 'a<b', marks: [em] }]),
    ).toBe('<em><span data-eh-inline="math" data-eh-a="x&quot;y" data-eh-z="1">a&lt;b</span></em>');
  });

  it('leaves nbsp and emoji literal', () => {
    expect(ser([text('a 😀', [strong])])).toBe('<strong>a 😀</strong>');
  });

  it('is balanced and deterministic (property)', () => {
    fc.assert(
      fc.property(arbInline, (content) => {
        const out = serializeInline(content);
        expect(serializeInline(content)).toBe(out);
        const stack: string[] = [];
        for (const m of out.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
          const [, close, name] = m as unknown as [string, string, string];
          if (name === 'br') continue;
          if (close) expect(stack.pop()).toBe(name);
          else stack.push(name);
        }
        expect(stack).toEqual([]);
      }),
    );
  });
});
