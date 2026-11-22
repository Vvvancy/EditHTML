/**
 * 路线图 T1.7 验收：`exportMarkdown(importMarkdown(md).doc, {flavor: 'obsidian'})` 与原文逐字节一致
 * （只允许 {@link normalizeMarkdownWhitespace} 定义的空白规范化），覆盖 `tests/fixtures/obsidian/vault/**` 与
 * `tests/fixtures/md/*.md`。不能往返的样本列在 {@link ALLOWLIST} 中，并写明原因。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDoc } from '@edithtml/core';
import { describe, expect, it } from 'vitest';
import { exportMarkdown, importMarkdown, normalizeMarkdownWhitespace } from './index.js';

const FIXTURES = fileURLToPath(new URL('../../../../tests/fixtures/', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((f) => {
      const p = join(dir, f);
      if (f === '.obsidian') return [];
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [];
    });
}

const FILES = [...walk(join(FIXTURES, 'obsidian/vault')), ...walk(join(FIXTURES, 'md'))];

/**
 * 不能逐字节往返的样本：键为相对 `tests/fixtures/` 的路径；值为原因，以及允许不同的原文行
 * （这些行之外必须逐字节一致）。与 obsidian/EXPECTED.md"不能往返"一节对应。
 */
const ALLOWLIST: Readonly<Record<string, { reason: string; lines: readonly string[] }>> = {
  'obsidian/vault/notes/Raw HTML.md': {
    reason:
      'EXPECTED.md：被剔除的 onclick / javascript: 是故意的安全差异（01 §9），永远不能往返；含这些内容的段不保存原文',
    lines: ['<button onclick="alert(1)">带 onclick 的按钮</button> <a href="javascript:alert(2)">危险链接</a>'],
  },
  'md/36-entities-unicode.md': {
    reason: '同上：原始 HTML 中的 onclick 与 javascript: 链接被安全清洗',
    lines: [
      '<p data-eh="eu9" onclick="alert(1)">Markdown 中的原始 HTML 块，带 onclick —— 预期：清洗后保留为 p，或作为外来块？</p>',
      '[javascript 链接](javascript:alert(1)) —— 预期：href 被剔除。 ^eu10',
    ],
  },
};

describe('T1.7 Markdown round trip (obsidian flavor)', () => {
  it('covers the fixture set', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(16 + 21);
  });

  for (const file of FILES) {
    const name = relative(FIXTURES, file);
    it(name, () => {
      const src = readFileSync(file, 'utf8');
      const { doc, report } = importMarkdown(src);
      expect(validateDoc(doc)).toEqual([]);
      expect(report.dropped).toEqual([]);
      const out = exportMarkdown(doc, { flavor: 'obsidian' });
      const allowed = ALLOWLIST[name];
      if (!allowed) {
        expect(normalizeMarkdownWhitespace(out)).toBe(normalizeMarkdownWhitespace(src));
        // 实际上连规范化都不需要
        expect(out).toBe(src);
        return;
      }
      expect(report.sanitized.length).toBeGreaterThan(0);
      const a = normalizeMarkdownWhitespace(src).split('\n');
      const b = normalizeMarkdownWhitespace(out).split('\n');
      expect(b.length).toBe(a.length);
      const differing = a.filter((l, i) => l !== b[i]);
      expect(differing).toEqual(allowed.lines);
    });
  }

  it('re-imports its own output to the same export (idempotent)', () => {
    for (const file of FILES) {
      const once = exportMarkdown(importMarkdown(readFileSync(file, 'utf8')).doc);
      expect(exportMarkdown(importMarkdown(once).doc)).toBe(once);
    }
  });

  it('model-only export (no verbatim sources) is idempotent on every fixture', () => {
    for (const file of FILES) {
      const g1 = exportMarkdown(importMarkdown(readFileSync(file, 'utf8')).doc, { verbatim: false });
      const g2 = exportMarkdown(importMarkdown(g1).doc, { verbatim: false });
      expect(g2, relative(FIXTURES, file)).toBe(g1);
    }
  });
});
