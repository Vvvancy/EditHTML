import { describe, expect, it } from 'vitest';
import {
  componentBlock,
  createDoc,
  docEquals,
  foreignBlock,
  inlineText,
  text,
  textBlock,
  validateDoc,
  type Block,
  type ComponentBlock,
  type Doc,
  type TextBlock,
} from '../model.js';
import { apply, tr } from './apply.js';
import { TxError, type TxErrorCode } from './errors.js';
import { invertOps } from './invert.js';
import type { Op } from './ops.js';

/**
 * root: p1 "hello", c1 callout { slot0: [p2 "inner"], slot1: [] }, f1 foreign, t1 table
 */
function sample(): Doc {
  return createDoc(
    [
      textBlock('p1', 'p', [text('hello')]),
      textBlock('p2', 'p', [text('inner')]),
      componentBlock('c1', 'callout', { kind: 'info', title: 'T' }, { slots: [['p2'], []], fallback: '<p>x</p>' }),
      foreignBlock('f1', '<div>x</div>'),
      textBlock('t1', 'table', [], {}, { head: [[text('A')], [text('B')]], body: [[[text('1')], [text('2')]]] }),
    ],
    { root: ['p1', 'c1', 'f1', 't1'], meta: { title: 'Doc' } },
  );
}

const txt = (doc: Doc, id: string): string => inlineText((doc.blocks.get(id) as TextBlock).content);

/** 应用、校验、逆向应用，返回结果。 */
function roundTrip(doc: Doc, ops: Op[]) {
  const r = apply(doc, ops);
  expect(validateDoc(r.doc)).toEqual([]);
  const back = apply(r.doc, invertOps(r.applied));
  expect(validateDoc(back.doc)).toEqual([]);
  expect(docEquals(back.doc, doc)).toBe(true);
  for (const [id, b] of doc.blocks) expect(back.doc.blocks.get(id)?.hash).toBe(b.hash);
  return r;
}

function expectTxError(fn: () => unknown, code: TxErrorCode): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TxError);
    expect((e as TxError).code).toBe(code);
    return;
  }
  throw new Error(`expected TxError(${code})`);
}

