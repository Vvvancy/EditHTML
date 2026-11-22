/**
 * 属性测试（03 §10："撤销 N 步再重做 N 步，文档哈希不变"）：随机文档 × 随机有效 Op 序列
 * （生成器与 tx 属性测试共用，见 `../testing/ops.ts`）。
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  docEquals,
  docToComparable,
  inlineLength,
  textBlock,
  validateDoc,
  type Doc,
  type TextBlock,
} from '../model.js';
import { arbScenario } from '../testing/ops.js';
import { apply } from '../tx/apply.js';
import type { Op } from '../tx/ops.js';
import { History } from './history.js';

const RUNS = Number(process.env.HISTORY_PROP_RUNS ?? 200);
const TIMEOUT = 600_000;

const hashes = (doc: Doc): Record<string, number> =>
  Object.fromEntries([...doc.blocks.values()].map((b) => [b.id, b.hash]));

function expectSame(a: Doc, b: Doc): void {
  expect(docToComparable(a)).toBe(docToComparable(b));
  expect(docEquals(a, b)).toBe(true);
  expect(hashes(a)).toEqual(hashes(b));
  expect(validateDoc(a)).toEqual([]);
}

/** 把 Op 序列切成若干事务：`cuts[i]` 为真表示第 i 个 Op 之后结束当前事务。 */
function chunk(ops: readonly Op[], cuts: readonly boolean[]): Op[][] {
  const out: Op[][] = [];
  let cur: Op[] = [];
  ops.forEach((op, i) => {
    cur.push(op);
    if (cuts[i] !== false || i === ops.length - 1) {
      out.push(cur);
      cur = [];
    }
  });
  return out;
}

/** 场景 + 事务切分 + 每个事务之间的时间间隔（0..800ms，可能触发输入合并）。 */
const arbHistoryScenario = arbScenario.chain(({ doc, ops }) =>
  fc
    .tuple(
      fc.array(fc.boolean(), { minLength: ops.length, maxLength: ops.length }),
      fc.array(fc.integer({ min: 0, max: 800 }), { minLength: ops.length, maxLength: ops.length }),
    )
    .map(([cuts, gaps]) => ({ doc, txs: chunk(ops, cuts), gaps })),
);

