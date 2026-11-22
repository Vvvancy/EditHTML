// @vitest-environment happy-dom
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activateScripts,
  adoptInto,
  doctypeHtml,
  executableScripts,
  hasActiveContent,
  parseInert,
  scriptFingerprint,
  scriptKind,
} from './scripts.js';

/** 允许执行 JS 的 happy-dom 窗口（模拟受信任的 iframe）。 */
const windows: Window[] = [];
function jsWindow(): { win: Window & { log: string[] }; doc: Document } {
  const win = new Window({
    settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
  }) as Window & { log: string[] };
  win.log = [];
  windows.push(win);
  return { win, doc: win.document as unknown as Document };
}
afterEach(async () => {
  for (const w of windows.splice(0)) await w.happyDOM.close();
});

/** 在 `win` 中按打开器的方式搭建文档：解析（不执行）→ 搬入。 */
function load(win: Window, source: string): Document {
  const doc = win.document as unknown as Document;
  return adoptInto(doc, parseInert(source, win as unknown as globalThis.Window));
}

const PAGE = `<!DOCTYPE html>
<html><head><script>log.push('head')</script>
<script type="application/json" id="data">{"a":1}</script>
<script type="module">log.push('module')</script>
</head><body>
<p>正文</p>
<script>log.push('body:' + document.querySelectorAll('p').length)</script>
<script>document.write('<i id="w">写入</i>')</script>
<script>document.addEventListener('DOMContentLoaded', () => log.push('ready')); addEventListener('load', () => log.push('load'))</script>
</body></html>`;

describe('parseInert + adoptInto', () => {
  it('搬入 live 文档后脚本不执行', () => {
    const { win } = jsWindow();
    load(win, PAGE);
    expect(win.log).toEqual([]);
    expect(win.document.querySelector('p')?.textContent).toBe('正文');
  });

  it('doctypeHtml 还原 doctype（决定标准/怪异模式）', () => {
    expect(doctypeHtml(parseInert('<!doctype html><p>x'))).toBe('<!DOCTYPE html>');
    expect(doctypeHtml(parseInert('<p>x'))).toBe('');
    expect(
      doctypeHtml(
        parseInert(
          '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><p>',
        ),
      ),
    ).toBe(
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">',
    );
  });
});

describe('activateScripts', () => {
  it('按文档顺序执行：经典脚本先于模块，最后补发 DOMContentLoaded / load', async () => {
    const { win } = jsWindow();
    const doc = load(win, PAGE);
    const n = await activateScripts(doc, undefined, { timeout: 1000 });
    expect(n).toBe(5); // JSON 数据块不算
    expect(win.log).toEqual(['head', 'body:1', 'module', 'ready', 'load']);
  });

  it('每个脚本换成新节点并调用 transfer(old, fresh)，非 JS 类型原样不动', async () => {
    const { win } = jsWindow();
    const doc = load(win, PAGE);
    const before = Array.from(doc.querySelectorAll('script'));
    const json = doc.getElementById('data');
    const pairs: [Node, Node][] = [];
    await activateScripts(doc, { transfer: (a, b) => pairs.push([a, b]) }, { timeout: 1000 });
    const after = Array.from(doc.querySelectorAll('script'));
    expect(doc.getElementById('data')).toBe(json);
    expect(pairs.map(([a]) => a)).toEqual(before.filter((s) => s !== json).sort(moduleLast));
    for (const [old, fresh] of pairs) {
      expect(old.isConnected).toBe(false);
      expect(after).toContain(fresh);
      expect((fresh as Element).outerHTML).toBe((old as Element).outerHTML);
    }
  });

  it('document.write 插到当前脚本之后，而不是清空整页', async () => {
    const { win } = jsWindow();
    const doc = load(win, PAGE);
    await activateScripts(doc, undefined, { timeout: 1000 });
    const w = doc.getElementById('w');
    expect(w?.textContent).toBe('写入');
    expect(w?.previousElementSibling?.textContent).toContain('document.write');
    expect(doc.querySelector('p')?.textContent).toBe('正文');
    expect(Object.prototype.hasOwnProperty.call(doc, 'write')).toBe(false); // 垫片已撤销
  });

  it('已被前面的脚本移除的脚本不再执行', async () => {
    const { win } = jsWindow();
    const doc = load(
      win,
      `<script>document.getElementById('x').remove()</script><script id="x">log.push('x')</script>`,
    );
    expect(await activateScripts(doc, undefined, { dispatchLoadEvents: false })).toBe(1);
    expect(win.log).toEqual([]);
  });
});

/** 第二轮（模块）排在经典脚本之后。 */
function moduleLast(a: Element, b: Element): number {
  const m = (e: Element): number => (scriptKind(e) === 'module' ? 1 : 0);
  return m(a) - m(b);
}

describe('脚本识别与指纹', () => {
  it('scriptKind', () => {
    const d = parseInert(
      '<script></script><script type="text/javascript"></script><script type="module"></script>' +
        '<script type="importmap">{}</script><script type="application/ld+json"></script>' +
        '<script nomodule></script><script type="text/template"></script>',
    );
    expect(Array.from(d.querySelectorAll('script'), scriptKind)).toEqual([
      'classic',
      'classic',
      'module',
      'importmap',
      null,
      null,
      null,
    ]);
    expect(executableScripts(d)).toHaveLength(4);
  });

  it('hasActiveContent：脚本或 on* 事件属性', () => {
    expect(hasActiveContent(parseInert('<p>x</p><script type="application/json">{}</script>'))).toBe(false);
    expect(hasActiveContent(parseInert('<img src=x onerror="alert(1)">'))).toBe(true);
    expect(hasActiveContent(parseInert('<script src="a.js"></script>'))).toBe(true);
  });

  it('指纹只取决于可运行代码：改正文不变，改脚本就变', async () => {
    const a = await scriptFingerprint(parseInert('<p>一</p><script>f()</script>'));
    const b = await scriptFingerprint(parseInert('<p>二</p><script>f()</script>'));
    const c = await scriptFingerprint(parseInert('<p>一</p><script>g()</script>'));
    expect(a).toMatch(/^(sha256|fnv):/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(await scriptFingerprint(parseInert('<p>没有脚本</p>'))).toBeNull();
  });
});
