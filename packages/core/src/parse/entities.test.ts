import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeEntities } from './entities.js';

describe('decodeEntities', () => {
  it('numeric entities', () => {
    expect(decodeEntities('&#65;&#x42;&#X43;&#68&#0;&#xD800;&#x110000;&#99999999999;')).toBe(
      'ABCD\ufffd\ufffd\ufffd\ufffd',
    );
    expect(decodeEntities('&#x1F600;')).toBe('😀');
  });

  it('named entities', () => {
    expect(decodeEntities('&lt;&gt;&amp;&quot;&apos;&nbsp;&mdash;&alpha;&rarr;')).toBe('<>&"\'\u00a0—α→');
  });

  it('unknown named entities stay literal and warn', () => {
    const warns: number[] = [];
    expect(decodeEntities('x &bogus; y', false, 10, (_c, _m, o) => warns.push(o))).toBe('x &bogus; y');
    expect(warns).toEqual([12]);
  });

  it('bare ampersands stay literal', () => {
    expect(decodeEntities('AT&T & co &#; &;')).toBe('AT&T & co &#; &;');
  });

  it('legacy entities without semicolon', () => {
    expect(decodeEntities('&amp &copy2026 &ltx')).toBe('& ©2026 <x');
    expect(decodeEntities('?a=1&ampb=2', true)).toBe('?a=1&ampb=2');
    expect(decodeEntities('?a=1&amp=2', true)).toBe('?a=1&amp=2');
  });

  it('inverse of minimal escaping', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        expect(decodeEntities(esc)).toBe(s);
      }),
    );
  });
});