describe('text ops', () => {
  it('insertText with and without marks', () => {
    const doc = sample();
    const r = roundTrip(doc, [
      { t: 'insertText', block: 'p1', offset: 5, text: ' world' },
      { t: 'insertText', block: 'p1', offset: 0, text: '>', marks: [{ type: 'strong' }] },
    ]);
    expect(txt(r.doc, 'p1')).toBe('>hello world');
    expect((r.doc.blocks.get('p1') as TextBlock).content).toEqual([
      text('>', [{ type: 'strong' }]),
      text('hello world'),
    ]);
    expect([...r.dirty]).toEqual(['p1']);
    expect(r.rootChanged).toBe(false);
    expect(r.doc.version).toBe(doc.version + 1);
  });

  it('insertContent inserts br and atoms', () => {
    const r = roundTrip(sample(), [
      {
        t: 'insertContent',
        block: 'p1',
        offset: 2,
        content: [
          { t: 'br', marks: [] },
          { t: 'atom', kind: 'tag', attrs: {}, text: 'x', marks: [] },
        ],
      },
    ]);
    expect(txt(r.doc, 'p1')).toBe('he\nxllo');
    expect(r.mapping.map({ block: 'p1', offset: 3 })).toEqual({ block: 'p1', offset: 5 });
  });

  it('deleteText captures the deleted slice (with marks)', () => {
    const doc = createDoc([textBlock('p1', 'p', [text('ab'), text('cd', [{ type: 'em' }]), text('ef')])]);
    const r = roundTrip(doc, [{ t: 'deleteText', block: 'p1', from: 1, to: 5 }]);
    expect(txt(r.doc, 'p1')).toBe('af');
    expect(r.applied[0]).toMatchObject({ deleted: [text('b'), text('cd', [{ type: 'em' }]), text('e')] });
  });

  it('setMark add/remove, including replacing a link with a different href', () => {
    const a = { type: 'link', attrs: { href: 'a' } } as const;
    const b = { type: 'link', attrs: { href: 'b' } } as const;
    const doc = createDoc([textBlock('p1', 'p', [text('xx', [a]), text('yy'), text('zz', [{ type: 'em' }])])]);
    const r = roundTrip(doc, [
      { t: 'setMark', block: 'p1', from: 1, to: 4, mark: b, value: true },
      { t: 'setMark', block: 'p1', from: 0, to: 6, mark: { type: 'em' }, value: false },
      { t: 'setMark', block: 'p1', from: 0, to: 6, mark: { type: 'strong' }, value: true },
    ]);
    expect((r.doc.blocks.get('p1') as TextBlock).content).toEqual([
      text('x', [a, { type: 'strong' }]),
      text('xyy', [b, { type: 'strong' }]),
      text('zz', [{ type: 'strong' }]),
    ]);
  });

  it('no-op text changes leave the block object untouched and not dirty', () => {
    const doc = sample();
    const r = apply(doc, [
      { t: 'insertText', block: 'p1', offset: 1, text: '' },
      { t: 'deleteText', block: 'p1', from: 2, to: 2 },
      { t: 'setMark', block: 'p1', from: 0, to: 5, mark: { type: 'em' }, value: false },
      { t: 'insertText', block: 'p1', offset: 1, text: 'Q' },
      { t: 'deleteText', block: 'p1', from: 1, to: 2 },
    ]);
    expect(r.dirty.size).toBe(0);
    expect(r.doc.blocks.get('p1')).toBe(doc.blocks.get('p1'));
    expect(r.doc.blocks).not.toBe(doc.blocks); // 事务内曾写入 → 复制过一次
  });

  it('text op errors', () => {
    const doc = createDoc([textBlock('p1', 'p', [text('a😀b')]), componentBlock('c1', 'chart', {})]);
    expectTxError(() => apply(doc, [{ t: 'insertText', block: 'zz', offset: 0, text: 'x' }]), 'unknownBlock');
    expectTxError(() => apply(doc, [{ t: 'insertText', block: 'c1', offset: 0, text: 'x' }]), 'wrongKind');
    expectTxError(() => apply(doc, [{ t: 'insertText', block: 'p1', offset: 5, text: 'x' }]), 'range');
    expectTxError(() => apply(doc, [{ t: 'insertText', block: 'p1', offset: -1, text: 'x' }]), 'range');
    expectTxError(() => apply(doc, [{ t: 'insertText', block: 'p1', offset: 2, text: 'x' }]), 'boundary');
    expectTxError(() => apply(doc, [{ t: 'deleteText', block: 'p1', from: 3, to: 1 }]), 'range');
    expectTxError(() => apply(doc, [{ t: 'deleteText', block: 'p1', from: 0, to: 2 }]), 'boundary');
    expectTxError(
      () => apply(doc, [{ t: 'setMark', block: 'p1', from: 0, to: 1, mark: { type: 'bogus' as 'em' }, value: true }]),
      'invalid',
    );
    expectTxError(
      () => apply(doc, [{ t: 'insertContent', block: 'p1', offset: 0, content: [{ t: 'x' } as never] }]),
      'invalid',
    );
  });
});

