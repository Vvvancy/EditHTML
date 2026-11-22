// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"handleDisabledFileLoadingAsSuccess":true,"disableJavaScriptEvaluation":true,"disableCSSFileLoading":true,"disableIframePageLoading":true}}
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSpec } from '../testing/spec-dom.js';
import { openPreserve, type PreserveOptions, type PreserveSession } from './edit.js';
import { GENERATED_ATTR } from './mount.js';

const FIXTURES = join(import.meta.dirname, '../../../../tests/fixtures/html/');
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.html'))
  .map((f) => [f, readFileSync(FIXTURES + f, 'utf8')] as const);

let session: PreserveSession | undefined;
afterEach(() => {
  session?.close();
  session = undefined;
});

/** 可控时钟。 */
let clock = 0;

function open(src: string, options: PreserveOptions = {}): PreserveSession {
  session?.close();
  loadSpec(document, src);
  session = openPreserve(document, src, { ...options, history: { now: () => clock, ...options.history } });
  return session;
}

function req<T>(v: T | null | undefined, what = 'value'): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

function firstText(el: Node): Text | undefined {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (/\S/.test((n as Text).data)) return n as Text;
  return undefined;
}

/** 模拟一次输入事件：在用户编辑窗口内改文本。 */
function setText(s: PreserveSession, t: Text, data: string): void {
  s.mount.userEdit(() => {
    t.data = data;
  });
}

/** 逐字符在文本末尾输入，每个字符间隔 `gap` 毫秒。 */
function typeChars(s: PreserveSession, t: Text, text: string, gap = 50): void {
  for (const ch of text) {
    clock += gap;
    setText(s, t, t.data + ch);
  }
}

function undoAll(s: PreserveSession): number {
  let n = 0;
  while (s.undo()) n++;
  return n;
}

function redoAll(s: PreserveSession): number {
  let n = 0;
  while (s.redo()) n++;
  return n;
}

/** 容器的可比较快照：内部 HTML + 属性（排序）。 */
function snap(els: readonly Element[]): string[] {
  return els.map(
    (e) =>
      `${e.innerHTML}|${Array.from(e.attributes)
        .map((a) => `${a.name}=${a.value}`)
        .sort()
        .join(',')}`,
  );
}

