// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"handleDisabledFileLoadingAsSuccess":true,"disableJavaScriptEvaluation":true,"disableCSSFileLoading":true,"disableIframePageLoading":true}}
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSpec } from '../testing/spec-dom.js';
import { openPreserve, type PreserveSession } from './edit.js';
import { GENERATED_ATTR } from './mount.js';
import {
  createSourcePopover,
  regionElements,
  sourceRegions,
  type SourceEditor,
  type SourcePopover,
  type SourceRegion,
} from './source-popover.js';

const FIXTURES = join(import.meta.dirname, '../../../../tests/fixtures/html/');
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.html'))
  .map((f) => [f, readFileSync(FIXTURES + f, 'utf8')] as const);
const fixture = (name: string): string => readFileSync(FIXTURES + name, 'utf8');

let session: PreserveSession | undefined;
const windows: Window[] = [];
afterEach(async () => {
  session?.close();
  session = undefined;
  for (const w of windows.splice(0)) await w.happyDOM.close();
});

function open(src: string): PreserveSession {
  session?.close();
  loadSpec(document, src);
  session = openPreserve(document, src);
  return session;
}

function req<T>(v: T | null | undefined, what = 'value'): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

const q = (sel: string): HTMLElement => req(document.querySelector<HTMLElement>(sel), sel);

/** 区域在原文中的区间。 */
function spanOfRegion(s: PreserveSession, r: { first: Element; last: Element }): { start: number; end: number } {
  const a = req(s.mount.spanOf(r.first)?.span, 'first span');
  const b = req(s.mount.spanOf(r.last)?.span, 'last span');
  return { start: a.start, end: b.end };
}

/** 模拟 echarts.init(el).setOption(...)：脚本往容器里塞 div>canvas，并给容器加属性。 */
function fakeEcharts(s: PreserveSession, el: HTMLElement): void {
  el.setAttribute('_echarts_instance_', 'ec_1');
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.appendChild(document.createElement('canvas'));
  const tip = document.createElement('div');
  tip.textContent = '周三 1290';
  wrap.appendChild(tip);
  el.appendChild(wrap);
  s.mount.flush();
}

/** 结构合法的随机替换 HTML：空白、CRLF、实体、注释、各种属性写法、脚本、pre。 */
const inline: fc.Arbitrary<string> = fc.letrec<{ inl: string }>((tie) => ({
  inl: fc.oneof(
    { depthSize: 'small' },
    fc.constantFrom(
      '文字',
      'a &amp; b',
      '&nbsp;',
      '&#x4e2d;&#20013;',
      'x &lt; y',
      ' ',
      '\r\n',
      '\t',
      'a < b',
      '<br>',
      '<br/>',
    ),
    fc.constantFrom('<img src=a.png alt="">', '<!-- 注释 -->', '<!---->'),
    fc
      .tuple(
        fc.constantFrom('span', 'strong', 'em', 'a', 'code'),
        fc.constantFrom('', ' class=x', " title='a\"b'", ' data-x="1 &amp; 2"', ' hidden', '  id = "i"'),
        fc.array(tie('inl'), { maxLength: 3 }),
      )
      .map(([t, a, kids]) => `<${t}${a}>${kids.join('')}</${t}>`),
  ),
})).inl;

const block: fc.Arbitrary<string> = fc.letrec<{ blk: string }>((tie) => ({
  blk: fc.oneof(
    { depthSize: 'small' },
    fc.array(inline, { maxLength: 4 }).map((k) => `<p>${k.join('')}</p>`),
    fc.array(inline, { maxLength: 3 }).map((k) => `<h2 class="t">${k.join('')}</h2>`),
    fc.array(inline, { minLength: 1, maxLength: 3 }).map((k) => `<ul>\n  <li>${k.join('</li>\n  <li>')}</li>\n</ul>`),
    fc.constantFrom(
      '<pre>\nline 1\n  line 2</pre>',
      '<script>var a = 1 < 2 && "</p>";</script>',
      '<hr>',
      '<!-- 块注释 -->',
    ),
    fc
      .tuple(fc.constantFrom('div', 'section', 'blockquote'), fc.array(tie('blk'), { maxLength: 3 }))
      .map(([t, kids]) => `<${t} style="color: red">\n${kids.join('\n')}\n</${t}>`),
  ),
})).blk;