describe('block ops', () => {
  it('insertBlock at root and into a slot; with a subtree', () => {
    const doc = sample();
    const child = textBlock('n2', 'p', [text('child')]);
    const box = componentBlock('n1', 'toggle', { title: 't', open: true }, { slots: [['n2']] });
    const r = roundTrip(doc, [
      { t: 'insertBlock', parent: null, slot: 0, index: 1, block: box, descendants: [child] },
      { t: 'insertBlock', parent: 'c1', slot: 1, index: 0, block: textBlock('n3', 'h1', [text('H')]) },
    ]);
    expect(r.doc.root).toEqual(['p1', 'n1', 'c1', 'f1', 't1']);
    expect((r.doc.blocks.get('c1') as ComponentBlock).slots).toEqual([['p2'], ['n3']]);
    expect(new Set(r.dirty)).toEqual(new Set(['n1', 'n2', 'n3', 'c1']));
    expect(new Set(r.inserted)).toEqual(new Set(['n1', 'n2', 'n3']));
    expect(r.rootChanged).toBe(true);
    // 哈希正确的输入块按引用采用。
    expect(r.doc.blocks.get('n2')).toBe(child);
  });

  it('insertBlock fixes stale hashes and unnormalized content', () => {
    const raw = { id: 'n1', kind: 'text', type: 'p', attrs: {}, content: [text('a'), text('b')], hash: 0 } as Block;
    const r = apply(sample(), [{ t: 'insertBlock', parent: null, slot: 0, index: 0, block: raw }]);
    expect(validateDoc(r.doc)).toEqual([]);
    expect(txt(r.doc, 'n1')).toBe('ab');
  });

  it('insertBlock errors', () => {
    const doc = sample();
    const p = (id: string) => textBlock(id, 'p');
    const ins = (op: Partial<Extract<Op, { t: 'insertBlock' }>>): Op => ({
      t: 'insertBlock',
      parent: null,
      slot: 0,
      index: 0,
      block: p('n1'),
      ...op,
    });
    expectTxError(() => apply(doc, [ins({ block: p('p1') })]), 'duplicateId');
    expectTxError(() => apply(doc, [ins({ block: p('Bad') })]), 'invalid');
    expectTxError(() => apply(doc, [ins({ index: 5 })]), 'range');
    expectTxError(() => apply(doc, [ins({ slot: 1 })]), 'range');
    expectTxError(() => apply(doc, [ins({ parent: 'p1' })]), 'wrongKind');
    expectTxError(() => apply(doc, [ins({ parent: 'c1', slot: 2 })]), 'range');
    expectTxError(() => apply(doc, [ins({ parent: 'zz' })]), 'unknownBlock');
    const box = componentBlock('n1', 'callout', {}, { slots: [['n2']] });
    expectTxError(() => apply(doc, [ins({ block: box })]), 'invalid'); // 缺子块
    expectTxError(() => apply(doc, [ins({ block: box, descendants: [p('n2'), p('n3')] })]), 'invalid'); // 多余块
    expectTxError(() => apply(doc, [ins({ block: box, descendants: [p('n2'), p('n2')] })]), 'duplicateId');
  });

  it('removeBlock removes the subtree; dirty includes removed ids and the parent', () => {
    const doc = sample();
    const r = roundTrip(doc, [{ t: 'removeBlock', id: 'c1' }]);
    expect(r.doc.root).toEqual(['p1', 'f1', 't1']);
    expect(r.doc.blocks.has('p2')).toBe(false);
    expect(new Set(r.removed)).toEqual(new Set(['c1', 'p2']));
    expect(new Set(r.dirty)).toEqual(new Set(['c1', 'p2']));
    expect(r.rootChanged).toBe(true);
    expect(r.mapping.mapResult({ block: 'p2', offset: 2 }).deleted).toBe(true);
    const r2 = roundTrip(doc, [{ t: 'removeBlock', id: 'p2' }]);
    expect(new Set(r2.dirty)).toEqual(new Set(['c1', 'p2']));
    expect(r2.rootChanged).toBe(false);
    expect(r2.doc.root).toBe(doc.root);
  });

  it('remove after edit in the same tx captures a block with a correct hash', () => {
    const r = roundTrip(sample(), [
      { t: 'insertText', block: 'p2', offset: 0, text: 'X' },
      { t: 'removeBlock', id: 'c1' },
    ]);
    const removed = (r.applied[1] as Extract<Op, { t: 'removeBlock' }>).removed;
    if (!removed) throw new Error('removeBlock not resolved');
    expect(validateDoc(createDoc([removed.block, ...removed.descendants]))).toEqual([]);
  });

  it('moveBlock: within root, into a slot, out of a slot; index is post-removal', () => {
    const doc = sample();
    const r = roundTrip(doc, [{ t: 'moveBlock', id: 'p1', parent: null, slot: 0, index: 3 }]);
    expect(r.doc.root).toEqual(['c1', 'f1', 't1', 'p1']);
    expect(r.dirty.size).toBe(0);
    expect(r.rootChanged).toBe(true);
    const r2 = roundTrip(doc, [
      { t: 'moveBlock', id: 'f1', parent: 'c1', slot: 1, index: 0 },
      { t: 'moveBlock', id: 'p2', parent: null, slot: 0, index: 0 },
    ]);
    expect(r2.doc.root).toEqual(['p2', 'p1', 'c1', 't1']);
    expect((r2.doc.blocks.get('c1') as ComponentBlock).slots).toEqual([[], ['f1']]);
    expect([...r2.dirty]).toEqual(['c1']);
    // 下一事务复用父索引缓存。
    const r3 = roundTrip(r2.doc, [{ t: 'moveBlock', id: 'f1', parent: 'c1', slot: 0, index: 0 }]);
    expect((r3.doc.blocks.get('c1') as ComponentBlock).slots).toEqual([['f1'], []]);
  });

  it('moveBlock errors: cycle, range', () => {
    const doc = createDoc([
      componentBlock('a', 'callout', {}, { slots: [['b']] }),
      componentBlock('b', 'callout', {}, { slots: [[]] }),
    ]);
    expectTxError(() => apply(doc, [{ t: 'moveBlock', id: 'a', parent: 'a', slot: 0, index: 0 }]), 'cycle');
    expectTxError(() => apply(doc, [{ t: 'moveBlock', id: 'a', parent: 'b', slot: 0, index: 0 }]), 'cycle');
    expectTxError(() => apply(doc, [{ t: 'moveBlock', id: 'a', parent: null, slot: 0, index: 1 }]), 'range');
    expectTxError(() => apply(doc, [{ t: 'moveBlock', id: 'b', parent: null, slot: 0, index: 2 }]), 'range');
    expectTxError(() => apply(doc, [{ t: 'removeBlock', id: 'zz' }]), 'unknownBlock');
  });

  it('setType / setAttrs / setFallback / setProps', () => {
    const doc = sample();
    const r = roundTrip(doc, [
      { t: 'setType', id: 'p1', type: 'li' },
      { t: 'setAttrs', id: 'p1', attrs: { list: 'ul', indent: '0', task: 'todo' } },
      { t: 'setAttrs', id: 'p1', attrs: { task: null } },
      { t: 'setType', id: 'c1', type: 'toggle' },
      { t: 'setFallback', id: 'c1', fallback: null },
      {
        t: 'setProps',
        id: 'c1',
        patch: [
          { op: 'replace', path: '/title', value: 'U' },
          { op: 'remove', path: '/kind' },
        ],
      },
    ]);
    const p1 = r.doc.blocks.get('p1') as TextBlock;
    expect(p1.type).toBe('li');
    expect(p1.attrs).toEqual({ list: 'ul', indent: '0' });
    const c1 = r.doc.blocks.get('c1') as ComponentBlock;
    expect(c1).toMatchObject({ type: 'toggle', props: { title: 'U' } });
    expect('fallback' in c1).toBe(false);
    expectTxError(() => apply(doc, [{ t: 'setType', id: 'p1', type: 'section' }]), 'invalid');
    expectTxError(() => apply(doc, [{ t: 'setType', id: 'f1', type: 'p' }]), 'wrongKind');
    expectTxError(() => apply(doc, [{ t: 'setAttrs', id: 'f1', attrs: { a: 'b' } }]), 'wrongKind');
    expectTxError(() => apply(doc, [{ t: 'setProps', id: 'p1', patch: [] }]), 'wrongKind');
    expectTxError(() => apply(doc, [{ t: 'setProps', id: 'c1', patch: [{ op: 'remove', path: '/x' }] }]), 'invalid');
  });

  it('setProps undo restores key order (serializer uses insertion order)', () => {
    const doc = sample();
    const r = apply(doc, [
      {
        t: 'setProps',
        id: 'c1',
        patch: [
          { op: 'remove', path: '/kind' },
          { op: 'add', path: '/kind', value: 'w' },
        ],
      },
    ]);
    expect(Object.keys((r.doc.blocks.get('c1') as ComponentBlock).props as object)).toEqual(['title', 'kind']);
    const back = apply(r.doc, invertOps(r.applied)).doc;
    expect(JSON.stringify((back.blocks.get('c1') as ComponentBlock).props)).toBe('{"kind":"info","title":"T"}');
  });

  it('table ops', () => {
    const doc = sample();
    const r = roundTrip(doc, [
      { t: 'setCell', id: 't1', section: 'head', row: 0, col: 1, content: [text('BB'), text('!')] },
      { t: 'setCell', id: 't1', section: 'body', row: 0, col: 0, content: [] },
      { t: 'setTable', id: 'p1', table: { head: [], body: [[[text('x')]]], align: ['left'] } },
    ]);
    const t1 = (r.doc.blocks.get('t1') as TextBlock).table;
    expect(t1?.head[1]).toEqual([text('BB!')]);
    expect(t1?.body[0]?.[0]).toEqual([]);
    expect(t1?.head[0]).toBe((doc.blocks.get('t1') as TextBlock).table?.head[0]);
    roundTrip(doc, [{ t: 'setTable', id: 't1', table: null }]);
    expectTxError(
      () => apply(doc, [{ t: 'setCell', id: 't1', section: 'body', row: 1, col: 0, content: [] }]),
      'range',
    );
    expectTxError(
      () => apply(doc, [{ t: 'setCell', id: 't1', section: 'head', row: 0, col: 2, content: [] }]),
      'range',
    );
    expectTxError(
      () => apply(doc, [{ t: 'setCell', id: 'p1', section: 'head', row: 0, col: 0, content: [] }]),
      'wrongKind',
    );
  });

  it('slot ops', () => {
    const doc = createDoc([
      componentBlock('c1', 'tabs', {}, { slots: [['p1']] }),
      textBlock('p1', 'p'),
      componentBlock('m1', 'math', {}),
    ]);
    const r = roundTrip(doc, [
      { t: 'insertSlot', id: 'c1', slot: 0 },
      { t: 'insertSlot', id: 'm1', slot: 0 },
      { t: 'insertBlock', parent: 'm1', slot: 0, index: 0, block: textBlock('p2', 'p') },
    ]);
    expect((r.doc.blocks.get('c1') as ComponentBlock).slots).toEqual([[], ['p1']]);
    expect((r.doc.blocks.get('m1') as ComponentBlock).slots).toEqual([['p2']]);
    const r2 = roundTrip(r.doc, [
      { t: 'removeBlock', id: 'p2' },
      { t: 'removeSlot', id: 'm1', slot: 0, unset: true },
      { t: 'removeSlot', id: 'c1', slot: 0 },
    ]);
    expect('slots' in (r2.doc.blocks.get('m1') as ComponentBlock)).toBe(false);
    expectTxError(() => apply(doc, [{ t: 'removeSlot', id: 'c1', slot: 0 }]), 'invalid'); // 非空
    expectTxError(() => apply(doc, [{ t: 'removeSlot', id: 'm1', slot: 0 }]), 'wrongKind');
    expectTxError(() => apply(doc, [{ t: 'insertSlot', id: 'c1', slot: 3 }]), 'range');
  });

  it('setMeta / setHead', () => {
    const doc = sample();
    const r = roundTrip(doc, [
      {
        t: 'setMeta',
        patch: [
          { op: 'add', path: '/tags', value: ['a'] },
          { op: 'remove', path: '/title' },
        ],
      },
      { t: 'setHead', head: { lang: 'en', userCss: 'p{}' } },
      { t: 'setHead', head: { userCss: null } },
    ]);
    expect(r.doc.meta).toEqual({ tags: ['a'] });
    expect(r.doc.head).toEqual({ lang: 'en' });
    expect(r.metaChanged && r.headChanged).toBe(true);
    expect(r.dirty.size).toBe(0);
    expect(r.doc.blocks).toBe(doc.blocks);
    expectTxError(() => apply(doc, [{ t: 'setMeta', patch: [{ op: 'replace', path: '', value: 3 }] }]), 'invalid');
    expectTxError(() => apply(doc, [{ t: 'setHead', head: { bogus: 'x' } as never }]), 'invalid');
  });
});

