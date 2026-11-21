import { describe, expect, it } from 'vitest';
import {
  componentBlock,
  createDoc,
  docToComparable,
  foreignBlock,
  text,
  textBlock,
  validateDoc,
  type Block,
  type ComponentBlock,
  type Doc,
  type DocHead,
  type DocMeta,
  type ForeignBlock,
  type TextBlock,
} from '../model.js';
import { parse } from './parser.js';
import type { ParseWarningCode } from './warnings.js';

/** 按 01 §6.1 骨架包裹顶层块（每块缩进 6）。 */
function page(body: string | string[], headLines: string[] = [], lang = 'zh-CN', title = ''): string {
  const lines = Array.isArray(body) ? body : body === '' ? [] : [body];
  const indented = lines.map((l) => `      ${l}`).join('\n');
  return [
    '<!doctype html>',
    `<html lang="${lang}" data-eh-version="0.1">`,
    '  <head>',
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    `    <title>${title}</title>`,
    ...headLines.map((l) => `    ${l}`),
    '  </head>',
    '  <body>',
    '    <main id="eh-doc">',
    ...(indented ? [indented] : []),
    '    </main>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

function blocksOf(html: string): Block[] {
  const { doc } = parse(html);
  expect(validateDoc(doc)).toEqual([]);
  return doc.root.map((id) => doc.blocks.get(id) as Block);
}

function only(html: string): Block {
  const bs = blocksOf(html);
  expect(bs).toHaveLength(1);
  return bs[0] as Block;
}

const codes = (html: string): ParseWarningCode[] => parse(html).warnings.map((w) => w.code);

function expectDoc(actual: Doc, blocks: Block[], opts: { meta?: DocMeta; head?: DocHead } = {}): void {
  expect(docToComparable(actual)).toBe(docToComparable(createDoc(blocks, opts)));
}

describe('skeleton and head', () => {
  it('parses an empty canonical document', () => {
    const { doc, warnings } = parse(page(''));
    expectDoc(doc, []);
    expect(warnings).toEqual([]);
  });

  it('reads meta, title, styles, runtime and extra', () => {
    const html = page(
      '<p data-eh="b1">x</p>',
      [
        '<script type="application/json" id="eh-meta">{"title":"T","created":"2026-11-21","tags":["a"],"x":"<\\/script>"}</script>',
        '<style id="eh-theme">:root { --a: 1; }\n  p > b {}</style>',
        '<style id="eh-user-style">[data-eh="b1"] { color: red }</style>',
        '<link rel="icon" href="x.png">',
        '<meta name="author" content="me">',
        '<script id="eh-runtime" src="https://cdn.example/eh-runtime.js" defer></script>',
      ],
      'en',
      'T',
    );
    const { doc, warnings } = parse(html);
    expect(warnings).toEqual([]);
    expect(doc.meta).toEqual({ title: 'T', created: '2026-11-21', tags: ['a'], x: '</script>' });
    expect(doc.head).toEqual({
      lang: 'en',
      themeCss: ':root { --a: 1; }\n  p > b {}',
      userCss: '[data-eh="b1"] { color: red }',
      extra: '<link rel="icon" href="x.png">\n    <meta name="author" content="me">',
      runtimeSrc: 'https://cdn.example/eh-runtime.js',
    });
  });

  it('keeps a title that differs from meta.title, decoding entities', () => {
    const { doc } = parse(
      page('', ['<script type="application/json" id="eh-meta">{"title":"A"}</script>'], 'zh-CN', 'B &amp; C'),
    );
    expect(doc.head).toEqual({ title: 'B & C' });
    expect(parse(page('', [], 'zh-CN', 'only title')).doc.head).toEqual({ title: 'only title' });
  });

  it('omits defaults (lang zh-CN, empty title)', () => {
    expect(parse(page('')).doc.head).toEqual({});
  });

  it('keeps invalid #eh-meta in head.extra', () => {
    const { doc, warnings } = parse(page('', ['<script type="application/json" id="eh-meta">{oops</script>']));
    expect(doc.meta).toEqual({});
    expect(doc.head.extra).toBe('<script type="application/json" id="eh-meta">{oops</script>');
    expect(warnings.map((w) => w.code)).toContain('invalid-meta');
  });

  it('parses body children when there is no main#eh-doc', () => {
    const bs = blocksOf('<html><body><p data-eh="a">x</p><h2 data-eh="b">y</h2></body></html>');
    expect(bs.map((b) => b.id)).toEqual(['a', 'b']);
  });

  it('parses a bare fragment', () => {
    const bs = blocksOf('<p data-eh="a">x</p>\n<hr data-eh="b">');
    expect(bs.map((b) => (b as TextBlock).type)).toEqual(['p', 'hr']);
  });

  it('merges content outside main into the root with a warning', () => {
    const html = '<body><p data-eh="a">before</p><main id="eh-doc"><p data-eh="b">in</p></main></body>';
    expect(blocksOf(html).map((b) => b.id)).toEqual(['a', 'b']);
    expect(codes(html)).toContain('content-outside-main');
  });

  it('handles uppercase tags and attributes, BOM and CRLF structure', () => {
    const bs = blocksOf(
      '\ufeff<!DOCTYPE html>\r\n<HTML><BODY><MAIN ID="eh-doc"><P DATA-EH="a">X</P></MAIN></BODY></HTML>',
    );
    expect(bs).toEqual([textBlock('a', 'p', [text('X')])]);
  });
});

describe('text blocks', () => {
  it('paragraphs and headings', () => {
    const { doc } = parse(
      page([
        '<p data-eh="b1">一段 <strong>粗体</strong>、<code>代码</code>、<a href="https://x.y/?a=1&amp;b=2">链接</a>。</p>',
        ...[1, 2, 3, 4, 5, 6].map((n) => `<h${n} data-eh="h${n}">H${n}</h${n}>`),
      ]),
    );
    expectDoc(doc, [
      textBlock('b1', 'p', [
        text('一段 '),
        text('粗体', [{ type: 'strong' }]),
        text('、'),
        text('代码', [{ type: 'code' }]),
        text('、'),
        text('链接', [{ type: 'link', attrs: { href: 'https://x.y/?a=1&b=2' } }]),
        text('。'),
      ]),
      ...[1, 2, 3, 4, 5, 6].map((n) => textBlock(`h${n}`, `h${n}` as 'h1', [text(`H${n}`)])),
    ]);
  });

  it('preserves whitespace inside text exactly', () => {
    expect(only(page('<p data-eh="a">  a\tb  </p>'))).toEqual(textBlock('a', 'p', [text('  a\tb  ')]));
  });

  it('empty paragraph', () => {
    expect(only(page('<p data-eh="a"></p>'))).toEqual(textBlock('a', 'p'));
  });

  it('nested marks in canonical order and shared prefixes', () => {
    const b = only(page('<p data-eh="a"><a href="u" title="t"><strong>x<em>y</em></strong></a><em>z</em></p>'));
    const link = { type: 'link' as const, attrs: { href: 'u', title: 't' } };
    expect(b).toEqual(
      textBlock('a', 'p', [
        text('x', [link, { type: 'strong' }]),
        text('y', [link, { type: 'strong' }, { type: 'em' }]),
        text('z', [{ type: 'em' }]),
      ]),
    );
  });

  it('all whitelisted marks', () => {
    const b = only(
      page('<p data-eh="a"><s>1</s><mark>2</mark><sub>3</sub><sup>4</sup><kbd>5</kbd><code>6</code></p>'),
    ) as TextBlock;
    expect(b.content.map((n) => n.marks[0]?.type)).toEqual(['s', 'mark', 'sub', 'sup', 'kbd', 'code']);
  });

  it('br and inline atoms', () => {
    const b = only(
      page(
        '<p data-eh="a">x<br>y<span data-eh-inline="math">a &lt; b</span><strong><span data-eh-inline="wikilink" data-eh-target="n#b3">N</span></strong></p>',
      ),
    );
    expect(b).toEqual(
      textBlock('a', 'p', [
        text('x'),
        { t: 'br', marks: [] },
        text('y'),
        { t: 'atom', kind: 'math', attrs: {}, text: 'a < b', marks: [] },
        { t: 'atom', kind: 'wikilink', attrs: { target: 'n#b3' }, text: 'N', marks: [{ type: 'strong' }] },
      ]),
    );
  });

  it('decodes entities; keeps unknown entities literally', () => {
    const html = page('<p data-eh="a">&lt;&gt;&amp;&quot;&#39;&#x1F600;&nbsp;&hellip;&foo; AT&T &copy</p>');
    expect(only(html)).toEqual(textBlock('a', 'p', [text('<>&"\'😀\u00a0…&foo; AT&T ©')]));
    expect(codes(html)).toEqual(['unknown-entity']);
  });

  it('blockquote', () => {
    expect(only(page('<blockquote data-eh="q">引用<br>第二行</blockquote>'))).toEqual(
      textBlock('q', 'quote', [text('引用'), { t: 'br', marks: [] }, text('第二行')]),
    );
  });

  it('blockquote with paragraphs is flattened with br', () => {
    expect(only('<blockquote data-eh="q">\n  <p>a</p>\n  <p>b</p>\n</blockquote>')).toEqual(
      textBlock('q', 'quote', [text('a'), { t: 'br', marks: [] }, text('b')]),
    );
  });

  it('blockquote containing other blocks becomes foreign', () => {
    const src = '<blockquote data-eh="q"><ul><li>x</li></ul></blockquote>';
    expect(only(src)).toEqual(foreignBlock('q', src));
  });

  it('hr', () => {
    expect(only(page('<hr data-eh="h">'))).toEqual(textBlock('h', 'hr'));
    expect(only('<hr data-eh="h"/>')).toEqual(textBlock('h', 'hr'));
  });

  it('code block keeps content verbatim', () => {
    const b = only(page('<pre data-eh="c" data-lang="ts"><code>\nconst a = 1 &lt; 2;\n  &lt;/code&gt;\n</code></pre>'));
    expect(b).toEqual(textBlock('c', 'code', [text('\nconst a = 1 < 2;\n  </code>\n')], { lang: 'ts' }));
  });

  it('code block without lang, empty code', () => {
    expect(only(page('<pre data-eh="c"><code></code></pre>'))).toEqual(textBlock('c', 'code'));
  });

  it('code block lenient forms', () => {
    expect(only('<pre data-eh="c">\nx</pre>')).toEqual(textBlock('c', 'code', [text('x')]));
    expect(only('<pre data-eh="c">\n  <code class="language-py">print(1)</code>\n</pre>')).toEqual(
      textBlock('c', 'code', [text('print(1)')], { lang: 'py' }),
    );
  });

  it('figure', () => {
    expect(
      only(
        page(
          '<figure data-eh="f"><img alt="图 &quot;1&quot;" src="assets/图 1.png"><figcaption>说明 <em>x</em></figcaption></figure>',
        ),
      ),
    ).toEqual(
      textBlock('f', 'figure', [text('说明 '), text('x', [{ type: 'em' }])], { src: 'assets/图 1.png', alt: '图 "1"' }),
    );
    expect(only(page('<figure data-eh="f"><img alt="" src="a.png"></figure>'))).toEqual(
      textBlock('f', 'figure', [], { src: 'a.png', alt: '' }),
    );
  });

  it('figure without img becomes foreign', () => {
    const src = '<figure data-eh="f"><div>x</div></figure>';
    expect(only(src)).toEqual(foreignBlock('f', src));
  });
});

describe('tables', () => {
  it('canonical table with head and alignment', () => {
    const html = page([
      '<table data-eh="t">',
      '  <thead><tr><th>A</th><th data-eh-align="center">B</th></tr></thead>',
      '  <tbody>',
      '    <tr><td>1</td><td data-eh-align="center">2</td></tr>',
      '    <tr><td><strong>3</strong></td><td data-eh-align="center"></td></tr>',
      '  </tbody>',
      '</table>',
    ]);
    expect(only(html)).toEqual(
      textBlock(
        't',
        'table',
        [],
        {},
        {
          head: [[text('A')], [text('B')]],
          body: [
            [[text('1')], [text('2')]],
            [[text('3', [{ type: 'strong' }])], []],
          ],
          align: [null, 'center'],
        },
      ),
    );
  });

  it('table without head', () => {
    const html = page(['<table data-eh="t">', '  <tbody>', '    <tr><td>1</td></tr>', '  </tbody>', '</table>']);
    expect(only(html)).toEqual(textBlock('t', 'table', [], {}, { head: [], body: [[[text('1')]]], align: [null] }));
  });

  it('lenient: rows without tbody, th first row as head, align attr', () => {
    const html = '<table data-eh="t"><tr><th align="right">h</th></tr><tr><td>1</td></tr></table>';
    expect(only(html)).toEqual(
      textBlock('t', 'table', [], {}, { head: [[text('h')]], body: [[[text('1')]]], align: ['right'] }),
    );
  });

  it('tables with spans or captions become foreign', () => {
    for (const src of [
      '<table data-eh="t"><tr><td colspan="2">x</td></tr></table>',
      '<table data-eh="t"><caption>c</caption><tr><td>x</td></tr></table>',
      '<table data-eh="t"><tr><td><ul><li>x</li></ul></td></tr></table>',
    ])
      expect(only(src)).toEqual(foreignBlock('t', src));
  });
});

describe('lists', () => {
  it('flat and nested lists with tasks', () => {
    const html = page([
      '<ul>',
      '  <li data-eh="a">父项<ul>',
      '    <li data-eh="b" data-eh-task="done">子项</li>',
      '    <li data-eh="b2" data-eh-task="todo">子项2</li>',
      '  </ul></li>',
      '  <li data-eh="c">下一项</li>',
      '</ul>',
      '<ol>',
      '  <li data-eh="d">1</li>',
      '</ol>',
    ]);
    expect(blocksOf(html)).toEqual([
      textBlock('a', 'li', [text('父项')], { list: 'ul', indent: '0' }),
      textBlock('b', 'li', [text('子项')], { list: 'ul', indent: '1', task: 'done' }),
      textBlock('b2', 'li', [text('子项2')], { list: 'ul', indent: '1', task: 'todo' }),
      textBlock('c', 'li', [text('下一项')], { list: 'ul', indent: '0' }),
      textBlock('d', 'li', [text('1')], { list: 'ol', indent: '0' }),
    ]);
  });

  it('nested list type change at the same level', () => {
    const html = '<ul><li data-eh="a">p<ul><li data-eh="b">x</li></ul><ol><li data-eh="c">y</li></ol></li></ul>';
    expect(blocksOf(html).map((b) => (b as TextBlock).attrs)).toEqual([
      { list: 'ul', indent: '0' },
      { list: 'ul', indent: '1' },
      { list: 'ol', indent: '1' },
    ]);
  });

  it('enforces the indent invariant', () => {
    const html = '<ul><ul><ul><li data-eh="a">x</li></ul></ul><li data-eh="b">y</li></ul>';
    expect(blocksOf(html).map((b) => (b as TextBlock).attrs.indent)).toEqual(['0', '0']);
  });

  it('lenient: unclosed li, loose paragraphs, GFM checkboxes', () => {
    const html =
      '<ul>\n<li><p>a</p>\n<p>b</p>\n</li>\n<li><input type="checkbox" checked disabled> done\n<li><input type="checkbox"> todo</ul>';
    const bs = blocksOf(html) as TextBlock[];
    expect(bs.map((b) => b.content)).toEqual([
      [text('a'), { t: 'br', marks: [] }, text('b')],
      [text('done\n')],
      [text('todo')],
    ]);
    expect(bs.map((b) => b.attrs.task)).toEqual([undefined, 'done', 'todo']);
  });

  it('stray li outside a list', () => {
    expect(only('<li data-eh="a">x</li>')).toEqual(textBlock('a', 'li', [text('x')], { list: 'ul', indent: '0' }));
  });
});

describe('components', () => {
  it('leaf component with JSON and fallback', () => {
    const html = page([
      '<eh-chart data-eh="c1" data-eh-height="300">',
      '  <script type="application/json">{"type":"bar","data":{"x":["A","<\\/script>","\\u003c!--"],"y":[3,5]}}</script>',
      '  <!--eh:fallback--><img src="data:image/svg+xml;..." alt="柱状图"><div>\n x</div><!--eh:fallback-->',
      '</eh-chart>',
    ]);
    expect(only(html)).toEqual(
      componentBlock(
        'c1',
        'chart',
        { type: 'bar', data: { x: ['A', '</script>', '<!--'], y: [3, 5] } },
        {
          attrs: { 'data-eh-height': '300' },
          fallback: '<img src="data:image/svg+xml;..." alt="柱状图"><div>\n x</div>',
        },
      ),
    );
  });

  it('component without fallback; unknown component type', () => {
    expect(only(page('<eh-foo data-eh="f">\n  <script type="application/json">[1,2]</script>\n</eh-foo>'))).toEqual(
      componentBlock('f', 'foo', [1, 2]),
    );
  });

  it('container with slots (incl. empty and nested)', () => {
    const html = page([
      '<eh-tabs data-eh="t1">',
      '  <script type="application/json">{"tabs":[{"title":"概念"},{"title":"例子"}]}</script>',
      '  <eh-slot data-eh-slot="0">',
      '    <p data-eh="t1a">…</p>',
      '    <eh-callout data-eh="t1c">',
      '      <script type="application/json">{"kind":"info"}</script>',
      '      <eh-slot data-eh-slot="0">',
      '        <ul>',
      '          <li data-eh="t1d">x</li>',
      '        </ul>',
      '      </eh-slot>',
      '    </eh-callout>',
      '  </eh-slot>',
      '  <eh-slot data-eh-slot="1"></eh-slot>',
      '  <!--eh:fallback--><div>fb</div><!--eh:fallback-->',
      '</eh-tabs>',
    ]);
    const { doc, warnings } = parse(html);
    expect(warnings).toEqual([]);
    expectDoc(doc, [
      componentBlock(
        't1',
        'tabs',
        { tabs: [{ title: '概念' }, { title: '例子' }] },
        {
          slots: [['t1a', 't1c'], []],
          fallback: '<div>fb</div>',
        },
      ),
      textBlock('t1a', 'p', [text('…')]),
      componentBlock('t1c', 'callout', { kind: 'info' }, { slots: [['t1d']] }),
      textBlock('t1d', 'li', [text('x')], { list: 'ul', indent: '0' }),
    ]);
  });

  it('lenient: unmarked fallback content, missing JSON', () => {
    const b = only('<eh-chart data-eh="c"><script type="application/json">{}</script><img src="x.svg"></eh-chart>');
    expect(b).toEqual(componentBlock('c', 'chart', {}, { fallback: '<img src="x.svg">' }));
    const html = '<eh-chart data-eh="c"></eh-chart>';
    expect(only(html)).toEqual(componentBlock('c', 'chart', {}));
    expect(codes(html)).toContain('missing-props');
  });

  it('invalid JSON makes the component foreign', () => {
    const src =
      '<eh-chart data-eh="c"><script type="application/json">{nope</script><eh-slot><p>x</p></eh-slot></eh-chart>';
    expect(only(src)).toEqual(foreignBlock('c', src));
    expect(codes(src)).toContain('invalid-json');
  });

  it('strips on* attributes from components', () => {
    const html = '<eh-x data-eh="c" onclick="alert(1)" data-eh-k="v"><script type="application/json">1</script></eh-x>';
    expect(only(html)).toEqual(componentBlock('c', 'x', 1, { attrs: { 'data-eh-k': 'v' } }));
    expect(codes(html)).toContain('stripped-event-handler');
  });
});

describe('foreign blocks', () => {
  it('eh-foreign wrapper keeps the inner slice verbatim', () => {
    const inner = '<div class="x">自定义 <b>HTML</b></div>\n<script src="https://cdn.example/x.js"></script>';
    expect(only(page(`<eh-foreign data-eh="f1">${inner}</eh-foreign>`))).toEqual(foreignBlock('f1', inner));
  });

  it('eh-foreign with tricky inner content', () => {
    const inner = '<script>if (a</b) document.write("</eh-foreign>")</script><div><p>unclosed</div>';
    expect(only(`<eh-foreign data-eh="f">${inner}</eh-foreign>`)).toEqual(foreignBlock('f', inner));
  });

  it('unwrapped out-of-spec content becomes foreign with the original slice', () => {
    const html = page(
      '<div class="X" onclick="y()"><P>a</P>\n<span>b</span></div>\n<!-- note -->\n<script>x<y</script>\n<p data-eh="p">z</p>',
    );
    const bs = blocksOf(html);
    expect(bs.map((b) => (b.kind === 'foreign' ? b.html : b.kind))).toEqual([
      '<div class="X" onclick="y()"><P>a</P>\n<span>b</span></div>',
      '<!-- note -->',
      '<script>x<y</script>',
      'text',
    ]);
    expect((bs[0] as ForeignBlock).id).toMatch(/^b\d/);
  });
});

describe('lenient rules', () => {
  it('maps b/i/del/strike and unwraps unknown inline', () => {
    expect(
      only('<p data-eh="a"><b>1</b><i>2</i><del>3</del><strike>4</strike><u>5</u><span class="x">6</span></p>'),
    ).toEqual(
      textBlock('a', 'p', [
        text('1', [{ type: 'strong' }]),
        text('2', [{ type: 'em' }]),
        text('34', [{ type: 's' }]),
        text('56'),
      ]),
    );
  });

  it('drops script/style inside text blocks', () => {
    const html = '<p data-eh="a">x<script>alert("<p>")</script><style>p{}</style>y</p>';
    expect(only(html)).toEqual(textBlock('a', 'p', [text('xy')]));
    expect(codes(html)).toEqual(['dropped-element', 'dropped-element']);
  });

  it('strips on* attributes and javascript: links', () => {
    const html =
      '<p data-eh="a" onclick="x()"><a href=" JaVa\tScript:alert(1)">t</a><a href="ok" onmouseover="x">u</a></p>';
    expect(only(html)).toEqual(textBlock('a', 'p', [text('t'), text('u', [{ type: 'link', attrs: { href: 'ok' } }])]));
    expect(codes(html)).toEqual(['stripped-event-handler', 'stripped-javascript-url', 'stripped-event-handler']);
  });

  it('reassigns missing, duplicate and invalid ids in document order', () => {
    const html = '<p>x</p><p data-eh="b1">a</p><p data-eh="b1">dup</p><p data-eh="B2!">bad</p><p data-eh="b2">c</p>';
    const { doc, warnings } = parse(html);
    expect(doc.root).toEqual(['b3', 'b1', 'b4', 'b5', 'b2']);
    expect(warnings.map((w) => w.code)).toEqual(['missing-id', 'duplicate-id', 'invalid-id']);
    expect(warnings[1]?.offset).toBe(html.indexOf('<p data-eh="b1">dup'));
  });

  it('first occurrence keeps its id even across nesting', () => {
    const html =
      '<eh-callout data-eh="a"><script type="application/json">{}</script><eh-slot data-eh-slot="0"><p data-eh="a">x</p></eh-slot></eh-callout>';
    const { doc } = parse(html);
    expect(doc.root).toEqual(['a']);
    expect((doc.blocks.get('a') as ComponentBlock).slots).toEqual([['b1']]);
  });

  it('bare text and inline content become implicit paragraphs', () => {
    expect(blocksOf('<body>\n  hello <b>w</b>\n  <p>x</p>tail\n</body>')).toEqual([
      textBlock('b1', 'p', [text('hello '), text('w', [{ type: 'strong' }])]),
      textBlock('b2', 'p', [text('x')]),
      textBlock('b3', 'p', [text('tail')]),
    ]);
  });

  it('heading closed by a different heading level', () => {
    expect(only('<h1 data-eh="a">x</h2>')).toEqual(textBlock('a', 'h1', [text('x')]));
  });

  it('keeps extra attributes on p/h/quote/hr (minus on*), drops them elsewhere', () => {
    expect(only('<p data-eh="a" class="x" onclick="y()" data-eh-k="v">y</p>')).toEqual(
      textBlock('a', 'p', [text('y')], { class: 'x', 'data-eh-k': 'v' }),
    );
    expect(only('<hr data-eh="a" class="x">')).toEqual(textBlock('a', 'hr', [], { class: 'x' }));
    expect(only('<blockquote data-eh="a" cite="u">q</blockquote>')).toEqual(
      textBlock('a', 'quote', [text('q')], { cite: 'u' }),
    );
    const html = '<pre data-eh="a" class="x"><code>y</code></pre>';
    expect(only(html)).toEqual(textBlock('a', 'code', [text('y')]));
    expect(codes(html)).toEqual(['dropped-attribute']);
  });
});

describe('malformed input never throws', () => {
  const cases = [
    '',
    '<',
    '</',
    '</>',
    '<p',
    '<p data-eh="a',
    '<p>unclosed',
    '</p></p>stray',
    '<!--',
    '<!-- x',
    '<script>never closed',
    '<eh-chart><script type="application/json">{"a":1}',
    '<eh-chart><!--eh:fallback--><div>',
    '<table><tr><td>x',
    '<ul><li>a<ul><li>b',
    '<figure><img src="x"',
    '<pre><code>x',
    '<b><i>x</b></i>',
    '<a href="x"><a href="y">z</a></a>',
    '<eh-foreign data-eh="f"><div>',
    '<span data-eh-inline="math">x',
    '<html><head><title>x',
    '<main id="eh-doc"><p>x</main></main>',
    '<eh-tabs><eh-slot data-eh-slot="99999999"><p>x</p></eh-slot></eh-tabs>',
    '&#xFFFFFFFFFF; &#0; &#xD800; &',
    '<<<>>>!!<?xml?><![CDATA[x]]>',
  ];
  for (const c of cases)
    it(JSON.stringify(c), () => {
      const { doc } = parse(c);
      expect(validateDoc(doc)).toEqual([]);
    });

  it('unclosed p is closed by the next block', () => {
    expect(blocksOf('<p data-eh="a">x<p data-eh="b">y').map((b) => (b as TextBlock).content)).toEqual([
      [text('x')],
      [text('y')],
    ]);
  });

  it('EOF mid-tag warns', () => {
    expect(codes('<p data-eh="a">x<strong')).toContain('eof-in-tag');
  });

  it('deep nesting does not overflow the stack', () => {
    const n = 5000;
    for (const [open, close] of [
      ['<eh-x><eh-slot>', '</eh-slot></eh-x>'],
      ['<ul><li>x', '</li></ul>'],
      ['<div>', '</div>'],
      ['<b>', '</b>'],
    ] as const) {
      const { doc } = parse(open.repeat(n) + close.repeat(n));
      expect(validateDoc(doc)).toEqual([]);
    }
  });
});

describe('T1.3 serializer conventions', () => {
  it('empty styles give empty strings; multi-line head.extra is kept verbatim', () => {
    const extra = '<link rel="a" href="b">\n<!-- c -->\n  <meta name="x" content="y">';
    const html = page('', ['<style id="eh-theme"></style>', '<style id="eh-user-style"></style>', extra]);
    const { doc, warnings } = parse(html);
    expect(warnings).toEqual([]);
    expect(doc.head).toEqual({ themeCss: '', userCss: '', extra });
  });

  it('nested type change inside one li gives siblings at the same indent', () => {
    const html = page([
      '<ul>',
      '  <li data-eh="a">p<ul>',
      '    <li data-eh="b">x</li>',
      '  </ul><ol>',
      '    <li data-eh="c">y</li>',
      '  </ol></li>',
      '</ul>',
      '<ol>',
      '  <li data-eh="d">z</li>',
      '</ol>',
    ]);
    expect(blocksOf(html).map((b) => (b as TextBlock).attrs)).toEqual([
      { list: 'ul', indent: '0' },
      { list: 'ul', indent: '1' },
      { list: 'ol', indent: '1' },
      { list: 'ol', indent: '0' },
    ]);
  });

  it('fallback: empty markers give "", no markers give undefined; no eh-slot gives no slots', () => {
    const json = '  <script type="application/json">{"tex":"x"}</script>';
    const a = only(page(['<eh-math data-eh="m">', json, '  <!--eh:fallback--><!--eh:fallback-->', '</eh-math>']));
    expect((a as ComponentBlock).fallback).toBe('');
    expect('slots' in a).toBe(false);
    const b = only(page(['<eh-math data-eh="m">', json, '</eh-math>']));
    expect('fallback' in b).toBe(false);
  });

  it('figure with optional alt/src; table with empty tbody', () => {
    expect(only(page('<figure data-eh="f"><img src="a.png"></figure>'))).toEqual(
      textBlock('f', 'figure', [], { src: 'a.png' }),
    );
    expect(only(page('<figure data-eh="f"><img></figure>'))).toEqual(textBlock('f', 'figure', [], {}));
    const t = only(
      page(['<table data-eh="t">', '  <thead><tr><th>A</th><th>B</th></tr></thead>', '  <tbody></tbody>', '</table>']),
    );
    expect(t).toEqual(
      textBlock('t', 'table', [], {}, { head: [[text('A')], [text('B')]], body: [], align: [null, null] }),
    );
  });
});