const replacement: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom('', '\n', '  ', '\r\n'), fc.array(block, { maxLength: 3 }), fc.constantFrom('', '\n', ' '))
  .map(([a, bs, b]) => a + bs.join('\n\n') + b);

describe('replaceSource：整段替换区域源码', () => {
  it('property: 随机区域 × 随机 HTML → 保存结果中该区间恰为新 HTML，其余逐字节不变；撤销到底 = 原文', () => {
    const docs = fixtures.filter(([, src]) => {
      const s = open(src);
      return sourceRegions(s, document).length > 0;
    });
    expect(docs.length).toBeGreaterThan(10);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: docs.length - 1 }), fc.nat(), replacement, (d, pick, html) => {
        const src = (docs[d] as (typeof docs)[number])[1];
        const s = open(src);
        const regions = sourceRegions(s, document);
        const r = regions[pick % regions.length] as SourceRegion;
        const { start, end } = spanOfRegion(s, r);
        expect(s.getSource(r)).toBe(src.slice(start, end));
        s.replaceSource(r, html);
        const expected = src.slice(0, start) + html + src.slice(end);
        expect(s.save()).toBe(expected);
        expect(s.undo()).toBe(true);
        expect(s.patches()).toEqual([]);
        expect(s.save()).toBe(src);
        expect(s.redo()).toBe(true);
        expect(s.save()).toBe(expected);
      }),
      { numRuns: 150 },
    );
  });

  it.each(fixtures)('%s: 每个区域原样替换（getSource → replaceSource）→ 逐字节不变', (_n, src) => {
    const s = open(src);
    const regions = sourceRegions(s, document);
    for (const r of regions) s.replaceSource(r, s.getSource(r));
    expect(s.save()).toBe(src);
  });

  it('替换后在新内容里打字：只有那几个字变化，用户写的缩进、实体、注释都保留', () => {
    const src = '<!doctype html>\n<body>\n  <p>旧段落</p>\n  <p>尾</p>\n</body>\n';
    const s = open(src);
    const html = '<div class="box">\n\t<p>新&nbsp;段落 &amp; 更多</p>  <!-- 留着 -->\n</div>';
    s.replaceSource(q('p'), html);
    const p = q('div.box > p');
    expect(s.mount.isEditable(p)).toBe(true);
    const t = req(p.firstChild as Text);
    s.mount.userEdit(() => {
      t.data = t.data.replace('更多', '更多的');
    });
    expect(s.save()).toBe(src.replace('<p>旧段落</p>', html.replace('更多', '更多的')));
  });

  it('同一区域可以反复编辑源码（替换可嵌套），逐步撤销回原文', () => {
    const src = '<body>\n<p>一</p>\n<p>二</p>\n</body>';
    const s = open(src);
    s.replaceSource(q('p'), '<section>\n  <h2>甲</h2>\n</section>');
    const after1 = s.save();
    const sec = q('section');
    expect(s.getSource(sec)).toBe('<section>\n  <h2>甲</h2>\n</section>');
    s.replaceSource(sec, '<h3>乙</h3>\n<p>丙</p>');
    expect(s.save()).toBe('<body>\n<h3>乙</h3>\n<p>丙</p>\n<p>二</p>\n</body>');
    // 只替换新内容中的一部分（第二层替换的顶层节点）
    s.replaceSource(q('h3'), '<h4>丁</h4>');
    expect(s.save()).toBe('<body>\n<h4>丁</h4>\n<p>丙</p>\n<p>二</p>\n</body>');
    expect(s.undo()).toBe(true);
    expect(s.undo()).toBe(true);
    expect(s.save()).toBe(after1);
    expect(s.undo()).toBe(true);
    expect(s.patches()).toEqual([]);
    expect(s.save()).toBe(src);
  });

  it('替换为空串 = 删除该区间', () => {
    const src = '<body>\n<p>一</p>\n<p>二</p>\n</body>';
    const s = open(src);
    s.replaceSource(q('p'), '');
    expect(s.save()).toBe('<body>\n\n<p>二</p>\n</body>');
    s.undo();
    expect(s.save()).toBe(src);
  });

  it('与其它编辑并存：先改字、再替换别处、再撤销替换 → 只剩改字', () => {
    const src = '<body>\n<p>一</p>\n<div>二</div>\n</body>';
    const s = open(src);
    const t = req(q('p').firstChild as Text);
    s.mount.userEdit(() => {
      t.data = '一一';
    });
    s.replaceSource(q('div'), '<div>贰</div>');
    expect(s.save()).toBe('<body>\n<p>一一</p>\n<div>贰</div>\n</body>');
    s.undo();
    expect(s.save()).toBe('<body>\n<p>一一</p>\n<div>二</div>\n</body>');
  });

  it('无法逐字节保留的写法（表格寄养文本）→ 抛错，DOM 与历史都不变', () => {
    const src = '<body>\n<p>一</p>\n</body>';
    const s = open(src);
    const p = q('p');
    expect(() => s.replaceSource(p, '<table>a<!--c-->b<tr><td>x</td></tr></table>')).toThrow(/逐字节/);
    expect(p.isConnected).toBe(true);
    expect(s.canUndo()).toBe(false);
    expect(s.save()).toBe(src);
  });

  it('拒绝未配对的元素与 body 本身', () => {
    const s = open('<body>\n<p>一</p>\n</body>');
    expect(() => s.replaceSource(document.body, '<p>x</p>')).toThrow(/head|body/);
    const fresh = s.insertAfter(q('p'), 'p', '新');
    expect(() => s.replaceSource(fresh, '<p>x</p>')).toThrow(/配对/);
  });

  it('runScripts：新脚本换成可执行的新节点，区间随之转移，输出不变', () => {
    const src = '<body>\n<div id="c"></div>\n<script>draw(1)</script>\n</body>';
    const s = open(src);
    const r = req(sourceRegions(s, document)[0]);
    const html = '<div id="c"></div>\n<script>draw(2)</script>';
    const nodes = s.replaceSource(r, html, { runScripts: true });
    const script = req(document.querySelector('script'));
    expect(nodes).toContain(script);
    expect(s.mount.spanOf(script)?.kind).toBe('element');
    expect(s.save()).toBe(src.replace('draw(1)', 'draw(2)'));
    s.undo();
    expect(s.save()).toBe(src);
  });
});

