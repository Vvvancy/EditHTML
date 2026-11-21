/**
 * 解析器属性测试（fast-check）。
 *
 * `emitCanonical` 是**仅供测试**的最小规范形式输出器，按 01 §6.1 手写，用来为随机文档生成
 * "规范样式"的输入；它不是序列化器（序列化器由 T1.3 提供，合并后由集成测试做真正的往返）。
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  docToComparable,
  getBlock,
  MARK_ORDER,
  validateDoc,
  type Block,
  type BlockId,
  type Doc,
  type InlineNode,
  type Mark,
  type TextBlock,
} from '../model.js';
import { arbDoc } from '../testing/arbitraries.js';
import { parse } from './parser.js';

const escText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string): string => escText(s).replace(/"/g, '&quot;');
const json = (v: unknown): string => JSON.stringify(v).replace(/<\//g, '<\\/').replace(/<!--/g, '\\u003c!--');

function openMark(m: Mark): string {
  if (m.type !== 'link') return `<${m.type}>`;
  const title = m.attrs?.title;
  return `<a href="${escAttr(m.attrs?.href ?? '')}"${title !== undefined ? ` title="${escAttr(title)}"` : ''}>`;
}
const closeMark = (m: Mark): string => (m.type === 'link' ? '</a>' : `</${m.type}>`);

/** 行内内容：每个节点独立包裹自身的标记（规范形式会共享前缀，但解析结果等价）。 */
function inline(content: readonly InlineNode[]): string {
  return content
    .map((n) => {
      const marks = [...n.marks].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
      const body =
        n.t === 'text'
          ? escText(n.text)
          : n.t === 'br'
            ? '<br>'
            : `<span data-eh-inline="${escAttr(n.kind)}"${Object.entries(n.attrs)
                .map(([k, v]) => ` data-eh-${k}="${escAttr(v)}"`)
                .join('')}>${escText(n.text)}</span>`;
      return marks.map(openMark).join('') + body + [...marks].reverse().map(closeMark).join('');
    })
    .join('');
}

function textBlockHtml(b: TextBlock, pad: string): string {
  const id = `data-eh="${b.id}"`;
  switch (b.type) {
    case 'quote':
      return `${pad}<blockquote ${id}>${inline(b.content)}</blockquote>`;
    case 'hr':
      return `${pad}<hr ${id}>`;
    case 'code': {
      const lang = b.attrs.lang ? ` data-lang="${escAttr(b.attrs.lang)}"` : '';
      const code = b.content[0]?.t === 'text' ? b.content[0].text : '';
      return `${pad}<pre ${id}${lang}><code>${escText(code)}</code></pre>`;
    }
    case 'figure': {
      const cap = b.content.length ? `<figcaption>${inline(b.content)}</figcaption>` : '';
      return `${pad}<figure ${id}><img alt="${escAttr(b.attrs.alt ?? '')}" src="${escAttr(b.attrs.src ?? '')}">${cap}</figure>`;
    }
    case 'table': {
      const t = b.table ?? { head: [], body: [] };
      const al = (i: number): string => {
        const a = t.align?.[i];
        return a ? ` data-eh-align="${a}"` : '';
      };
      const lines = [`${pad}<table ${id}>`];
      if (t.head.length)
        lines.push(`${pad}  <thead><tr>${t.head.map((c, i) => `<th${al(i)}>${inline(c)}</th>`).join('')}</tr></thead>`);
      lines.push(`${pad}  <tbody>`);
      for (const row of t.body)
        lines.push(`${pad}    <tr>${row.map((c, i) => `<td${al(i)}>${inline(c)}</td>`).join('')}</tr>`);
      lines.push(`${pad}  </tbody>`, `${pad}</table>`);
      return lines.join('\n');
    }
    case 'li':
      throw new Error('li handled by list grouping');
    default:
      return `${pad}<${b.type} ${id}>${inline(b.content)}</${b.type}>`;
  }
}

function listHtml(items: TextBlock[], pad: string): string {
  let pos = 0;
  const render = (level: number): string => {
    let html = '';
    let cur: string | null = null;
    while (pos < items.length && Number((items[pos] as TextBlock).attrs.indent) >= level) {
      const it = items[pos] as TextBlock;
      if (cur !== it.attrs.list) {
        if (cur) html += `</${cur}>`;
        cur = it.attrs.list as string;
        html += `<${cur}>`;
      }
      const task = it.attrs.task ? ` data-eh-task="${it.attrs.task}"` : '';
      html += `\n${pad}  <li data-eh="${it.id}"${task}>${inline(it.content)}`;
      pos++;
      if (pos < items.length && Number((items[pos] as TextBlock).attrs.indent) > level) html += render(level + 1);
      html += '</li>';
    }
    return `${html}\n${pad}</${cur}>`;
  };
  return pad + render(0);
}

function seqHtml(doc: Doc, ids: readonly BlockId[], pad: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const b = getBlock(doc, ids[i] as BlockId);
    if (b.kind === 'text' && b.type === 'li') {
      const run: TextBlock[] = [];
      while (i < ids.length) {
        const x = getBlock(doc, ids[i] as BlockId);
        if (x.kind !== 'text' || x.type !== 'li') break;
        run.push(x);
        i++;
      }
      i--;
      out.push(listHtml(run, pad));
    } else out.push(blockHtml(doc, b, pad));
  }
  return out;
}

