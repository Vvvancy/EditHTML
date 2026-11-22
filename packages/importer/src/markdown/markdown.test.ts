/**
 * 06 §5 映射表逐行的黄金测试，以及编辑后导出、CommonMark 降级与转换报告。
 */
import {
  BLOCK_ID_RE,
  componentBlock,
  getBlock,
  textBlock,
  validateDoc,
  walkBlocks,
  type Block,
  type ComponentBlock,
  type Doc,
  type InlineAtom,
  type TextBlock,
} from '@edithtml/core';
import { describe, expect, it } from 'vitest';
import { exportMarkdown, importMarkdown, readSourceInfo } from './index.js';

/** 文档的块树（去掉 hash），便于断言。 */
function tree(doc: Doc, ids = doc.root): unknown[] {
  return ids.map((id) => {
    const { hash: _h, id: _i, ...rest } = getBlock(doc, id);
    if (rest.kind === 'component' && rest.slots) return { ...rest, slots: rest.slots.map((s) => tree(doc, s)) };
    return rest;
  });
}

const imp = (md: string): Doc => {
  const { doc } = importMarkdown(md);
  expect(validateDoc(doc)).toEqual([]);
  return doc;
};
const first = (md: string): Block => {
  const doc = imp(md);
  return getBlock(doc, doc.root[0] as string);
};
const atoms = (b: Block): InlineAtom[] =>
  b.kind === 'text' ? b.content.filter((n): n is InlineAtom => n.t === 'atom') : [];

/** 替换一个块（模拟编辑；真实编辑走 Transaction）。 */
function replace(doc: Doc, b: Block): Doc {
  const blocks = new Map(doc.blocks);
  blocks.set(b.id, b);
  return { ...doc, blocks };
}
const editText = (doc: Doc, id: string, text: string): Doc => {
  const b = getBlock(doc, id) as TextBlock;
  return replace(doc, textBlock(b.id, b.type, [{ t: 'text', text, marks: [] }], { ...b.attrs }, b.table));
};

const roundtrip = (md: string): void => expect(exportMarkdown(imp(md))).toBe(md);

describe('06 §5 row 1: text blocks', () => {
  it('headings, paragraphs, lists, tasks, quotes, code, tables, hr, images', () => {
    const md = [
      '# H1',
      '',
      'para *em* **strong**',
      '',
      '- a',
      '  - b',
      '1. one',
      '',
      '- [ ] todo',
      '- [x] done',
      '',
      '> quote',
      '',
      '```js',
      'x()',
      '```',
      '',
      '| a | b |',
      '| :- | -: |',
      '| 1 | 2 |',
      '',
      '---',
      '',
      '![alt](img.png)',
      '',
    ].join('\n');
    const doc = imp(md);
    const types = doc.root.map((id) => (getBlock(doc, id) as TextBlock).type);
    expect(types).toEqual(['h1', 'p', 'li', 'li', 'li', 'li', 'li', 'quote', 'code', 'table', 'hr', 'figure']);
    const lis = doc.root.slice(2, 7).map((id) => (getBlock(doc, id) as TextBlock).attrs);
    expect(lis).toEqual([
      { list: 'ul', indent: '0' },
      { list: 'ul', indent: '1' },
      { list: 'ol', indent: '0' },
      { list: 'ul', indent: '0', task: 'todo' },
      { list: 'ul', indent: '0', task: 'done' },
    ]);
    expect(exportMarkdown(doc)).toBe(md);
  });

  it('keeps list markers, `[X]` and custom task states verbatim', () => {
    roundtrip('* star\n+ plus\n- [X] upper\n- [-] cancelled\n- [>] deferred\n');
  });
});

