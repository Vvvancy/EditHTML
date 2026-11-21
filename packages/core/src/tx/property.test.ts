/**
 * 属性测试：随机文档上的随机有效 Op 序列（roadmap T1.4 验收："随机 Op 序列 apply+invert 回到原文档"）。
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { idGeneratorFor } from '../ids.js';
import {
  componentBlock,
  docEquals,
  docToComparable,
  inlineLength,
  validateDoc,
  type Block,
  type BlockId,
  type ComponentBlock,
  type Doc,
  type InlineNode,
  type Mark,
  type TextBlock,
  type TextBlockType,
} from '../model.js';
import { arbDoc, arbInline, arbMarks, arbText, arbTextBlockSpec } from '../testing/arbitraries.js';
import { apply, HEAD_KEYS } from './apply.js';
import { isInlineBoundary } from './inline.js';
import { invertOps } from './invert.js';
import type { Op, PatchOp } from './ops.js';

// ───────────────────────────── 生成器 ─────────────────────────────

function boundaries(content: readonly InlineNode[]): number[] {
  const len = inlineLength(content);
  const out: number[] = [];
  for (let i = 0; i <= len; i++) if (isInlineBoundary(content, i)) out.push(i);
  return out;
}

const arbRange = (content: readonly InlineNode[]): fc.Arbitrary<[number, number]> => {
  const bs = boundaries(content);
  return fc
    .tuple(fc.constantFrom(...bs), fc.constantFrom(...bs))
    .map(([a, b]): [number, number] => (a <= b ? [a, b] : [b, a]));
};

const ALL_MARKS: Mark[] = [
  { type: 'strong' },
  { type: 'em' },
  { type: 'code' },
  { type: 'sup' },
  { type: 'link', attrs: { href: 'https://a.example' } },
  { type: 'link', attrs: { href: 'https://b.example', title: 'B' } },
];

const TEXT_TYPES: TextBlockType[] = ['p', 'h1', 'h3', 'li', 'quote', 'code', 'figure', 'hr'];

const arbJson: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer(),
  arbText,
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer(), { maxLength: 3 }),
  fc.record({ k: arbText }),
);

/** 对给定 props 生成一个有效的 JSON Patch。 */
function arbPatch(props: unknown): fc.Arbitrary<PatchOp[]> {
  const opts: fc.Arbitrary<PatchOp[]>[] = [arbJson.map((value) => [{ op: 'replace', path: '', value }])];
  if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
    const obj = props as Record<string, unknown>;
    const keys = Object.keys(obj);
    opts.push(
      fc
        .tuple(fc.constantFrom('a', 'zz', 'k~/x', ...keys), arbJson)
        .map(([k, value]) => [{ op: 'add', path: '/' + k.replace(/~/g, '~0').replace(/\//g, '~1'), value }]),
    );
    if (keys.length) {
      const esc = (k: string): string => '/' + k.replace(/~/g, '~0').replace(/\//g, '~1');
      opts.push(fc.constantFrom(...keys).map((k) => [{ op: 'remove', path: esc(k) }]));
      opts.push(
        fc.tuple(fc.constantFrom(...keys), arbJson).map(([k, value]) => [{ op: 'replace', path: esc(k), value }]),
      );
      const arrays = keys.filter((k) => Array.isArray(obj[k]));
      if (arrays.length)
        opts.push(
          fc.constantFrom(...arrays).chain((k) => {
            const arr = obj[k] as unknown[];
            const ops: fc.Arbitrary<PatchOp[]>[] = [
              fc
                .tuple(fc.oneof(fc.constant('-'), fc.nat(arr.length).map(String)), arbJson)
                .map(([i, value]) => [{ op: 'add', path: `${esc(k)}/${i}`, value }]),
            ];
            if (arr.length) ops.push(fc.nat(arr.length - 1).map((i) => [{ op: 'remove', path: `${esc(k)}/${i}` }]));
            return fc.oneof(...ops);
          }),
        );
      // 两步 patch：先加后删 / 嵌套
      const objs = keys.filter((k) => obj[k] !== null && typeof obj[k] === 'object' && !Array.isArray(obj[k]));
      if (objs.length)
        opts.push(
          fc.tuple(fc.constantFrom(...objs), arbJson).map(([k, value]) => [
            { op: 'add', path: `${esc(k)}/new`, value },
            { op: 'replace', path: `${esc(k)}/new`, value: 1 },
          ]),
        );
    }
  }
  return fc.oneof(...opts);
}

/** 所有可作为插入/移动目标的序列。 */
function sequences(doc: Doc): { parent: BlockId | null; slot: number; len: number }[] {
  const out: { parent: BlockId | null; slot: number; len: number }[] = [
    { parent: null, slot: 0, len: doc.root.length },
  ];
  for (const b of doc.blocks.values())
    if (b.kind === 'component' && b.slots)
      b.slots.forEach((s, i) => out.push({ parent: b.id, slot: i, len: s.length }));
  return out;
}

function descendantsOf(doc: Doc, id: BlockId): Set<BlockId> {
  const out = new Set<BlockId>();
  const visit = (bid: BlockId): void => {
    out.add(bid);
    const b = doc.blocks.get(bid);
    if (b?.kind === 'component' && b.slots) for (const s of b.slots) for (const c of s) visit(c);
  };
  visit(id);
  return out;
}

/** 针对 `doc` 的单个随机有效 Op。 */
function arbOp(doc: Doc): fc.Arbitrary<Op> {
  const all = [...doc.blocks.values()];
  const texts = all.filter((b): b is TextBlock => b.kind === 'text');
  const comps = all.filter((b): b is ComponentBlock => b.kind === 'component');
  const tables = texts.filter((b) => b.table);
  const editable = all.filter((b) => b.kind !== 'foreign');
  const seqs = sequences(doc);
  const ids = idGeneratorFor(doc);
  const freshId = ids.next();
  const freshId2 = ids.next();

  const opts: { weight: number; arbitrary: fc.Arbitrary<Op> }[] = [];
  const add = (weight: number, arbitrary: fc.Arbitrary<Op>): void => {
    opts.push({ weight, arbitrary });
  };

  // insertBlock：文本块、或带一个子块的容器块。
  add(
    3,
    fc.tuple(fc.constantFrom(...seqs), fc.nat(), arbTextBlockSpec, fc.boolean()).map(([s, i, spec, container]): Op => {
      const index = i % (s.len + 1);
      if (!container) return { t: 'insertBlock', parent: s.parent, slot: s.slot, index, block: spec(freshId) };
      const child = spec(freshId2);
      return {
        t: 'insertBlock',
        parent: s.parent,
        slot: s.slot,
        index,
        block: componentBlock(freshId, 'callout', { kind: 'info' }, { slots: [[child.id], []] }),
        descendants: [child],
      };
    }),
  );
  add(
    1,
    fc
      .record({ k: fc.constantFrom('title', 'x'), v: arbText })
      .map(({ k, v }): Op => ({ t: 'setMeta', patch: [{ op: 'add', path: `/${k}`, value: v }] })),
  );
  add(
    1,
    fc
      .tuple(fc.constantFrom(...HEAD_KEYS), fc.option(arbText, { nil: null }))
      .map(([k, v]): Op => ({ t: 'setHead', head: { [k]: v } })),
  );
  if (Object.keys(doc.meta).length)
    add(
      1,
      fc
        .constantFrom(...Object.keys(doc.meta))
        .map((k): Op => ({ t: 'setMeta', patch: [{ op: 'remove', path: `/${k}` }] })),
    );

  if (texts.length) {
    const tb = fc.constantFrom(...texts);
    add(
      6,
      tb.chain((b) =>
        fc
          .tuple(fc.constantFrom(...boundaries(b.content)), arbText, fc.option(arbMarks, { nil: undefined }))
          .map(([offset, text, marks]): Op =>
            marks
              ? { t: 'insertText', block: b.id, offset, text, marks }
              : { t: 'insertText', block: b.id, offset, text },
          ),
      ),
    );
    add(
      2,
      tb.chain((b) =>
        fc
          .tuple(fc.constantFrom(...boundaries(b.content)), arbInline)
          .map(([offset, content]): Op => ({ t: 'insertContent', block: b.id, offset, content })),
      ),
    );
    add(
      5,
      tb.chain((b) => arbRange(b.content).map(([from, to]): Op => ({ t: 'deleteText', block: b.id, from, to }))),
    );
    add(
      4,
      tb.chain((b) =>
        fc
          .tuple(arbRange(b.content), fc.constantFrom(...ALL_MARKS), fc.boolean())
          .map(([[from, to], mark, value]): Op => ({ t: 'setMark', block: b.id, from, to, mark, value })),
      ),
    );
    add(
      2,
      fc.tuple(tb, fc.constantFrom(...TEXT_TYPES)).map(([b, type]): Op => ({ t: 'setType', id: b.id, type })),
    );
  }
  if (editable.length)
    add(
      2,
      fc
        .tuple(
          fc.constantFrom(...editable),
          fc.dictionary(
            fc.constantFrom('indent', 'lang', 'task', 'src', 'x-y'),
            fc.option(fc.constantFrom('0', '1', 'ts', 'done'), { nil: null }),
            { minKeys: 1 },
          ),
        )
        .map(([b, attrs]): Op => ({ t: 'setAttrs', id: b.id, attrs })),
    );
  if (comps.length) {
    const cb = fc.constantFrom(...comps);
    add(
      3,
      cb.chain((b) => arbPatch(b.props).map((patch): Op => ({ t: 'setProps', id: b.id, patch }))),
    );
    add(
      1,
      fc
        .tuple(cb, fc.option(fc.constantFrom('<p>fb</p>', ''), { nil: null }))
        .map(([b, fallback]): Op => ({ t: 'setFallback', id: b.id, fallback })),
    );
    add(
      1,
      fc.tuple(cb, fc.constantFrom('chart', 'x-custom')).map(([b, type]): Op => ({ t: 'setType', id: b.id, type })),
    );
    add(
      1,
      cb.chain((b) => fc.nat(b.slots?.length ?? 0).map((slot): Op => ({ t: 'insertSlot', id: b.id, slot }))),
    );
    const emptySlots = comps.flatMap((b) => (b.slots ?? []).flatMap((s, i) => (s.length ? [] : [[b.id, i] as const])));
    if (emptySlots.length)
      add(
        1,
        fc
          .tuple(fc.constantFrom(...emptySlots), fc.boolean())
          .map(([[id, slot], unset]): Op => ({ t: 'removeSlot', id, slot, unset })),
      );
  }
  if (tables.length) {
    const tbl = fc.constantFrom(...tables);
    add(
      2,
      tbl.chain((b) => {
        const t = b.table as NonNullable<TextBlock['table']>;
        const cells: ['head' | 'body', number, number][] = [
          ...t.head.map((_, c): ['head', number, number] => ['head', 0, c]),
          ...t.body.flatMap((row, r) => row.map((_, c): ['body', number, number] => ['body', r, c])),
        ];
        return fc
          .tuple(fc.constantFrom(...cells), arbInline)
          .map(([[section, row, col], content]): Op => ({ t: 'setCell', id: b.id, section, row, col, content }));
      }),
    );
    add(
      1,
      tbl.map((b): Op => {
        const t = b.table as NonNullable<TextBlock['table']>;
        return { t: 'setTable', id: b.id, table: { ...t, body: [...t.body, t.head.map(() => [])] } };
      }),
    );
  }
  if (texts.length)
    add(
      1,
      fc
        .constantFrom(...texts)
        .map((b): Op => ({ t: 'setTable', id: b.id, table: b.table ? null : { head: [[]], body: [] } })),
    );
  if (all.length) {
    const ab = fc.constantFrom(...all);
    add(
      3,
      ab.map((b): Op => ({ t: 'removeBlock', id: b.id })),
    );
    add(
      3,
      ab.chain((b) => {
        const sub = descendantsOf(doc, b.id);
        const targets = seqs.filter((s) => s.parent === null || !sub.has(s.parent));
        return fc.tuple(fc.constantFrom(...targets), fc.nat()).map(([s, i]): Op => {
          // 若目标序列就是其所在序列，移除后长度减 1。
          const inSame = (
            s.parent === null ? doc.root : ((doc.blocks.get(s.parent) as ComponentBlock).slots?.[s.slot] ?? [])
          ).includes(b.id);
          const len = inSame ? s.len - 1 : s.len;
          return { t: 'moveBlock', id: b.id, parent: s.parent, slot: s.slot, index: i % (len + 1) };
        });
      }),
    );
  }
  return fc.oneof(...opts);
}

/** 从 `doc` 出发逐步生成 `n` 个 Op，每一步基于前一步的结果文档。 */
function arbSteps(doc: Doc, n: number): fc.Arbitrary<Op[]> {
  if (n === 0) return fc.constant([]);
  return arbOp(doc).chain((op) => {
    const next = apply(doc, [op]).doc;
    return arbSteps(next, n - 1).map((rest) => [op, ...rest]);
  });
}

const arbScenario = fc
  .tuple(arbDoc({ maxBlocks: 6 }), fc.integer({ min: 1, max: 20 }))
  .chain(([doc, n]) => arbSteps(doc, n).map((ops) => ({ doc, ops })));

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
      'setMark',
      'setMeta',
      'setProps',
      'setTable',
      'setType',
    ];
    expect([...seen].sort()).toEqual(all.sort());
  });
});