function blockHtml(doc: Doc, b: Block, pad: string): string {
  if (b.kind === 'text') return textBlockHtml(b, pad);
  if (b.kind === 'foreign') return `${pad}<eh-foreign data-eh="${b.id}">${b.html}</eh-foreign>`;
  const attrs = Object.entries(b.attrs)
    .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
    .join('');
  const lines = [
    `${pad}<eh-${b.type} data-eh="${b.id}"${attrs}>`,
    `${pad}  <script type="application/json">${json(b.props)}</script>`,
  ];
  b.slots?.forEach((slot, i) => {
    if (slot.length === 0) lines.push(`${pad}  <eh-slot data-eh-slot="${i}"></eh-slot>`);
    else lines.push(`${pad}  <eh-slot data-eh-slot="${i}">`, ...seqHtml(doc, slot, `${pad}    `), `${pad}  </eh-slot>`);
  });
  if (b.fallback !== undefined) lines.push(`${pad}  <!--eh:fallback-->${b.fallback}<!--eh:fallback-->`);
  lines.push(`${pad}</eh-${b.type}>`);
  return lines.join('\n');
}

/** 测试用：按 01 §6.1 输出规范样式的 HTML。 */
export function emitCanonical(doc: Doc): string {
  const title = typeof doc.meta.title === 'string' ? doc.meta.title : '';
  return [
    '<!doctype html>',
    '<html lang="zh-CN" data-eh-version="0.1">',
    '  <head>',
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    `    <title>${escText(title)}</title>`,
    `    <script type="application/json" id="eh-meta">${json(doc.meta)}</script>`,
    '  </head>',
    '  <body>',
    '    <main id="eh-doc">',
    ...seqHtml(doc, doc.root, '      '),
    '    </main>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

describe('parse: property tests', () => {
  it('canonical-looking input parses to a valid doc equal to the source doc, without warnings', () => {
    fc.assert(
      fc.property(arbDoc({ maxDepth: 3 }), (doc) => {
        const html = emitCanonical(doc);
        const { doc: parsed, warnings } = parse(html);
        expect(validateDoc(parsed)).toEqual([]);
        expect(warnings).toEqual([]);
        expect(docToComparable(parsed)).toBe(docToComparable(doc));
      }),
      { numRuns: 300 },
    );
  });

  it('never throws and always yields a valid doc on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (s) => {
        expect(validateDoc(parse(s).doc)).toEqual([]);
      }),
      { numRuns: 500 },
    );
  });

  const soupPiece = fc.oneof(
    fc.constantFrom(
      '<p>',
      '</p>',
      '<p data-eh="b1">',
      '<p data-eh="b1"',
      '<h2>',
      '</h3>',
      '<ul>',
      '</ul>',
      '<ol>',
      '<li>',
      '</li>',
      '<li data-eh-task="done">',
      '<table>',
      '<tr>',
      '<td>',
      '</td>',
      '<th align="center">',
      '</table>',
      '<thead>',
      '<figure>',
      '<img src="x">',
      '<figcaption>',
      '</figure>',
      '<pre>',
      '<code>',
      '</code>',
      '</pre>',
      '<blockquote>',
      '</blockquote>',
      '<hr>',
      '<br>',
      '<b>',
      '</b>',
      '<i>',
      '<a href="javascript:x">',
      '</a>',
      '<span data-eh-inline="math">',
      '</span>',
      '<script>',
      '</script>',
      '<style>',
      '<!--',
      '-->',
      '<!--eh:fallback-->',
      '<eh-chart data-eh="c">',
      '</eh-chart>',
      '<script type="application/json">',
      '{"a":1}',
      '<eh-slot data-eh-slot="1">',
      '</eh-slot>',
      '<eh-tabs>',
      '</eh-tabs>',
      '<eh-foreign>',
      '</eh-foreign>',
      '<div onclick="x">',
      '</div>',
      '<main id="eh-doc">',
      '</main>',
      '<html>',
      '<head>',
      '<title>',
      '</title>',
      '<body>',
      '&amp;',
      '&foo;',
      '&#x1F600;',
      '&',
      '<',
      '>',
      '"',
      "'",
      '=',
      '/',
      ' ',
      '\n',
      'text',
      '中文',
    ),
    fc.string({ maxLength: 4 }),
  );

  it('never throws on random tag soup', () => {
    fc.assert(
      fc.property(fc.array(soupPiece, { maxLength: 60 }), (pieces) => {
        const { doc } = parse(pieces.join(''));
        expect(validateDoc(doc)).toEqual([]);
      }),
      { numRuns: 1000 },
    );
  });

  it('parsing is deterministic', () => {
    fc.assert(
      fc.property(fc.array(soupPiece, { maxLength: 40 }), (pieces) => {
        const s = pieces.join('');
        expect(docToComparable(parse(s).doc)).toBe(docToComparable(parse(s).doc));
      }),
      { numRuns: 200 },
    );
  });
});