describe('transactions', () => {
  it('a failing op leaves nothing half-applied and reports opIndex', () => {
    const doc = sample();
    const before = JSON.stringify([...doc.blocks.values()]);
    try {
      apply(doc, [
        { t: 'insertText', block: 'p1', offset: 0, text: 'x' },
        { t: 'removeBlock', id: 'c1' },
        { t: 'deleteText', block: 'p1', from: 0, to: 99 },
      ]);
      throw new Error('unreachable');
    } catch (e) {
      expect(e).toBeInstanceOf(TxError);
      expect((e as TxError).opIndex).toBe(2);
    }
    expect(JSON.stringify([...doc.blocks.values()])).toBe(before);
    expect(doc.root).toEqual(['p1', 'c1', 'f1', 't1']);
    // 文档依然可用（父索引缓存未损坏）。
    const r = roundTrip(doc, [{ t: 'moveBlock', id: 'p2', parent: null, slot: 0, index: 0 }]);
    expect(r.doc.root).toEqual(['p2', 'p1', 'c1', 'f1', 't1']);
  });

  it('empty transaction bumps version and shares everything', () => {
    const doc = sample();
    const r = apply(doc, { ops: [] });
    expect(r.doc.version).toBe(1);
    expect(r.doc.blocks).toBe(doc.blocks);
    expect(r.doc.root).toBe(doc.root);
    expect(r.dirty.size).toBe(0);
  });

  it('builder: ops apply step by step; map() converts start positions', () => {
    const doc = sample();
    const b = tr(doc).insertText('p1', 0, 'abc').deleteText('p1', 3, 4);
    expect(b.map({ block: 'p1', offset: 5 })).toEqual({ block: 'p1', offset: 7 });
    const end = b.map({ block: 'p1', offset: 5 });
    b.insertText(end.block, end.offset, '!').removeBlock('f1');
    const r = b.apply({ input: 'typing' });
    expect(txt(r.doc, 'p1')).toBe('abcello!');
    expect(r.tx.meta).toEqual({ input: 'typing' });
    expect(r.applied).toHaveLength(4);
    expect(
      docEquals(
        r.doc,
        apply(
          doc,
          r.applied.map((o) => o),
        ).doc,
      ),
    ).toBe(true);
    expectTxError(() => b.insertText('p1', 0, 'x'), 'finished');
    const bad = tr(doc);
    expectTxError(() => bad.insertText('p1', 99, 'x'), 'range');
    expectTxError(() => bad.apply(), 'finished');
  });

  it('invert of an unresolved op throws notResolved', () => {
    expectTxError(() => invertOps([{ t: 'deleteText', block: 'p1', from: 0, to: 1 }]), 'notResolved');
    expectTxError(() => invertOps([{ t: 'removeBlock', id: 'p1' }]), 'notResolved');
  });
});

