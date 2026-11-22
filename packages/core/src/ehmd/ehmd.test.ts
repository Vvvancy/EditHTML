/** EHMD 逐构造的黄金测试（serialize 输出逐字比较 + parse 结果检查）与扩展点测试。 */
import { describe, expect, it } from 'vitest';
import {
  componentBlock,
  createDoc,
  getBlock,
  htmlBlock,
  text,
  textBlock,
  type Block,
  type ComponentBlock,
  type Doc,
  type DocMeta,
  type InlineNode,
  type TextBlock,
} from '../model.js';
import { ehmdComparable } from './compare.js';
import type { DirectiveSpec } from './directives.js';
import { parseEhmd } from './parse.js';
import { serializeEhmd } from './serialize.js';
import type { EhmdExtension } from './types.js';

const doc = (blocks: Block[], meta: DocMeta = {}, root?: string[]): Doc =>
  createDoc(blocks, { meta, ...(root ? { root } : {}) });
const all = (d: Doc): string => serializeEhmd(d, { ids: 'all' });
const p = (id: string, content: InlineNode[] | string): TextBlock =>
  textBlock(id, 'p', typeof content === 'string' ? [text(content)] : content);

/** 序列化结果逐字相等，且读回后与原文档相等。 */
function golden(d: Doc, expected: string): void {
  const out = all(d);
  expect(out).toBe(expected);
  expect(ehmdComparable(parseEhmd(out).doc)).toBe(ehmdComparable(d));
}

const first = (src: string): Block => {
  const { doc: d } = parseEhmd(src);
  return getBlock(d, d.root[0] as string);
};

describe('frontmatter ↔ meta', () => {
  it('writes meta keys in #eh-meta order and reads YAML core types (no dates)', () => {
    golden(
      doc([p('b1', 'x')], { tags: ['a', 'b c'], extra: { n: 1 }, title: '标题', created: '2026-11-22' }),
      '---\ntitle: 标题\ncreated: 2026-11-22\ntags: [a, b c]\nextra:\n  n: 1\n---\n\nx ^b1\n',
    );
    expect(parseEhmd('---\ncreated: 2026-11-22\nn: 1\nok: true\n---\n').doc.meta).toEqual({
      created: '2026-11-22',
      n: 1,
      ok: true,
    });
  });
  it('empty meta → no frontmatter; empty doc → empty string', () => {
    expect(all(doc([]))).toBe('');
    expect(parseEhmd('').doc.root).toEqual([]);
    expect(parseEhmd('---\n---\n').doc.meta).toEqual({});
  });
  it('invalid frontmatter is kept as a yaml code block with a warning', () => {
    const r = parseEhmd('---\n[unclosed\n---\n\npara\n');
    expect(r.warnings.map((w) => w.code)).toContain('invalid-frontmatter');
    expect(r.doc.meta).toEqual({});
    const b = getBlock(r.doc, r.doc.root[0] as string) as TextBlock;
    expect([b.type, b.attrs.lang, b.content[0]?.t === 'text' && b.content[0].text]).toEqual([
      'code',
      'yaml',
      '[unclosed\n',
    ]);
  });
  it('a leading hr without frontmatter is written as *** so it is not read as frontmatter', () => {
    golden(doc([textBlock('r', 'hr'), p('b', 'x'), textBlock('s', 'hr')]), '***\n\n^r\n\nx ^b\n\n---\n\n^s\n');
  });
});

