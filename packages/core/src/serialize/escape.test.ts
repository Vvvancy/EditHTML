import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { embedJson, escapeAttr, escapeText, serializeAttrs, serializeMeta } from './escape.js';

describe('escapeText / escapeAttr', () => {
  it('escapes only & < > in text', () => {
    expect(escapeText(`a & b < c > d "e" 'f'`)).toBe(`a &amp; b &lt; c &gt; d "e" 'f'`);
  });
  it('also escapes " in attributes', () => {
    expect(escapeAttr(`a & b < c > d "e" 'f'`)).toBe(`a &amp; b &lt; c &gt; d &quot;e&quot; 'f'`);
  });
  it('leaves nbsp, emoji and CJK literal', () => {
    const s = 'a b 😀 𝒳 中文';
    expect(escapeText(s)).toBe(s);
    expect(escapeAttr(s)).toBe(s);
  });
  it('does not double-escape entities', () => {
    expect(escapeText('&amp;')).toBe('&amp;amp;');
  });
  it('output never contains raw < or > (property)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(escapeText(s)).not.toMatch(/[<>]/);
        expect(escapeAttr(s)).not.toMatch(/[<>"]/);
      }),
    );
  });
});

describe('embedJson', () => {
  it('escapes </ and <!-- and stays valid JSON', () => {
    const v = { html: '<b>hi</b></script>', c: '<!-- x -->' };
    const out = embedJson(v);
    expect(out).toBe('{"html":"<b>hi<\\/b><\\/script>","c":"\\u003c!-- x -->"}');
    expect(JSON.parse(out)).toEqual(v);
  });
  it('keeps insertion order and compact form', () => {
    expect(embedJson({ z: 1, a: [1, 2], m: { y: null, b: true } })).toBe('{"z":1,"a":[1,2],"m":{"y":null,"b":true}}');
  });
  it('maps undefined to null', () => {
    expect(embedJson(undefined)).toBe('null');
  });
  it('never contains </ or <!-- and round-trips through JSON.parse (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const out = embedJson(v);
        expect(out).not.toContain('</');
        expect(out).not.toContain('<!--');
        expect(JSON.parse(out)).toEqual(JSON.parse(JSON.stringify(v)));
      }),
    );
  });
});

describe('serializeMeta', () => {
  it('outputs {} for empty meta', () => {
    expect(serializeMeta({})).toBe('{}');
  });
  it('orders title, created, tags, theme first, rest lexicographically', () => {
    expect(
      serializeMeta({ zeta: 1, theme: 'dark', Alpha: 2, tags: ['a'], beta: 3, created: '2026-11-21', title: 'T' }),
    ).toBe('{"title":"T","created":"2026-11-21","tags":["a"],"theme":"dark","Alpha":2,"beta":3,"zeta":1}');
  });
  it('orders integer-like keys lexicographically, not numerically', () => {
    expect(serializeMeta({ '10': 1, '9': 2, a: 3 })).toBe('{"10":1,"9":2,"a":3}');
  });
  it('omits undefined values and escapes </', () => {
    expect(serializeMeta({ title: '</script>', created: undefined })).toBe('{"title":"<\\/script>"}');
  });
});

describe('serializeAttrs', () => {
  it('orders data-eh, data-eh-*, then others, each lexicographically', () => {
    expect(
      serializeAttrs('b1', { class: 'x', 'data-eh-z': '1', 'aria-label': 'l', 'data-eh-a': '2', 'data-eh': 'ignored' }),
    ).toBe(' data-eh="b1" data-eh-a="2" data-eh-z="1" aria-label="l" class="x"');
  });
  it('writes empty (boolean) values as name="" and escapes values', () => {
    expect(serializeAttrs(undefined, { hidden: '', title: 'a"<b>&' })).toBe(' hidden="" title="a&quot;&lt;b&gt;&amp;"');
  });
});
