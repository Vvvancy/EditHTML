/**
 * EHMD 属性测试（fast-check）：
 * - 对任意（受约束的）`arbDoc()` 文档，`parseEhmd(serializeEhmd(doc, {ids:'all'}))` 与 `doc` 相等（忽略 fallback）；
 * - `serializeEhmd ∘ parseEhmd` 在生成的 EHMD 上幂等（各种 ids 模式）。
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createDoc,
  htmlBlock,
  normalizeInline,
  textBlock,
  validateDoc,
  type Block,
  type Doc,
  type InlineNode,
  type Mark,
} from '../model.js';
import { arbDoc } from '../testing/arbitraries.js';
import { ehmdComparable } from './compare.js';
import { parseEhmd } from './parse.js';
import { serializeEhmd } from './serialize.js';

/**
 * 把 arbDoc 约束到 EHMD 可表达的子集（见 01 §7"实现约定"中的已知有损项）：
 * - 非空代码块内容以 `\n` 结尾（围栏代码块的内容按行保存，最后一行总有换行，与 CommonMark 的 HTML 输出一致）；
 * - 表格表头不能全为空单元格（全空表头行表示"无表头"）。
 */
function ehmdRepresentable(doc: Doc): Doc {
  const blocks = new Map(doc.blocks);
  for (const [id, b] of doc.blocks) {
    if (b.kind !== 'text') continue;
    if (b.type === 'code') {
      const t = b.content.map((n) => (n.t === 'text' ? n.text : '')).join('');
      if (t !== '' && !t.endsWith('\n'))
        blocks.set(id, textBlock(id, 'code', [{ t: 'text', text: t + '\n', marks: [] }], b.attrs));
    }
    if (b.type === 'table' && b.table && b.table.head.length > 0 && b.table.head.every((c) => c.length === 0)) {
      const head = b.table.head.map((c, i) => (i === 0 ? [{ t: 'text' as const, text: 'h', marks: [] }] : c));
      blocks.set(id, textBlock(id, 'table', [], b.attrs, { ...b.table, head }));
    }
  }
  return { ...doc, blocks: blocks as Map<string, Block> };
}

const runs = Number(process.env.EHMD_RUNS ?? 300);

// ── 更"刁钻"的行内内容：全部 ASCII 标点、Markdown 语法片段、换行、首尾空白、任意原子与链接 ──

const hardChar = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...'aZ09 '.split('')) },
  { weight: 4, arbitrary: fc.constantFrom(...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split('')) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      '\n',
      '\t',
      '中',
      '。',
      '😀',
      ' ',
      '**',
      '==',
      '~~',
      '[[',
      ']]',
      '](',
      '^b1',
      '{#x}',
      '#tag',
      '$x$',
      '&amp;',
      '&#35;',
      'http://a.b',
      'www.x.y',
      'a@b.co',
      '<b>',
      '<!--',
      '1. ',
      '- ',
      '> ',
      '```',
      ':::',
      '---',
    ),
  },
);
const hardText = fc.array(hardChar, { minLength: 1, maxLength: 8 }).map((cs) => cs.join(''));
const hardMarks: fc.Arbitrary<Mark[]> = fc
  .tuple(
    fc.subarray(['strong', 'em', 's', 'mark', 'sub', 'sup', 'kbd', 'code'] as const, { maxLength: 3 }),
    fc.option(
      fc.record({ href: fc.oneof(hardText, fc.constant('')), title: fc.option(hardText, { nil: undefined }) }),
      { nil: undefined },
    ),
  )
  .map(([types, link]): Mark[] => [
    ...types.map((type) => ({ type })),
    ...(link
      ? [
          {
            type: 'link' as const,
            attrs: (link.title === undefined ? { href: link.href } : { href: link.href, title: link.title }) as Record<
              string,
              string
            >,
          },
        ]
      : []),
  ]);
const hardNode: fc.Arbitrary<InlineNode> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant('text' as const), text: hardText, marks: hardMarks }) },
  { weight: 1, arbitrary: hardMarks.map((marks) => ({ t: 'br' as const, marks })) },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('atom' as const),
      kind: fc.constantFrom('math', 'wikilink', 'tag', 'color'),
      attrs: fc.oneof({ weight: 4, arbitrary: fc.constant({}) }, { weight: 1, arbitrary: fc.constant({ v: 'a"b' }) }),
      text: fc.oneof(hardText, fc.constantFrom('[[a|b]]', '#t/x', 'x^2', '[[#^b1]]', '')),
      marks: hardMarks,
    }),
  },
);
const hardInline = fc.array(hardNode, { maxLength: 6 }).map((ns) => normalizeInline(ns));