describe('text blocks', () => {
  it('paragraphs and headings carry ids as ` ^id` / ` {#id}`', () => {
    golden(
      doc([
        textBlock('h', 'h1', [text('Title')]),
        p('a', 'para'),
        textBlock('h6x', 'h6', [text('six')]),
        textBlock('e', 'h2'),
      ]),
      '# Title {#h}\n\npara ^a\n\n###### six {#h6x}\n\n## {#e}\n',
    );
    expect((first('Text {#x} ^real') as TextBlock).id).toBe('real');
    expect((first('# T ^cid') as TextBlock).id).toBe('cid');
  });
  it('ids: referenced (default) keeps only referenced ids; none drops all ids', () => {
    const d = doc([p('a', 'target'), p('b', [text('see', [{ type: 'link', attrs: { href: '#a' } }])])]);
    expect(serializeEhmd(d)).toBe('target ^a\n\n[see](#a)\n');
    expect(serializeEhmd(d, { ids: 'none' })).toBe('target\n\n[see](#a)\n');
    expect(serializeEhmd(d, { keepIds: ['b'] })).toBe('target ^a\n\n[see](#a) ^b\n');
  });
  it('empty paragraphs are written as a lone `^id` (dropped with ids:none)', () => {
    const d = doc([p('a', 'z'), textBlock('t', 'hr'), textBlock('e', 'p'), p('x', 'y')]);
    golden(d, 'z ^a\n\n---\n\n^t\n\n^e\n\ny ^x\n');
    expect(serializeEhmd(d)).toBe('z\n\n---\n\n^t\n\n^e\n\ny\n');
    expect(serializeEhmd(d, { ids: 'none' })).toBe('z\n\n---\n\ny\n');
  });
  it('flat li blocks: list type, indent, task, numbering, empty task items', () => {
    const li = (id: string, list: string, indent: string, c: string, task?: string): TextBlock =>
      textBlock(id, 'li', c ? [text(c)] : [], { list, indent, ...(task ? { task } : {}) });
    golden(
      doc([
        li('a', 'ul', '0', 'one'),
        li('b', 'ol', '1', 'sub'),
        li('c', 'ol', '1', 'sub2', 'done'),
        li('d', 'ul', '2', '', 'todo'),
        li('e', 'ul', '0', 'two'),
        li('f', 'ol', '0', 'n'),
      ]),
      '- one ^a\n  1. sub ^b\n  2. [x] sub2 ^c\n     - [ ] ^d\n- two ^e\n1. n ^f\n',
    );
    expect(serializeEhmd(doc([li('t', 'ul', '0', '', 'todo')]), { ids: 'none' })).toBe('- [ ] <!---->\n');
    expect(ehmdComparable(parseEhmd('- [ ] <!---->\n', {}).doc)).toBe(
      ehmdComparable(doc([li('b1', 'ul', '0', '', 'todo')])),
    );
  });
  it('quote: one paragraph, hard breaks continue with `> `, id on the next block line', () => {
    golden(doc([textBlock('q', 'quote', [text('a'), { t: 'br', marks: [] }, text('b')])]), '> a\\\n> b\n\n^q\n');
  });
  it('multi-paragraph and nested quotes are flattened into quote blocks (warning)', () => {
    const r = parseEhmd('> a\n>\n> > b\n');
    expect(r.doc.root.map((id) => (getBlock(r.doc, id) as TextBlock).type)).toEqual(['quote', 'quote']);
    expect(r.warnings.map((w) => w.code)).toContain('flattened-quote');
  });
  it('code: lang + {#id} in the info string; content keeps its final newline; longer fences when needed', () => {
    golden(doc([textBlock('c', 'code', [text('let a = 1;\n')], { lang: 'ts' })]), '```ts {#c}\nlet a = 1;\n```\n');
    golden(doc([textBlock('c', 'code', [text('```\nx\n')])]), '````{#c}\n```\nx\n````\n');
    golden(doc([textBlock('c', 'code', [])]), '```{#c}\n```\n');
    golden(doc([textBlock('c', 'code', [text('\n')], { lang: 'a b{' })]), '```{#c lang="a b{"}\n\n```\n');
    // 已知有损：没有结尾换行的内容读回时补上 '\n'
    expect((first(all(doc([textBlock('c', 'code', [text('x')])]))) as TextBlock).content).toEqual([text('x\n')]);
  });
  it('table: GFM with alignment, escaped pipes, id on the next block line; all-empty header = no header', () => {
    const t = {
      head: [[text('A')], [text('B|C')]],
      body: [[[text('1')], [text('x', [{ type: 'code' }])]]],
      align: [null, 'center'] as const,
    };
    golden(
      doc([textBlock('t', 'table', [], {}, { ...t, align: [...t.align] })]),
      '| A | B\\|C |\n| --- | :---: |\n| 1 | `x` |\n\n^t\n',
    );
    golden(
      doc([textBlock('t', 'table', [], {}, { head: [], body: [[[text('only')]]], align: [null] })]),
      '|  |\n| --- |\n| only |\n\n^t\n',
    );
  });
  it('figure: image paragraph; plain caption as title, rich caption after the image', () => {
    golden(
      doc([textBlock('f', 'figure', [text('A "cap"')], { src: 'a b.png', alt: 'alt' })]),
      '![alt](<a b.png> "A \\"cap\\"") ^f\n',
    );
    golden(
      doc([textBlock('f', 'figure', [text('rich', [{ type: 'em' }])], { src: 'x.png', alt: '' })]),
      '![](x.png) *rich* ^f\n',
    );
    golden(doc([textBlock('f', 'figure', [], { src: 'x.png', alt: 'a' })]), '![a](x.png) ^f\n');
  });
  it('paragraphs with images are split into figures (warning)', () => {
    const r = parseEhmd('before ![a](x.png) after');
    expect(r.doc.root.map((id) => (getBlock(r.doc, id) as TextBlock).type)).toEqual(['p', 'figure']);
    expect(r.warnings.map((w) => w.code)).toContain('split-paragraph');
  });
});