describe('06 §5 row 2: YAML frontmatter → meta', () => {
  const md = '---\ntitle: T\naliases:\n  - a\ncreated: 2026-11-01\ncssclasses: [home]\n---\n\nbody\n';
  it('parses meta (dates stay strings) and reproduces the original YAML text', () => {
    const doc = imp(md);
    expect(doc.meta).toEqual({ title: 'T', aliases: ['a'], created: '2026-11-01', cssclasses: ['home'] });
    expect(readSourceInfo(doc)?.frontmatter?.raw).toBe(
      '---\ntitle: T\naliases:\n  - a\ncreated: 2026-11-01\ncssclasses: [home]\n---\n',
    );
    expect(exportMarkdown(doc)).toBe(md);
  });
  it('regenerates the frontmatter when meta changes', () => {
    const doc = imp(md);
    const out = exportMarkdown({ ...doc, meta: { ...doc.meta, title: 'U' } });
    expect(out).toBe('---\ntitle: U\ncreated: 2026-11-01\naliases: [a]\ncssclasses: [home]\n---\n\nbody\n');
  });
});

describe('06 §5 row 3: mermaid fences → mermaid component', () => {
  it('``` and ~~~ fences; fence char restored after an edit', () => {
    const md = '~~~mermaid\ngraph TD\n  A --> B\n~~~\n';
    const doc = imp(md);
    const b = getBlock(doc, doc.root[0] as string) as ComponentBlock;
    expect(b).toMatchObject({ kind: 'component', type: 'mermaid', props: { source: 'graph TD\n  A --> B' } });
    expect(exportMarkdown(doc)).toBe(md);
    const edited = replace(doc, componentBlock(b.id, 'mermaid', { source: 'graph LR' }, { attrs: {} }));
    expect(exportMarkdown(edited)).toBe('~~~mermaid\ngraph LR\n~~~\n');
    expect(first('```mermaid\nx\n```\n')).toMatchObject({ type: 'mermaid', props: { source: 'x' } });
  });
});

describe('06 §5 row 4: $$…$$ / $…$', () => {
  it('block math, inline math atoms, display atoms', () => {
    expect(first('$$\na^2\n$$\n')).toMatchObject({ kind: 'component', type: 'math', props: { tex: 'a^2' } });
    expect(atoms(first('x $a$ y'))).toEqual([{ t: 'atom', kind: 'math', attrs: {}, text: 'a', marks: [] }]);
    expect(atoms(first('x $$a$$ y'))[0]).toMatchObject({ kind: 'math', attrs: { display: 'block' }, text: 'a' });
  });
  it('Obsidian dollar rule: `$5 和 $3` is text', () => {
    expect(atoms(first('苹果 $5，香蕉 $3。'))).toEqual([]);
    expect(atoms(first('a $ x$ b'))).toEqual([]);
  });
  it('`$$ ^id` closing line carries the block id', () => {
    const md = '$$\nx\n$$ ^eq-1\n\nafter\n';
    const doc = imp(md);
    expect(doc.root).toHaveLength(2);
    expect(getBlock(doc, doc.root[0] as string)).toMatchObject({ type: 'math', attrs: { 'md-id': 'eq-1' } });
    expect(exportMarkdown(doc)).toBe(md);
  });
});

