// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"handleDisabledFileLoadingAsSuccess":true,"disableJavaScriptEvaluation":true,"disableCSSFileLoading":true,"disableIframePageLoading":true}}
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSpec } from '../testing/spec-dom.js';
import { openPreserve, type PreserveSession } from './edit.js';
import { buildSpanIndex, type SpanNode } from './span-index.js';

const FIXTURES = join(import.meta.dirname, '../../../../tests/fixtures/html/');
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.html'))
  .map((f) => [f, readFileSync(FIXTURES + f, 'utf8')] as const);

let session: PreserveSession | undefined;
afterEach(() => {
  session?.close();
  session = undefined;
});

function open(src: string): PreserveSession {
  loadSpec(document, src);
  session = openPreserve(document, src);
  return session;
}

function req<T>(v: T | null | undefined, what = 'value'): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

/** 容器里的第一个非空白文本节点。 */
function firstText(el: Node): Text | undefined {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (/\S/.test((n as Text).data)) return n as Text;
  return undefined;
}

/** 行级差异：返回发生变化的行数（原文与新文按行对齐，适用于行数不变的改动）。 */
function changedLines(a: string, b: string): number {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length !== y.length) return Math.abs(x.length - y.length) + 1000;
  return x.filter((l, i) => l !== y[i]).length;
}

/** 区间树中某节点的纯文本（用于验证输出重新解析后的内容）。 */
function textOfSpan(s: SpanNode): string {
  if (s.kind === 'text') return s.value;
  if (s.kind === 'comment') return '';
  return s.children.map(textOfSpan).join('');
}

/** 模拟用户在容器里改文本（等价于 beforeinput→input 窗口内的变动）。 */
function typeInto(s: PreserveSession, t: Text, data: string): void {
  s.mount.userEdit(() => {
    t.data = data;
  });
  s.touch(t);
}