describe('脚本生成的内容不进源码', () => {
  it('03-echarts：图表生成的 DOM 与脚本加的属性，在父元素被重新输出时也不写进文件', () => {
    const src = fixture('03-echarts.html');
    const s = open(src);
    for (const id of ['pv-chart', 'source-chart', 'heat']) fakeEcharts(s, q(`#${id}`));
    q('#heat').style.height = '300px';
    s.mount.flush();
    const h1 = q('h1');
    s.insertAfter(h1, 'p', '新段');
    const out = s.save();
    expect(out).not.toMatch(/canvas|_echarts_instance_|周三 1290|height: 300px/);
    expect(out).toBe(src.replace('<h1>第 47 周访问量</h1>', '<h1>第 47 周访问量</h1>\n  <p>新段</p>'));
  });

  it('在已运行过脚本的 DOM 上重新打开会话：与原文不同的属性视为脚本所改', () => {
    const src = '<body>\n<div id="c" class="chart"></div>\n<p>正文</p>\n</body>';
    loadSpec(document, src);
    q('#c').setAttribute('_echarts_instance_', 'ec_9');
    q('#c').setAttribute('class', 'chart ready');
    const s = openPreserve(document, src);
    session = s;
    s.insertAfter(q('p'), 'p', '新');
    expect(s.save()).toBe('<body>\n<div id="c" class="chart"></div>\n<p>正文</p>\n<p>新</p>\n</body>');
  });
});

