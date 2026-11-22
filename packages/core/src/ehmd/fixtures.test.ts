/**
 * `tests/fixtures/md/*.md`：
 * - 每个样本都能解析（不抛错、文档有效），且 `serializeEhmd ∘ parseEhmd` 幂等；
 * - 与同名 `ehtml/NN-x.ehtml` 配对的样本：`parseEhmd(md)` 与 `parse(ehtml)` 相等
 *   （忽略 fallback 与 head，见 tests/fixtures/README.md），已知无法表达的差异在 {@link KNOWN} 中逐条列出。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  componentBlock,
  createDoc,
  htmlBlock,
  textBlock,
  validateDoc,
  type Block,
  type BlockId,
  type Doc,
} from '../model.js';
import { parse } from '../parse/index.js';
import { ehmdComparable } from './compare.js';
import { parseEhmd } from './parse.js';
import { serializeEhmd } from './serialize.js';

const root = resolve(import.meta.dirname, '../../../../tests/fixtures');
const mdDir = join(root, 'md');
const files = existsSync(mdDir)
  ? readdirSync(mdDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
  : [];

/**
 * 配对样本中已知的、EHMD 无法（或按约定不）表达的差异。
 * `drop`：只存在于 `.ehtml` 一侧、`.md` 中按 README 省略的块；比较前从 ehtml 文档中移除。
 * `normalize`：比较前对两侧文档都做的改写（记录约定造成的差异）。
 */
const KNOWN: Record<
  string,
  {
    drop?: BlockId[];
    dropMd?: BlockId[];
    renameMd?: Record<BlockId, BlockId>;
    why: string;
    normalize?: (doc: Doc) => Doc;
  }
> = {
  '03-headings-paragraphs': {
    why: 'md 正文中的 `#eh-user-style` 按 EHMD 规则是标签原子（ehtml 中是普通文本）；比较时把该标签还原为文本',
    normalize: (doc) =>
      mapBlocks(doc, (b) =>
        b.kind === 'text'
          ? textBlock(
              b.id,
              b.type,
              b.content.map((n) =>
                n.t === 'atom' && n.kind === 'tag' ? { t: 'text' as const, text: n.text, marks: n.marks } : n,
              ),
              { ...b.attrs },
              b.table,
            )
          : b,
      ),
  },
  '06-table': {
    drop: ['t2'],
    dropMd: ['b1'],
    why: '无表头的表格（t2）在 GFM 中无法表达，md 中省略并留下一条 HTML 注释（解析为 HTML 块 b1）',
  },
  '22-kitchen-sink': {
    renameMd: { b1: 'ks19' },
    why: 'md 中的外来块（<details>）是没有 ID 的原始 HTML（README：TBD），解析时分配了新 ID b1',
  },
  '07-figure': {
    drop: ['f3'],
    why:
      'f3（图注中有 <em>）在 md 中省略（README）；f4 的 src 在 md 中写成未编码路径 `<assets/my photo 照片.png>`，' +
      'EHMD 按原样保存目标（不做 URL 编码），因此比较时对两侧 src 做 decodeURI',
    normalize: (doc) =>
      mapBlocks(doc, (b) =>
        b.kind === 'text' && b.type === 'figure'
          ? { ...b, attrs: { ...b.attrs, src: safeDecode(b.attrs.src ?? '') } }
          : b,
      ),
  },
};

function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

function mapBlocks(doc: Doc, f: (b: Block) => Block): Doc {
  return { ...doc, blocks: new Map([...doc.blocks].map(([id, b]) => [id, f(b)])) };
}

function dropBlocks(doc: Doc, ids: readonly BlockId[]): Doc {
  const gone = new Set(ids);
  const blocks: Block[] = [];
  const keep = (list: readonly BlockId[]): BlockId[] => list.filter((id) => !gone.has(id));
  for (const b of doc.blocks.values()) {
    if (gone.has(b.id)) continue;
    blocks.push(b.kind === 'component' && b.slots ? { ...b, slots: b.slots.map(keep) } : b);
  }
  return createDoc(blocks, { root: keep(doc.root), meta: { ...doc.meta }, head: doc.head });
}

function renameBlocks(doc: Doc, names: Readonly<Record<BlockId, BlockId>>): Doc {
  const r = (id: BlockId): BlockId => names[id] ?? id;
  const blocks = [...doc.blocks.values()].map((b): Block => {
    if (b.kind === 'text') return textBlock(r(b.id), b.type, b.content, { ...b.attrs }, b.table);
    if (b.kind === 'html') return htmlBlock(r(b.id), b.html);
    return componentBlock(r(b.id), b.type, b.props, {
      attrs: { ...b.attrs },
      ...(b.slots ? { slots: b.slots.map((s) => s.map(r)) } : {}),
    });
  });
  return createDoc(blocks, { root: doc.root.map(r), meta: { ...doc.meta }, head: doc.head });
}

describe('md fixtures', () => {
  it.skipIf(files.length === 0)('parse without throwing, valid docs, idempotent serialize ∘ parse', () => {
    for (const f of files) {
      const src = readFileSync(join(mdDir, f), 'utf8');
      const { doc } = parseEhmd(src);
      expect(validateDoc(doc), f).toEqual([]);
      for (const ids of ['all', 'referenced', 'none'] as const) {
        const once = serializeEhmd(doc, { ids });
        expect(serializeEhmd(parseEhmd(once).doc, { ids }), `${f} (${ids})`).toBe(once);
      }
      // ids:'all' 时第二次解析得到同一文档
      expect(ehmdComparable(parseEhmd(serializeEhmd(doc, { ids: 'all' })).doc), f).toBe(ehmdComparable(doc));
    }
  });

  const pairs = files.filter((f) => existsSync(join(root, 'ehtml', f.replace(/\.md$/, '.ehtml'))));
  for (const f of pairs) {
    const base = f.replace(/\.md$/, '');
    it(`${base}: parseEhmd(md) equals parse(ehtml) ignoring fallback/head`, () => {
      const known = KNOWN[base];
      let fromMd = parseEhmd(readFileSync(join(mdDir, f), 'utf8')).doc;
      let fromHtml = parse(readFileSync(join(root, 'ehtml', `${base}.ehtml`), 'utf8')).doc;
      if (known?.drop) fromHtml = dropBlocks(fromHtml, known.drop);
      if (known?.dropMd) fromMd = dropBlocks(fromMd, known.dropMd);
      if (known?.renameMd) fromMd = renameBlocks(fromMd, known.renameMd);
      if (known?.normalize) {
        fromMd = known.normalize(fromMd);
        fromHtml = known.normalize(fromHtml);
      }
      expect(ehmdComparable(fromMd)).toBe(ehmdComparable(fromHtml));
    });
  }
});