describe('preserve history: grouping', () => {
  it('typing "hello world" quickly = two undo steps (break after space)', () => {
    const src = '<p>x</p>';
    const s = open(src);
    const t = req(firstText(req(document.querySelector('p'))));
    typeChars(s, t, ' hello world');
    expect(s.save()).toBe('<p>x hello world</p>');
    expect(s.history.undoDepth).toBe(3); // " " | "hello " | "world"
    expect(s.undo()).toBe(true);
    expect(s.save()).toBe('<p>x hello </p>');
    expect(s.undo()).toBe(true);
    expect(s.save()).toBe('<p>x </p>');
    expect(s.undo()).toBe(true);
    expect(s.save()).toBe(src);
    expect(s.patches()).toEqual([]);
    expect(s.undo()).toBe(false);
  });

  it('a pause longer than the merge window starts a new step', () => {
    const s = open('<p>a</p>');
    const t = req(firstText(req(document.querySelector('p'))));
    typeChars(s, t, 'bc');
    clock += 1000;
    typeChars(s, t, 'de');
    expect(s.history.undoDepth).toBe(2);
    s.undo();
    expect(s.save()).toBe('<p>abc</p>');
  });

  it('backspacing merges; checkpoint() breaks the group', () => {
    const s = open('<p>abcdef</p>');
    const t = req(firstText(req(document.querySelector('p'))));
    for (let i = 0; i < 3; i++) {
      clock += 20;
      setText(s, t, t.data.slice(0, -1));
    }
    expect(s.history.undoDepth).toBe(1);
    s.checkpoint();
    clock += 20;
    setText(s, t, t.data.slice(0, -1));
    expect(s.history.undoDepth).toBe(2);
    expect(s.save()).toBe('<p>ab</p>');
    s.undo();
    expect(s.save()).toBe('<p>abc</p>');
    s.undo();
    expect(s.save()).toBe('<p>abcdef</p>');
  });

  it('a jump of the caret (non-contiguous insert) starts a new step', () => {
    const s = open('<p>abc</p>');
    const t = req(firstText(req(document.querySelector('p'))));
    clock += 10;
    setText(s, t, 'abcX');
    clock += 10;
    setText(s, t, 'YabcX');
    expect(s.history.undoDepth).toBe(2);
  });

  it('IME composition is one step', () => {
    const s = open('<p>好</p>');
    const p = req(document.querySelector('p'));
    const t = req(firstText(p));
    p.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    for (const v of ['好n', '好ni', '好nih', '好你好']) {
      clock += 30;
      t.data = v;
      p.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    p.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect(s.save()).toBe('<p>好你好</p>');
    expect(s.history.undoDepth).toBe(1);
    // 组合结束后接着输入：新的一步
    clock += 30;
    setText(s, t, '好你好a');
    expect(s.history.undoDepth).toBe(2);
    s.undo();
    s.undo();
    expect(s.save()).toBe('<p>好</p>');
    expect(s.patches()).toEqual([]);
  });

  it('a rich-text command (one userEdit) is one step and never merges with typing', () => {
    const src = '<p>Hello brave world</p>';
    const s = open(src);
    const p = req(document.querySelector('p'));
    const t = req(firstText(p));
    typeChars(s, t, '!');
    s.mount.userEdit(() => {
      const rest = t.splitText(6);
      const tail = rest.splitText(5);
      const b = document.createElement('b');
      b.appendChild(rest);
      p.insertBefore(b, tail);
    });
    expect(s.save()).toBe('<p>Hello <b>brave</b> world!</p>');
    expect(s.history.undoDepth).toBe(2);
    s.undo();
    expect(s.save()).toBe('<p>Hello brave world!</p>');
    expect(p.childNodes).toHaveLength(1);
    expect(p.firstChild).toBe(t);
    s.undo();
    expect(s.save()).toBe(src);
  });
});

describe('preserve history: undo / redo', () => {
  it('a new edit after undo truncates the redo branch', () => {
    const s = open('<p>a</p>');
    const t = req(firstText(req(document.querySelector('p'))));
    typeChars(s, t, 'b');
    clock += 1000;
    typeChars(s, t, 'c');
    s.undo();
    expect(s.canRedo()).toBe(true);
    clock += 1000;
    typeChars(s, t, 'X');
    expect(s.canRedo()).toBe(false);
    expect(s.redo()).toBe(false);
    expect(s.save()).toBe('<p>abX</p>');
    expect(undoAll(s)).toBe(2);
    expect(s.save()).toBe('<p>a</p>');
  });

  it('undo keeps span pairing: later edits still produce a one-character patch', () => {
    const s = open('<div>\n  <p>one</p>\n  <p>two</p>\n</div>');
    const p = req(document.querySelectorAll('p')[1]);
    const t = req(firstText(p));
    setText(s, t, 'TWO');
    s.undo();
    expect(s.mount.spanOf(t)).toBeDefined();
    expect(s.patches()).toEqual([]);
    setText(s, t, 'twO');
    expect(s.patches()).toHaveLength(1);
    expect(req(s.patches()[0]).text).toBe('O');
  });

  it('undo/redo mutations are user edits: containers stay editable, nothing greyed, not recorded', () => {
    const s = open('<p>abc</p>');
    const p = req(document.querySelector('p'));
    const t = req(firstText(p));
    setText(s, t, 'abcd');
    s.undo();
    s.mount.flush();
    expect(s.mount.isEditable(t)).toBe(true);
    expect(p.hasAttribute(GENERATED_ATTR)).toBe(false);
    expect(s.history.undoDepth).toBe(0);
    expect(s.history.redoDepth).toBe(1);
    s.redo();
    expect(s.history.undoDepth).toBe(1);
    expect(s.history.redoDepth).toBe(0);
    expect(s.save()).toBe('<p>abcd</p>');
  });

  it('attribute changes undo to the original bytes', () => {
    const src = '<p class="a" data-x=\'1\' title=t hidden>txt</p>';
    const s = open(src);
    const p = req(document.querySelector('p'));
    s.mount.userEdit(() => p.setAttribute('class', 'a b'));
    s.mount.userEdit(() => {
      p.removeAttribute('title');
      p.removeAttribute('hidden');
      p.setAttribute('lang', 'en');
    });
    expect(s.save()).toBe('<p class="a b" data-x=\'1\' lang="en">txt</p>');
    expect(undoAll(s)).toBe(2);
    expect(p.getAttribute('hidden')).toBe('');
    expect(p.hasAttribute('lang')).toBe(false);
    expect(s.save()).toBe(src);
    expect(s.patches()).toEqual([]);
    expect(redoAll(s)).toBe(2);
    expect(s.save()).toBe('<p class="a b" data-x=\'1\' lang="en">txt</p>');
  });

  it('insertAfter / remove undo and redo', () => {
    const src = '<body>\n    <h1>T</h1>\n    <p>a</p>\n    <p>b</p>\n  </body>';
    const s = open(src);
    const [pa, pb] = Array.from(document.querySelectorAll('p'));
    const fresh = s.insertAfter(req(pa), 'p', 'new');
    s.remove(req(pb));
    const t = req(firstText(fresh));
    setText(s, t, 'typed');
    const edited = s.save();
    expect(edited).toBe('<body>\n    <h1>T</h1>\n    <p>a</p>\n    <p>typed</p>\n  </body>');
    expect(undoAll(s)).toBe(3);
    expect(s.save()).toBe(src);
    expect(s.patches()).toEqual([]);
    expect(s.mount.containers()).not.toContain(fresh);
    expect(s.mount.containers()).toContain(pb);
    expect(redoAll(s)).toBe(3);
    expect(s.save()).toBe(edited);
  });

  it('pending (not yet flushed) user input is recorded before undo', () => {
    const s = open('<p>abc</p>');
    const p = req(document.querySelector('p'));
    const t = req(firstText(p));
    p.dispatchEvent(new InputEvent('beforeinput', { bubbles: true }));
    t.data = 'abcd';
    // input 事件尚未派发，直接撤销
    expect(s.undo()).toBe(true);
    expect(s.save()).toBe('<p>abc</p>');
  });

  it('onChange fires on record / undo / redo', () => {
    let n = 0;
    const s = open('<p>abc</p>', { history: { onChange: () => n++ } });
    const t = req(firstText(req(document.querySelector('p'))));
    setText(s, t, 'abcd');
    s.undo();
    s.redo();
    expect(n).toBe(3);
  });

  it('respects the item limit (oldest dropped)', () => {
    const s = open('<p>a</p>', { history: { limits: { maxItems: 2 } } });
    const t = req(firstText(req(document.querySelector('p'))));
    for (const ch of 'bcd') {
      clock += 1000;
      setText(s, t, t.data + ch);
    }
    expect(undoAll(s)).toBe(2);
    expect(s.save()).toBe('<p>ab</p>');
  });
});

/** 一种随机编辑。 */
type Edit =
  | { kind: 'type'; pick: number; at: number; del: number; ins: string; gap: number }
  | { kind: 'bold'; pick: number; at: number }
  | { kind: 'attr'; pick: number; name: string; value: string | null }
  | { kind: 'insert'; pick: number; text: string }
  | { kind: 'remove'; pick: number }
  | { kind: 'checkpoint' };

const textArb = fc.string({ unit: fc.constantFrom('a', 'Z', ' ', '&', '<', ' ', '中', '\n', '.'), maxLength: 4 });
const editArb: fc.Arbitrary<Edit> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('type' as const),
      pick: fc.nat(),
      at: fc.nat(),
      del: fc.nat({ max: 3 }),
      ins: textArb,
      gap: fc.constantFrom(10, 100, 1000),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('bold' as const), pick: fc.nat(), at: fc.nat() }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('attr' as const),
      pick: fc.nat(),
      name: fc.constantFrom('class', 'id', 'data-x', 'title', 'style'),
      value: fc.option(fc.constantFrom('', 'a', 'b "q"', 'x&y'), { nil: null }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('insert' as const), pick: fc.nat(), text: textArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('remove' as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'checkpoint' as const }) },
);

