import { describe, expect, it } from 'vitest';
import {
  componentBlock,
  createDoc,
  foreignBlock,
  text,
  textBlock,
  type Block,
  type Doc,
  type ListItemAttrs,
} from '../model.js';
import { segmentBlocks, serializeBlock, serializeListGroup, serializeSequence } from './block.js';

/** 文档顶层序列在缩进 0 处的输出。 */
const body = (blocks: Block[], root?: string[]): string => {
  const doc = createDoc(blocks, root ? { root } : {});
  return serializeSequence(doc, doc.root, 0);
};
const lines = (...ls: string[]): string => ls.map((l) => `${l}\n`).join('');
const li = (id: string, s: string, list: 'ul' | 'ol', indent: number, task?: ListItemAttrs['task']): Block =>
  textBlock(id, 'li', s ? [text(s)] : [], { list, indent: String(indent), ...(task ? { task } : {}) });

describe('text blocks', () => {
  it('p / headings / quote / hr', () => {
    expect(
      body([
        textBlock('a', 'p', [text('x '), text('y', [{ type: 'strong' }])]),
        textBlock('b', 'h1', [text('H1')]),
        textBlock('c', 'h6', [text('H6')]),
        textBlock('d', 'quote', [text('q'), { t: 'br', marks: [] }, text('r')]),
        textBlock('e', 'hr'),
        textBlock('f', 'p'),
      ]),
    ).toBe(
      lines(
        '<p data-eh="a">x <strong>y</strong></p>',
        '<h1 data-eh="b">H1</h1>',
        '<h6 data-eh="c">H6</h6>',
        '<blockquote data-eh="d">q<br>r</blockquote>',
        '<hr data-eh="e">',
        '<p data-eh="f"></p>',
      ),
    );
  });

  it('extra text-block attrs follow the attribute order', () => {
    expect(body([textBlock('a', 'p', [text('x')], { class: 'c', 'data-eh-color': 'red', 'aria-x': '"' })])).toBe(
      lines('<p data-eh="a" data-eh-color="red" aria-x="&quot;" class="c">x</p>'),
    );
  });

  it('code with and without lang; newlines and markup kept literal / escaped', () => {
    expect(
      body([textBlock('a', 'code', [text('const a = 1 < 2;\n</code>\n  x')], { lang: 'ts' }), textBlock('b', 'code')]),
    ).toBe(
      '<pre data-eh="a" data-lang="ts"><code>const a = 1 &lt; 2;\n&lt;/code&gt;\n  x</code></pre>\n' +
        '<pre data-eh="b"><code></code></pre>\n',
    );
  });

  it('figure with and without caption', () => {
    expect(
      body([
        textBlock('a', 'figure', [text('图 '), text('1', [{ type: 'em' }])], { src: 'assets/图 1.png', alt: 'a "b"' }),
        textBlock('b', 'figure', [], { src: 'x.png', alt: '' }),
      ]),
    ).toBe(
      lines(
        '<figure data-eh="a"><img alt="a &quot;b&quot;" src="assets/图 1.png"><figcaption>图 <em>1</em></figcaption></figure>',
        '<figure data-eh="b"><img alt="" src="x.png"></figure>',
      ),
    );
  });

  it('table with head, alignment and body', () => {
    const t = textBlock(
      't',
      'table',
      [],
      {},
      {
        head: [[text('A')], [text('B')]],
        body: [
          [[text('1')], [text('2 & 3', [{ type: 'code' }])]],
          [[], [text('x')]],
        ],
        align: [null, 'center'],
      },
    );
    expect(body([t])).toBe(
      lines(
        '<table data-eh="t">',
        '  <thead><tr><th>A</th><th data-eh-align="center">B</th></tr></thead>',
        '  <tbody>',
        '    <tr><td>1</td><td data-eh-align="center"><code>2 &amp; 3</code></td></tr>',
        '    <tr><td></td><td data-eh-align="center">x</td></tr>',
        '  </tbody>',
        '</table>',
      ),
    );
  });

  it('table without head and without body rows', () => {
    expect(body([textBlock('t', 'table', [], {}, { head: [], body: [[[text('a')]]] })])).toBe(
      lines('<table data-eh="t">', '  <tbody>', '    <tr><td>a</td></tr>', '  </tbody>', '</table>'),
    );
    expect(body([textBlock('t', 'table', [], {}, { head: [[text('A')]], body: [] })])).toBe(
      lines('<table data-eh="t">', '  <thead><tr><th>A</th></tr></thead>', '  <tbody></tbody>', '</table>'),
    );
  });
});

