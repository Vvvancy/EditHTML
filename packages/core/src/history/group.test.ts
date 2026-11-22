import { describe, expect, it } from 'vitest';
import { extendGroup, isBreakChar, startGroup, type TextEdit } from './group.js';

const ins = (from: number, text: string, target = 'p1'): TextEdit => ({
  kind: 'insert',
  target,
  from,
  to: from + text.length,
  text,
});
const del = (from: number, to: number, text: string): TextEdit => ({ kind: 'delete', target: 'p1', from, to, text });

describe('isBreakChar', () => {
  it.each([
    ' ',
    '\t',
    '\n',
    '　',
    ',',
    '.',
    '!',
    '?',
    ';',
    ':',
    '"',
    '(',
    '，',
    '。',
    '！',
    '？',
    '、',
    '；',
    '：',
    '「',
    '」',
    '…',
    '—',
  ])('treats %j as a break', (c) => expect(isBreakChar(c)).toBe(true));
  it.each(['a', 'Z', '0', '你', 'あ', '😀', 'é'])('does not treat %j as a break', (c) =>
    expect(isBreakChar(c)).toBe(false),
  );
});

describe('extendGroup', () => {
  it('works for any target type (T2.6 can describe raw-HTML text edits the same way)', () => {
    let g = startGroup(ins(10, 'a', 'range:3'), 0);
    g = extendGroup(g, ins(11, 'b', 'range:3'), 100) ?? g;
    expect(g.cursor).toBe(12);
    expect(extendGroup(g, ins(12, 'c', 'range:4'), 200)).toBeNull();
  });

  it('insert: contiguity, window, break after punctuation, style', () => {
    const g = startGroup(ins(0, 'ab'), 0);
    expect(extendGroup(g, ins(2, 'c'), 499)).not.toBeNull();
    expect(extendGroup(g, ins(2, 'c'), 500)).toBeNull();
    expect(extendGroup(g, ins(1, 'c'), 10)).toBeNull();
    expect(extendGroup(g, { ...ins(2, 'c'), style: 'strong' }, 10)).toBeNull();
    const p = startGroup(ins(0, '好。'), 0);
    expect(extendGroup(p, ins(2, '下'), 10)).toBeNull();
    expect(extendGroup(g, ins(2, '，'), 10)).not.toBeNull(); // 标点本身并入当前组
  });

  it('delete: direction is fixed by the second delete', () => {
    const g = startGroup(del(5, 6, 'x'), 0);
    const back = extendGroup(g, del(4, 5, 'y'), 10);
    expect(back?.kind).toBe('deleteBackward');
    expect(extendGroup(back ?? g, del(4, 5, 'z'), 20)).toBeNull();
    const fwd = extendGroup(g, del(5, 6, 'y'), 10);
    expect(fwd?.kind).toBe('deleteForward');
    expect(extendGroup(fwd ?? g, del(4, 5, 'z'), 20)).toBeNull();
    expect(extendGroup(g, del(3, 4, ' '), 10)).toBeNull();
    expect(extendGroup(g, ins(5, 'a'), 10)).toBeNull();
    expect(extendGroup(startGroup(ins(0, 'a'), 0), del(0, 1, 'a'), 10)).toBeNull();
  });
});
