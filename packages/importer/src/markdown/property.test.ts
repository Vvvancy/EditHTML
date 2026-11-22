/**
 * 属性测试：导入从不抛错；未编辑时导出与原文逐字节一致；按模型生成的导出（无原文）幂等且保持模型。
 */
import { getBlock, validateDoc, type Doc } from '@edithtml/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exportMarkdown, importMarkdown } from './index.js';

/** Markdown/Obsidian 语法字符密集的字母表。 */
const mdChar = fc.constantFrom(
  ...'abc 12\n\n\t#*_-+=~`$%^![]()<>|\\:{}>.&'.split(''),
  '[[',
  ']]',
  '![[',
  '%%',
  '$$',
  '> [!note] ',
  '> ',
  '- [ ] ',
  '```',
  '~~~',
  '^id-1',
  '[^1]',
  '[^1]: ',
  '^[',
  '<details>',
  '</details>',
  '<b>',
  '---\n',
  ':::callout\n',
  ':::\n',
  '中',
);
const mdString = fc.array(mdChar, { maxLength: 60 }).map((a) => a.join(''));

/** 去掉块 ID 的块树（比较模型用）。 */
function shape(doc: Doc, ids = doc.root): unknown[] {
  return ids.map((id) => {
    const { hash: _h, id: _i, ...rest } = getBlock(doc, id);
    if (rest.kind === 'component' && rest.slots) return { ...rest, slots: rest.slots.map((s) => shape(doc, s)) };
    return rest;
  });
}

// ── 随机 Obsidian 笔记（由能被模型表达的构造组成） ──
const word = fc.constantFrom('alpha', 'beta', '中文', 'x1', 'Note', 'gamma', '标题');
const words = fc.array(word, { minLength: 1, maxLength: 4 }).map((w) => w.join(' '));
const inlinePiece = fc.oneof(
  words,
  word.map((w) => `**${w}**`),
  word.map((w) => `*${w}*`),
  word.map((w) => `==${w}==`),
  word.map((w) => `\`${w}\``),
  word.map((w) => `[[${w}]]`),
  fc.tuple(word, word).map(([a, b]) => `[[${a}#${b}|${b}]]`),
  word.map((w) => `[[${w}#^blk-1]]`),
  word.map((w) => `![[${w}.png|200]]`),
  word.map((w) => `#${w}`),
  word.map((w) => `$${w}^2$`),
  word.map((w) => `%%${w}%%`),
  word.map((w) => `^[${w}]`),
  word.map((w) => `[${w}](https://ex.invalid/${w})`),
);
const inline = fc.array(inlinePiece, { minLength: 1, maxLength: 5 }).map((p) => p.join(' '));
const id = fc.option(fc.constantFrom('goal-1', 'abc', 'm0-spec', 'x9'), { nil: undefined });
const withId = (s: string, i: string | undefined): string => (i ? `${s} ^${i}` : s);
const block = fc.oneof(
  fc.tuple(inline, id).map(([s, i]) => withId(s, i)),
  fc.tuple(fc.integer({ min: 1, max: 3 }), words).map(([n, s]) => `${'#'.repeat(n)} ${s}`),
  fc
    .array(fc.tuple(fc.constantFrom('- ', '- [ ] ', '- [x] ', '1. '), inline), { minLength: 1, maxLength: 3 })
    .map((xs) => xs.map(([m, s]) => `${m}${s}`).join('\n')),
  fc
    .tuple(fc.constantFrom('note', 'tip', 'warning', 'custom-x'), fc.constantFrom('', '-', '+'), words, inline)
    .map(([k, f, t, b]) => `> [!${k}]${f} ${t}\n> ${b}`),
  words.map((s) => `> ${s}`),
  fc.tuple(fc.constantFrom('js', 'mermaid', 'dataview', ''), words).map(([l, s]) => `\`\`\`${l}\n${s}\n\`\`\``),
  words.map((s) => `$$\n${s}\n$$`),
  fc.tuple(word, word).map(([a, b]) => `| ${a} | ${b} |\n| --- | :-: |\n| [[${a}\\|${b}]] | $x$ |`),
  word.map((w) => `![[${w}.png]]`),
  word.map((w) => `![[${w}#^blk-1]]`),
  words.map((s) => `%%\n${s}\n%%`),
  fc.constant('---'),
  words.map((s) => `<details>\n<summary>${s}</summary>\n\n${s}\n\n</details>`),
);
const note = fc
  .tuple(
    fc.option(fc.constant('---\ntags: [a, b]\ncreated: 2026-11-01\n---\n\n'), { nil: '' }),
    fc.array(block, { maxLength: 6 }),
  )
  .map(([fm, bs]) => fm + bs.join('\n\n') + (bs.length ? '\n' : ''));

describe('markdown import/export properties', () => {
  it('import never throws and always yields a valid doc', () => {
    fc.assert(
      fc.property(fc.oneof(mdString, fc.string({ unit: 'grapheme', maxLength: 80 })), (s) => {
        const r = importMarkdown(s);
        expect(validateDoc(r.doc)).toEqual([]);
        exportMarkdown(r.doc);
        exportMarkdown(r.doc, { verbatim: false });
        exportMarkdown(r.doc, { flavor: 'commonmark' });
      }),
      { numRuns: 400 },
    );
  });

  it('unedited export reproduces any input byte-for-byte (except security sanitization)', () => {
    fc.assert(
      fc.property(fc.oneof(mdString, note), (s) => {
        const r = importMarkdown(s);
        if (r.report.sanitized.length > 0) return;
        expect(exportMarkdown(r.doc)).toBe(s);
      }),
      { numRuns: 400 },
    );
  });

  it('export∘import is idempotent on random Obsidian notes (model-only generator)', () => {
    fc.assert(
      fc.property(note, (s) => {
        const g1 = exportMarkdown(importMarkdown(s).doc, { verbatim: false });
        const d2 = importMarkdown(g1).doc;
        const g2 = exportMarkdown(d2, { verbatim: false });
        expect(g2).toBe(g1);
        // 生成的文本读回得到同一模型
        expect(shape(d2)).toEqual(shape(importMarkdown(s).doc));
      }),
      { numRuns: 300 },
    );
  });

  it('export∘import is idempotent on arbitrary strings (model-only generator)', () => {
    fc.assert(
      fc.property(mdString, (s) => {
        const g1 = exportMarkdown(importMarkdown(s).doc, { verbatim: false });
        const g2 = exportMarkdown(importMarkdown(g1).doc, { verbatim: false });
        expect(g2).toBe(g1);
      }),
      { numRuns: 300 },
    );
  });
});