describe('lists', () => {
  it('matches the spec example', () => {
    expect(body([li('a', '父项', 'ul', 0), li('b', '子项', 'ul', 1, 'done'), li('c', '下一项', 'ul', 0)])).toBe(
      lines(
        '<ul>',
        '  <li data-eh="a">父项<ul>',
        '    <li data-eh="b" data-eh-task="done">子项</li>',
        '  </ul></li>',
        '  <li data-eh="c">下一项</li>',
        '</ul>',
      ),
    );
  });

  it('ordered list, todo task, empty item', () => {
    expect(body([li('a', '', 'ol', 0, 'todo'), li('b', 'x', 'ol', 0)])).toBe(
      lines('<ol>', '  <li data-eh="a" data-eh-task="todo"></li>', '  <li data-eh="b">x</li>', '</ol>'),
    );
  });

  it('type change at level 0 closes and reopens (same as two groups)', () => {
    const out = body([li('a', 'a', 'ul', 0), li('b', 'b', 'ol', 0)]);
    expect(out).toBe(lines('<ul>', '  <li data-eh="a">a</li>', '</ul>', '<ol>', '  <li data-eh="b">b</li>', '</ol>'));
  });

  it('type change at a nested level stays inside the parent item', () => {
    expect(body([li('a', 'a', 'ul', 0), li('b', 'b', 'ul', 1), li('c', 'c', 'ol', 1), li('d', 'd', 'ul', 0)])).toBe(
      lines(
        '<ul>',
        '  <li data-eh="a">a<ul>',
        '    <li data-eh="b">b</li>',
        '  </ul><ol>',
        '    <li data-eh="c">c</li>',
        '  </ol></li>',
        '  <li data-eh="d">d</li>',
        '</ul>',
      ),
    );
  });

  it('nested list type comes from its first item', () => {
    expect(body([li('a', 'a', 'ul', 0), li('b', 'b', 'ol', 1)])).toBe(
      lines('<ul>', '  <li data-eh="a">a<ol>', '    <li data-eh="b">b</li>', '  </ol></li>', '</ul>'),
    );
  });

  it('deep nesting and multi-level dedent', () => {
    expect(
      body([
        li('a', 'a', 'ul', 0),
        li('b', 'b', 'ul', 1),
        li('c', 'c', 'ol', 2),
        li('d', 'd', 'ol', 3),
        li('e', 'e', 'ul', 1),
        li('f', 'f', 'ul', 2),
      ]),
    ).toBe(
      lines(
        '<ul>',
        '  <li data-eh="a">a<ul>',
        '    <li data-eh="b">b<ol>',
        '      <li data-eh="c">c<ol>',
        '        <li data-eh="d">d</li>',
        '      </ol></li>',
        '    </ol></li>',
        '    <li data-eh="e">e<ul>',
        '      <li data-eh="f">f</li>',
        '    </ul></li>',
        '  </ul></li>',
        '</ul>',
      ),
    );
  });

  it('dedent with type change at an intermediate level', () => {
    expect(body([li('a', 'a', 'ul', 0), li('b', 'b', 'ul', 1), li('c', 'c', 'ul', 2), li('d', 'd', 'ol', 1)])).toBe(
      lines(
        '<ul>',
        '  <li data-eh="a">a<ul>',
        '    <li data-eh="b">b<ul>',
        '      <li data-eh="c">c</li>',
        '    </ul></li>',
        '  </ul><ol>',
        '    <li data-eh="d">d</li>',
        '  </ol></li>',
        '</ul>',
      ),
    );
  });

  it('non-li blocks split list groups', () => {
    const doc = createDoc([
      li('a', 'a', 'ul', 0),
      textBlock('p', 'p', [text('x')]),
      li('b', 'b', 'ul', 0),
      li('c', 'c', 'ul', 0),
    ]);
    expect(segmentBlocks(doc, doc.root)).toEqual([
      { kind: 'list', ids: ['a'] },
      { kind: 'block', id: 'p' },
      { kind: 'list', ids: ['b', 'c'] },
    ]);
    expect(serializeSequence(doc, doc.root, 0)).toBe(
      lines(
        '<ul>',
        '  <li data-eh="a">a</li>',
        '</ul>',
        '<p data-eh="p">x</p>',
        '<ul>',
        '  <li data-eh="b">b</li>',
        '  <li data-eh="c">c</li>',
        '</ul>',
      ),
    );
  });

  it('clamps invalid indents so output stays well-formed', () => {
    expect(body([li('a', 'a', 'ul', 2), li('b', 'b', 'ul', 5)])).toBe(
      lines('<ul>', '  <li data-eh="a">a<ul>', '    <li data-eh="b">b</li>', '  </ul></li>', '</ul>'),
    );
  });

  it('serializeBlock on a single li yields a one-item list', () => {
    const doc = createDoc([li('a', 'a', 'ol', 1)]);
    expect(serializeBlock(doc, 'a', 1)).toBe(lines('  <ol>', '    <li data-eh="a">a</li>', '  </ol>'));
    expect(serializeListGroup(doc, ['a'], 1)).toBe(serializeBlock(doc, 'a', 1));
  });
});

