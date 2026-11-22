/**
 * 补丁引擎（T2.2，docs/06-import.md §2 第 5–6 步）。
 *
 * 补丁 `{ start, end, text }` 表示"把**原文**的 `[start, end)` 换成 `text`"，偏移为 UTF-16 下标、半开区间，
 * 与 {@link Span} 一致。一组补丁的所有偏移都指向同一份原文（而不是前一个补丁应用后的结果）。
 *
 * ## 合并语义（精确定义）
 *
 * 设补丁按输入顺序编号 `0..k-1`。
 *
 * 1. **冲突**：两个补丁 a、b 冲突，当且仅当
 *    - 都非空区间，且共享至少一个原文字符：`max(a.start, b.start) < min(a.end, b.end)`；或
 *    - 一个是空区间（纯插入）`[p, p)`，且 `p` **严格**落在另一个的区间内部：`s < p < e`。
 *
 *    边界相接（`[0,3)` 与 `[3,5)`、插入点恰在某区间的 start 或 end）**不**算冲突；两个纯插入永不冲突。
 * 2. **后者胜**：按冲突关系取连通分量，每个分量合并成一个补丁：区间为成员区间的并（必连续），
 *    文本为分量中**输入序号最大**的成员的文本，其余成员的文本被丢弃。
 *    等价的顺序描述：依输入顺序逐个加入补丁，新补丁吞并所有与之冲突的已有补丁（取区间并、保留自己的文本）。
 * 3. **同一起点**：合并后起点相同的若干分量（至多一个非空区间 + 若干纯插入）再拼成一个补丁，
 *    文本按各分量的**最小输入序号**排序后拼接。于是同一位置的两个纯插入保持输入顺序；
 *    插入点恰在某替换的 start 时，插入文本在替换文本之前还是之后，也由输入顺序决定。
 *
 * 结果称为**规范形式**：按 start 严格递增，且相邻两项满足 `a.end <= b.start`。
 * 应用规范形式的补丁就是：原文中未被任何区间覆盖的字符原样保留，每个补丁的文本放在它的 start 处。
 *
 * @module
 */
import type { Span } from './span-index.js';

/** 区间补丁：把原文 `[start, end)` 替换为 `text`。`start === end` 为纯插入，`text === ''` 为纯删除。 */
export interface Patch extends Span {
  readonly text: string;
}

/** {@link mapOffset} 的结合方向：`-1` 落在插入/替换文本之前，`1` 落在之后。 */
export type Assoc = -1 | 1;

function checkPatch(p: Patch, i: number, length?: number): void {
  const { start, end, text } = p;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new RangeError(`补丁 #${i} 的偏移必须是整数：[${String(start)}, ${String(end)})`);
  }
  if (start < 0 || start > end) {
    throw new RangeError(`补丁 #${i} 的区间非法：[${start}, ${end})（要求 0 <= start <= end）`);
  }
  if (length !== undefined && end > length) {
    throw new RangeError(`补丁 #${i} 越界：[${start}, ${end}) 超出原文长度 ${length}`);
  }
  if (typeof text !== 'string') throw new TypeError(`补丁 #${i} 的 text 必须是字符串`);
}

const nonEmpty = (p: Span): number => Number(p.end > p.start);

/** 合并中的冲突分量。 */
interface Group {
  start: number;
  end: number;
  /** 当前胜出成员（输入序号最大）的序号与文本。 */
  win: number;
  text: string;
  /** 成员的最小输入序号，决定同一起点处的先后。 */
  key: number;
}

/**
 * 把任意补丁集合并成等价的规范形式（语义见模块说明）。
 *
 * 复杂度 O(k log k)。
 *
 * @param length 原文长度；给出时额外检查 `end <= length`。
 *
 * @throws RangeError 区间非法。
 */
