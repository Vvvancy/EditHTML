import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeBlockHash, normalizeInline, stableStringify, type InlineNode } from '../model.js';
import { arbDoc, arbInlineNode } from '../testing/arbitraries.js';
import { fastBlockHash, fastStringify, normalizeInlineFast } from './fast.js';

describe('fast builders match model.ts exactly', () => {
  it('fastStringify === stableStringify', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(fastStringify(v)).toBe(stableStringify(v));
      }),
    );
  });

  it('fastBlockHash === computeBlockHash (incl. index-like keys and undefined values)', () => {
    fc.assert(
      fc.property(arbDoc(), (doc) => {
        for (const { hash, ...data } of doc.blocks.values()) {
          expect(fastBlockHash(data)).toBe(hash);
          expect(computeBlockHash(data)).toBe(hash);
        }
      }),
      { numRuns: 200 },
    );
    fc.assert(
      fc.property(
        fc.dictionary(fc.oneof(fc.string(), fc.nat().map(String)), fc.option(fc.jsonValue(), { nil: undefined })),
        (props) => {
          const b = { id: 'a', kind: 'component' as const, type: 'x', props, attrs: { '10': 'a', '9': 'b' } };
          expect(fastBlockHash(b)).toBe(computeBlockHash(b));
        },
      ),
    );
  });

  it('normalizeInlineFast === normalizeInline (on unnormalized input)', () => {
    const arbRaw: fc.Arbitrary<InlineNode[]> = fc.array(
      fc.oneof(arbInlineNode, fc.constant<InlineNode>({ t: 'text', text: '', marks: [] })),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(arbRaw, (nodes) => {
        expect(stableStringify(normalizeInlineFast(nodes))).toBe(stableStringify(normalizeInline(nodes)));
      }),
    );
  });
});
