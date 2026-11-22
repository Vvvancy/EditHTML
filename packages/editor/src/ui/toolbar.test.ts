// @vitest-environment happy-dom
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TOOLBAR_ATTR,
  formatState,
  mountToolbar,
  removeLink,
  sanitizeLinkUrl,
  setBlockLevel,
  setLink,
  toggleBold,
  toggleItalic,
  type ToolbarHost,
} from './toolbar.js';

function req<T>(v: T | null | undefined, what = 'value'): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

/** 以 `[contenteditable]` 为容器的假宿主；记录 run / touch 调用。 */
function fakeHost(): ToolbarHost & { runs: number; touched: Node[] } {
  const containerOf = (n: Node): HTMLElement | undefined => {
    const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
    return (el?.closest('[contenteditable="true"]') as HTMLElement | null) ?? undefined;
  };
  const host = {
    doc: document,
    runs: 0,
    touched: [] as Node[],
    run<T>(fn: () => T): T {
      host.runs++;
      return fn();
    },
    isEditable: (n: Node) => containerOf(n) !== undefined,
    containerOf,
    touch(n: Node) {
      host.touched.push(n);
    },
  };
  return host;
}

function setup(html: string): { host: ReturnType<typeof fakeHost>; root: HTMLElement } {
  document.body.innerHTML = `<div id="root">${html}</div>`;
  return { host: fakeHost(), root: req(document.getElementById('root')) };
}

/** 第 `i` 个（按文档顺序）包含 `needle` 的文本节点。 */
function textWith(root: Node, needle: string, i = 0): Text {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let k = 0;
  for (let n = w.nextNode(); n; n = w.nextNode()) if ((n as Text).data.includes(needle) && k++ === i) return n as Text;
  throw new Error(`no text ${needle}`);
}

/** 选中 `needle`（可跨文本节点：`from` 所在节点到 `to` 所在节点）。 */
function selectText(root: Node, from: string, to = from): void {
  const a = textWith(root, from);
  const b = textWith(root, to);
  const r = document.createRange();
  r.setStart(a, a.data.indexOf(from));
  r.setEnd(b, b.data.indexOf(to) + to.length);
  const sel = req(document.getSelection());
  sel.removeAllRanges();
  sel.addRange(r);
}

function caret(node: Node, offset: number): void {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const sel = req(document.getSelection());
  sel.removeAllRanges();
  sel.addRange(r);
}

const selected = (): string => req(document.getSelection()).toString();
const p = (root: HTMLElement): string => req(root.querySelector('[contenteditable]')).innerHTML;

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

describe('sanitizeLinkUrl', () => {
  it('accepts safe and relative URLs', () => {
    expect(sanitizeLinkUrl(' https://a.com/x ')).toBe('https://a.com/x');
    expect(sanitizeLinkUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(sanitizeLinkUrl('#sec')).toBe('#sec');
    expect(sanitizeLinkUrl('../notes/a.html')).toBe('../notes/a.html');
    expect(sanitizeLinkUrl('//cdn.x/y')).toBe('//cdn.x/y');
    expect(sanitizeLinkUrl('example.com/page')).toBe('https://example.com/page');
    expect(sanitizeLinkUrl('localhost:8080/x')).toBe('localhost:8080/x');
  });
  it('rejects script and data URLs', () => {
    for (const bad of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'java\tscript:x',
      'vbscript:x',
      'data:text/html,x',
      '',
    ])
      expect(sanitizeLinkUrl(bad)).toBeNull();
  });
});