export function mergePatches(patches: readonly Patch[], length?: number): Patch[] {
  patches.forEach((p, i) => checkPatch(p, i, length));
  // 同一起点：纯插入排在非空区间之前，这样线性扫描时非空分量总在最后，后续补丁只需与当前分量比较。
  const order = patches
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.start - b.p.start || nonEmpty(a.p) - nonEmpty(b.p) || a.i - b.i);

  const groups: Group[] = [];
  let cur: Group | undefined;
  for (const { p, i } of order) {
    // cur 非空时 p.start >= cur.start；p 非空：共享字符 ⇔ p.start < cur.end；p 为空：需 cur.start < p.start < cur.end。
    const conflict =
      cur !== undefined && cur.end > cur.start && p.start < cur.end && (p.end > p.start || p.start > cur.start);
    if (cur !== undefined && conflict) {
      cur.end = Math.max(cur.end, p.end);
      if (i > cur.win) {
        cur.win = i;
        cur.text = p.text;
      }
      cur.key = Math.min(cur.key, i);
    } else {
      cur = { start: p.start, end: p.end, win: i, text: p.text, key: i };
      groups.push(cur);
    }
  }

  // 同一起点的分量拼成一个补丁（文本按 key 排序）。groups 已按 start 有序。
  const out: Patch[] = [];
  let same: Group[] = [];
  const flush = (): void => {
    const first = same[0];
    if (!first) return;
    same.sort((x, y) => x.key - y.key);
    out.push({ start: first.start, end: Math.max(...same.map((g) => g.end)), text: same.map((g) => g.text).join('') });
    same = [];
  };
  for (const g of groups) {
    if (same[0] && same[0].start !== g.start) flush();
    same.push(g);
  }
  flush();
  return out;
}

/**
 * 把补丁应用到原文：先 {@link mergePatches}，再一次线性拼接，O(原文长度 + 补丁总长)。
 * 没有补丁时原样返回 `source`（`===`），保证未编辑文件逐字节相同。
 *
 * @throws RangeError 区间非法或越界。
 */
export function applyPatches(source: string, patches: readonly Patch[]): string {
  if (patches.length === 0) return source;
  const merged = mergePatches(patches, source.length);
  const parts: string[] = [];
  let pos = 0;
  for (const p of merged) {
    parts.push(source.slice(pos, p.start), p.text);
    pos = p.end;
  }
  parts.push(source.slice(pos));
  return parts.join('');
}

/**
 * 求逆补丁：返回一组以**新串**（`applyPatches(source, patches)` 的结果）为原文的补丁，
 * 应用后恰好还原 `source`。结果已是规范形式。
 *
 * @throws RangeError 区间非法或越界。
 */
export function invertPatches(source: string, patches: readonly Patch[]): Patch[] {
  const out: Patch[] = [];
  let delta = 0;
  for (const p of mergePatches(patches, source.length)) {
    const start = p.start + delta;
    out.push({ start, end: start + p.text.length, text: source.slice(p.start, p.end) });
    delta += p.text.length - (p.end - p.start);
  }
  // 相邻原补丁之间无原文（如 `[0,1)` 与 `[1,1)`）时，逆补丁会同起点；按输入顺序再规范化一次。
  return mergePatches(out);
}

/**
 * 把原文中的偏移映射到应用补丁后的新串中的偏移（供后续编辑/选区沿补丁重定位）。
 *
 * - 补丁之前的偏移不变，之后的偏移按长度差平移；
 * - 落在非空区间的 start 上映射到替换文本之前，落在 end 上映射到替换文本之后；
 * - 落在区间内部或纯插入点上时由 `assoc` 决定：`-1` 在文本之前，`1`（默认）在文本之后。
 *
 * @throws RangeError 补丁区间非法，或偏移不是 `[0, +∞)` 内的整数。
 */
export function mapOffset(patches: readonly Patch[], offset: number, assoc: Assoc = 1): number {
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`偏移必须是非负整数：${String(offset)}`);
  let delta = 0;
  for (const p of mergePatches(patches)) {
    if (p.start > offset) break;
    const ranged = p.end > p.start;
    if (p.end < offset || (ranged && p.end === offset)) {
      delta += p.text.length - (p.end - p.start);
      continue;
    }
    // 此处 p.start <= offset <= p.end，且不在非空区间的 end 上。
    const before = (ranged && offset === p.start) || assoc < 0;
    return p.start + delta + (before ? 0 : p.text.length);
  }
  return offset + delta;
}
