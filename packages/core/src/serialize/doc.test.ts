import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  componentBlock,
  createDoc,
  emptyDoc,
  text,
  textBlock,
  walkBlocks,
  type Block,
  type BlockId,
  type Doc,
  type InlineNode,
} from '../model.js';
import { arbDoc } from '../testing/arbitraries.js';
import { segmentBlocks, serializeSegment, TOP_LEVEL_DEPTH } from './block.js';
import { serialize, serializeSkeleton } from './doc.js';

const lines = (...ls: string[]): string => ls.map((l) => `${l}\n`).join('');

const HEAD_START = (lang = 'zh-CN', title = '', meta = '{}'): string[] => [
  '<!doctype html>',
  `<html lang="${lang}" data-eh-version="0.1">`,
  '  <head>',
  '    <meta charset="utf-8">',
  '    <meta name="viewport" content="width=device-width, initial-scale=1">',
  `    <title>${title}</title>`,
  `    <script type="application/json" id="eh-meta">${meta}</script>`,
];
const HEAD_END = ['  </head>', '  <body>', '    <main id="eh-doc">'];
const TAIL = ['    </main>', '  </body>', '</html>'];

describe('serialize: skeleton', () => {
  it('empty doc', () => {
    expect(serialize(emptyDoc())).toBe(lines(...HEAD_START(), ...HEAD_END, ...TAIL));
  });

  it('title falls back to meta.title; meta key order', () => {
    const doc = createDoc([textBlock('b1', 'h1', [text('标题')])], {
      meta: { tags: ['学习'], title: 'A & B', extra: 1, created: '2026-11-21' },
    });
    expect(serialize(doc)).toBe(
      lines(
        ...HEAD_START('zh-CN', 'A &amp; B', '{"title":"A & B","created":"2026-11-21","tags":["学习"],"extra":1}'),
        ...HEAD_END,
        '      <h1 data-eh="b1">标题</h1>',
        ...TAIL,
      ),
    );
  });

  it('all optional head lines, in order', () => {
    const doc = createDoc([], {
      meta: { title: 'M', theme: 'default' },
      head: {
        lang: 'en"',
        title: 'T</title>',
        themeCss: ':root { --a: 1; }\n  p > a {}',
        userCss: '',
        extra: '<link rel="icon" href="x.png">',
        runtimeSrc: 'https://x/eh-runtime.js?a=1&b=2',
      },
    });
    expect(serialize(doc)).toBe(
      lines(
        ...HEAD_START('en&quot;', 'T&lt;/title&gt;', '{"title":"M","theme":"default"}'),
        '    <style id="eh-theme">:root { --a: 1; }\n  p > a {}</style>',
        '    <style id="eh-user-style"></style>',
        '    <link rel="icon" href="x.png">',
        '    <script id="eh-runtime" src="https://x/eh-runtime.js?a=1&amp;b=2" defer></script>',
        ...HEAD_END,
        ...TAIL,
      ),
    );
  });

  it('omits empty head.extra', () => {
    expect(serialize(createDoc([], { head: { extra: '' } }))).toBe(serialize(emptyDoc()));
  });

  it('escapes </script> and <!-- in meta JSON', () => {
    const out = serialize(createDoc([], { meta: { title: 'x', note: '</script><!--' } }));
    expect(out).toContain(
      '<script type="application/json" id="eh-meta">{"title":"x","note":"<\\/script>\\u003c!--"}</script>',
    );
  });

  it('nbsp and emoji left literal in title and body', () => {
    const doc = createDoc([textBlock('b1', 'p', [text('a b 😀')])], { meta: { title: '😀 ' } });
    const out = serialize(doc);
    expect(out).toContain('<title>😀 </title>');
    expect(out).toContain('<p data-eh="b1">a b 😀</p>');
  });
});

// ───────────────────────────── 属性测试辅助 ─────────────────────────────

const VOID = new Set([
  'meta',
  'br',
  'hr',
  'img',
  'link',
  'input',
  'area',
  'base',
  'col',
  'embed',
  'source',
  'track',
  'wbr',
]);
const RAW = new Set(['script', 'style']);
const TAG =
  /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>/=]+(?:="[^"<>]*")?)*)\s*>|<\/([a-zA-Z][a-zA-Z0-9-]*)>|<!--[\s\S]*?-->|<!doctype html>/y;