describe('inline content', () => {
  const inl = (nodes: InlineNode[]): string => all(doc([textBlock('p', 'p', nodes)])).replace(/ \^p\n$/, '');
  it('marks use Markdown syntax when safe', () => {
    expect(
      inl([
        text('b', [{ type: 'strong' }]),
        text(' '),
        text('i', [{ type: 'em' }]),
        text(' '),
        text('s', [{ type: 's' }]),
        text(' '),
        text('m', [{ type: 'mark' }]),
        text(' '),
        text('c', [{ type: 'code' }]),
      ]),
    ).toBe('**b** *i* ~~s~~ ==m== `c`');
    expect(inl([text('t', [{ type: 'link', attrs: { href: 'https://x.y/a b', title: 'T' } }])])).toBe(
      '[t](<https://x.y/a b> "T")',
    );
    expect(inl([text('https://x.y', [{ type: 'link', attrs: { href: 'https://x.y' } }])])).toBe('<https://x.y>');
  });
  it('sub/sup/kbd are inline HTML; unsafe flanking falls back to HTML tags', () => {
    expect(
      inl([
        text('H'),
        text('2', [{ type: 'sub' }]),
        text('O '),
        text('K', [{ type: 'kbd' }]),
        text('x'),
        text('2', [{ type: 'sup' }]),
      ]),
    ).toBe('H<sub>2</sub>O <kbd>K</kbd>x<sup>2</sup>');
    expect(inl([text(' a ', [{ type: 'strong' }])])).toBe('<strong>&#x20;a&#x20;</strong>');
    expect(inl([text('a', [{ type: 'strong' }]), text('b', [{ type: 'strong' }, { type: 'em' }])])).toBe(
      '<strong>a*b*</strong>',
    );
  });
  it('escapes Markdown-significant characters conservatively', () => {
    expect(inl([text('1. *a* [b] `c` $d ~e <f> a_b _g x^y ^z #tag C# www.x a@b http://q')])).toBe(
      '1\\. \\*a\\* \\[b\\] \\`c\\` \\$d \\~e \\<f> a_b \\_g x^y \\^z \\#tag C# www\\.x a\\@b http\\://q',
    );
    expect(inl([text(' lead\nsoft  ')])).toBe('&#x20;lead\nsoft &#x20;');
  });
  it('br: backslash hard break; `<br>` at the end or in single-line contexts', () => {
    expect(inl([text('a'), { t: 'br', marks: [] }, text('b'), { t: 'br', marks: [] }])).toBe('a\\\nb<br>');
    golden(doc([textBlock('h', 'h2', [text('a'), { t: 'br', marks: [] }, text('b')])]), '## a<br>b {#h}\n');
  });
  it('atoms: $math$, [[wikilink]], #tag; otherwise span[data-eh-inline]', () => {
    const atom = (kind: string, t: string, attrs: Record<string, string> = {}): InlineNode => ({
      t: 'atom',
      kind,
      attrs,
      text: t,
      marks: [],
    });
    expect(
      inl([atom('math', 'e^{i\\pi}'), text(' '), atom('wikilink', '[[a|b]]'), text(' '), atom('tag', '#t/x')]),
    ).toBe('$e^{i\\pi}$ [[a|b]] #t/x');
    expect(
      inl([atom('math', 'a$b'), text(' '), atom('tag', 'no-hash'), text(' '), atom('color', 'red', { c: '#f00' })]),
    ).toBe(
      '<span data-eh-inline="math">a\\$b</span> <span data-eh-inline="tag">no-hash</span> <span data-eh-inline="color" data-eh-c="#f00">red</span>',
    );
    for (const s of ['$e^{i\\pi}$ [[a|b]] #t/x', '<span data-eh-inline="color" data-eh-c="#f00">red</span>'])
      expect(ehmdComparable(parseEhmd(all(parseEhmd(s).doc)).doc)).toBe(ehmdComparable(parseEhmd(s).doc));
  });
  it('parses inline HTML marks and drops script links', () => {
    const b = first('<b>x</b> <del>d</del> <u>u</u> [j](javascript:alert(1))') as TextBlock;
    expect(b.content).toEqual([text('x', [{ type: 'strong' }]), text(' '), text('d', [{ type: 's' }]), text(' u j')]);
  });
});