describe('bold / italic', () => {
  it('wraps a word in <strong> and keeps it selected', () => {
    const { host, root } = setup('<p contenteditable="true">hello world</p>');
    selectText(root, 'world');
    expect(toggleBold(host)).toBe(true);
    expect(p(root)).toBe('hello <strong>world</strong>');
    expect(selected()).toBe('world');
    expect(formatState(host).bold).toBe(true);
    expect(host.runs).toBe(1);
    expect(host.touched[0]).toBe(root.firstChild);
  });

  it('toggles off and merges the split text back into one node', () => {
    const { host, root } = setup('<p contenteditable="true">hello world</p>');
    const original = textWith(root, 'hello');
    selectText(root, 'world');
    toggleBold(host);
    toggleBold(host);
    expect(p(root)).toBe('hello world');
    const c = req(root.querySelector('p'));
    expect(c.childNodes.length).toBe(1);
    expect(c.firstChild).toBe(original);
    expect(selected()).toBe('world');
    expect(formatState(host).bold).toBe(false);
  });

  it('removes bold only from the selected part of an existing <b>', () => {
    const { host, root } = setup('<p contenteditable="true"><b class="k">one two three</b></p>');
    const b = req(root.querySelector('b'));
    selectText(root, 'two');
    expect(formatState(host).bold).toBe(true);
    toggleBold(host);
    expect(p(root)).toBe('<b class="k">one </b>two<b class="k"> three</b>');
    expect(root.querySelector('b')).toBe(b); // 前半保留原元素
    expect(selected()).toBe('two');
  });

  it('keeps the file style: uses <b> when the container already uses <b>', () => {
    const { host, root } = setup('<p contenteditable="true"><b>x</b> and y</p>');
    selectText(root, 'y');
    toggleBold(host);
    expect(p(root)).toBe('<b>x</b> and <b>y</b>');
    const { host: h2, root: r2 } = setup('<p contenteditable="true"><i>x</i> and y</p>');
    selectText(r2, 'y');
    toggleItalic(h2);
    expect(p(r2)).toBe('<i>x</i> and <i>y</i>');
  });

  it('defaults to <em> for italic', () => {
    const { host, root } = setup('<p contenteditable="true">plain text</p>');
    selectText(root, 'plain');
    toggleItalic(host);
    expect(p(root)).toBe('<em>plain</em> text');
  });

  it('partial selection spanning text nodes and elements wraps one run and absorbs inner bold', () => {
    const { host, root } = setup('<p contenteditable="true">ab<em>cd</em>e<strong>f</strong>gh</p>');
    selectText(root, 'b', 'g');
    expect(formatState(host).bold).toBe(false);
    toggleBold(host);
    expect(p(root)).toBe('a<strong>b<em>cd</em>efg</strong>h');
    expect(selected()).toBe('bcdefg');
    expect(formatState(host).bold).toBe(true);
    toggleBold(host);
    expect(p(root)).toBe('ab<em>cd</em>efgh');
  });

  it('selection ending inside a nested element only wraps the selected part', () => {
    const { host, root } = setup('<p contenteditable="true">ab<em>cdef</em>gh</p>');
    selectText(root, 'b', 'cd');
    toggleBold(host);
    expect(p(root)).toBe('a<strong>b</strong><em><strong>cd</strong>ef</em>gh');
    expect(selected()).toBe('bcd');
    expect(formatState(host).bold).toBe(true);
    toggleBold(host);
    expect(p(root)).toBe('ab<em>cdef</em>gh');
  });

  it('mixed selection (partly bold) becomes fully bold and merges with neighbours', () => {
    const { host, root } = setup('<p contenteditable="true"><strong>ab</strong>cd</p>');
    selectText(root, 'b', 'cd');
    expect(formatState(host).bold).toBe(false);
    toggleBold(host);
    expect(p(root)).toBe('<strong>abcd</strong>');
  });

  it('collapsed selection and non-editable selection do nothing', () => {
    const { host, root } = setup('<p contenteditable="true">abc</p><p>outside</p>');
    caret(textWith(root, 'abc'), 1);
    expect(toggleBold(host)).toBe(false);
    selectText(root, 'outside');
    expect(formatState(host).enabled).toBe(false);
    expect(toggleBold(host)).toBe(false);
    expect(setBlockLevel(host, 2)).toBe(false);
    expect(host.runs).toBe(0);
  });

  it('selection spanning two containers is disabled', () => {
    const { host, root } = setup('<p contenteditable="true">one</p><p contenteditable="true">two</p>');
    selectText(root, 'one', 'two');
    expect(formatState(host).enabled).toBe(false);
    expect(toggleItalic(host)).toBe(false);
  });
});

describe('links', () => {
  it('wraps a selection in <a href> and reports it', () => {
    const { host, root } = setup('<p contenteditable="true">see the docs here</p>');
    selectText(root, 'docs');
    expect(setLink(host, 'https://x.dev/')).toBe(true);
    expect(p(root)).toBe('see the <a href="https://x.dev/">docs</a> here');
    expect(formatState(host).link).toBe('https://x.dev/');
  });

  it('rejects javascript: URLs without touching the DOM', () => {
    const { host, root } = setup('<p contenteditable="true">click me</p>');
    selectText(root, 'me');
    expect(setLink(host, 'javascript:alert(1)')).toBe(false);
    expect(p(root)).toBe('click me');
    expect(host.runs).toBe(0);
  });

  it('updates href when the selection is inside a link', () => {
    const { host, root } = setup('<p contenteditable="true"><a href="/a" title="t">some link</a></p>');
    selectText(root, 'link');
    setLink(host, '/b');
    expect(p(root)).toBe('<a href="/b" title="t">some link</a>');
  });

  it('collapsed caret inside a link: removeLink unwraps the whole link', () => {
    const { host, root } = setup('<p contenteditable="true">x <a href="/a">some link</a> y</p>');
    caret(textWith(root, 'some'), 2);
    expect(formatState(host).link).toBe('/a');
    expect(removeLink(host)).toBe(true);
    expect(p(root)).toBe('x some link y');
  });

  it('removeLink on a partial selection only unlinks the selected part', () => {
    const { host, root } = setup('<p contenteditable="true"><a href="/a">some link</a></p>');
    selectText(root, 'link');
    removeLink(host);
    expect(p(root)).toBe('<a href="/a">some </a>link');
  });

  it('linking across part of an existing link replaces the overlap', () => {
    const { host, root } = setup('<p contenteditable="true"><a href="/a">ab</a>cd</p>');
    selectText(root, 'b', 'c');
    setLink(host, '/z');
    expect(p(root)).toBe('<a href="/a">a</a><a href="/z">bc</a>d');
  });

  it('collapsed caret outside a link inserts the URL as link text', () => {
    const { host, root } = setup('<p contenteditable="true">ab</p>');
    caret(textWith(root, 'ab'), 1);
    setLink(host, 'https://x.dev');
    expect(p(root)).toBe('a<a href="https://x.dev">https://x.dev</a>b');
  });

  it('removeLink without a link does nothing', () => {
    const { host, root } = setup('<p contenteditable="true">ab</p>');
    selectText(root, 'ab');
    expect(removeLink(host)).toBe(false);
    expect(host.runs).toBe(0);
  });
});