describe('06 §5 row 5: callouts', () => {
  it('kind kept verbatim (no coercion), title, body', () => {
    const doc = imp('> [!TIP] 标题\n> 内容\n');
    expect(tree(doc)).toEqual([
      {
        kind: 'component',
        type: 'callout',
        props: { kind: 'TIP', title: '标题' },
        attrs: {},
        slots: [[{ kind: 'text', type: 'p', attrs: {}, content: [{ t: 'text', text: '内容', marks: [] }] }]],
      },
    ]);
    expect(first('> [!custom-type]\n> x\n')).toMatchObject({ props: { kind: 'custom-type', title: '' } });
  });
  it('foldable `-` / `+` → toggle with open + kind; restored after an edit', () => {
    for (const [mark, open] of [
      ['-', false],
      ['+', true],
    ] as const) {
      const md = `> [!warning]${mark} 折叠\n> 原文\n`;
      const doc = imp(md);
      const t = getBlock(doc, doc.root[0] as string) as ComponentBlock;
      expect(t).toMatchObject({ type: 'toggle', props: { title: '折叠', open }, attrs: { kind: 'warning' } });
      const child = (t.slots?.[0]?.[0] ?? '') as string;
      expect(exportMarkdown(editText(doc, child, '改过'))).toBe(`> [!warning]${mark} 折叠\n> 改过\n`);
    }
  });
  it('nested callouts (3 levels), lists and code inside', () => {
    const md = '> [!note] 外\n> a\n>\n> > [!example] 内\n> > b\n> >\n> > > [!quote]- 三\n> > > c\n';
    const doc = imp(md);
    const depths = [...walkBlocks(doc)].map(
      ([b, d]) => `${d}:${b.kind === 'component' ? b.type : (b as TextBlock).type}`,
    );
    expect(depths).toEqual(['0:callout', '1:p', '1:callout', '2:p', '2:toggle', '3:p']);
    expect(exportMarkdown(doc)).toBe(md);
    // 全部按模型重新生成也一样
    expect(exportMarkdown(doc, { verbatim: false })).toBe(md);
    const withList = imp('> [!abstract] t\n> - a\n> - b\n>\n> ```js\n> x\n> ```\n');
    const c = getBlock(withList, withList.root[0] as string) as ComponentBlock;
    expect(c.slots?.[0]?.map((id) => (getBlock(withList, id) as TextBlock).type)).toEqual(['li', 'li', 'code']);
  });
  it('a plain blockquote is not a callout', () => {
    expect(first('> 普通\n> 引用\n')).toMatchObject({ kind: 'text', type: 'quote' });
  });
});

describe('06 §5 row 6: wikilinks', () => {
  it('four forms with structured attrs; target kept as written', () => {
    const b = first('[[Roadmap]] [[Roadmap#目标]] [[Roadmap#^goal-1]] [[projects/EditHTML/Roadmap.md|路线图]]');
    expect(atoms(b).map((a) => [a.kind, a.attrs, a.text])).toEqual([
      ['wikilink', { target: 'Roadmap' }, '[[Roadmap]]'],
      ['wikilink', { target: 'Roadmap', heading: '目标' }, '[[Roadmap#目标]]'],
      ['wikilink', { target: 'Roadmap', block: 'goal-1' }, '[[Roadmap#^goal-1]]'],
      [
        'wikilink',
        { target: 'projects/EditHTML/Roadmap.md', alias: '路线图' },
        '[[projects/EditHTML/Roadmap.md|路线图]]',
      ],
    ]);
  });
  it('`\\|` inside a table cell is the alias separator; regenerated tables keep it', () => {
    const md = '| a |\n| --- |\n| [[R\\|别名]] |\n';
    const doc = imp(md);
    const t = getBlock(doc, doc.root[0] as string) as TextBlock;
    expect(t.table?.body[0]?.[0]?.[0]).toMatchObject({ kind: 'wikilink', attrs: { target: 'R', alias: '别名' } });
    expect(exportMarkdown(doc, { verbatim: false })).toBe(md);
  });
});

