import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { inlineLength, inlineText, normalizeInline, text, type InlineNode } from '../model.js';
import { arbInline } from '../testing/arbitraries.js';
import { isInlineBoundary, isNormalizedInline, markSegments, replaceInline, splitInline } from './inline.js';

const atom: InlineNode = { t: 'atom', kind: 'math', attrs: {}, text: 'x^2', marks: [] };
const content: InlineNode[] = normalizeInline([
  text('ab', [{ type: 'strong' }]),
  atom,
  text('c😀d'),
  { t: 'br', marks: [] },
]);

describe('inline helpers', () => {
  it('boundaries: atoms and br are single units; surrogate pairs cannot be split', () => {
    expect(inlineLength(content)).toBe(8);
    expect([...Array(10).keys()].filter((i) => isInlineBoundary(content, i))).toEqual([0, 1, 2, 3, 4, 6, 7, 8]);
    expect(isInlineBoundary(content, -1)).toBe(false);
    expect(isInlineBoundary(content, 1.5)).toBe(false);
  });

  it('splitInline splits text nodes and keeps atoms whole', () => {
    const [a, b] = splitInline(content, 1);
    expect(inlineText(a)).toBe('a');
    expect(inlineText(b)).toBe('bx^2c😀d\n');
    expect(splitInline(content, 3)[0]).toHaveLength(2);
  });

  it('replaceInline returns normalized content and the removed slice', () => {
    const { content: c, removed } = replaceInline(content, 1, 4, [text('Z', [{ type: 'strong' }])]);
    expect(inlineText(c)).toBe('aZ😀d\n');
    expect(c[0]).toEqual(text('aZ', [{ type: 'strong' }]));
    expect(inlineText(removed)).toBe('bx^2c');
  });

  it('markSegments merges equal neighbours', () => {
    const c = normalizeInline([
      text('aa', [{ type: 'em' }]),
      text('bb', [{ type: 'em' }, { type: 'strong' }]),
      text('cc'),
    ]);
    expect(markSegments(c, 1, 6, 'em')).toEqual([
      { from: 1, to: 4, mark: { type: 'em' } },
      { from: 4, to: 6, mark: null },
    ]);
  });

  it('isNormalizedInline agrees with normalizeInline', () => {
    fc.assert(
      fc.property(arbInline, (c) => {
        expect(isNormalizedInline(c)).toBe(true);
        const split = [...c, ...c];
        expect(isNormalizedInline(split)).toBe(JSON.stringify(normalizeInline(split)) === JSON.stringify(split));
      }),
    );
    expect(isNormalizedInline([text('a'), text('b')])).toBe(false);
    expect(isNormalizedInline([{ t: 'text', text: '', marks: [] }])).toBe(false);
    expect(isNormalizedInline([{ t: 'text', text: 'a', marks: [{ type: 'em' }, { type: 'strong' }] }])).toBe(false);
  });

  it('replace preserves total length arithmetic', () => {
    fc.assert(
      fc.property(arbInline, arbInline, fc.nat(), fc.nat(), (c, ins, x, y) => {
        const bs = [...Array(inlineLength(c) + 1).keys()].filter((i) => isInlineBoundary(c, i));
        const a = bs[x % bs.length] as number;
        const b = bs[y % bs.length] as number;
        const [from, to] = a <= b ? [a, b] : [b, a];
        const r = replaceInline(c, from, to, ins);
        expect(inlineLength(r.content)).toBe(inlineLength(c) - (to - from) + inlineLength(ins));
        expect(inlineLength(r.removed)).toBe(to - from);
      }),
    );
  });
});