describe('sourceRegions：区域列表', () => {
  it('03-echarts：正文块各一个区域，图表容器连同其脚本为一个区域', () => {
    const s = open(fixture('03-echarts.html'));
    const list = (): string[] =>
      sourceRegions(s, document).map(
        (r) => `${r.label}${r.last === r.first ? '' : `+${r.last.localName}`}${r.generated ? '*' : ''}`,
      );
    // 脚本未运行：空的图表容器按占位处理
    expect(list()).toEqual([
      'h1「第 47 周访问量」',
      'p「本周 PV 在周三达到峰值，…」',
      'div#pv-chart+script',
      'h2「来源构成」',
      'div#source-chart+script',
      'h2「每小时热力（数据由代码生成）」',
      'div#heat+script',
      'p「数据来源：内部统计，已脱敏。」',
    ]);
    for (const id of ['pv-chart', 'source-chart', 'heat']) fakeEcharts(s, q(`#${id}`));
    const charts = sourceRegions(s, document).filter((r) => r.generated);
    expect(charts.map((r) => r.first.id)).toEqual(['pv-chart', 'source-chart', 'heat']);
  });

  it('03-echarts：编辑标灰图表区域的原始源码（容器 + 脚本），保存正确、撤销复原图表', () => {
    const src = fixture('03-echarts.html');
    const s = open(src);
    const chart = q('#pv-chart');
    fakeEcharts(s, chart);
    const wrap = req(chart.firstElementChild);
    expect(wrap.hasAttribute(GENERATED_ATTR)).toBe(true);
    const r = req(sourceRegions(s, document).find((x) => x.first === chart));
    expect(r.generated).toBe(true);
    expect(r.last.localName).toBe('script');
    const { start, end } = spanOfRegion(s, r);
    const orig = s.getSource(r);
    expect(orig).toBe(src.slice(start, end));
    expect(orig).not.toMatch(/canvas|_echarts_instance_/);
    const html = orig.replace('[820, 932, 1290, 1130, 990, 610, 540]', '[1, 2, 3, 4, 5, 6, 7]');
    s.replaceSource(r, html);
    expect(s.save()).toBe(src.replace('[820, 932, 1290, 1130, 990, 610, 540]', '[1, 2, 3, 4, 5, 6, 7]'));
    expect(chart.isConnected).toBe(false);
    s.undo();
    expect(s.save()).toBe(src);
    expect(chart.isConnected).toBe(true);
    expect(chart.firstElementChild).toBe(wrap); // 已渲染的图表原样回来
  });

  it('main / article 包装与唯一的 div 包装向内展开', () => {
    const s = open(
      '<body>\n<div class="container">\n<main>\n<h1>标题</h1>\n<article><p>甲</p><p>乙</p></article>\n</main>\n<footer>脚注</footer>\n</div>\n<script>x()</script>\n</body>',
    );
    expect(sourceRegions(s, document).map((r) => r.label)).toEqual([
      'h1「标题」',
      'p「甲」',
      'p「乙」',
      'footer「脚注」',
    ]);
  });

  it('嵌套的标灰区域单独列出，排在外层区域之后', () => {
    const s = open('<body>\n<section>\n<h2>图</h2>\n<div id="g"></div>\n</section>\n<p>尾</p>\n</body>');
    const g = q('#g');
    g.appendChild(document.createElement('canvas'));
    s.mount.flush();
    expect(sourceRegions(s, document).map((r) => `${r.label}${r.generated ? '*' : ''}`)).toEqual([
      'section「图」',
      'div#g*',
      'p「尾」',
    ]);
  });
});

/** 测试用的编辑器：一个可直接改值的对象。 */
interface FakeEditor extends SourceEditor {
  value: string;
  change(v: string): void;
  destroyed: boolean;
}

function popover(s: PreserveSession, previewDelay = 0): { pop: SourcePopover; editors: FakeEditor[]; host: Document } {
  const win = new Window();
  windows.push(win);
  const host = win.document as unknown as Document;
  const editors: FakeEditor[] = [];
  const pop = createSourcePopover({
    session: s,
    doc: document,
    host,
    previewDelay,
    editor(_parent, value, onChange) {
      const ed: FakeEditor = {
        value,
        destroyed: false,
        getValue: () => ed.value,
        focus() {},
        destroy() {
          ed.destroyed = true;
        },
        change(v) {
          ed.value = v;
          onChange();
        },
      };
      editors.push(ed);
      return Promise.resolve(ed);
    },
  });
  return { pop, editors, host };
}

