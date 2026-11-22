/**
 * 集成测试：解析器（T1.2）× 序列化器（T1.3）往返与幂等（01 §6、§6.1，03 §10）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createDoc, docToComparable, textBlock, type Block, type Doc } from './model.js';
import { parse } from './parse/index.js';
import { serialize } from './serialize/index.js';
import { arbDoc } from './testing/arbitraries.js';

const FIXTURES = join(__dirname, '../../../tests/fixtures/ehtml');
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.ehtml'))
  .sort()
  .map((name) => ({ name, src: readFileSync(join(FIXTURES, name), 'utf8') }));

/**
 * README 中标为"规范形式"的样本：重新序列化应逐字节一致。
 * 15 除外：其中 u3 是没有 JSON 的未知组件，规范形式会补上 `{}`（待决，见 tests/fixtures/README.md）。
 */
const CANONICAL = new Set([
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
  '13',
  '14',
  '19',
  '22',
  '23',
  '27',
]);

const fmt = (src: string): string => serialize(parse(src).doc);

describe('parse ∘ serialize round-trip', () => {
  it('docEquals(parse(serialize(doc)), doc) for random docs, without warnings', () => {
    fc.assert(
      fc.property(arbDoc(), (doc) => {
        const html = serialize(doc);
        const { doc: back, warnings } = parse(html);
        expect(warnings).toEqual([]);
        expect(docToComparable(back)).toBe(docToComparable(doc));
      }),
      { numRuns: 500 },
    );
  }, 30_000); // 整套测试并行、机器负载高时 500 次往返会超过默认 5s

  it('serialize ∘ parse is idempotent on random tag soup', () => {
    const soup = fc
      .array(
        fc.oneof(
          fc.constantFrom(
            '<p>',
            '</p>',
            '<ul>',
            '<li>',
            '</li>',
            '<b>',
            '</i>',
            '<eh-tabs>',
            '<eh-slot>',
            '<div>',
            '<br>',
          ),
          fc.constantFrom('<table><tr><td>', '<pre><code>', '<!--eh:fallback-->', '<script type="application/json">{'),
          fc.constantFrom(
            '<head>',
            '</head>',
            '<style>',
            '<!--',
            '-->',
            '<eh-html>',
            '</eh-html>',
            '<main id="eh-doc">',
          ),
          fc.constantFrom(
            '<script>',
            '</script>',
            '<eh-chart data-eh="c1">',
            '<textarea>',
            '<a href="javascript:x">',
            '"',
          ),
          fc.constantFrom('文本', ' ', '&amp;', '&nbsp;', '<', '>', 'x'),
        ),
        { maxLength: 40 },
      )
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(soup, (src) => {
        const once = fmt(src);
        expect(fmt(once)).toBe(once);
      }),
      { numRuns: 2000 },
    );
  });
});

/** 给随机文档中的文本块加上任意附加属性（模拟导入器写入的 `md-id`、`syntax` 等）。 */
const EXTRA: Record<string, string>[] = [
  {},
  { 'md-id': 'goal-1' },
  { syntax: 'wikilink', width: '200' },
  { class: 'x y', 'data-x': '"q" & <a>' },
];
const withExtraAttrs = (doc: Doc, picks: readonly number[]): Doc => {
  let i = 0;
  const blocks: Block[] = [...doc.blocks.values()].map((b) => {
    if (b.kind !== 'text') return b;
    const extra = EXTRA[(picks[i++ % picks.length] ?? 0) % EXTRA.length] as Record<string, string>;
    return textBlock(b.id, b.type, b.content, { ...extra, ...b.attrs }, b.table);
  });
  return createDoc(blocks, { root: [...doc.root], meta: doc.meta, head: doc.head });
};

describe('extra attributes on every text block survive .ehtml save/reload', () => {
  it('docEquals(parse(serialize(doc)), doc) with random extra attrs', () => {
    fc.assert(
      fc.property(arbDoc(), fc.array(fc.nat(), { minLength: 1, maxLength: 40 }), (d, picks) => {
        const doc = withExtraAttrs(d, picks);
        const { doc: back, warnings } = parse(serialize(doc));
        expect(warnings).toEqual([]);
        expect(docToComparable(back)).toBe(docToComparable(doc));
      }),
      { numRuns: 300 },
    );
  });
});

describe('unclosed raw-text and comments do not swallow following content', () => {
  it.each([
    '<script type="application/json">{',
    '<head><style>p{',
    '<head><!-- open comment',
    '<body><script>let x = 1',
    '<eh-html data-eh="f1"><script>x',
    '<div><style>a{}',
  ])('%s', (src) => {
    const once = fmt(src);
    expect(fmt(once)).toBe(once);
  });
});

describe('fixtures', () => {
  it.each(fixtures)('$name: serialize ∘ parse is idempotent', ({ src }) => {
    const once = fmt(src);
    expect(fmt(once)).toBe(once);
  });

  it.each(fixtures.filter((f) => CANONICAL.has(f.name.slice(0, 2))))(
    '$name: canonical fixture re-serializes byte-identically',
    ({ src }) => {
      expect(fmt(src)).toBe(src);
    },
  );
});
