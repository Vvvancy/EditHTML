import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TxError } from './errors.js';
import { applyPatch, formatPointer, parsePointer } from './patch.js';

describe('JSON pointer', () => {
  it('parses and formats with escapes', () => {
    expect(parsePointer('')).toEqual([]);
    expect(parsePointer('/a~1b/~0c/0')).toEqual(['a/b', '~c', '0']);
    expect(formatPointer(['a/b', '~c', '0'])).toBe('/a~1b/~0c/0');
    expect(() => parsePointer('a')).toThrow(TxError);
  });
  it('round-trips', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (ts) => {
        expect(parsePointer(formatPointer(ts))).toEqual(ts);
      }),
    );
  });
});

describe('applyPatch', () => {
  const props = Object.freeze({ a: 1, b: Object.freeze({ c: Object.freeze([1, 2, 3]) }), d: 'x' });

  it('add / replace / remove on objects and arrays, without mutating input', () => {
    const { value } = applyPatch(props, [
      { op: 'add', path: '/e', value: true },
      { op: 'replace', path: '/a', value: 2 },
      { op: 'remove', path: '/d' },
      { op: 'add', path: '/b/c/1', value: 9 },
      { op: 'add', path: '/b/c/-', value: 7 },
      { op: 'remove', path: '/b/c/0' },
    ]);
    expect(value).toEqual({ a: 2, b: { c: [9, 2, 3, 7] }, e: true });
    expect(props).toEqual({ a: 1, b: { c: [1, 2, 3] }, d: 'x' });
  });

  it('shares untouched subtrees', () => {
    const src = { x: { y: 1 }, z: { w: 2 } };
    const { value } = applyPatch(src, [{ op: 'replace', path: '/x/y', value: 5 }]);
    expect((value as typeof src).z).toBe(src.z);
  });

  it('inverse restores the value including key order', () => {
    const ops = [
      { op: 'remove', path: '/a' },
      { op: 'add', path: '/a', value: 3 },
      { op: 'add', path: '/b/c/0', value: 0 },
      { op: 'replace', path: '', value: { whole: 1 } },
      { op: 'add', path: '/k', value: [] },
    ] as const;
    const { value, inverse } = applyPatch(props, ops);
    expect(value).toEqual({ whole: 1, k: [] });
    const back = applyPatch(value, inverse).value;
    expect(back).toEqual(props);
    expect(JSON.stringify(back)).toBe(JSON.stringify(props));
  });

  it('rejects invalid patches', () => {
    const bad = [
      [{ op: 'remove', path: '' }],
      [{ op: 'remove', path: '/nope' }],
      [{ op: 'replace', path: '/nope', value: 1 }],
      [{ op: 'add', path: '/x/y', value: 1 }],
      [{ op: 'add', path: '/b/c/4', value: 1 }],
      [{ op: 'remove', path: '/b/c/3' }],
      [{ op: 'add', path: '/b/c/01', value: 1 }],
      [{ op: 'add', path: '/a/x', value: 1 }],
      [{ op: 'add', path: '/a', value: undefined }],
    ] as const;
    for (const p of bad) expect(() => applyPatch(props, p), JSON.stringify(p)).toThrow(TxError);
  });
});