describe('heading level', () => {
  it('p → h2 keeps attributes, child node identities and the selection', () => {
    const { host, root } = setup('<p contenteditable="true" class="lead" data-x="1">Hi <b>there</b> you</p>');
    const old = req(root.querySelector('p'));
    const kids = Array.from(old.childNodes);
    selectText(root, 'there');
    expect(formatState(host).block).toBe(0);
    expect(setBlockLevel(host, 2)).toBe(true);
    const h2 = req(root.querySelector('h2'));
    expect(root.querySelector('p')).toBeNull();
    expect(h2.outerHTML).toBe('<h2 contenteditable="true" class="lead" data-x="1">Hi <b>there</b> you</h2>');
    expect(Array.from(h2.childNodes)).toEqual(kids);
    expect(selected()).toBe('there');
    expect(formatState(host).block).toBe(2);
    expect(host.touched).toContain(h2);
  });

  it('h3 → p and skips host-owned attributes, calling adopt', () => {
    const { host, root } = setup('<h3 contenteditable="true" id="t">Title</h3>');
    const adopted: HTMLElement[] = [];
    const h: ToolbarHost = {
      ...host,
      ownsAttribute: (_el, name) => name === 'contenteditable',
      adopt: (el) => {
        adopted.push(el);
        el.setAttribute('contenteditable', 'true');
        return true;
      },
    };
    caret(textWith(root, 'Title'), 2);
    expect(setBlockLevel(h, 0)).toBe(true);
    const el = req(root.querySelector('p'));
    expect(adopted).toEqual([el]);
    expect(el.getAttribute('id')).toBe('t');
    expect(el.textContent).toBe('Title');
  });

  it('is unavailable for non-p/h containers and same level', () => {
    const { host, root } = setup('<ul><li contenteditable="true">item</li></ul><h1 contenteditable="true">t</h1>');
    selectText(root, 'item');
    expect(formatState(host).block).toBeNull();
    expect(setBlockLevel(host, 1)).toBe(false);
    selectText(root, 't');
    expect(setBlockLevel(host, 1)).toBe(false);
  });
});

