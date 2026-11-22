import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyPatches, invertPatches, mapOffset, mergePatches, type Patch } from './patch.js';

const RUNS = Number(process.env.PATCH_PROP_RUNS ?? 1000);

const FIXTURES = fileURLToPath(new URL('../../../../tests/fixtures/html/', import.meta.url));
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.html'))
  .map((f) => readFileSync(FIXTURES + f, 'utf8'));

// ---------------------------------------------------------------------------
// 朴素参考实现：逐条按模块说明的"顺序描述"吞并冲突补丁，再按字符归属数组重建。
// ---------------------------------------------------------------------------

function conflicts(a: Patch, b: Patch): boolean {
  const ea = a.end > a.start;
  const eb = b.end > b.start;
  if (ea && eb) return Math.max(a.start, b.start) < Math.min(a.end, b.end);
  if (ea) return a.start < b.start && b.start < a.end;
  if (eb) return b.start < a.start && a.start < b.end;
  return false;
}

interface RefGroup extends Patch {
  readonly key: number;
}

function naiveGroups(patches: readonly Patch[]): RefGroup[] {
  let groups: RefGroup[] = [];
  patches.forEach((p, i) => {
    const hit = groups.filter((g) => conflicts(g, p));
    groups = groups.filter((g) => !hit.includes(g));
    groups.push({
      start: Math.min(p.start, ...hit.map((g) => g.start)),
      end: Math.max(p.end, ...hit.map((g) => g.end)),
      text: p.text,
      key: Math.min(i, ...hit.map((g) => g.key)),
    });
  });
  return groups;
}

