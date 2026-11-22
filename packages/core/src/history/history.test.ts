import { describe, expect, it } from 'vitest';
import {
  componentBlock,
  createDoc,
  docEquals,
  inlineText,
  text,
  textBlock,
  type BlockId,
  type Doc,
  type TextBlock,
} from '../model.js';
import { apply, tr, type TxResult } from '../tx/apply.js';
import type { Op } from '../tx/ops.js';
import { History, type HistoryOptions, type RecordOptions } from './history.js';

/** 测试用的小编辑器：持有文档与历史，时间手动推进。 */
class Ed {
  doc: Doc;
  t = 0;
  readonly h: History<string>;
  constructor(doc: Doc, opts: HistoryOptions = {}) {
    this.doc = doc;
    this.h = new History<string>({ clock: () => this.t, ...opts });
  }
  run(ops: Op[], opts: RecordOptions<string> = {}): TxResult {
    const r = apply(this.doc, ops);
    this.h.record(r, opts);
    this.doc = r.doc;
    return r;
  }
  type(block: BlockId, offset: number, s: string, dt = 100, opts: RecordOptions<string> = {}): this {
    this.t += dt;
    this.run([{ t: 'insertText', block, offset, text: s }], opts);
    return this;
  }
  /** 逐字符输入（每个字符间隔 dt）。 */
  typeChars(block: BlockId, offset: number, s: string, dt = 100): this {
    let o = offset;
    for (const ch of s) {
      this.type(block, o, ch, dt);
      o += ch.length;
    }
    return this;
  }
  del(block: BlockId, from: number, to: number, dt = 100): this {
    this.t += dt;
    this.run([{ t: 'deleteText', block, from, to }]);
    return this;
  }
  side(ops: Op[]): this {
    this.run(ops, { addToHistory: false });
    return this;
  }
  undo(): boolean {
    const u = this.h.undo(this.doc);
    if (u) this.doc = u.doc;
    return !!u;
  }
  redo(): boolean {
    const u = this.h.redo(this.doc);
    if (u) this.doc = u.doc;
    return !!u;
  }
  text(id: BlockId): string {
    return inlineText((this.doc.blocks.get(id) as TextBlock).content);
  }
}

const doc2 = (): Doc => createDoc([textBlock('b1', 'p', [text('hello')]), textBlock('b2', 'p', [text('world')])]);
const empty = (): Doc => createDoc([textBlock('b1', 'p'), textBlock('b2', 'p')]);

