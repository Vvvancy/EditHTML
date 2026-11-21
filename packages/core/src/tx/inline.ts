/**
 * 规范化行内内容上的切片 / 替换 / 标记工具（纯函数）。偏移为模型行内偏移（见 `nodeLength`）。
 *
 * @module
 */
import {
  markEquals,
  marksEqual,
  MARK_ORDER,
  nodeLength,
  normalizeInline,
  type InlineNode,
  type Mark,
} from '../model.js';
import { fail } from './errors.js';
import type { MarkSegment } from './ops.js';

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * `offset` 是否为合法插入/切分点：在 `[0, inlineLength]` 内且不在代理对中间。
 */
export function isInlineBoundary(content: readonly InlineNode[], offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0) return false;
  let pos = 0;
  for (const node of content) {
    const len = nodeLength(node);
    if (offset < pos + len) {
      if (offset === pos || node.t !== 'text') return true;
      const k = offset - pos;
      return !(isHigh(node.text.charCodeAt(k - 1)) && isLow(node.text.charCodeAt(k)));
    }
    pos += len;
  }
  return offset === pos;
}

/** 校验偏移，不合法时抛 `TxError`（`range` / `boundary`）。 */
export function assertBoundary(content: readonly InlineNode[], offset: number, len: number, what: string): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > len) fail('range', `${what} ${offset} out of [0, ${len}]`);
  if (!isInlineBoundary(content, offset)) fail('boundary', `${what} ${offset} splits a surrogate pair`);
}

/** 在 `offset` 处把内容切成前后两段（必要时切分文本节点）。 */
export function splitInline(content: readonly InlineNode[], offset: number): [InlineNode[], InlineNode[]] {
  let pos = 0;
  for (let i = 0; i < content.length; i++) {
    const node = content[i] as InlineNode;
    const len = nodeLength(node);
    if (offset === pos) return [content.slice(0, i), content.slice(i)];
    if (offset < pos + len && node.t === 'text') {
      const k = offset - pos;
      return [
        [...content.slice(0, i), { t: 'text', text: node.text.slice(0, k), marks: node.marks }],
        [{ t: 'text', text: node.text.slice(k), marks: node.marks }, ...content.slice(i + 1)],
      ];
    }
    pos += len;
  }
  return [content.slice(), []];
}

/** 把内容切成 `[0, from)`、`[from, to)`、`[to, end)` 三段（未规范化）。 */
export function sliceInline3(
  content: readonly InlineNode[],
  from: number,
  to: number,
): [InlineNode[], InlineNode[], InlineNode[]] {
  const [before, rest] = splitInline(content, from);
  const [mid, after] = splitInline(rest, to - from);
  return [before, mid, after];
}

/** 用 `insert` 替换 `[from, to)`，返回规范化的新内容与被移除的规范化切片。 */
export function replaceInline(
  content: readonly InlineNode[],
  from: number,
  to: number,
  insert: readonly InlineNode[],
): { content: InlineNode[]; removed: InlineNode[] } {
  const [before, mid, after] = sliceInline3(content, from, to);
  return { content: normalizeInline([...before, ...insert, ...after]), removed: normalizeInline(mid) };
}

/** 对 `[from, to)` 内每个节点的标记应用 `fn`，返回规范化结果。 */
export function mapMarks(
  content: readonly InlineNode[],
  from: number,
  to: number,
  fn: (marks: readonly Mark[]) => readonly Mark[],
): InlineNode[] {
  const [before, mid, after] = sliceInline3(content, from, to);
  return normalizeInline([...before, ...mid.map((n) => ({ ...n, marks: fn(n.marks) })), ...after]);
}

/**
 * `[from, to)` 内 `type` 类型标记的原值分段（相邻相同者合并）。
 */
export function markSegments(
  content: readonly InlineNode[],
  from: number,
  to: number,
  type: Mark['type'],
): MarkSegment[] {
  const segs: MarkSegment[] = [];
  let pos = 0;
  for (const node of content) {
    const len = nodeLength(node);
    const a = Math.max(pos, from);
    const b = Math.min(pos + len, to);
    if (a < b) {
      const mark = node.marks.find((m) => m.type === type) ?? null;
      const last = segs[segs.length - 1];
      if (last && last.to === a && (last.mark === null ? mark === null : mark !== null && markEquals(last.mark, mark)))
        segs[segs.length - 1] = { from: last.from, to: b, mark: last.mark };
      else segs.push({ from: a, to: b, mark });
    }
    pos += len;
    if (pos >= to) break;
  }
  return segs;
}

/** 内容是否已规范化（与 `normalizeInline` 结果一致），O(节点数)，不分配。 */
export function isNormalizedInline(content: readonly InlineNode[]): boolean {
  let prev: InlineNode | undefined;
  for (const node of content) {
    if (!marksSorted(node.marks)) return false;
    if (node.t === 'text') {
      if (node.text === '') return false;
      if (prev && prev.t === 'text' && marksEqual(prev.marks, node.marks)) return false;
    }
    prev = node;
  }
  return true;
}

function marksSorted(marks: readonly Mark[]): boolean {
  let last = -1;
  for (const m of marks) {
    const i = MARK_ORDER.indexOf(m.type);
    if (i <= last) return false;
    last = i;
  }
  return true;
}