describe('components and HTML blocks', () => {
  it('leaf components: `:::type {#id}` + YAML body (props {} ↔ empty body)', () => {
    golden(
      doc([
        componentBlock('ch', 'chart', { type: 'bar', data: { x: ['A', 'B'], y: [3, 5] } }, { fallback: '<svg/>' }),
        componentBlock('e', 'embed', {}),
      ]),
      ':::chart {#ch}\ntype: bar\ndata:\n  x: [A, B]\n  y: [3, 5]\n:::\n\n:::embed {#e}\n:::\n',
    );
    golden(
      doc([componentBlock('m', 'mermaid', { source: 'graph TD\n  A-->B' })]),
      ':::mermaid {#m}\nsource: |-\n  graph TD\n    A-->B\n:::\n',
    );
    golden(
      doc([componentBlock('u', 'foo', { bar: 1 }, { attrs: { 'data-eh-variant': 'compact' } })]),
      ':::foo {#u data-eh-variant=compact}\nbar: 1\n:::\n',
    );
  });
  it('fallback is not stored in EHMD', () => {
    const c = getBlock(
      parseEhmd(all(doc([componentBlock('m', 'math', { tex: 'x' }, { fallback: '<b>x</b>' })]))).doc,
      'm',
    ) as ComponentBlock;
    expect(c.fallback).toBeUndefined();
  });
  it('containers: callout / toggle / tabs / columns with label + attrs; nested colons grow outward', () => {
    golden(
      doc(
        [
          componentBlock('c', 'callout', { kind: 'info', title: '提示' }, { slots: [['c1']] }),
          p('c1', 'inside'),
          componentBlock('g', 'toggle', { title: 'T', open: false }, { slots: [[]] }),
          componentBlock('t', 'tabs', { tabs: [{ title: 'A' }, { title: '' }] }, { slots: [['k'], []] }),
          componentBlock('k', 'columns', { ratio: [1, 2] }, { slots: [['k1'], []] }),
          p('k1', 'col'),
        ],
        {},
        ['c', 'g', 't'],
      ),
      ':::callout 提示 {#c kind=info}\ninside ^c1\n:::\n\n:::toggle T {#g open=false}\n:::\n\n' +
        '::::::tabs {#t}\n:::::tab A\n::::columns {#k ratio=1,2}\n:::column\ncol ^k1\n:::\n:::column\n:::\n::::\n:::::\n:::tab\n:::\n::::::\n',
    );
  });
  it('unusual props fall back to the generic `:::props` + `:::slot` form', () => {
    golden(
      doc(
        [
          componentBlock('c', 'callout', { kind: 'info', title: 'x', extra: true }, { slots: [['a'], ['b']] }),
          p('a', '1'),
          p('b', '2'),
        ],
        {},
        ['c'],
      ),
      '::::callout {#c}\n:::props\nkind: info\ntitle: x\nextra: true\n:::\n:::slot\n1 ^a\n:::\n:::slot\n2 ^b\n:::\n::::\n',
    );
    golden(
      doc([componentBlock('k', 'kanban', { cols: [] }, { slots: [['a']] }), p('a', '1')], {}, ['k']),
      '::::kanban {#k}\n:::props\ncols: []\n:::\n:::slot\n1 ^a\n:::\n::::\n',
    );
  });
  it('parses the fixture container conventions (label, title attr wins, `[label]` form)', () => {
    const c = first(':::callout[Hi]{#c1 kind=warn}\nx\n:::') as ComponentBlock;
    expect([c.id, c.props]).toEqual(['c1', { kind: 'warn', title: 'Hi' }]);
    const r = parseEhmd(':::callout L {title="T"}\n:::');
    expect((getBlock(r.doc, r.doc.root[0] as string) as ComponentBlock).props).toEqual({ title: 'T' });
    expect(r.warnings.map((w) => w.code)).toContain('ignored-directive-part');
  });
  it('invalid YAML keeps the whole directive as an `ehmd` code block', () => {
    const r = parseEhmd(':::chart {#x}\ndata: [1, 2\n:::\n');
    const b = getBlock(r.doc, r.doc.root[0] as string) as TextBlock;
    expect([b.type, b.attrs.lang]).toEqual(['code', 'ehmd']);
    expect(r.warnings.map((w) => w.code)).toEqual(['invalid-yaml']);
  });
  it('directive syntax inside fenced code stays code; unclosed directives extend to the end', () => {
    expect((first('```\n:::chart\n:::\n```') as TextBlock).type).toBe('code');
    const r = parseEhmd(':::callout\nopen');
    expect(r.warnings.map((w) => w.code)).toContain('unclosed-directive');
  });
  it('HTML blocks: raw HTML (+ `^id` line) when it reads back as one HTML block, else `:::html`', () => {
    golden(
      doc([htmlBlock('h', '<div class="x">自定义 <b>HTML</b></div>')]),
      '<div class="x">自定义 <b>HTML</b></div>\n\n^h\n',
    );
    golden(doc([htmlBlock('h', '<div>\n\npara</div>')]), ':::html {#h}\n<div>\n\npara</div>\n:::\n');
    golden(doc([htmlBlock('h', '<p>native</p>')]), ':::html {#h}\n<p>native</p>\n:::\n');
  });
  it('raw HTML in Markdown goes through the HTML parser (native blocks, sanitized)', () => {
    const b = first('<p data-eh="k1" onclick="x()">hi</p>') as TextBlock;
    expect([b.id, b.type, b.content]).toEqual(['k1', 'p', [text('hi')]]);
  });
  it('`$$` display math becomes a math component and accepts a trailing `^id`', () => {
    const c = first('$$\nx^2\n$$\n\n^m1') as ComponentBlock;
    expect([c.id, c.type, c.props]).toEqual(['m1', 'math', { tex: 'x^2' }]);
  });
  it('duplicate and invalid ids are reassigned with warnings', () => {
    const r = parseEhmd('a ^x\n\nb ^x\n\nc ^Bad-Id\n');
    expect(r.doc.root).toEqual(['x', 'b1', 'b2']);
    expect(r.warnings.map((w) => w.code)).toEqual(['duplicate-id', 'invalid-id']);
  });
});

