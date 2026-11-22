// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"handleDisabledFileLoadingAsSuccess":true,"disableJavaScriptEvaluation":true,"disableCSSFileLoading":true,"disableIframePageLoading":true}}
/**
 * 集成：工具栏作用于保真会话（@edithtml/importer 仅为测试依赖）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_ATTR, openPreserve, preserveToolbarHost, type PreserveSession } from '@edithtml/importer';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatState,
  mountToolbar,
  setBlockLevel,
  setLink,
  toggleBold,
  toggleItalic,
  type ToolbarHost,
} from './toolbar.js';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../../../../tests/fixtures/html/', name), 'utf8');
const FIXTURE = fixture('01-handwritten-notes.html');
const PAGE = fixture('02-ai-generated-page.html');

function req<T>(v: T | null | undefined, what = 'value'): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

let session: PreserveSession | undefined;
afterEach(() => {
  session?.close();
  session = undefined;
  document.getSelection()?.removeAllRanges();
});

/** 把原文载入全局 document（selection 需要真实窗口），开启会话并返回宿主。 */
function open(src: string): { s: PreserveSession; host: ToolbarHost } {
  const parsed = new DOMParser().parseFromString(src, 'text/html');
  while (document.firstChild) document.removeChild(document.firstChild);
  for (const c of Array.from(parsed.childNodes)) {
    if (c.nodeType === Node.DOCUMENT_TYPE_NODE) {
      const d = c as DocumentType;
      document.appendChild(document.implementation.createDocumentType(d.name, d.publicId, d.systemId));
    } else document.appendChild(document.importNode(c, true));
  }
  const s = openPreserve(document, src);
  session = s;
  return { s, host: preserveToolbarHost(s, document) };
}

function selectIn(el: Element, needle: string): void {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = n as Text;
    const i = t.data.indexOf(needle);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(t, i);
    r.setEnd(t, i + needle.length);
    const sel = req(document.getSelection());
    sel.removeAllRanges();
    sel.addRange(r);
    return;
  }
  throw new Error(`no text ${needle}`);
}

/** 新旧文本逐行比较，返回变化的行（按行数相同的前提）。 */
function changedLines(a: string, b: string): [string, string][] {
  const x = a.split('\n');
  const y = b.split('\n');
  expect(y.length).toBe(x.length);
  const out: [string, string][] = [];
  x.forEach((l, i) => {
    if (l !== y[i]) out.push([l, y[i] ?? '']);
  });
  return out;
}

const paragraph = (needle: string): HTMLElement =>
  req(Array.from(document.querySelectorAll('p')).find((p) => p.textContent?.includes(needle)));

describe('toolbar × preserve session', () => {
  it('bolding a word changes only that line and writes <strong>word</strong>', () => {
    const { s, host } = open(FIXTURE);
    const p = paragraph('目的有三个');
    expect(host.isEditable(p)).toBe(true);
    selectIn(p, '目的');
    expect(toggleBold(host)).toBe(true);
    s.mount.flush();
    expect(p.hasAttribute(GENERATED_ATTR)).toBe(false); // 没被当作脚本改动
    expect(host.isEditable(p)).toBe(true);
    const out = s.save();
    expect(changedLines(FIXTURE, out)).toEqual([['    目的有三个：', '    <strong>目的</strong>有三个：']]);
    // 再次切换 → 回到原文字节
    expect(formatState(host).bold).toBe(true);
    toggleBold(host);
    expect(s.save()).toBe(FIXTURE);
  });

  it('italic and link on the same paragraph stay within that line', () => {
    const { s, host } = open(FIXTURE);
    const p = paragraph('主库');
    selectIn(p, '所有写入');
    toggleItalic(host);
    selectIn(p, '变更日志');
    expect(setLink(host, 'javascript:alert(1)')).toBe(false);
    expect(setLink(host, 'https://x.dev/log')).toBe(true);
    const lines = changedLines(FIXTURE, s.save());
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toBe(
      '<p><em>所有写入</em>都发给<strong>主库</strong>（leader），主库把<a href="https://x.dev/log">变更日志</a>发给<a href="https://example.invalid/followers">从库</a>。</p>',
    );
  });

  it('p → h2 patches only that element: tags change, inner bytes (entities) stay', () => {
    const { s, host } = open(PAGE);
    const p = paragraph('只能有一个');
    selectIn(p, '可以有多个');
    expect(formatState(host).block).toBe(0);
    expect(setBlockLevel(host, 2)).toBe(true);
    const h2 = req(Array.from(document.querySelectorAll('h2')).find((h) => h.textContent?.includes('只能有一个')));
    expect(Array.from(h2.querySelectorAll('code')).map((c) => c.textContent)).toEqual(['&T', '&mut T']);
    // 新块重新登记为容器；挂载层的 contenteditable 没被当成原文属性复制
    expect(host.isEditable(h2)).toBe(true);
    expect(s.mount.owns(h2, 'contenteditable')).toBe(true);
    expect(formatState(host).block).toBe(2);

    const inner = '<code>&amp;T</code> 可以有多个，<code>&amp;mut T</code> 只能有一个。';
    const el = `<p>${inner}</p>`;
    const start = PAGE.indexOf(el);
    expect(start).toBeGreaterThan(0);
    const ps = s.patches();
    expect(ps).toHaveLength(1);
    const patch = req(ps[0]);
    // 补丁落在该元素区间内，从标签名开始、到结束标签名为止
    expect(patch.start).toBe(start + 1);
    expect(patch.end).toBe(start + el.length - 1);
    expect(changedLines(PAGE, s.save())).toEqual([[`            ${el}`, `            <h2>${inner}</h2>`]]);

    // 改回段落 → 回到原文字节
    setBlockLevel(host, 0);
    expect(s.save()).toBe(PAGE);
  });

  it('heading conversion keeps original attributes', () => {
    const src =
      '<!DOCTYPE html>\n<body>\n<div>\n<p class="lead" id=intro>Hello <em>there</em></p>\n<p>next</p>\n</div>\n</body>\n';
    const { s, host } = open(src);
    selectIn(paragraph('Hello'), 'Hello');
    setBlockLevel(host, 3);
    expect(s.save()).toBe(
      src.replace(
        '<p class="lead" id=intro>Hello <em>there</em></p>',
        '<h3 class="lead" id="intro">Hello <em>there</em></h3>',
      ),
    );
  });

  it('toolbar UI mounted outside the edited document never enters the saved file', () => {
    const { s, host } = open(FIXTURE);
    const uiDoc = document.implementation.createHTMLDocument('ui');
    const tb = mountToolbar(host, uiDoc.body);
    selectIn(paragraph('目的有三个'), '三个');
    tb.update();
    const bold = req(tb.element.querySelector<HTMLButtonElement>('[aria-label="粗体"]'));
    expect(bold.disabled).toBe(false);
    bold.click();
    expect(bold.getAttribute('aria-pressed')).toBe('true');
    const out = s.save();
    expect(out).toContain('目的有<strong>三个</strong>：');
    expect(out).not.toContain('eh-toolbar');
    tb.destroy();
  });
});
