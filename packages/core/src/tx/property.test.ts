/**
 * 属性测试：随机文档上的随机有效 Op 序列（roadmap T1.4 验收："随机 Op 序列 apply+invert 回到原文档"）。
 * 生成器见 `../testing/ops.ts`（与 history 属性测试共用）。
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  docEquals,
  docToComparable,
  inlineLength,
  validateDoc,
  type Block,
  type BlockId,
  type Doc,
  type TextBlock,
} from '../model.js';
import { arbScenario } from '../testing/ops.js';
import { apply } from './apply.js';
import { invertOps } from './invert.js';
import type { Op } from './ops.js';

// ───────────────────────────── 辅助 ─────────────────────────────

function deepFreeze<T>(v: T): T {
  if (v instanceof Map) {
    for (const x of v.values()) deepFreeze(x);
  } else if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

function snapshot(doc: Doc): { cmp: string; entries: [BlockId, Block][]; root: readonly BlockId[] } {
  return { cmp: docToComparable(doc), entries: [...doc.blocks.entries()], root: doc.root };
}

function expectSnapshot(doc: Doc, snap: ReturnType<typeof snapshot>): void {
  expect(doc.root).toBe(snap.root);
  expect([...doc.blocks.entries()]).toEqual(snap.entries);
  [...doc.blocks.entries()].forEach(([id, b], i) => {
    expect(id).toBe(snap.entries[i]?.[0]);
    expect(b).toBe(snap.entries[i]?.[1]);
  });
  expect(docToComparable(doc)).toBe(snap.cmp);
}

const hashes = (doc: Doc): Record<BlockId, number> =>
  Object.fromEntries([...doc.blocks.values()].map((b) => [b.id, b.hash]));

/** props 的非稳定 JSON（检查键顺序也被撤销复原，序列化器按插入顺序输出 props）。 */
const propsJson = (doc: Doc): string =>
  JSON.stringify(
    [...doc.blocks.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .flatMap((b) => (b.kind === 'component' ? [[b.id, b.props]] : [])),
  );

const RUNS = Number(process.env.TX_PROP_RUNS ?? 300);
const TIMEOUT = 600_000;

// ───────────────────────────── 属性 ─────────────────────────────

describe('tx properties', () => {
  it(
    'step-wise: each result valid; inverses in reverse order restore the doc, hashes and props order; inputs never mutated',
    () => {
      fc.assert(
        fc.property(arbScenario, ({ doc, ops }) => {
          const docs: Doc[] = [deepFreeze(doc)];
          const applied: Op[][] = [];
          for (const op of ops) {
            const cur = docs[docs.length - 1] as Doc;
            const snap = snapshot(cur);
            deepFreeze(op);
            const r = apply(cur, [op]);
            expectSnapshot(cur, snap);
            expect(validateDoc(r.doc)).toEqual([]);
            expect(r.doc.version).toBe(cur.version + 1);
            // 未改动块按引用共享；dirty 恰为对象改变的块。
            for (const [id, b] of r.doc.blocks) if (!r.dirty.has(id)) expect(cur.blocks.get(id)).toBe(b);
            for (const id of r.dirty) expect(r.doc.blocks.get(id)).not.toBe(cur.blocks.get(id));
            docs.push(deepFreeze(r.doc));
            applied.push(r.applied.slice());
          }
          // 逆序撤销。
          let d = docs[docs.length - 1] as Doc;
          for (let i = applied.length - 1; i >= 0; i--) {
            const r = apply(d, invertOps(applied[i] as Op[]));
            expect(validateDoc(r.doc)).toEqual([]);
            const want = docs[i] as Doc;
            expect(docToComparable(r.doc)).toBe(docToComparable(want));
            d = r.doc;
          }
          expect(docEquals(d, doc)).toBe(true);
          expect(hashes(d)).toEqual(hashes(doc));
          expect(propsJson(d)).toBe(propsJson(doc));
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    'single transaction: apply(all ops) then apply(invertOps(applied)) restores the doc',
    () => {
      fc.assert(
        fc.property(arbScenario, ({ doc, ops }) => {
          deepFreeze(doc);
          const snap = snapshot(doc);
          const r = apply(doc, { ops, meta: { source: 'test' } });
          expectSnapshot(doc, snap);
          expect(validateDoc(r.doc)).toEqual([]);
          expect(r.tx.meta).toEqual({ source: 'test' });
          // 事务整体结果与逐步应用一致。
          let step = doc;
          for (const op of ops) step = apply(step, [op]).doc;
          expect(docToComparable(r.doc)).toBe(docToComparable(step));
          const u = apply(deepFreeze(r.doc), invertOps(r.applied));
          expect(validateDoc(u.doc)).toEqual([]);
          expect(docEquals(u.doc, doc)).toBe(true);
          expect(hashes(u.doc)).toEqual(hashes(doc));
          expect(propsJson(u.doc)).toBe(propsJson(doc));
          // 重做：再次应用逆的逆。
          const redo = apply(u.doc, invertOps(u.applied));
          expect(docEquals(redo.doc, r.doc)).toBe(true);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    'dirty covers exactly the blocks that differ; removed/inserted are consistent',
    () => {
      fc.assert(
        fc.property(arbScenario, ({ doc, ops }) => {
          const r = apply(doc, ops);
          const ids = new Set([...doc.blocks.keys(), ...r.doc.blocks.keys()]);
          for (const id of ids) {
            const a = doc.blocks.get(id);
            const b = r.doc.blocks.get(id);
            if (r.dirty.has(id)) expect(a).not.toBe(b);
            else expect(a).toBe(b);
            expect(r.removed.has(id)).toBe(!!a && !b);
            expect(r.inserted.has(id)).toBe(!a && !!b);
          }
          expect(r.rootChanged).toBe(doc.root.join() !== r.doc.root.join());
          if (!r.rootChanged) expect(r.doc.root).toBe(doc.root);
        }),
        { numRuns: 150 },
      );
    },
    TIMEOUT,
  );

  it(
    'mapping: positions outside edited text keep pointing at the same characters',
    () => {
      fc.assert(
        fc.property(arbScenario, ({ doc, ops }) => {
          const r = apply(doc, ops);
          for (const b of doc.blocks.values()) {
            if (b.kind !== 'text') continue;
            const len = inlineLength(b.content);
            for (let off = 0; off <= len; off++) {
              const res = r.mapping.mapResult({ block: b.id, offset: off });
              if (!res.deleted) {
                const nb = r.doc.blocks.get(b.id);
                expect(nb).toBeDefined();
                expect(res.pos.offset).toBeGreaterThanOrEqual(0);
                expect(res.pos.offset).toBeLessThanOrEqual(inlineLength((nb as TextBlock).content));
              }
            }
          }
        }),
        { numRuns: 150 },
      );
    },
    TIMEOUT,
  );
});

describe('op generator', () => {
  it('covers every op type', () => {
    const seen = new Set<string>();
    for (const { ops } of fc.sample(arbScenario, { numRuns: 400, seed: 42 })) for (const op of ops) seen.add(op.t);
    const all: Op['t'][] = [
      'deleteText',
      'insertBlock',
      'insertContent',
      'insertSlot',
      'insertText',
      'moveBlock',
      'removeBlock',
      'removeSlot',
      'setAttrs',
      'setCell',
      'setFallback',
      'setHead',
      'setHtml',
      'setMark',
      'setMeta',
      'setProps',
      'setTable',
      'setType',
    ];
    expect([...seen].sort()).toEqual(all.sort());
  });
});