describe('extension points (for T1.7)', () => {
  it('blockHandlers can take over an mdast node type and fall back with next()', () => {
    const obsidianCallout: EhmdExtension = {
      blockHandlers: {
        blockquote(node, ctx) {
          if (node.type !== 'blockquote') return undefined;
          const para = node.children[0];
          if (para?.type !== 'paragraph' || para.children[0]?.type !== 'text') return undefined;
          const m = /^\[!(\w+)\][ \t]*([^\n]*)\n?/.exec(para.children[0].value);
          if (!m) return undefined;
          const rest = {
            ...para,
            children: [
              { ...para.children[0], value: para.children[0].value.slice(m[0].length) },
              ...para.children.slice(1),
            ],
          };
          const body = ctx.blocks([rest, ...node.children.slice(1)]);
          return [
            {
              k: 'component',
              type: 'callout',
              props: { kind: m[1], title: m[2] },
              attrs: {},
              slots: [body],
              offset: ctx.offset(node),
            },
          ];
        },
      },
    };
    const { doc: d } = parseEhmd('> [!note] 标题\n> 内容\n', { extensions: [obsidianCallout] });
    const c = getBlock(d, d.root[0] as string) as ComponentBlock;
    expect([c.type, c.props]).toEqual(['callout', { kind: 'note', title: '标题' }]);
    expect((getBlock(d, c.slots?.[0]?.[0] as string) as TextBlock).content).toEqual([text('内容')]);
    // 不匹配时回落到内置处理
    expect((first('> plain') as TextBlock).type).toBe('quote');
    expect((getBlock(parseEhmd('> plain', { extensions: [obsidianCallout] }).doc, 'b1') as TextBlock).type).toBe(
      'quote',
    );
  });
  it('directives can register a container spec; serializeBlock can override output', () => {
    const note: DirectiveSpec = {
      type: 'note',
      encode: (props, attrs, n) => (n === 1 && JSON.stringify(props) === '{}' ? { attrs: { ...attrs } } : null),
      decode: (head) => ({ props: {}, attrs: { ...head.attrs } }),
    };
    const ext: EhmdExtension = { directives: [note] };
    const d = doc([componentBlock('n', 'note', {}, { slots: [['a']] }), p('a', 'x')], {}, ['n']);
    const out = serializeEhmd(d, { ids: 'all', extensions: [ext] });
    expect(out).toBe(':::note {#n}\nx ^a\n:::\n');
    expect(ehmdComparable(parseEhmd(out, { extensions: [ext] }).doc)).toBe(ehmdComparable(d));
    const mermaidFence: EhmdExtension = {
      serializeBlock: (b) =>
        b.kind === 'component' && b.type === 'mermaid'
          ? '```mermaid\n' + String((b.props as { source: string }).source) + '\n```'
          : undefined,
    };
    expect(
      serializeEhmd(doc([componentBlock('m', 'mermaid', { source: 'graph TD' })]), { extensions: [mermaidFence] }),
    ).toBe('```mermaid\ngraph TD\n```\n');
  });
});