describe('history properties', () => {
  it(
    'record N transactions (no merging): undo N → original doc and hashes; redo N → final doc',
    () => {
      fc.assert(
        fc.property(arbScenario, ({ doc, ops }) => {
          let t = 0;
          const h = new History({ clock: () => (t += 1000) });
          let d = doc;
          const states: Doc[] = [doc];
          for (const op of ops) {
            const r = apply(d, [op]);
            h.record(r);
            d = r.doc;
            states.push(d);
          }
          const final = d;
          const n = h.undoDepth;
          expect(n).toBeLessThanOrEqual(ops.length);
          for (let i = 0; i < n; i++) {
            const u = h.undo(d);
            expect(u).not.toBeNull();
            expect(u?.skipped).toBe(0);
            d = (u as { doc: Doc }).doc;
          }
          expect(h.canUndo()).toBe(false);
          expectSame(d, doc);
          for (let i = 0; i < n; i++) d = (h.redo(d) as { doc: Doc }).doc;
          expect(h.canRedo()).toBe(false);
          expectSame(d, final);
          // 再撤销到底一次：仍回到原文档（重做产生的项也可撤销）。
          while (h.canUndo()) d = (h.undo(d) as { doc: Doc }).doc;
          expectSame(d, doc);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    'multi-op transactions with input merging: undo to the bottom → original; redo to the top → final',
    () => {
      fc.assert(
        fc.property(arbHistoryScenario, ({ doc, txs, gaps }) => {
          let t = 0;
          const h = new History({ clock: () => t });
          let d = doc;
          txs.forEach((ops, i) => {
            t += gaps[i] ?? 0;
            const r = apply(d, ops);
            h.record(r);
            d = r.doc;
          });
          const final = d;
          while (h.canUndo()) d = (h.undo(d) as { doc: Doc }).doc;
          expectSame(d, doc);
          while (h.canRedo()) d = (h.redo(d) as { doc: Doc }).doc;
          expectSame(d, final);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    'partial undo then redo returns to the same intermediate states',
    () => {
      fc.assert(
        fc.property(arbScenario, fc.nat(), ({ doc, ops }, k) => {
          let t = 0;
          const h = new History({ clock: () => (t += 1000) });
          let d = doc;
          const states: Doc[] = [doc];
          for (const op of ops) {
            const r = apply(d, [op]);
            h.record(r);
            d = r.doc;
            if (h.undoDepth === states.length) states.push(d);
            else states[states.length - 1] = d; // 空操作没有入栈
          }
          const m = k % (h.undoDepth + 1);
          for (let i = 0; i < m; i++) d = (h.undo(d) as { doc: Doc }).doc;
          expectSame(d, states[states.length - 1 - m] as Doc);
          for (let i = 0; i < m; i++) d = (h.redo(d) as { doc: Doc }).doc;
          expectSame(d, states[states.length - 1] as Doc);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  // ───────────── 与不进历史的事务交错 ─────────────

  /** 作用于"旁路"块的非历史事务（与被记录的 Op 互不相交）：以函数形式给出，便于在两个文档上分别生成。 */
  type SideOp = (doc: Doc) => Op;
  let sideSeq = 0;
  const arbSideOp: fc.Arbitrary<SideOp> = fc.oneof(
    fc
      .tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.stringMatching(/^[a-z ]{1,4}$/))
      .map(([f, s]): SideOp => (d) => {
        const len = inlineLength((d.blocks.get('zside') as TextBlock).content);
        return { t: 'insertText', block: 'zside', offset: Math.floor(f * len), text: s };
      }),
    fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.nat(3)).map(([f, n]): SideOp => (d) => {
      const len = inlineLength((d.blocks.get('zside') as TextBlock).content);
      const from = Math.floor(f * len);
      return { t: 'deleteText', block: 'zside', from, to: Math.min(len, from + n) };
    }),
    fc
      .constant((): SideOp => {
        const id = `zs${(sideSeq++).toString(36)}`;
        return (d) => ({ t: 'insertBlock', parent: null, slot: 0, index: d.root.length, block: textBlock(id, 'p') });
      })
      .map((mk) => mk()),
    fc.nat(9).map((n): SideOp => () => ({ t: 'setAttrs', id: 'zside', attrs: { x: String(n) } })),
  );

  const arbInterleaved = arbHistoryScenario.chain((s) =>
    fc
      .tuple(
        fc.array(fc.array(arbSideOp, { maxLength: 2 }), { minLength: s.txs.length, maxLength: s.txs.length }),
        fc.array(fc.array(arbSideOp, { maxLength: 2 }), { minLength: s.txs.length, maxLength: s.txs.length }),
      )
      .map(([during, whileUndoing]) => ({ ...s, during, whileUndoing })),
  );

  it(
    'non-history transactions on unrelated blocks interleaved with recording and undoing: undo reverts exactly the recorded edits',
    () => {
      fc.assert(
        fc.property(arbInterleaved, ({ doc, txs, gaps, during, whileUndoing }) => {
          // 旁路块放在顶层末尾：生成的 Op 下标都 ≤ 原顶层长度，仍然有效。
          const side = textBlock('zside', 'p', [{ t: 'text', text: 'side', marks: [] }]);
          const base = apply(doc, [
            { t: 'insertBlock', parent: null, slot: 0, index: doc.root.length, block: side },
          ]).doc;
          let expected = base; // 只应用旁路事务
          let t = 0;
          const h = new History({ clock: () => t });
          let d = base;
          const sideRun = (ops: readonly SideOp[]): void => {
            for (const mk of ops) {
              const r = apply(d, [mk(d)]);
              h.record(r, { addToHistory: false });
              d = r.doc;
              expected = apply(expected, [mk(expected)]).doc;
            }
          };
          txs.forEach((ops, i) => {
            t += gaps[i] ?? 0;
            const r = apply(d, ops);
            h.record(r);
            d = r.doc;
            sideRun(during[i] ?? []);
          });
          const final = d;
          let i = 0;
          while (h.canUndo()) {
            const u = h.undo(d);
            expect(u?.skipped).toBe(0);
            d = (u as { doc: Doc }).doc;
            sideRun(whileUndoing[i++] ?? []);
          }
          expectSame(d, expected);
          // 之后再全部重做：等于"所有记录的编辑 + 所有旁路事务"。
          const afterUndo = expected;
          while (h.canRedo()) d = (h.redo(d) as { doc: Doc }).doc;
          if (whileUndoing.every((x) => x.length === 0)) expectSame(d, final);
          expect(validateDoc(d)).toEqual([]);
          // 再撤销到底：回到只有旁路事务的文档。
          while (h.canUndo()) d = (h.undo(d) as { doc: Doc }).doc;
          expectSame(d, afterUndo);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});
