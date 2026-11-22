import { describe, expect, it } from 'vitest';
import { UndoStack } from './stack.js';

interface E {
  readonly name: string;
  readonly size: number;
}
const e = (name: string, size = 1): E => ({ name, size });
const names = (s: UndoStack<E>): string[] => [...s.entries()].map((x) => x.name);

describe('UndoStack', () => {
  it('push clears redo; undo/redo move entries between stacks', () => {
    const dropped: string[] = [];
    const s = new UndoStack<E>({}, (x) => dropped.push(x.name));
    s.push(e('a'));
    s.push(e('b'));
    expect(s.popUndo()?.name).toBe('b');
    s.pushRedo(e('b-'));
    expect(s.redoDepth).toBe(1);
    expect(s.peekRedo()?.name).toBe('b-');
    s.push(e('c'));
    expect(s.redoDepth).toBe(0);
    expect(dropped).toEqual(['b-']);
    expect(names(s)).toEqual(['a', 'c']);
  });

  it('replaceTop swaps the top entry and keeps byte accounting', () => {
    const s = new UndoStack<E>();
    s.push(e('a', 10));
    s.replaceTop(e('a2', 25));
    expect(s.undoDepth).toBe(1);
    expect(s.bytes).toBe(25);
    expect(s.peekUndo()?.name).toBe('a2');
    const t = new UndoStack<E>();
    t.replaceTop(e('x'));
    expect(t.undoDepth).toBe(1);
  });

  it('trims by item count and bytes, oldest first, undo stack before redo stack', () => {
    const dropped: string[] = [];
    const s = new UndoStack<E>({ maxItems: 3, maxBytes: 100 }, (x) => dropped.push(x.name));
    for (const n of ['a', 'b', 'c', 'd']) s.push(e(n));
    expect(names(s)).toEqual(['b', 'c', 'd']);
    s.push(e('big', 90));
    expect(names(s)).toEqual(['c', 'd', 'big']);
    s.push(e('huge', 500)); // 单项超限也保留最新一项
    expect(names(s)).toEqual(['huge']);
    expect(dropped).toEqual(['a', 'b', 'c', 'd', 'big']);
    s.popUndo();
    s.pushRedo(e('r1'));
    s.pushRedo(e('r2'));
    s.pushRedo(e('r3'));
    s.pushRedo(e('r4'));
    expect(names(s)).toEqual(['r2', 'r3', 'r4']);
  });

  it('clear drops everything', () => {
    const dropped: string[] = [];
    const s = new UndoStack<E>({}, (x) => dropped.push(x.name));
    s.push(e('a'));
    s.pushRedo(e('b'));
    s.clear();
    expect(s.undoDepth + s.redoDepth).toBe(0);
    expect(s.bytes).toBe(0);
    expect(dropped).toEqual(['a', 'b']);
  });

  it('rejects maxItems < 1', () => {
    expect(() => new UndoStack<E>({ maxItems: 0 })).toThrow(RangeError);
  });
});