describe('History basics', () => {
  it('undo / redo a single transaction; canUndo / canRedo', () => {
    const e = new Ed(doc2());
    const orig = e.doc;
    expect(e.h.canUndo()).toBe(false);
    e.type('b1', 5, '!');
    expect(e.h.canUndo()).toBe(true);
    expect(e.undo()).toBe(true);
    expect(docEquals(e.doc, orig)).toBe(true);
    expect(e.h.canUndo()).toBe(false);
    expect(e.h.canRedo()).toBe(true);
    expect(e.redo()).toBe(true);
    expect(e.text('b1')).toBe('hello!');
    expect(e.undo() && e.undo()).toBe(false);
    expect(e.h.undo(e.doc)).toBeNull();
  });

  it('undo returns the result for rendering and the stored selection', () => {
    const e = new Ed(doc2());
    e.type('b1', 0, 'x', 100, { selectionBefore: 'before', selectionAfter: 'after' });
    const u = e.h.undo(e.doc);
    expect(u?.selection).toBe('before');
    expect(u?.result.dirty.has('b1')).toBe(true);
    expect(u?.skipped).toBe(0);
    const r = e.h.redo(u?.doc as Doc);
    expect(r?.selection).toBe('after');
  });

  it('merged items keep the first selectionBefore and the last selectionAfter', () => {
    const e = new Ed(empty());
    e.type('b1', 0, 'a', 100, { selectionBefore: 's0', selectionAfter: 's1' });
    e.type('b1', 1, 'b', 100, { selectionBefore: 's1', selectionAfter: 's2' });
    expect(e.h.undoDepth).toBe(1);
    const u = e.h.undo(e.doc);
    expect(u?.selection).toBe('s0');
    expect(e.h.redo(u?.doc as Doc)?.selection).toBe('s2');
  });

  it('a new recorded edit clears the redo stack', () => {
    const e = new Ed(doc2());
    e.type('b1', 0, 'x', 1000).type('b1', 0, 'y', 1000);
    e.undo();
    expect(e.h.canRedo()).toBe(true);
    e.type('b2', 0, 'z', 1000);
    expect(e.h.canRedo()).toBe(false);
    expect(e.redo()).toBe(false);
  });

  it('ignores no-op transactions', () => {
    const e = new Ed(doc2());
    e.run([{ t: 'setMark', block: 'b1', from: 0, to: 0, mark: { type: 'strong' }, value: true }]);
    expect(e.h.canUndo()).toBe(false);
  });

  it('honours tx.meta.addToHistory === false', () => {
    const e = new Ed(doc2());
    const r = tr(e.doc).insertText('b1', 0, 'x').apply({ addToHistory: false });
    e.h.record(r);
    e.doc = r.doc;
    expect(e.h.canUndo()).toBe(false);
  });

  it('rejects a doc that was not produced through record()', () => {
    const e = new Ed(doc2());
    e.type('b1', 0, 'x');
    const stray = apply(e.doc, [{ t: 'insertText', block: 'b1', offset: 0, text: 'y' }]).doc;
    expect(() => e.h.undo(stray)).toThrow(/record/);
  });

  it('undo of structural ops: remove/insert/move blocks, props, meta', () => {
    const d = createDoc([
      textBlock('b1', 'p', [text('a')]),
      componentBlock('c1', 'callout', { kind: 'info' }, { slots: [['b3']] }),
      textBlock('b3', 'p', [text('in')]),
    ]);
    const e = new Ed(d);
    e.t += 1000;
    e.run([{ t: 'removeBlock', id: 'b1' }]);
    e.t += 1000;
    e.run([{ t: 'moveBlock', id: 'b3', parent: null, slot: 0, index: 0 }]);
    e.t += 1000;
    e.run([
      { t: 'setProps', id: 'c1', patch: [{ op: 'replace', path: '/kind', value: 'warn' }] },
      { t: 'setMeta', patch: [{ op: 'add', path: '/title', value: 'T' }] },
    ]);
    const after = e.doc;
    while (e.undo());
    expect(docEquals(e.doc, d)).toBe(true);
    while (e.redo());
    expect(docEquals(e.doc, after)).toBe(true);
  });
});