function naiveApply(source: string, patches: readonly Patch[]): string {
  const groups = naiveGroups(patches);
  // owner[k]：原文第 k 个字符是否被某个分量删除。
  const deleted = Array.from({ length: source.length }, (_, k) => groups.some((g) => g.start <= k && k < g.end));
  let out = '';
  for (let gap = 0; gap <= source.length; gap++) {
    for (const g of groups.filter((x) => x.start === gap).sort((x, y) => x.key - y.key)) out += g.text;
    if (gap < source.length && deleted[gap] !== true) out += source.charAt(gap);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

const arbText = fc.string({ unit: fc.constantFrom('a', 'b', 'X', '<', '>', '\n', 'é', '😀'), maxLength: 6 });

function arbPatchesFor(length: number, maxLen: number): fc.Arbitrary<Patch[]> {
  const arbPatch = fc
    .tuple(fc.integer({ min: 0, max: length }), fc.integer({ min: 0, max: maxLen }), arbText)
    .map(([start, len, text]) => ({ start, end: Math.min(length, start + len), text }));
  // 混入一些"同一点纯插入"，提高同起点并列的概率。
  const arbInsert = fc
    .tuple(fc.integer({ min: 0, max: Math.min(length, 3) }), arbText)
    .map(([start, text]) => ({ start, end: start, text }));
  return fc.array(fc.oneof(arbPatch, arbPatch, arbInsert), { maxLength: 12 });
}

const arbSmallCase = fc
  .string({ unit: fc.constantFrom('a', 'b', 'c', '\r', '\n', 'é'), maxLength: 20 })
  .chain((source) => arbPatchesFor(source.length, 6).map((patches) => ({ source, patches })));

const arbFixtureCase = fc.integer({ min: 0, max: fixtures.length - 1 }).chain((i) => {
  const source = fixtures[i] ?? '';
  return arbPatchesFor(source.length, 200).map((patches) => ({ source, patches }));
});

function isCanonical(ps: readonly Patch[]): boolean {
  return ps.every((p, i) => {
    const prev = ps[i - 1];
    return p.start <= p.end && (prev === undefined || (prev.start < p.start && prev.end <= p.start));
  });
}

// ---------------------------------------------------------------------------

describe('applyPatches', () => {
  it('无补丁时原样返回（===）', () => {
    for (const src of fixtures) expect(applyPatches(src, [])).toBe(src);
    const s = 'x'.repeat(3);
    expect(applyPatches(s, [])).toBe(s);
  });

  it('基本替换 / 插入 / 删除', () => {
    expect(applyPatches('hello world', [{ start: 6, end: 11, text: 'there' }])).toBe('hello there');
    expect(applyPatches('abc', [{ start: 1, end: 1, text: 'X' }])).toBe('aXbc');
    expect(applyPatches('abcdef', [{ start: 1, end: 3, text: '' }])).toBe('adef');
    expect(applyPatches('abc', [{ start: 3, end: 3, text: '!' }])).toBe('abc!');
    expect(applyPatches('', [{ start: 0, end: 0, text: 'x' }])).toBe('x');
  });

  it('输入顺序无关（不冲突时），按 start 降序与乱序结果一致', () => {
    const ps: Patch[] = [
      { start: 0, end: 1, text: 'A' },
      { start: 4, end: 6, text: 'B' },
      { start: 2, end: 2, text: 'C' },
    ];
    expect(applyPatches('0123456', ps)).toBe('A1C23B6');
    expect(applyPatches('0123456', [...ps].reverse())).toBe('A1C23B6');
  });

  it('同一点的纯插入保持输入顺序', () => {
    expect(
      applyPatches('ab', [
        { start: 1, end: 1, text: 'x' },
        { start: 1, end: 1, text: 'y' },
      ]),
    ).toBe('axyb');
    expect(
      applyPatches('ab', [
        { start: 1, end: 1, text: 'y' },
        { start: 1, end: 1, text: 'x' },
      ]),
    ).toBe('ayxb');
  });

  it('插入点在替换的 start 上：按输入顺序决定先后；在 end 上：总在替换之后', () => {
    const r: Patch = { start: 1, end: 3, text: 'R' };
    const i: Patch = { start: 1, end: 1, text: 'i' };
    expect(applyPatches('abcd', [r, i])).toBe('aRid');
    expect(applyPatches('abcd', [i, r])).toBe('aiRd');
    expect(applyPatches('abcd', [{ start: 3, end: 3, text: 'e' }, r])).toBe('aRed');
  });

  it('冲突时后者胜：区间取并，文本取最后一个', () => {
    expect(
      applyPatches('0123456789', [
        { start: 1, end: 5, text: 'A' },
        { start: 3, end: 7, text: 'B' },
      ]),
    ).toBe('0B789');
    // 嵌套：外层后到 → 外层胜；内层后到 → 内层文本替换整个并集。
    const outer: Patch = { start: 1, end: 9, text: 'O' };
    const inner: Patch = { start: 3, end: 5, text: 'I' };
    expect(applyPatches('0123456789', [inner, outer])).toBe('0O9');
    expect(applyPatches('0123456789', [outer, inner])).toBe('0I9');
    // 严格内部的插入与替换冲突。
    expect(
      applyPatches('0123', [
        { start: 0, end: 4, text: 'R' },
        { start: 2, end: 2, text: 'i' },
      ]),
    ).toBe('i');
    // 链式冲突：A 与 C 不直接冲突，经 B 连通。
    expect(
      applyPatches('0123456789', [
        { start: 0, end: 3, text: 'A' },
        { start: 7, end: 9, text: 'C' },
        { start: 2, end: 8, text: 'B' },
      ]),
    ).toBe('B9');
  });

  it('非法补丁抛出清晰错误', () => {
    expect(() => applyPatches('abc', [{ start: 2, end: 1, text: '' }])).toThrow(/区间非法/);
    expect(() => applyPatches('abc', [{ start: -1, end: 1, text: '' }])).toThrow(/区间非法/);
    expect(() => applyPatches('abc', [{ start: 1, end: 4, text: '' }])).toThrow(/越界/);
    expect(() => applyPatches('abc', [{ start: 0.5, end: 1, text: '' }])).toThrow(/整数/);
    expect(() => mergePatches([{ start: Number.NaN, end: 1, text: '' }])).toThrow(RangeError);
    expect(() => invertPatches('abc', [{ start: 0, end: 9, text: '' }])).toThrow(/越界/);
  });

  it('性质：随机补丁集（含重叠、同点插入）应用结果 = 朴素参考重建', () => {
    fc.assert(
      fc.property(arbSmallCase, ({ source, patches }) => {
        expect(applyPatches(source, patches)).toBe(naiveApply(source, patches));
      }),
      { numRuns: RUNS },
    );
  });

  it('性质：真实 fixtures 上的随机补丁 = 朴素参考重建', () => {
    fc.assert(
      fc.property(arbFixtureCase, ({ source, patches }) => {
        expect(applyPatches(source, patches)).toBe(naiveApply(source, patches));
      }),
      { numRuns: Math.max(1, Math.floor(RUNS / 5)) },
    );
  });

  it('性质：两两不冲突且起点互异时 = 按 start 降序逐个 slice 重建', () => {
    fc.assert(
      fc.property(arbSmallCase, ({ source, patches }) => {
        const disjoint = patches.filter((p, i) =>
          patches.every((q, j) => i === j || (q.start !== p.start && (q.end <= p.start || p.end <= q.start))),
        );
        let s = source;
        for (const p of [...disjoint].sort((a, b) => b.start - a.start))
          s = s.slice(0, p.start) + p.text + s.slice(p.end);
        expect(applyPatches(source, disjoint)).toBe(s);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('mergePatches', () => {
  it('空输入 → 空输出', () => {
    expect(mergePatches([])).toEqual([]);
  });

  it('同起点拼接、边界相接不合并', () => {
    expect(
      mergePatches([
        { start: 3, end: 5, text: 'b' },
        { start: 0, end: 3, text: 'a' },
        { start: 3, end: 3, text: 'c' },
      ]),
    ).toEqual([
      { start: 0, end: 3, text: 'a' },
      { start: 3, end: 5, text: 'bc' },
    ]);
  });

  it('性质：输出为规范形式、幂等，且与原补丁集等价', () => {
    fc.assert(
      fc.property(arbSmallCase, ({ source, patches }) => {
        const m = mergePatches(patches, source.length);
        expect(isCanonical(m)).toBe(true);
        expect(mergePatches(m)).toEqual(m);
        expect(applyPatches(source, m)).toBe(applyPatches(source, patches));
      }),
      { numRuns: RUNS },
    );
  });
});

describe('invertPatches', () => {
  it('示例', () => {
    const src = 'hello world';
    const ps: Patch[] = [
      { start: 0, end: 5, text: 'bye' },
      { start: 11, end: 11, text: '!' },
    ];
    const out = applyPatches(src, ps);
    expect(out).toBe('bye world!');
    expect(invertPatches(src, ps)).toEqual([
      { start: 0, end: 3, text: 'hello' },
      { start: 9, end: 10, text: '' },
    ]);
  });

  it('性质：apply(apply(s, P), invert(s, P)) === s', () => {
    fc.assert(
      fc.property(fc.oneof(arbSmallCase, arbFixtureCase), ({ source, patches }) => {
        const out = applyPatches(source, patches);
        const inv = invertPatches(source, patches);
        expect(isCanonical(inv)).toBe(true);
        expect(applyPatches(out, inv)).toBe(source);
        // 逆的逆还原出新串。
        expect(applyPatches(source, invertPatches(out, inv))).toBe(out);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('mapOffset', () => {
  it('示例', () => {
    const ps: Patch[] = [
      { start: 2, end: 4, text: 'XYZ' },
      { start: 6, end: 6, text: 'ii' },
    ];
    // 'ab' 'cd'→'XYZ' 'ef' + 'ii' + 'gh'  ⇒  'abXYZefiigh'
    expect(applyPatches('abcdefgh', ps)).toBe('abXYZefiigh');
    expect(mapOffset(ps, 1)).toBe(1);
    expect(mapOffset(ps, 2, 1)).toBe(2); // 替换的 start：在文本之前
    expect(mapOffset(ps, 3, -1)).toBe(2); // 内部：按 assoc
    expect(mapOffset(ps, 3, 1)).toBe(5);
    expect(mapOffset(ps, 4, -1)).toBe(5); // 替换的 end：在文本之后
    expect(mapOffset(ps, 6, -1)).toBe(7); // 插入点：按 assoc
    expect(mapOffset(ps, 6, 1)).toBe(9);
    expect(mapOffset(ps, 8)).toBe(11);
    expect(() => mapOffset(ps, -1)).toThrow(RangeError);
  });

  it('性质：两种 assoc 各自单调；未被覆盖的字符映射后仍指向同一字符；首尾映射到首尾', () => {
    fc.assert(
      fc.property(arbSmallCase, ({ source, patches }) => {
        const out = applyPatches(source, patches);
        const merged = mergePatches(patches);
        let prevLo = -1;
        let prevHi = -1;
        for (let o = 0; o <= source.length; o++) {
          const lo = mapOffset(patches, o, -1);
          const hi = mapOffset(patches, o, 1);
          expect(prevLo <= lo && prevHi <= hi && lo <= hi && hi <= out.length).toBe(true);
          prevLo = lo;
          prevHi = hi;
          const covered = merged.some((p) => p.start <= o && o < p.end);
          if (o < source.length && !covered) expect(out.charAt(hi)).toBe(source.charAt(o));
        }
        expect(mapOffset(patches, 0, -1)).toBe(0);
        expect(mapOffset(patches, source.length, 1)).toBe(out.length);
      }),
      { numRuns: RUNS },
    );
  });
});