const hardDoc: fc.Arbitrary<Doc> = fc
  .array(
    fc.oneof(
      hardInline.map((c) => (id: string) => textBlock(id, 'p', c)),
      fc.tuple(fc.constantFrom('h2', 'quote', 'li') as fc.Arbitrary<'h2' | 'quote' | 'li'>, hardInline).map(
        ([t, c]) =>
          (id: string) =>
            textBlock(id, t, c, t === 'li' ? { list: 'ul', indent: '0', task: 'todo' } : {}),
      ),
      fc.tuple(hardInline, hardInline).map(
        ([a, b]) =>
          (id: string) =>
            textBlock(
              id,
              'table',
              [],
              {},
              {
                head: [[{ t: 'text', text: 'h', marks: [] }], a],
                body: [[b, a]],
                align: [null, 'right'],
              },
            ),
      ),
      fc.tuple(hardInline, hardText, hardText).map(
        ([cap, src, alt]) =>
          (id: string) =>
            textBlock(id, 'figure', cap, { src, alt }),
      ),
      fc.tuple(hardText, hardText).map(
        ([code, lang]) =>
          (id: string) =>
            textBlock(id, 'code', [{ t: 'text', text: code + '\n', marks: [] }], { lang }),
      ),
      fc
        .constantFrom('<div>\n\n:::x\n</div>', '<p>raw</p>', 'text <b>', '<!-- c -->', '')
        .map((h) => (id: string) => htmlBlock(id, h)),
    ),
    { maxLength: 6 },
  )
  .map((specs) => createDoc(specs.map((s, i) => s(`b${(i + 1).toString(36)}`))));

describe('EHMD round trip', () => {
  it('parseEhmd(serializeEhmd(doc, {ids:"all"})) equals doc (ignoring fallback)', () => {
    fc.assert(
      fc.property(arbDoc().map(ehmdRepresentable), (doc) => {
        const src = serializeEhmd(doc, { ids: 'all' });
        const { doc: back } = parseEhmd(src);
        expect(validateDoc(back)).toEqual([]);
        expect(ehmdComparable(back), src).toBe(ehmdComparable(doc));
      }),
      { numRuns: runs },
    );
  }, 600_000);

  it('round-trips adversarial inline content (escaping, atoms, links, HTML blocks)', () => {
    fc.assert(
      fc.property(hardDoc, (doc) => {
        const src = serializeEhmd(doc, { ids: 'all' });
        const { doc: back } = parseEhmd(src);
        expect(validateDoc(back)).toEqual([]);
        expect(ehmdComparable(back), src).toBe(ehmdComparable(doc));
      }),
      { numRuns: runs },
    );
  }, 600_000);

  it('serializeEhmd ∘ parseEhmd is idempotent on generated EHMD (all id modes)', () => {
    fc.assert(
      fc.property(
        arbDoc(),
        fc.constantFrom('all', 'referenced', 'none') as fc.Arbitrary<'all' | 'referenced' | 'none'>,
        (doc, ids) => {
          const once = serializeEhmd(parseEhmd(serializeEhmd(doc, { ids })).doc, { ids });
          const twice = serializeEhmd(parseEhmd(once).doc, { ids });
          expect(twice).toBe(once);
        },
      ),
      { numRuns: runs },
    );
  }, 600_000);

  it('serializeEhmd ∘ parseEhmd is idempotent on adversarial docs', () => {
    fc.assert(
      fc.property(
        hardDoc,
        fc.constantFrom('all', 'referenced', 'none') as fc.Arbitrary<'all' | 'referenced' | 'none'>,
        (doc, ids) => {
          const once = serializeEhmd(parseEhmd(serializeEhmd(doc, { ids })).doc, { ids });
          expect(serializeEhmd(parseEhmd(once).doc, { ids })).toBe(once);
        },
      ),
      { numRuns: runs },
    );
  }, 600_000);

  it('parses arbitrary Markdown-ish text without throwing; serialize ∘ parse is idempotent', () => {
    const line = fc.oneof(
      hardText,
      fc.constantFrom(
        '',
        '',
        '# H',
        '## H {#h1}',
        'para ^p1',
        '^t1',
        '- a',
        '  - b',
        '1. c',
        '- [ ] t',
        '- [x] d ^l1',
        '> q',
        '> > nested',
        '```ts {#c1}',
        '```',
        '~~~',
        '    indented',
        '| a | b |',
        '| --- | :-: |',
        '| 1 | 2 |',
        '---',
        '***',
        'Setext',
        '===',
        ':::callout 提示 {#c1 kind=info}',
        ':::toggle T {open=false}',
        '::::tabs {#t1}',
        ':::tab A',
        ':::',
        '::::',
        ':::chart {#ch}',
        'type: bar',
        'data: [1, 2',
        ':::props',
        ':::slot',
        ':::html',
        '<div>',
        '</div>',
        '<!-- c -->',
        '$$',
        'x^2',
        '[^1]: note',
        '[ref]: https://x.y "t"',
        'see [ref] and [[w|a]] #tag $m$ ==hi== ~~s~~',
        '![img](a.png "cap") ^f1',
        '::embed{url=x}',
      ),
    );
    const src = fc.array(line, { maxLength: 25 }).map((ls) => ls.join('\n'));
    fc.assert(
      fc.property(
        src,
        fc.constantFrom('all', 'referenced', 'none') as fc.Arbitrary<'all' | 'referenced' | 'none'>,
        (s, ids) => {
          const { doc } = parseEhmd(s);
          expect(validateDoc(doc)).toEqual([]);
          const once = serializeEhmd(doc, { ids });
          const twice = serializeEhmd(parseEhmd(once).doc, { ids });
          expect(twice, JSON.stringify(s)).toBe(once);
        },
      ),
      { numRuns: runs },
    );
  }, 600_000);
});
