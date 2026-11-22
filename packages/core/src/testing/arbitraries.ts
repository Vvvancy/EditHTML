/**
 * fast-check 生成器：随机生成**有效且规范化**的 `Doc`，供解析/序列化/事务的属性测试共用。
 * 仅用于测试，不从包入口导出。
 *
 * 用法：`import { arbDoc } from '../testing/arbitraries.js'`
 *
 * @module
 */
import fc from 'fast-check';
import {
  componentBlock,
  createDoc,
  htmlBlock,
  normalizeInline,
  textBlock,
  type Block,
  type BlockId,
  type CellAlign,
  type Doc,
  type DocMeta,
  type InlineNode,
  type Mark,
  type MarkType,
  type TableData,
  type TextBlockType,
} from '../model.js';

/** 文本字符：混合 ASCII、需转义字符、CJK、emoji（代理对）、空白。 */
export const arbChar: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...'abcxyz ABC 0123'.split('')) },
  { weight: 2, arbitrary: fc.constantFrom('&', '<', '>', '"', "'", ' ', '\t') },
  { weight: 3, arbitrary: fc.constantFrom('中', '文', '笔', '记', '。', '，') },
  { weight: 1, arbitrary: fc.constantFrom('😀', '𝒳', 'é', 'ש') },
);

/** 非空文本。 */
export const arbText: fc.Arbitrary<string> = fc
  .array(arbChar, { minLength: 1, maxLength: 12 })
  .map((cs) => cs.join(''));

const SIMPLE_MARKS: MarkType[] = ['strong', 'em', 's', 'mark', 'sub', 'sup', 'kbd', 'code'];

/** 标记集合（未排序；构造节点时由 normalizeInline 排序）。 */
export const arbMarks: fc.Arbitrary<Mark[]> = fc
  .tuple(
    fc.subarray(SIMPLE_MARKS, { maxLength: 3 }),
    fc.option(fc.constantFrom('https://example.com/a?b=1&c=2', './note.ehtml#b3', 'mailto:x@y.z'), { nil: undefined }),
  )
  .map(([types, href]) => [
    ...types.map((type) => ({ type })),
    ...(href !== undefined ? [{ type: 'link' as const, attrs: { href } }] : []),
  ]);

/** 单个行内节点。 */
export const arbInlineNode: fc.Arbitrary<InlineNode> = fc.oneof(
  { weight: 8, arbitrary: fc.record({ t: fc.constant('text' as const), text: arbText, marks: arbMarks }) },
  { weight: 1, arbitrary: arbMarks.map((marks) => ({ t: 'br' as const, marks })) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('atom' as const),
      kind: fc.constantFrom('math', 'wikilink', 'tag'),
      attrs: fc.constant({}),
      text: arbText,
      marks: fc.constant([]),
    }),
  },
);

/** 规范化的行内内容。 */
export const arbInline: fc.Arbitrary<InlineNode[]> = fc
  .array(arbInlineNode, { maxLength: 6 })
  .map((ns) => normalizeInline(ns));

/** 代码块文本（无标记，可含换行与 `<`）。 */
const arbCode = fc
  .array(fc.oneof(arbChar, fc.constant('\n'), fc.constant('</code>')), { maxLength: 30 })
  .map((cs) => cs.join(''));

const arbTable: fc.Arbitrary<TableData> = fc.integer({ min: 1, max: 4 }).chain((cols) =>
  fc.record({
    head: fc.array(arbInline, { minLength: cols, maxLength: cols }),
    body: fc.array(fc.array(arbInline, { minLength: cols, maxLength: cols }), { maxLength: 3 }),
    align: fc.array(fc.constantFrom<CellAlign>('left', 'center', 'right', null), { minLength: cols, maxLength: cols }),
  }),
);

type BlockSpec = (id: BlockId) => Block;

/** 文本块生成器（返回接收 ID 的构造函数）。 */
export const arbTextBlockSpec: fc.Arbitrary<BlockSpec> = fc.oneof(
  arbInline.map(
    (c): BlockSpec =>
      (id) =>
        textBlock(id, 'p', c),
  ),
  fc.tuple(fc.constantFrom<TextBlockType>('h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote'), arbInline).map(
    ([t, c]): BlockSpec =>
      (id) =>
        textBlock(id, t, c),
  ),
  fc
    .tuple(
      arbInline,
      fc.constantFrom('ul', 'ol'),
      fc.constantFrom('0', '1'),
      fc.option(fc.constantFrom('done', 'todo'), { nil: undefined }),
    )
    .map(
      ([c, list, indent, task]): BlockSpec =>
        (id) =>
          textBlock(id, 'li', c, { list, indent, ...(task ? { task } : {}) }),
    ),
  fc.tuple(arbCode, fc.option(fc.constantFrom('ts', 'python', 'mermaid'), { nil: undefined })).map(
    ([code, lang]): BlockSpec =>
      (id) =>
        textBlock(id, 'code', code ? [{ t: 'text', text: code, marks: [] }] : [], lang ? { lang } : {}),
  ),
  fc.constant<BlockSpec>((id) => textBlock(id, 'hr')),
  arbTable.map(
    (t): BlockSpec =>
      (id) =>
        textBlock(id, 'table', [], {}, t),
  ),
  fc.tuple(arbInline, fc.constantFrom('assets/a.png', 'assets/图 1.png'), arbText).map(
    ([cap, src, alt]): BlockSpec =>
      (id) =>
        textBlock(id, 'figure', cap, { src, alt }),
  ),
);