describe('input merging (03 §4)', () => {
  it('consecutive single-char insertText within 500ms in one block merge into one item', () => {
    const e = new Ed(empty());
    e.typeChars('b1', 0, 'hello', 100);
    expect(e.h.undoDepth).toBe(1);
    e.undo();
    expect(e.text('b1')).toBe('');
  });

  it('the merge window is < 500ms, measured from the previous keystroke', () => {
    const e = new Ed(empty());
    e.type('b1', 0, 'a', 0).type('b1', 1, 'b', 499).type('b1', 2, 'c', 499);
    expect(e.h.undoDepth).toBe(1);
    e.type('b1', 3, 'd', 500);
    expect(e.h.undoDepth).toBe(2);
    e.undo();
    expect(e.text('b1')).toBe('abc');
  });

  it('time going backwards does not merge; explicit now overrides the clock', () => {
    const e = new Ed(empty());
    e.type('b1', 0, 'a', 1000);
    e.type('b1', 1, 'b', 0, { now: 10 });
    expect(e.h.undoDepth).toBe(2);
    e.type('b1', 2, 'c', 0, { now: 20 });
    expect(e.h.undoDepth).toBe(2);
  });

  it('breaks after a space: "hello world" → "hello " + "world"', () => {
    const e = new Ed(empty());
    e.typeChars('b1', 0, 'hello world', 50);
    expect(e.h.undoDepth).toBe(2);
    e.undo();
    expect(e.text('b1')).toBe('hello ');
    e.undo();
    expect(e.text('b1')).toBe('');
  });

  it.each(['，', '。', '！', '？', '、', '；', ',', '.', '!', '?', '　', '\t'])('breaks after %j', (p) => {
    const e = new Ed(empty());
    e.typeChars('b1', 0, `你好${p}世界`, 50);
    expect(e.h.undoDepth).toBe(2);
    e.undo();
    expect(e.text('b1')).toBe(`你好${p}`);
  });

  it('multi-char insertions (IME commits) merge; emoji (surrogate pairs) are not break chars', () => {
    const e = new Ed(empty());
    e.type('b1', 0, '你好', 100).type('b1', 2, '😀', 100).type('b1', 4, '世界', 100);
    expect(e.h.undoDepth).toBe(1);
  });

  it('breaks on block change', () => {
    const e = new Ed(empty());
    e.type('b1', 0, 'a').type('b2', 0, 'b').type('b1', 1, 'c');
    expect(e.h.undoDepth).toBe(3);
  });

  it('breaks on selection jump (non-contiguous offset), merge: false and closeGroup()', () => {
    const e = new Ed(doc2());
    e.type('b1', 5, 'a').type('b1', 0, 'b');
    expect(e.h.undoDepth).toBe(2);
    e.type('b1', 1, 'c', 100, { merge: false });
    expect(e.h.undoDepth).toBe(3);
    e.h.closeGroup();
    e.type('b1', 2, 'd');
    expect(e.h.undoDepth).toBe(4);
    e.type('b1', 3, 'e');
    expect(e.h.undoDepth).toBe(4);
  });

  it('breaks when marks differ', () => {
    const e = new Ed(empty());
    e.type('b1', 0, 'a');
    e.t += 100;
    e.run([{ t: 'insertText', block: 'b1', offset: 1, text: 'b', marks: [{ type: 'strong' }] }]);
    expect(e.h.undoDepth).toBe(2);
  });

  it('breaks on any non-text op, and non-text ops never merge', () => {
    const e = new Ed(empty());
    e.type('b1', 0, 'ab');
    e.t += 10;
    e.run([{ t: 'setMark', block: 'b1', from: 0, to: 1, mark: { type: 'em' }, value: true }]);
    e.type('b1', 2, 'c', 10);
    e.t += 10;
    e.run([{ t: 'setAttrs', id: 'b1', attrs: { x: '1' } }]);
    e.t += 10;
    e.run([{ t: 'setAttrs', id: 'b1', attrs: { x: '2' } }]);
    expect(e.h.undoDepth).toBe(5);
  });

  it('multi-op transactions do not merge', () => {
    const e = new Ed(empty());
    e.type('b1', 0, 'a');
    e.t += 10;
    e.run([
      { t: 'insertText', block: 'b1', offset: 1, text: 'b' },
      { t: 'insertText', block: 'b1', offset: 2, text: 'c' },
    ]);
    expect(e.h.undoDepth).toBe(2);
  });

  it('a non-history transaction in between breaks the group', () => {
    const e = new Ed(empty());
    e.type('b1', 0, 'a')
      .side([{ t: 'insertText', block: 'b2', offset: 0, text: 'remote' }])
      .type('b1', 1, 'b');
    expect(e.h.undoDepth).toBe(2);
  });

  it('consecutive backspaces merge; deleting a space starts a new group', () => {
    const e = new Ed(createDoc([textBlock('b1', 'p', [text('hello world')])]));
    for (let i = 11; i > 6; i--) e.del('b1', i - 1, i, 50); // "dlrow"
    expect(e.h.undoDepth).toBe(1);
    e.del('b1', 5, 6, 50); // " "
    e.del('b1', 4, 5, 50); // "o"
    expect(e.h.undoDepth).toBe(2);
    expect(e.text('b1')).toBe('hell');
    e.undo();
    expect(e.text('b1')).toBe('hello ');
    e.undo();
    expect(e.text('b1')).toBe('hello world');
  });

  it('consecutive forward deletes merge; switching direction breaks', () => {
    const e = new Ed(createDoc([textBlock('b1', 'p', [text('abcdef')])]));
    e.del('b1', 2, 3).del('b1', 2, 3); // Delete ×2 at offset 2
    expect(e.h.undoDepth).toBe(1);
    e.del('b1', 1, 2); // backspace
    expect(e.h.undoDepth).toBe(2);
    expect(e.text('b1')).toBe('aef');
  });

  it('insert after delete (and vice versa) does not merge', () => {
    const e = new Ed(createDoc([textBlock('b1', 'p', [text('abc')])]));
    e.del('b1', 2, 3).type('b1', 2, 'x').del('b1', 2, 3);
    expect(e.h.undoDepth).toBe(3);
  });

  it('deleting a <br> or atom is not merged', () => {
    const d = createDoc([textBlock('b1', 'p', [text('ab'), { t: 'br', marks: [] }, text('cd')])]);
    const e = new Ed(d);
    e.del('b1', 4, 5).del('b1', 3, 4).del('b1', 2, 3).del('b1', 1, 2);
    expect(e.h.undoDepth).toBe(3);
  });

  it('custom merge window and break predicate', () => {
    const e = new Ed(empty(), { mergeWindow: 2000, isBreak: (c) => c === '|' });
    e.typeChars('b1', 0, 'a b', 1500);
    expect(e.h.undoDepth).toBe(1);
    e.typeChars('b1', 3, '|c', 10);
    expect(e.h.undoDepth).toBe(2);
  });
});