describe('06 §5 row 7: embeds', () => {
  it('standalone image embed → figure (size / alt kept)', () => {
    expect(first('![[image.png]]')).toMatchObject({
      type: 'figure',
      attrs: { src: 'image.png', alt: '', syntax: 'wikilink' },
    });
    expect(first('![[photo.png|120x80]]')).toMatchObject({ attrs: { src: 'photo.png', width: '120', height: '80' } });
    expect(first('![[image.png|示意图]]')).toMatchObject({ attrs: { alt: '示意图' } });
    const doc = imp('![[photo.png|200]]\n');
    expect(exportMarkdown(doc, { verbatim: false })).toBe('![[photo.png|200]]\n');
  });
  it('note / heading / block / pdf embeds → note-embed component', () => {
    expect(first('![[Roadmap#^goal-1]]')).toMatchObject({
      kind: 'component',
      type: 'note-embed',
      props: { target: 'Roadmap', block: 'goal-1' },
    });
    expect(first('![[manual.pdf#page=3]]')).toMatchObject({
      type: 'note-embed',
      props: { target: 'manual.pdf', heading: 'page=3' },
    });
    expect(exportMarkdown(imp('![[张三]]\n'), { verbatim: false })).toBe('![[张三]]\n');
  });
  it('embed inside a paragraph → embed atom', () => {
    expect(atoms(first('带尺寸：![[photo.png|200]]，完'))).toEqual([
      { t: 'atom', kind: 'embed', attrs: { target: 'photo.png', alias: '200' }, text: '![[photo.png|200]]', marks: [] },
    ]);
  });
});

describe('06 §5 row 8: tags', () => {
  it('#tag and #nested/tag are atoms; #2026 and a#b are not', () => {
    expect(atoms(first('#inbox #nested/tag/deep #2026 学习#读书 `#code`')).map((a) => a.text)).toEqual([
      '#inbox',
      '#nested/tag/deep',
    ]);
  });
});

describe('06 §5 row 9: ^blockid', () => {
  it('Obsidian ids are kept in attrs[md-id]; the block id still satisfies BLOCK_ID_RE', () => {
    const doc = imp('目标一 ^goal-1\n\n普通 ^morning\n\n- item ^deep-task\n');
    const bs = doc.root.map((id) => getBlock(doc, id) as TextBlock);
    expect(bs.map((b) => b.attrs['md-id'])).toEqual(['goal-1', 'morning', 'deep-task']);
    expect(bs.map((b) => BLOCK_ID_RE.test(b.id))).toEqual([true, true, true]);
    expect(bs[1]?.id).toBe('morning');
    expect(importMarkdown('a ^goal-1').report.sourceIds).toEqual([{ original: 'goal-1', blockId: 'b1' }]);
  });
  it('export writes back only ids that existed in the source', () => {
    const doc = imp('a ^goal-1\n\nb\n\n| t |\n| - |\n| 1 |\n\n^tbl\n');
    const ed = editText(editText(doc, doc.root[1] as string, 'B'), doc.root[0] as string, 'A');
    expect(exportMarkdown(ed)).toBe('A ^goal-1\n\nB\n\n| t |\n| - |\n| 1 |\n\n^tbl\n');
    expect(exportMarkdown(ed, { verbatim: false })).toBe('A ^goal-1\n\nB\n\n| t |\n| --- |\n| 1 |\n\n^tbl\n');
    expect(exportMarkdown(ed, { verbatim: false })).not.toMatch(/\^b\d/);
  });
});

describe('06 §5 row 10: ==highlight== and footnotes', () => {
  it('==mark==', () => {
    const b = first('这是==高亮==');
    expect(b.kind === 'text' && b.content[1]).toEqual({ t: 'text', text: '高亮', marks: [{ type: 'mark' }] });
  });
  it('[^1] references, definitions and inline ^[…] footnotes', () => {
    const md = '正文[^1]与行内^[脚注]。\n\n[^1]: 定义内容。\n';
    const doc = imp(md);
    const p = getBlock(doc, doc.root[0] as string);
    expect(atoms(p)).toEqual([
      { t: 'atom', kind: 'footnote', attrs: { label: '1' }, text: '1', marks: [] },
      { t: 'atom', kind: 'footnote', attrs: { form: 'inline' }, text: '脚注', marks: [] },
    ]);
    expect(tree(doc).slice(1)).toEqual([
      {
        kind: 'component',
        type: 'footnote',
        props: { label: '1' },
        attrs: {},
        slots: [[{ kind: 'text', type: 'p', attrs: {}, content: [{ t: 'text', text: '定义内容。', marks: [] }] }]],
      },
    ]);
    expect(exportMarkdown(doc, { verbatim: false })).toBe(md);
  });
});