describe('mountToolbar', () => {
  it('renders Chinese-labelled controls reflecting the selection', () => {
    const { host, root } = setup('<p contenteditable="true"><strong>bold</strong> plain</p>');
    const ui = document.createElement('div');
    document.body.appendChild(ui);
    const tb = mountToolbar(host, ui);
    const btn = (label: string): HTMLButtonElement => req(tb.element.querySelector(`[aria-label="${label}"]`));
    expect(tb.element.getAttribute('role')).toBe('toolbar');
    expect(tb.element.hasAttribute(TOOLBAR_ATTR)).toBe(true);
    expect(btn('粗体').disabled).toBe(true);
    selectText(root, 'bold');
    tb.update();
    expect(btn('粗体').disabled).toBe(false);
    expect(btn('粗体').getAttribute('aria-pressed')).toBe('true');
    expect(btn('斜体').getAttribute('aria-pressed')).toBe('false');
    const level = req(tb.element.querySelector<HTMLSelectElement>('[aria-label="标题级别"]'));
    expect(level.value).toBe('0');
    btn('斜体').click();
    // 整个 <strong> 被选中：斜体包在它外面
    expect(p(root)).toBe('<em><strong>bold</strong></em> plain');
    expect(btn('斜体').getAttribute('aria-pressed')).toBe('true');
    level.value = '1';
    level.dispatchEvent(new Event('change'));
    expect(root.querySelector('h1')).not.toBeNull();
    tb.destroy();
    expect(ui.childNodes.length).toBe(0);
  });

  it('keyboard shortcuts Ctrl/Cmd+B/I/K', () => {
    const { host, root } = setup('<p contenteditable="true">alpha beta gamma</p>');
    const prompt = vi.fn((): string | null => 'https://k.dev');
    const tb = mountToolbar(host, undefined, { prompt });
    const key = (k: string, mod: 'ctrlKey' | 'metaKey'): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', { key: k, [mod]: true, bubbles: true, cancelable: true });
      req(root.querySelector('p')).dispatchEvent(e);
      return e;
    };
    selectText(root, 'alpha');
    expect(key('b', 'ctrlKey').defaultPrevented).toBe(true);
    selectText(root, 'beta');
    key('i', 'metaKey');
    selectText(root, 'gamma');
    key('k', 'ctrlKey');
    expect(prompt).toHaveBeenCalledOnce();
    expect(p(root)).toBe('<strong>alpha</strong> <em>beta</em> <a href="https://k.dev">gamma</a>');
    // 在链接上 Ctrl+K 并留空 → 移除链接
    prompt.mockReturnValueOnce('');
    key('k', 'ctrlKey');
    expect(p(root)).toBe('<strong>alpha</strong> <em>beta</em> gamma');
    // 选区不可编辑时不拦截
    document.getSelection()?.removeAllRanges();
    expect(key('b', 'ctrlKey').defaultPrevented).toBe(false);
    tb.destroy();
  });

  it('link button rejects unsafe URLs and reports them', () => {
    const { host, root } = setup('<p contenteditable="true">x y</p>');
    const onInvalidUrl = vi.fn();
    const tb = mountToolbar(host, undefined, { prompt: () => 'javascript:alert(1)', onInvalidUrl });
    selectText(root, 'y');
    expect(tb.exec('link')).toBe(false);
    expect(onInvalidUrl).toHaveBeenCalledWith('javascript:alert(1)');
    expect(p(root)).toBe('x y');
    tb.destroy();
  });

  it('floating toolbar is hidden when the selection is not editable', () => {
    const { host, root } = setup('<p contenteditable="true">x</p><p>ro</p>');
    const tb = mountToolbar(host);
    expect(tb.element.parentNode).toBe(document.body);
    selectText(root, 'ro');
    tb.update();
    expect(tb.element.hidden).toBe(true);
    selectText(root, 'x');
    tb.update();
    expect(tb.element.hidden).toBe(false);
    tb.destroy();
  });
});

describe('properties', () => {
  const html = fc.constantFrom(
    'plain text here',
    'ab<em>cd</em>ef',
    '<b>bold</b> and <i>it</i> x',
    'x<a href="/a">link <strong>s</strong></a>y',
    'a<span>b<em>c</em>d</span>e',
  );
  it('toggling bold/italic on any range keeps text and selection; on then off restores the HTML', () => {
    fc.assert(
      fc.property(html, fc.nat(), fc.nat(), fc.constantFrom('b', 'i'), (inner, x, y, which) => {
        const { host, root } = setup(`<p contenteditable="true">${inner}</p>`);
        const c = req(root.querySelector('p'));
        const before = c.innerHTML;
        const texts: Text[] = [];
        const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) texts.push(n as Text);
        const total = c.textContent?.length ?? 0;
        const point = (k: number): [Text, number] => {
          let rest = k % (total + 1);
          for (const t of texts) {
            if (rest <= t.data.length) return [t, rest];
            rest -= t.data.length;
          }
          const last = req(texts[texts.length - 1]);
          return [last, last.data.length];
        };
        const [a, ao] = point(Math.min(x, y) % (total + 1));
        const [b, bo] = point(Math.max(x % (total + 1), y % (total + 1)));
        const r = document.createRange();
        r.setStart(a, ao);
        r.setEnd(b, bo);
        if (r.collapsed) return;
        const sel = req(document.getSelection());
        sel.removeAllRanges();
        sel.addRange(r);
        const text = sel.toString();
        const toggle = which === 'b' ? toggleBold : toggleItalic;
        const state = (): boolean => (which === 'b' ? formatState(host).bold : formatState(host).italic);
        const was = state();
        expect(toggle(host)).toBe(true);
        expect(c.textContent?.length).toBe(total);
        expect(selected()).toBe(text);
        expect(state()).toBe(!was);
        // 原来完全没有该格式时，加上再去掉 → 原 HTML（部分已有格式时会整体去掉，属预期）
        const tags = which === 'b' ? /<(b|strong)[\s>]/ : /<(i|em)[\s>]/;
        if (!tags.test(before)) {
          toggle(host);
          expect(c.innerHTML).toBe(before);
        }
      }),
      { numRuns: 300 },
    );
  });
});