describe('limits', () => {
  it('caps by item count, dropping the oldest', () => {
    const e = new Ed(empty(), { maxItems: 3 });
    for (let i = 0; i < 5; i++) e.type('b1', i, String(i), 1000);
    expect(e.h.undoDepth).toBe(3);
    while (e.undo());
    expect(e.text('b1')).toBe('01');
  });

  it('caps by approximate memory, dropping the oldest but keeping the newest', () => {
    const e = new Ed(empty(), { maxBytes: 2000 });
    e.type('b1', 0, 'x'.repeat(300), 1000); // ~ 700 B
    e.type('b1', 300, 'y'.repeat(300), 1000);
    expect(e.h.undoDepth).toBe(2);
    e.type('b1', 600, 'z'.repeat(300), 1000);
    expect(e.h.undoDepth).toBe(2);
    expect(e.h.bytes).toBeLessThanOrEqual(2000);
    e.type('b2', 0, 'w'.repeat(5000), 1000); // 单项超限：仍保留
    expect(e.h.undoDepth).toBe(1);
    e.undo();
    expect(e.text('b2')).toBe('');
  });

  it('the limit counts the redo stack too', () => {
    const e = new Ed(empty(), { maxItems: 2 });
    e.type('b1', 0, 'a', 1000).type('b1', 1, 'b', 1000);
    e.undo();
    e.undo();
    expect(e.h.redoDepth).toBe(2);
    e.redo();
    e.redo();
    expect(e.text('b1')).toBe('ab');
  });

  it('the mapping log is compacted once items are dropped', () => {
    const e = new Ed(empty(), { maxItems: 2 });
    for (let i = 0; i < 3000; i++) e.type('b1', i, 'a', 1000);
    expect(e.h.logSize).toBeLessThan(2100);
    e.h.clear();
    expect(e.h.logSize).toBe(0);
    expect(e.h.canUndo()).toBe(false);
  });
});

describe('snapshots', () => {
  it('takes a block-hash snapshot every N transactions and verifies', () => {
    const e = new Ed(doc2(), { snapshotEvery: 3, maxSnapshots: 2 });
    e.type('b1', 0, 'a', 1000).type('b1', 0, 'b', 1000);
    expect(e.h.snapshots.length).toBe(0);
    e.type('b1', 0, 'c', 1000);
    expect(e.h.snapshots.length).toBe(1);
    const snap = e.h.snapshots[0];
    expect(snap?.version).toBe(e.doc.version);
    expect(snap?.txCount).toBe(3);
    expect(e.h.verify(e.doc).ok).toBe(true);
    e.type('b2', 0, 'x', 1000);
    const v = e.h.verify(e.doc);
    expect(v.ok).toBe(false);
    expect(v.changed).toEqual(['b2']);
    e.undo(); // undo / redo count as transactions too
    expect(e.h.verify(e.doc).ok).toBe(true);
    expect(e.h.snapshots.length).toBe(1);
    e.undo();
    e.undo();
    expect(e.h.snapshots.length).toBe(2);
  });

  it('detects corrupt hashes, added / missing blocks and root order changes', () => {
    const e = new Ed(doc2());
    const snap = e.h.snapshot(e.doc);
    e.run([{ t: 'removeBlock', id: 'b2' }]);
    e.run([{ t: 'insertBlock', parent: null, slot: 0, index: 0, block: textBlock('b9', 'p') }]);
    const v = e.h.verify(e.doc, snap);
    expect(v).toMatchObject({ ok: false, added: ['b9'], missing: ['b2'], rootEqual: false, corrupt: [] });
    const b1 = e.doc.blocks.get('b1') as TextBlock;
    const bad: Doc = { ...e.doc, blocks: new Map([...e.doc.blocks, ['b1', { ...b1, hash: b1.hash + 1 }]]) };
    expect(e.h.verify(bad, snap).corrupt).toEqual(['b1']);
  });

  it('snapshotEvery: 0 disables automatic snapshots; verify without snapshots checks integrity only', () => {
    const e = new Ed(doc2(), { snapshotEvery: 0 });
    for (let i = 0; i < 300; i++) e.type('b1', 0, 'a', 1000);
    expect(e.h.snapshots.length).toBe(0);
    expect(e.h.verify(e.doc).ok).toBe(true);
  });
});