describe('06 §5 row 11: embedded raw HTML', () => {
  it('unrecognizable HTML lands in an HtmlBlock', () => {
    const b = first('<center>居中</center>\n');
    expect(b).toEqual(expect.objectContaining({ kind: 'html', html: '<center>居中</center>' }));
    roundtrip('<div style="color: red">\n<b>x</b>\n</div>\n');
  });
  it('recognizable HTML → native blocks via the core parser', () => {
    expect(first('<p>段落</p>\n')).toMatchObject({ kind: 'text', type: 'p' });
  });
  it('<details> split by blank lines is paired into a toggle', () => {
    const md = '<details>\n<summary>标题</summary>\n\n正文\n\n</details>\n';
    const doc = imp(md);
    expect(tree(doc)).toEqual([
      {
        kind: 'component',
        type: 'toggle',
        props: { title: '标题', open: false },
        attrs: { syntax: 'html' },
        slots: [[{ kind: 'text', type: 'p', attrs: {}, content: [{ t: 'text', text: '正文', marks: [] }] }]],
      },
    ]);
    expect(exportMarkdown(doc, { verbatim: false })).toBe(md);
  });
  it('event handlers / javascript: links are sanitized and reported', () => {
    const r = importMarkdown('<a href="javascript:alert(1)">x</a> y\n');
    expect(r.report.sanitized.map((s) => s.code)).toContain('stripped-javascript-url');
    expect(exportMarkdown(r.doc)).not.toContain('javascript:');
  });
});

describe('06 §5 row 12: unrecognized extension syntax preserved verbatim', () => {
  it('Dataview blocks are code blocks written back verbatim', () => {
    const md = '```dataview\nTABLE file.name\nFROM #project\n```\n\nstatus:: active\n';
    const r = importMarkdown(md);
    expect(getBlock(r.doc, r.doc.root[0] as string)).toMatchObject({ type: 'code', attrs: { lang: 'dataview' } });
    expect(r.report.preserved.map((p) => p.kind)).toEqual(['extension-code']);
    expect(exportMarkdown(r.doc)).toBe(md);
  });
  it('%%comments%% (inline, block, multi-paragraph) and link definitions', () => {
    const md = 'a %%内联%% b\n\n%%块%%\n\n%%\n多段\n\n注释\n%%\n\n[ref]: https://x.invalid\n';
    const r = importMarkdown(md);
    expect(tree(r.doc).slice(1)).toEqual([
      { kind: 'component', type: 'markdown', props: { source: '%%块%%' }, attrs: { syntax: 'comment' } },
      { kind: 'component', type: 'markdown', props: { source: '%%\n多段\n\n注释\n%%' }, attrs: { syntax: 'comment' } },
      {
        kind: 'component',
        type: 'markdown',
        props: { source: '[ref]: https://x.invalid' },
        attrs: { syntax: 'definition' },
      },
    ]);
    expect(atoms(getBlock(r.doc, r.doc.root[0] as string))).toMatchObject([{ kind: 'comment', text: '内联' }]);
    expect(exportMarkdown(r.doc)).toBe(md);
    expect(exportMarkdown(r.doc, { verbatim: false })).toBe(md);
  });
});