function run(s: PreserveSession, e: Edit): void {
  const cs = s.mount.containers();
  if (e.kind === 'checkpoint') return s.checkpoint();
  if (cs.length === 0) return;
  const c = req(cs[e.pick % cs.length]);
  switch (e.kind) {
    case 'type': {
      const t = firstText(c);
      if (!t) return;
      clock += e.gap;
      const at = e.at % (t.data.length + 1);
      setText(s, t, t.data.slice(0, at) + e.ins + t.data.slice(at + e.del));
      return;
    }
    case 'bold': {
      const t = firstText(c);
      if (!t || t.data.length < 2) return;
      const at = 1 + (e.at % (t.data.length - 1));
      s.mount.userEdit(() => {
        const rest = t.splitText(at);
        const b = document.createElement('b');
        req(rest.parentNode).insertBefore(b, rest);
        b.appendChild(rest);
      });
      return;
    }
    case 'attr':
      s.mount.userEdit(() => {
        if (e.value === null) c.removeAttribute(e.name);
        else c.setAttribute(e.name, e.value);
      });
      return;
    case 'insert':
      s.insertAfter(c, 'p', e.text);
      return;
    case 'remove':
      if (cs.length > 1) s.remove(c);
      return;
  }
}

describe('preserve history: property', () => {
  const docs = fixtures.filter(([, src]) => {
    loadSpec(document, src);
    const s = openPreserve(document, src);
    const ok = s.mount.containers().length > 0;
    s.close();
    return ok;
  });

  it('random edits on fixtures → undo all = original bytes, no patches; redo all = edited output', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: docs.length - 1 }),
        fc.array(editArb, { minLength: 1, maxLength: 8 }),
        (di, edits) => {
          const [, src] = req(docs[di]);
          const s = open(src);
          const original = s.mount.containers();
          const before = snap(original);
          for (const e of edits) run(s, e);
          const edited = s.save();
          const editedPatches = s.patches();
          const editedSnap = snap(original);
          undoAll(s);
          expect(s.save()).toBe(src);
          expect(s.patches()).toEqual([]);
          expect(snap(original)).toEqual(before);
          expect(s.mount.containers()).toEqual(original);
          expect(s.canUndo()).toBe(false);
          redoAll(s);
          expect(s.save()).toBe(edited);
          expect(s.patches()).toEqual(editedPatches);
          expect(snap(original)).toEqual(editedSnap);
          // 再撤销到底一次：仍回到原文
          undoAll(s);
          expect(s.save()).toBe(src);
        },
      ),
      { numRuns: 200 },
    );
  }, 120_000);
});