/** 叶子组件块（非容器）的 props。 */
const arbLeafComponent: fc.Arbitrary<[string, unknown]> = fc.oneof(
  fc
    .record({
      type: fc.constantFrom('bar', 'line', 'pie'),
      data: fc.record({ x: fc.array(arbText, { maxLength: 4 }), y: fc.array(fc.integer(), { maxLength: 4 }) }),
    })
    .map((p): [string, unknown] => ['chart', p]),
  fc.record({ source: arbCode }).map((p): [string, unknown] => ['mermaid', p]),
  fc.record({ tex: arbText }).map((p): [string, unknown] => ['math', p]),
  fc
    .record({ url: fc.constant('https://example.com'), height: fc.nat(800) })
    .map((p): [string, unknown] => ['embed', p]),
  fc
    .record({ html: fc.constant('<b>hi</b></script>'), css: fc.constant(''), js: fc.constant('console.log(1)') })
    .map((p): [string, unknown] => ['script', p]),
);

/** 生成文档的选项。 */
export interface ArbDocOptions {
  /** 顶层块数上限，默认 12。 */
  maxBlocks?: number;
  /** 容器嵌套深度上限，默认 2（规范建议上限 4）。 */
  maxDepth?: number;
  /** 是否包含HTML 块，默认 true。 */
  html?: boolean;
}

/**
 * 随机有效文档。所有块 ID 唯一（`b1`, `b2`, …按先序分配），哈希正确，内容已规范化，
 * `validateDoc` 返回空数组。
 */
export function arbDoc(opts: ArbDocOptions = {}): fc.Arbitrary<Doc> {
  const { maxBlocks = 12, maxDepth = 2, html = true } = opts;

  type Tree = { leaf: BlockSpec } | { container: string; props: unknown; slots: Tree[][] };

  const tie = fc.letrec<{ tree: Tree; leaf: Tree }>((t) => ({
    leaf: fc.oneof(
      { weight: 6, arbitrary: arbTextBlockSpec.map((leaf): Tree => ({ leaf })) },
      {
        weight: 2,
        arbitrary: arbLeafComponent.map(([type, props]): Tree => ({
          leaf: (id) => componentBlock(id, type, props, { fallback: `<div class="eh-fallback">${type}</div>` }),
        })),
      },
      {
        weight: html ? 1 : 0,
        arbitrary: fc
          .constantFrom('<div class="x">自定义 <b>HTML</b></div>', '<script src="https://cdn.example/x.js"></script>')
          .map((html): Tree => ({ leaf: (id) => htmlBlock(id, html) })),
      },
    ),
    tree: fc.oneof(
      { weight: 5, arbitrary: t('leaf') },
      {
        weight: 1,
        arbitrary: fc
          .constantFrom(
            ['callout', { kind: 'info', title: '提示' }, 1] as const,
            ['toggle', { title: '展开', open: false }, 1] as const,
            ['tabs', { tabs: [{ title: '概念' }, { title: '例子' }] }, 2] as const,
            ['columns', { ratio: [1, 2] }, 2] as const,
          )
          .chain(([container, props, n]) =>
            fc
              .array(fc.array(t('tree'), { maxLength: 3 }), { minLength: n, maxLength: n })
              .map((slots): Tree => ({ container, props, slots })),
          ),
      },
    ),
  }));

  const meta: fc.Arbitrary<DocMeta> = fc.record(
    { title: arbText, created: fc.constant('2026-11-21'), tags: fc.array(arbText, { maxLength: 3 }) },
    { requiredKeys: [] },
  );

  return fc.tuple(fc.array(tie.tree, { maxLength: maxBlocks }), meta).map(([trees, m]) => {
    let n = 0;
    const blocks: Block[] = [];
    const build = (tree: Tree, depth: number): BlockId => {
      const id = `b${(++n).toString(36)}`;
      if ('leaf' in tree || depth >= maxDepth) {
        const spec = 'leaf' in tree ? tree.leaf : (i: BlockId) => textBlock(i, 'p');
        blocks.push(spec(id));
        return id;
      }
      const slots = tree.slots.map((s) => s.map((c) => build(c, depth + 1)));
      blocks.push(componentBlock(id, tree.container, tree.props, { slots }));
      return id;
    };
    const root = trees.map((t) => build(t, 0));
    const doc = createDoc(blocks, { root, meta: m });
    return fixListIndents(doc);
  });
}

/**
 * 强制列表不变量（01 §6.1）：同一列表组内第一个 `li` 的 indent 为 0，且每项 indent ≤ 前一项 + 1。
 */
function fixListIndents(doc: Doc): Doc {
  const blocks = new Map(doc.blocks);
  const fixSeq = (ids: readonly BlockId[]): void => {
    let prev = -1;
    for (const id of ids) {
      const b = blocks.get(id);
      if (!b) continue;
      if (b.kind === 'text' && b.type === 'li') {
        const want = Math.min(Number(b.attrs.indent ?? '0'), prev + 1);
        if (String(want) !== b.attrs.indent)
          blocks.set(id, textBlock(id, 'li', b.content, { ...b.attrs, indent: String(want) }));
        prev = want;
      } else {
        prev = -1;
        if (b.kind === 'component' && b.slots) b.slots.forEach(fixSeq);
      }
    }
  };
  fixSeq(doc.root);
  return { ...doc, blocks };
}