describe('component, container and foreign blocks', () => {
  it('leaf component with attrs, JSON and fallback', () => {
    const c = componentBlock(
      'c',
      'chart',
      { type: 'bar', data: { x: ['A'], y: [3] } },
      {
        attrs: { 'data-eh-height': '300', class: 'w' },
        fallback: '<img src="data:image/svg+xml;x" alt="柱状图">',
      },
    );
    expect(body([c])).toBe(
      lines(
        '<eh-chart data-eh="c" data-eh-height="300" class="w">',
        '  <script type="application/json">{"type":"bar","data":{"x":["A"],"y":[3]}}</script>',
        '  <!--eh:fallback--><img src="data:image/svg+xml;x" alt="柱状图"><!--eh:fallback-->',
        '</eh-chart>',
      ),
    );
  });

  it('escapes </script> and <!-- inside component JSON; omits missing fallback', () => {
    const c = componentBlock('s', 'script', { html: '<b>hi</b></script>', css: '<!-- c -->', js: 'a</b' });
    expect(body([c])).toBe(
      lines(
        '<eh-script data-eh="s">',
        '  <script type="application/json">{"html":"<b>hi<\\/b><\\/script>","css":"\\u003c!-- c -->","js":"a<\\/b"}</script>',
        '</eh-script>',
      ),
    );
  });

  it('empty-string fallback still emits markers', () => {
    expect(body([componentBlock('m', 'math', { tex: 'x' }, { fallback: '' })])).toBe(
      lines(
        '<eh-math data-eh="m">',
        '  <script type="application/json">{"tex":"x"}</script>',
        '  <!--eh:fallback--><!--eh:fallback-->',
        '</eh-math>',
      ),
    );
  });

  it('container with slots (incl. empty slot and nested list), fallback after slots', () => {
    const doc = createDoc([
      componentBlock(
        't',
        'tabs',
        { tabs: [{ title: '概念' }, { title: '例子' }, { title: '空' }] },
        {
          slots: [['p1', 'l1', 'l2'], ['n'], []],
          fallback: '<div>tabs</div>',
        },
      ),
      textBlock('p1', 'p', [text('概念')]),
      li('l1', 'a', 'ul', 0),
      li('l2', 'b', 'ul', 1),
      componentBlock('n', 'callout', { kind: 'info' }, { slots: [['q']] }),
      textBlock('q', 'quote', [text('q')]),
    ]);
    expect(serializeSequence(doc, doc.root, 3)).toBe(
      lines(
        '      <eh-tabs data-eh="t">',
        '        <script type="application/json">{"tabs":[{"title":"概念"},{"title":"例子"},{"title":"空"}]}</script>',
        '        <eh-slot data-eh-slot="0">',
        '          <p data-eh="p1">概念</p>',
        '          <ul>',
        '            <li data-eh="l1">a<ul>',
        '              <li data-eh="l2">b</li>',
        '            </ul></li>',
        '          </ul>',
        '        </eh-slot>',
        '        <eh-slot data-eh-slot="1">',
        '          <eh-callout data-eh="n">',
        '            <script type="application/json">{"kind":"info"}</script>',
        '            <eh-slot data-eh-slot="0">',
        '              <blockquote data-eh="q">q</blockquote>',
        '            </eh-slot>',
        '          </eh-callout>',
        '        </eh-slot>',
        '        <eh-slot data-eh-slot="2"></eh-slot>',
        '        <!--eh:fallback--><div>tabs</div><!--eh:fallback-->',
        '      </eh-tabs>',
      ),
    );
  });

  it('foreign block is wrapped verbatim', () => {
    expect(body([foreignBlock('f', '<div class="x">自定义\n<b>HTML</b></div>')])).toBe(
      '<eh-foreign data-eh="f"><div class="x">自定义\n<b>HTML</b></div></eh-foreign>\n',
    );
  });

  it('throws on a missing block', () => {
    const doc: Doc = { ...createDoc([]), root: ['nope'] };
    expect(() => serializeSequence(doc, doc.root, 0)).toThrow(/nope/);
  });
});
