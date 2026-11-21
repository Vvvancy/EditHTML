import { describe, expect, it } from 'vitest';
import { Mapping, type MapStep } from './mapping.js';

const ins = (block: string, offset: number, n: number): MapStep => ({
  kind: 'text',
  block,
  offset,
  deleted: 0,
  inserted: n,
});
const del = (block: string, from: number, to: number): MapStep => ({
  kind: 'text',
  block,
  offset: from,
  deleted: to - from,
  inserted: 0,
});
const p = (offset: number, block = 'b1') => ({ block, offset });

describe('Mapping', () => {
  it('insertion: before/after shift, assoc decides the insertion point', () => {
    const m = new Mapping([ins('b1', 3, 2)]);
    expect(m.map(p(2))).toEqual(p(2));
    expect(m.map(p(4))).toEqual(p(6));
    expect(m.map(p(3), 1)).toEqual(p(5));
    expect(m.map(p(3), -1)).toEqual(p(3));
    expect(m.map(p(3))).toEqual(p(5)); // 默认 assoc = 1
    expect(m.mapResult(p(3)).deleted).toBe(false);
  });

  it('other blocks are untouched (same object returned)', () => {
    const m = new Mapping([ins('b1', 0, 5)]);
    const q = p(1, 'b2');
    expect(m.map(q)).toBe(q);
  });

  it('deletion: positions inside collapse to start and are flagged deleted; edges are not', () => {
    const m = new Mapping([del('b1', 2, 5)]);
    expect(m.mapResult(p(1))).toEqual({ pos: p(1), deleted: false });
    expect(m.mapResult(p(2))).toEqual({ pos: p(2), deleted: false });
    expect(m.mapResult(p(3))).toEqual({ pos: p(2), deleted: true });
    expect(m.mapResult(p(4), -1)).toEqual({ pos: p(2), deleted: true });
    expect(m.mapResult(p(5))).toEqual({ pos: p(2), deleted: false });
    expect(m.mapResult(p(7))).toEqual({ pos: p(4), deleted: false });
  });

  it('a deletion spanning a position followed by insertion at the same point', () => {
    const m = new Mapping([del('b1', 2, 6), ins('b1', 2, 3)]);
    expect(m.mapResult(p(4))).toEqual({ pos: p(5), deleted: true });
    expect(m.mapResult(p(4), -1)).toEqual({ pos: p(2), deleted: true });
    expect(m.map(p(8))).toEqual(p(7));
  });

  it('composes in order and tracks "that text" rather than "that offset"', () => {
    // "hello" 的 "llo" 从 2 开始；先在 0 插入 3 个字符，再删除 [0, 1)。
    const m = new Mapping([ins('b1', 0, 3)]).append(new Mapping([del('b1', 0, 1)]));
    expect(m.map(p(2))).toEqual(p(4));
    expect(m.steps).toHaveLength(2);
    expect(Mapping.empty.append(m)).toBe(m);
    expect(m.append(Mapping.empty)).toBe(m);
  });

  it('block removal flags every position in the block as deleted (sticky)', () => {
    const removed: MapStep = { kind: 'blocks', removed: new Set(['b1', 'b2']), inserted: new Set() };
    const m = new Mapping([removed]);
    expect(m.mapResult(p(3))).toEqual({ pos: p(3), deleted: true });
    expect(m.mapResult(p(0, 'b3')).deleted).toBe(false);
    expect(m.isBlockRemoved('b1')).toBe(true);
    const back = m.append(new Mapping([{ kind: 'blocks', removed: new Set(), inserted: new Set(['b1']) }]));
    expect(back.isBlockRemoved('b1')).toBe(false);
    expect(back.mapResult(p(3)).deleted).toBe(true);
  });

  it('invert maps back non-deleted positions', () => {
    const m = new Mapping([ins('b1', 1, 4), del('b1', 6, 8), ins('b2', 0, 1)]);
    const inv = m.invert();
    for (const off of [0, 1, 2, 5, 6, 9]) {
      const r = m.mapResult(p(off), -1);
      if (!r.deleted) expect(inv.map(r.pos, -1)).toEqual(p(off));
    }
    expect(inv.invert().steps).toEqual(m.steps);
    const blocks = new Mapping([{ kind: 'blocks', removed: new Set(['x']), inserted: new Set(['y']) }]).invert();
    expect(blocks.steps[0]).toEqual({ kind: 'blocks', removed: new Set(['y']), inserted: new Set(['x']) });
  });

  it('slice', () => {
    const m = new Mapping([ins('b1', 0, 1), ins('b1', 0, 2)]);
    expect(m.slice(1).map(p(0))).toEqual(p(2));
    expect(m.slice(0, 1).map(p(0))).toEqual(p(1));
  });
});