describe('non-history transactions are mapped through (that text, not that offset)', () => {
  it('remote insert before the recorded text in the same block', () => {
    const e = new Ed(doc2());
    e.type('b1', 5, ' there');
    e.side([{ t: 'insertText', block: 'b1', offset: 0, text: '>> ' }]);
    e.undo();
    expect(e.text('b1')).toBe('>> hello');
    e.redo();
    expect(e.text('b1')).toBe('>> hello there');
  });

  it('remote insert inside / after merged typing', () => {
    const e = new Ed(empty());
    e.typeChars('b1', 0, 'abc', 10);
    e.side([{ t: 'insertText', block: 'b1', offset: 3, text: 'XY' }]);
    e.side([{ t: 'insertText', block: 'b1', offset: 0, text: '<' }]);
    e.undo();
    expect(e.text('b1')).toBe('<XY');
  });

  it('undo of a deletion re-inserts at the mapped position', () => {
    const e = new Ed(createDoc([textBlock('b1', 'p', [text('one two three')])]));
    e.del('b1', 4, 8); // "two "
    e.side([{ t: 'insertText', block: 'b1', offset: 0, text: '0 ' }]);
    e.side([{ t: 'deleteText', block: 'b1', from: 6, to: 11 }]); // 删掉 "three"
    e.undo();
    expect(e.text('b1')).toBe('0 one two ');
  });

  it('mirrors: an undone deletion restores positions for older items exactly', () => {
    const e = new Ed(empty());
    e.type('b1', 0, 'abc', 1000); // Y
    e.del('b1', 0, 3, 1000); // X 删掉 Y 的全部文字
    e.side([{ t: 'insertText', block: 'b1', offset: 0, text: 'Z' }]);
    e.undo(); // 撤销 X → "Zabc"（越过 remote，走映射路径）
    expect(e.text('b1')).toBe('Zabc');
    e.undo(); // 撤销 Y：位置经 X 的删除与其镜像恢复，必须删掉 "abc"
    expect(e.text('b1')).toBe('Z');
    e.redo();
    e.redo();
    expect(e.text('b1')).toBe('Z');
    e.undo();
    expect(e.text('b1')).toBe('Zabc');
  });

  it('mirrors within one multi-op item', () => {
    const e = new Ed(empty());
    e.run([
      { t: 'insertText', block: 'b1', offset: 0, text: 'abc' },
      { t: 'deleteText', block: 'b1', from: 0, to: 3 },
      { t: 'insertText', block: 'b1', offset: 0, text: 'q' },
    ]);
    e.side([{ t: 'insertText', block: 'b1', offset: 1, text: 'R' }]);
    e.undo();
    expect(e.text('b1')).toBe('R');
  });

  it('ops on blocks removed by a non-history transaction are skipped', () => {
    const e = new Ed(doc2());
    e.type('b2', 0, 'x', 1000).type('b1', 0, 'y', 1000);
    e.side([{ t: 'removeBlock', id: 'b2' }]);
    const u1 = e.h.undo(e.doc);
    expect(u1?.skipped).toBe(0);
    e.doc = (u1 as { doc: Doc }).doc;
    expect(e.text('b1')).toBe('hello');
    const u2 = e.h.undo(e.doc);
    expect(u2?.skipped).toBe(1);
    e.doc = (u2 as { doc: Doc }).doc;
    expect(e.doc.blocks.has('b2')).toBe(false);
  });

  it('reinserting a removed block clamps its index when the sequence got shorter', () => {
    const d = createDoc(['b1', 'b2', 'b3', 'b4'].map((id) => textBlock(id, 'p', [text(id)])));
    const e = new Ed(d);
    e.run([{ t: 'removeBlock', id: 'b4' }]);
    e.side([{ t: 'removeBlock', id: 'b2' }]);
    e.side([{ t: 'removeBlock', id: 'b3' }]);
    e.undo();
    expect(e.doc.root).toEqual(['b1', 'b4']);
  });

  it('moveBlock undo clamps too', () => {
    const d = createDoc(['b1', 'b2', 'b3'].map((id) => textBlock(id, 'p', [text(id)])));
    const e = new Ed(d);
    e.run([{ t: 'moveBlock', id: 'b3', parent: null, slot: 0, index: 0 }]);
    e.side([{ t: 'removeBlock', id: 'b2' }]);
    e.undo();
    expect(e.doc.root).toEqual(['b1', 'b3']);
  });

  it('non-history transactions with an empty stack leave the log empty', () => {
    const e = new Ed(doc2());
    e.side([{ t: 'insertText', block: 'b1', offset: 0, text: 'x' }]);
    expect(e.h.logSize).toBe(0);
    expect(e.h.canUndo()).toBe(false);
  });
});