describe('performance', () => {
  function bigDoc(n: number): Doc {
    const blocks: Block[] = [];
    for (let i = 0; i < n; i++)
      blocks.push(textBlock(`b${i.toString(36)}`, 'p', [text(`paragraph ${i} with some text`)]));
    return createDoc(blocks);
  }

  it('single insertText on a 10,000-block doc is cheap', () => {
    let doc = bigDoc(10_000);
    const target = doc.root[5000] as string;
    const runs = 200;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) doc = apply(doc, [{ t: 'insertText', block: target, offset: 0, text: 'x' }]).doc;
    const per = (performance.now() - t0) / runs;
    // 主要代价是每事务一次的 blocks Map 复制（O(n)）。
    const t1 = performance.now();
    for (let i = 0; i < runs; i++) new Map(doc.blocks);
    const mapCopy = (performance.now() - t1) / runs;
    // 结构编辑（移动）在父索引缓存命中时也应便宜。
    const t2 = performance.now();
    for (let i = 0; i < runs; i++)
      doc = apply(doc, [{ t: 'moveBlock', id: target, parent: null, slot: 0, index: i % 100 }]).doc;
    const perMove = (performance.now() - t2) / runs;
    console.log(
      `[tx perf] 10k blocks: insertText ${per.toFixed(3)} ms/tx, Map copy ${mapCopy.toFixed(3)} ms, moveBlock ${perMove.toFixed(3)} ms/tx`,
    );
    expect(validateDoc(doc)).toEqual([]);
    expect(per).toBeLessThan(20);
    expect(perMove).toBeLessThan(20);
  });
});