/** 检查每个打开的标签都被正确关闭（void 元素除外），属性值不含原始 `< > "`，文本中无未转义的 `<`/`>`。 */
function checkWellFormed(html: string): void {
  const stack: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    const textEnd = lt === -1 ? html.length : lt;
    const between = html.slice(i, textEnd);
    if (between.includes('>')) throw new Error(`raw '>' in text at ${i}: ${JSON.stringify(between)}`);
    if (lt === -1) break;
    TAG.lastIndex = lt;
    const m = TAG.exec(html);
    if (!m) throw new Error(`malformed tag at ${lt}: ${JSON.stringify(html.slice(lt, lt + 40))}`);
    i = TAG.lastIndex;
    const [, open, , close] = m;
    if (open) {
      const name = open.toLowerCase();
      if (RAW.has(name)) {
        const end = html.toLowerCase().indexOf(`</${name}`, i);
        if (end === -1) throw new Error(`unclosed <${name}>`);
        if (html.startsWith(`</${name}>`, end) === false) throw new Error(`bad </${name}`);
        i = end + name.length + 3;
      } else if (!VOID.has(name)) stack.push(name);
    } else if (close) {
      const top = stack.pop();
      if (top !== close.toLowerCase()) throw new Error(`</${close}> closes <${top ?? '(none)'}> at ${lt}`);
    }
  }
  if (stack.length) throw new Error(`unclosed: ${stack.join(',')}`);
}

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const a = [...xs];
  let s = seed >>> 0 || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

describe('serialize: properties', () => {
  it('is deterministic and independent of blocks Map insertion order', () => {
    fc.assert(
      fc.property(arbDoc(), fc.integer(), (doc, seed) => {
        const out = serialize(doc);
        expect(serialize(doc)).toBe(out);
        const reordered: Doc = { ...doc, blocks: new Map(shuffled([...doc.blocks.entries()], seed)) };
        expect(serialize(reordered)).toBe(out);
      }),
    );
  });

  it('produces well-formed output', () => {
    fc.assert(
      fc.property(arbDoc(), (doc) => {
        checkWellFormed(serialize(doc));
      }),
    );
  });

  it('writes every block id exactly once as data-eh', () => {
    fc.assert(
      fc.property(arbDoc(), (doc) => {
        const ids = [...serialize(doc).matchAll(/ data-eh="([^"]*)"/g)].map((m) => m[1] as BlockId);
        const expected = [...walkBlocks(doc)].map(([b]) => b.id);
        expect(ids).toEqual(expected); // 文档顺序，且每个恰好一次
        expect(new Set(ids).size).toBe(doc.blocks.size);
      }),
    );
  });

  it('equals skeleton + concatenated per-segment pieces', () => {
    fc.assert(
      fc.property(arbDoc(), (doc) => {
        const { before, after } = serializeSkeleton(doc);
        const pieces = segmentBlocks(doc, doc.root).map((s) => serializeSegment(doc, s, TOP_LEVEL_DEPTH));
        expect(serialize(doc)).toBe(before + pieces.join('') + after);
        for (const p of pieces) expect(p).toMatch(/^ {6}<[^\n]*\n(?:[\s\S]*\n)?$/);
      }),
    );
  });

  it('ends with </html>\\n', () => {
    fc.assert(
      fc.property(arbDoc(), (doc) => {
        expect(serialize(doc).endsWith('</html>\n')).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});

// ───────────────────────────── 性能 ─────────────────────────────

function bigDoc(n: number): Doc {
  const blocks: Block[] = [];
  const inline = (i: number): InlineNode[] => [
    text(`第 ${i} 段，包含 `),
    text('粗体', [{ type: 'strong' }]),
    text(' 与 '),
    text('链接 & 代码', [{ type: 'link', attrs: { href: `./n.ehtml#b${i}` } }, { type: 'code' }]),
    text(' 以及一些 <普通> 文本。'),
  ];
  for (let i = 0; i < n; i++) {
    const id = `b${i.toString(36)}`;
    const k = i % 20;
    if (k < 10) blocks.push(textBlock(id, 'p', inline(i)));
    else if (k < 15)
      blocks.push(textBlock(id, 'li', inline(i), { list: 'ul', indent: k === 11 || k === 12 ? '1' : '0' }));
    else if (k === 15) blocks.push(textBlock(id, 'h2', [text(`标题 ${i}`)]));
    else if (k === 16) blocks.push(textBlock(id, 'code', [text(`const x${i} = a < b;\nreturn x;`)], { lang: 'ts' }));
    else if (k === 17) blocks.push(componentBlock(id, 'math', { tex: `x^${i}` }, { fallback: `<span>x^${i}</span>` }));
    else blocks.push(textBlock(id, 'quote', [text(`引用 ${i}`)]));
  }
  return createDoc(blocks);
}

describe('serialize: performance', () => {
  it('serializes a 10,000-block doc quickly', () => {
    const doc = bigDoc(10_000);
    const c0 = performance.now();
    serialize(doc); // 冷启动（含 JIT 预热）
    const cold = performance.now() - c0;
    const times: number[] = [];
    let size = 0;
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      size = serialize(doc).length;
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[2] as number;
    console.log(
      `serialize 10k blocks: median ${median.toFixed(1)}ms, min ${(times[0] as number).toFixed(1)}ms, ` +
        `max ${(times[4] as number).toFixed(1)}ms, cold ${cold.toFixed(1)}ms, output ${(size / 1024).toFixed(0)} KiB`,
    );
    expect(median).toBeLessThan(200);
    expect(cold).toBeLessThan(400);
  });
});