describe('editing', () => {
  it('only the edited segment is regenerated; the rest stays byte-identical', () => {
    const md = '# T\n\n*  odd   list\n\n段落   ^p1\n';
    const doc = imp(md);
    const out = exportMarkdown(editText(doc, doc.root[0] as string, 'New'));
    expect(out).toBe('# New\n\n*  odd   list\n\n段落   ^p1\n');
  });
  it('a tight gap is kept only between unchanged neighbours', () => {
    const doc = imp('# H\npara\n');
    expect(exportMarkdown(doc)).toBe('# H\npara\n');
    expect(exportMarkdown(editText(doc, doc.root[1] as string, 'x'))).toBe('# H\n\nx\n');
  });
  it('CRLF and BOM are restored', () => {
    roundtrip('\uFEFF# a\r\n\r\nb\r\n');
  });
  it('never throws and always produces a valid doc for odd input', () => {
    for (const s of ['', '\n\n', '---', '---\n---\n', '> [!', '![[', '%%', '$$', '<details>', '^[', '[^x]:'])
      expect(validateDoc(importMarkdown(s).doc)).toEqual([]);
  });
});

describe('commonmark flavor', () => {
  it('degrades components per 01 §7 and writes no ids', () => {
    const md = [
      '> [!info] 标题',
      '> 内容 ^c1',
      '',
      '```mermaid',
      'graph TD',
      '```',
      '',
      '$$',
      'x^2',
      '$$',
      '',
      '见 [[Roadmap#目标|路线图]] #tag $a$ %%c%%',
      '',
    ].join('\n');
    const out = exportMarkdown(imp(md), { flavor: 'commonmark' });
    expect(out).toBe(
      [
        '> ```yaml',
        '> callout:',
        '>   kind: info',
        '>   title: 标题',
        '> ```',
        '>',
        '> 内容',
        '',
        '```mermaid',
        'graph TD',
        '```',
        '',
        '```math',
        'x^2',
        '```',
        '',
        '见 [路线图](Roadmap#目标) \\#tag `$a$` <!--c-->',
        '',
      ].join('\n'),
    );
  });
  it('chart → image + data code block', () => {
    const doc = imp(':::chart\ntype: bar\n:::\n');
    const c = getBlock(doc, doc.root[0] as string) as ComponentBlock;
    const withFallback = replace(
      doc,
      componentBlock(c.id, 'chart', c.props, { attrs: {}, fallback: '<img src="chart.svg" alt="">' }),
    );
    expect(exportMarkdown(withFallback, { flavor: 'commonmark' })).toBe(
      '![chart](chart.svg)\n\n```yaml\ntype: bar\n```\n',
    );
  });
});

describe('conversion report', () => {
  it('counts blocks and exposes link targets as written', () => {
    const r = importMarkdown(
      '---\nattendees: ["[[张三]]"]\n---\n\n[[会议记录]] ![[x.png]] [a](notes/Raw%20HTML.md)\n\n![[x.png]]\n\n> [!note] t\n> b\n',
    );
    expect(r.report.nativeBlocks).toBe(3);
    expect(r.report.components).toEqual({ callout: 1 });
    expect(r.report.htmlBlocks).toBe(0);
    expect(r.report.dropped).toEqual([]);
    expect(r.report.links.map((l) => [l.kind, l.target])).toEqual([
      ['wikilink', '会议记录'],
      ['embed', 'x.png'],
      ['link', 'notes/Raw%20HTML.md'],
      ['embed', 'x.png'],
      ['frontmatter', '张三'],
    ]);
  });
  it('model-lossy constructs with preserved source are reported as lossy, not dropped', () => {
    const r = importMarkdown('| A | B |\n| - | - |\n| 1 | 2 | 3 |\n');
    expect(r.report.dropped).toEqual([]);
    expect(r.report.lossy.map((l) => l.code)).toEqual(['dropped-content']);
    expect(r.report.verbatimSegments).toBe(1);
  });
});

describe('literal footnote-like text', () => {
  it('escapes [^ so plain text never turns into a footnote reference or definition', () => {
    for (const src of ['\\[^1]: >a', 'see \\[^1] here', '<b>[^1]: >a\n[^1]: ']) {
      const once = exportMarkdown(importMarkdown(src).doc, { verbatim: false });
      expect(exportMarkdown(importMarkdown(once).doc, { verbatim: false })).toBe(once);
    }
  });
});