describe('openPreserve: edit → patch', () => {
  it.each(fixtures)('%s: no edit → output is byte-identical', (_n, src) => {
    const s = open(src);
    expect(s.patches()).toEqual([]);
    expect(s.save()).toBe(src);
  });

  it.each(fixtures)('%s: touching every container without changing it → byte-identical', (_n, src) => {
    const s = open(src);
    for (const c of s.mount.containers()) s.touch(c);
    expect(s.patches()).toEqual([]);
    expect(s.save()).toBe(src);
  });

  it.each(fixtures)('%s: changing one character changes exactly one line', (_n, src) => {
    const s = open(src);
    const c = s.mount.containers()[0];
    if (!c) return;
    const t = req(firstText(c), 'text');
    const i = t.data.search(/\S/);
    const ch = t.data[i] === 'X' ? 'Y' : 'X';
    typeInto(s, t, t.data.slice(0, i) + ch + t.data.slice(i + 1));
    const out = s.save();
    expect(out).not.toBe(src);
    expect(changedLines(src, out)).toBe(1);
    const [p] = s.patches();
    expect(s.patches()).toHaveLength(1);
    expect(req(p).text).toBe(ch);
  });

  it('keeps entity spellings and CRLF outside the edited run', () => {
    const src = '<p>caf&eacute; &mdash; Tom&nbsp;&amp;&nbsp;Jerry</p>\r\n<p>two</p>\r\n';
    const s = open(src);
    const p = req(document.querySelector('p'));
    const t = req(firstText(p));
    typeInto(s, t, t.data.replace('Tom', 'Tim'));
    expect(s.save()).toBe('<p>caf&eacute; &mdash; Tim&nbsp;&amp;&nbsp;Jerry</p>\r\n<p>two</p>\r\n');
    typeInto(s, t, t.data.replace('Jerry', 'J<1>'));
    expect(s.save()).toBe('<p>caf&eacute; &mdash; Tim&nbsp;&amp;&nbsp;J&lt;1&gt;</p>\r\n<p>two</p>\r\n');
  });

  it('writes inserted newlines in the file’s own style (CRLF)', () => {
    const src = '<pre>a\r\nb</pre>\r\n<p>x</p>\r\n';
    const s = open(src);
    const t = req(firstText(req(document.querySelector('p'))));
    typeInto(s, t, 'x\ny');
    expect(s.save()).toBe('<pre>a\r\nb</pre>\r\n<p>x\r\ny</p>\r\n');
  });

  it('serializes rich edits (bold) and keeps untouched attributes byte-for-byte', () => {
    const src = "<body>\n  <p class='lead'  id=intro>Hello brave world</p>\n</body>";
    const s = open(src);
    const p = req(document.querySelector('p'));
    s.mount.userEdit(() => {
      const t = req(firstText(p));
      const rest = t.splitText(6);
      const tail = rest.splitText(5);
      const b = document.createElement('b');
      b.appendChild(rest);
      p.insertBefore(b, tail);
    });
    s.touch(p);
    expect(s.save()).toBe("<body>\n  <p class='lead'  id=intro>Hello <b>brave</b> world</p>\n</body>");
  });

  it('patches only the attribute that changed', () => {
    const src = '<p class="a" data-x=\'1\' title=t>txt</p>';
    const s = open(src);
    const p = req(document.querySelector('p'));
    s.mount.userEdit(() => p.setAttribute('class', 'a b'));
    s.touch(p);
    expect(s.save()).toBe('<p class="a b" data-x=\'1\' title=t>txt</p>');
    s.mount.userEdit(() => {
      p.removeAttribute('title');
      p.setAttribute('lang', 'en');
    });
    expect(s.save()).toBe('<p class="a b" data-x=\'1\' lang="en">txt</p>');
  });

  it('never writes the mount layer’s own attributes (contenteditable, grey marks)', () => {
    const src = '<div>\n  <p>one</p>\n  <div id="gen"></div>\n</div>';
    const s = open(src);
    const gen = req(document.getElementById('gen'));
    gen.appendChild(document.createElement('canvas')); // 脚本生成 → 标灰
    s.mount.flush();
    const t = req(firstText(req(document.querySelector('p'))));
    typeInto(s, t, 'uno');
    s.touch(gen);
    const out = s.save();
    expect(out).not.toMatch(/contenteditable|data-eh-generated|由脚本生成/);
    expect(out.startsWith('<div>\n  <p>uno</p>')).toBe(true);
  });

  it('insertAfter / remove reuse sibling indentation', () => {
    const src = '<body>\n    <h1>T</h1>\n    <p>a</p>\n    <p>b</p>\n  </body>';
    const s = open(src);
    const [pa, pb] = Array.from(document.querySelectorAll('p'));
    const fresh = s.insertAfter(req(pa), 'p', 'new & <shiny>');
    expect(s.mount.isEditable(fresh)).toBe(true);
    expect(s.save()).toBe(
      '<body>\n    <h1>T</h1>\n    <p>a</p>\n    <p>new &amp; &lt;shiny&gt;</p>\n    <p>b</p>\n  </body>',
    );
    s.remove(req(pb));
    expect(s.save()).toBe('<body>\n    <h1>T</h1>\n    <p>a</p>\n    <p>new &amp; &lt;shiny&gt;</p>\n  </body>');
    // 用户接着在新段落里打字
    const t = req(firstText(fresh));
    typeInto(s, t, 'typed');
    expect(s.save()).toBe('<body>\n    <h1>T</h1>\n    <p>a</p>\n    <p>typed</p>\n  </body>');
  });

  it('removing the first block keeps the following indentation', () => {
    const src = '<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>';
    const s = open(src);
    s.remove(req(document.querySelector('li')));
    expect(s.save()).toBe('<ul>\n  <li>b</li>\n</ul>');
  });

  it('property: random text edits on fixtures → only edited containers change, output re-parses to the edited text', () => {
    const docs = fixtures.filter(([, src]) => {
      loadSpec(document, src);
      const s = openPreserve(document, src);
      const ok = s.mount.containers().length > 0;
      s.close();
      return ok;
    });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: docs.length - 1 }),
        fc.array(
          fc.record({
            pick: fc.nat(),
            from: fc.nat(),
            del: fc.nat({ max: 5 }),
            ins: fc.string({
              unit: fc.constantFrom('a', 'Z', ' ', '&', '<', '>', '\u00a0', '"', '中', '\n'),
              maxLength: 6,
            }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (di, edits) => {
          const [, src] = req(docs[di]);
          const s = open(src);
          const cs = s.mount.containers();
          const edited = new Set<HTMLElement>();
          for (const e of edits) {
            const c = req(cs[e.pick % cs.length]);
            const t = firstText(c);
            if (!t) continue;
            const at = e.from % (t.data.length + 1);
            typeInto(s, t, t.data.slice(0, at) + e.ins + t.data.slice(at + e.del));
            edited.add(c);
          }
          const out = s.save();
          // 补丁只落在被改的容器内
          for (const p of s.patches()) {
            const hit = [...edited].some((c) => {
              const sp = s.mount.spanOf(c);
              return sp?.kind === 'element' && sp.inner && sp.inner.start <= p.start && p.end <= sp.inner.end;
            });
            expect(hit).toBe(true);
          }
          // 重新解析输出：每个被改容器（按路径）的文本 = DOM 中的文本（换行按 \n 比较）
          const again = buildSpanIndex(out);
          for (const c of edited) {
            const sp = req(s.mount.spanOf(c));
            const node = req(again.byPath(sp.path), `path ${sp.path.join('.')}`);
            expect(textOfSpan(node)).toBe(c.textContent);
          }
          s.close();
          session = undefined;
        },
      ),
      { numRuns: 300 },
    );
  }, 60_000);
});
