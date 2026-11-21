import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createIdGenerator, isValidBlockId } from './ids.js';
import {
  buildParentIndex,
  componentBlock,
  computeBlockHash,
  createDoc,
  docEquals,
  fnv1a,
  inlineLength,
  inlineText,
  normalizeInline,
  stableStringify,
  text,
  textBlock,
  validateDoc,
  walkBlocks,
  type InlineNode,
} from './model.js';
import { arbDoc, arbInline } from './testing/arbitraries.js';

describe('fnv1a', () => {
  it('matches reference vectors', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });
});

describe('stableStringify', () => {
  it('sorts keys and drops undefined', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}');
  });
});

describe('normalizeInline', () => {
  it('merges adjacent same-mark text, drops empties, sorts marks', () => {
    const input: InlineNode[] = [
      { t: 'text', text: 'a', marks: [{ type: 'em' }, { type: 'strong' }] },
      { t: 'text', text: '', marks: [] },
      { t: 'text', text: 'b', marks: [{ type: 'strong' }, { type: 'em' }] },
      { t: 'br', marks: [] },
    ];
    expect(normalizeInline(input)).toEqual([
      { t: 'text', text: 'ab', marks: [{ type: 'strong' }, { type: 'em' }] },
      { t: 'br', marks: [] },
    ]);
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(arbInline, (c) => {
        expect(normalizeInline(normalizeInline(c))).toEqual(normalizeInline(c));
      }),
    );
  });

  it('counts offsets in UTF-16 units with atoms as 1', () => {
    const c: InlineNode[] = [
      text('中😀'),
      { t: 'br', marks: [] },
      { t: 'atom', kind: 'math', attrs: {}, text: 'x^2', marks: [] },
    ];
    expect(inlineLength(c)).toBe(5);
    expect(inlineText(c)).toBe('中😀\nx^2');
  });
});

describe('Doc', () => {
  const doc = createDoc([
    textBlock('b1', 'h1', [text('标题')]),
    componentBlock('t1', 'tabs', { tabs: [{ title: 'A' }, { title: 'B' }] }, { slots: [['t1a'], ['t1b']] }),
    textBlock('t1a', 'p', [text('a')]),
    textBlock('t1b', 'p', [text('b')]),
  ]);

  it('infers root from non-child blocks and validates', () => {
    expect(doc.root).toEqual(['b1', 't1']);
    expect(validateDoc(doc)).toEqual([]);
  });

  it('walks blocks in document order with depth', () => {
    expect([...walkBlocks(doc)].map(([b, d]) => `${b.id}@${d}`)).toEqual(['b1@0', 't1@0', 't1a@1', 't1b@1']);
  });

  it('indexes parents', () => {
    expect(buildParentIndex(doc).get('t1b')).toEqual({ parent: 't1', slot: 1, index: 0 });
  });

  it('detects stale hashes and orphans', () => {
    const blocks = new Map(doc.blocks);
    blocks.set('b1', { ...textBlock('b1', 'h1', [text('x')]), hash: 1 });
    blocks.set('zz', textBlock('zz', 'p'));
    expect(validateDoc({ ...doc, blocks })).toEqual(['block b1: stale hash', 'orphan block zz']);
  });

  it('hash changes with content', () => {
    expect(computeBlockHash(textBlock('b1', 'p', [text('a')]))).not.toBe(
      computeBlockHash(textBlock('b1', 'p', [text('b')])),
    );
  });
});

describe('arbDoc', () => {
  it('generates valid docs', () => {
    fc.assert(
      fc.property(arbDoc(), (d) => {
        expect(validateDoc(d)).toEqual([]);
        expect(docEquals(d, d)).toBe(true);
      }),
    );
  });
});

describe('ids', () => {
  it('skips reserved ids and validates format', () => {
    const g = createIdGenerator(['b1', 'b3']);
    expect([g.next(), g.next(), g.next()]).toEqual(['b2', 'b4', 'b5']);
    expect(g.reserve('b2')).toBe(false);
    expect(isValidBlockId('k9x')).toBe(true);
    expect(isValidBlockId('9k')).toBe(false);
  });
});