describe('createSourcePopover：弹层控制器（假编辑器）', () => {
  const SRC = '<body>\n<h1>标题</h1>\n<p>正文</p>\n</body>';

  it('界面只放进宿主文档，不碰被编辑的文档', () => {
    const s = open(SRC);
    const { pop, host } = popover(s);
    expect(host.querySelector('.eh-src-btn')).not.toBeNull();
    expect(document.querySelector('.eh-src-btn, .eh-src-pop')).toBeNull();
    expect(() =>
      createSourcePopover({
        session: s,
        doc: document,
        host: document,
        editor: () => Promise.reject(new Error('unused')),
      }),
    ).toThrow();
    pop.destroy();
    expect(host.querySelector('.eh-src-btn, .eh-src-pop')).toBeNull();
  });

  it('打开 → 改 → 应用：保存结果正确，一步撤销', async () => {
    const s = open(SRC);
    const { pop, editors, host } = popover(s);
    const r = req(pop.regionAt(req(q('p').firstChild)));
    expect(r.first).toBe(q('p'));
    await pop.open(r);
    const ed = req(editors[0]);
    expect(ed.value).toBe('<p>正文</p>');
    expect(req(host.querySelector<HTMLElement>('.eh-src-layer')).hidden).toBe(false);
    ed.change('<p>正文<b>加粗</b></p>');
    expect(pop.apply()).toBe(true);
    expect(ed.destroyed).toBe(true);
    expect(pop.current).toBeNull();
    expect(s.save()).toBe(SRC.replace('<p>正文</p>', '<p>正文<b>加粗</b></p>'));
    expect(s.history.undoDepth).toBe(1);
    s.undo();
    expect(s.save()).toBe(SRC);
  });

  it('预览多次后取消：页面复原，且不能重做预览', async () => {
    const s = open(SRC);
    const { pop, editors } = popover(s);
    await pop.open(req(pop.regions()[1]));
    const ed = req(editors[0]);
    ed.change('<p>预览一</p>');
    expect(pop.preview()).toBe(true);
    expect(document.body.textContent).toContain('预览一');
    ed.change('<p>预览二</p>');
    pop.preview();
    expect(s.history.undoDepth).toBe(1);
    pop.cancel();
    expect(s.save()).toBe(SRC);
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
    expect(q('p').textContent).toBe('正文');
  });

  it('预览后应用：保留预览（只占一步撤销）', async () => {
    const s = open(SRC);
    const { pop, editors } = popover(s);
    await pop.open(req(pop.regions()[0]));
    const ed = req(editors[0]);
    ed.change('<h1>新标题</h1>');
    pop.preview();
    const previewed = q('h1');
    pop.apply();
    expect(q('h1')).toBe(previewed);
    expect(s.save()).toBe(SRC.replace('标题', '新标题'));
    expect(s.history.undoDepth).toBe(1);
  });

  it('防抖的实时预览', async () => {
    const s = open(SRC);
    const { pop, editors } = popover(s, 5);
    await pop.open(req(pop.regions()[0]));
    req(editors[0]).change('<h1>自动预览</h1>');
    await new Promise((r) => setTimeout(r, 30));
    expect(q('h1').textContent).toBe('自动预览');
    pop.cancel();
    expect(s.save()).toBe(SRC);
  });

  it('无法替换时显示错误、弹层保持打开；Esc 取消', async () => {
    const s = open(SRC);
    const { pop, editors, host } = popover(s);
    await pop.open(req(pop.regions()[1]));
    req(editors[0]).change('<table>a<!--c-->b</table>');
    expect(pop.apply()).toBe(false);
    const msg = req(host.querySelector<HTMLElement>('.eh-src-msg'));
    expect(msg.hidden).toBe(false);
    expect(msg.textContent).toMatch(/逐字节/);
    expect(pop.current).not.toBeNull();
    const layer = req(host.querySelector('.eh-src-layer'));
    const win = req(host.defaultView);
    layer.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
    expect(pop.current).toBeNull();
    expect(s.save()).toBe(SRC);
  });

  it('标灰区域打开时给出提示，编辑器里是原始源码', async () => {
    const src = fixture('03-echarts.html');
    const s = open(src);
    fakeEcharts(s, q('#pv-chart'));
    const { pop, editors, host } = popover(s);
    const r = req(pop.regionAt(req(q('#pv-chart canvas'))));
    expect(regionElements(r).map((e) => e.localName)).toEqual(['div', 'script']);
    await pop.open(r);
    expect(req(editors[0]).value).toMatch(/^<div id="pv-chart" class="chart"><\/div>\n {2}<script>/);
    expect(req(host.querySelector('.eh-src-msg')).textContent).toMatch(/脚本生成/);
    pop.cancel();
  });
});
