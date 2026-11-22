import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, validateDoc } from '@edithtml/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectFormat, ehmdMarkdown, lineColumn, run } from './index.js';

const FIX = join(__dirname, '../../../tests/fixtures');
let dir: string;
let out: string;
let err: string;

const eh = (...argv: string[]): Promise<number> =>
  run(argv, { io: { out: (s) => (out += s), err: (s) => (err += s) }, markdown: ehmdMarkdown, cwd: dir });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eh-cli-'));
  out = '';
  err = '';
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('basics', () => {
  it('prints help and version; rejects unknown commands', async () => {
    expect(await eh()).toBe(0);
    expect(out).toContain('eh convert');
    out = '';
    expect(await eh('--version')).toBe(0);
    expect(out.trim()).toBe('0.1');
    expect(await eh('frobnicate')).toBe(2);
    expect(err).toContain('unknown command');
  });

  it('detects formats', () => {
    expect(detectFormat('a.eh.html')).toBe('ehtml');
    expect(detectFormat('a.html', '<html data-eh-version="0.1">')).toBe('ehtml');
    expect(detectFormat('a.html', '<html lang="en">')).toBe('html');
    expect(detectFormat('a.md')).toBe('md');
    expect(detectFormat('a.ehmd')).toBe('ehmd');
    expect(detectFormat('a.txt')).toBeNull();
  });

  it('converts offsets to line:column', () => {
    expect(lineColumn('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
    expect(lineColumn('ab', 0)).toEqual({ line: 1, column: 1 });
  });
});

describe('eh fmt', () => {
  it('--check passes on canonical files and fails on non-canonical ones', async () => {
    await cp(join(FIX, 'ehtml/02-minimal.ehtml'), join(dir, 'a.eh.html'));
    await cp(join(FIX, 'ehtml/20-noncanonical-format.ehtml'), join(dir, 'b.eh.html'));
    expect(await eh('fmt', '--check', 'a.eh.html')).toBe(0);
    expect(await eh('fmt', '--check', 'b.eh.html')).toBe(1);
    expect(out).toContain('b.eh.html: not canonical');
  });

  it('rewrites files into canonical form (idempotent)', async () => {
    await cp(join(FIX, 'ehtml/20-noncanonical-format.ehtml'), join(dir, 'b.eh.html'));
    expect(await eh('fmt', '.')).toBe(0);
    const once = await readFile(join(dir, 'b.eh.html'), 'utf8');
    expect(await eh('fmt', '--check', '.')).toBe(0);
    expect(validateDoc(parse(once).doc)).toEqual([]);
  });
});

describe('eh check', () => {
  it('reports warnings with file:line:col and honours --strict', async () => {
    await cp(join(FIX, 'ehtml/17-security-strip.ehtml'), join(dir, 's.eh.html'));
    expect(await eh('check', 's.eh.html')).toBe(0);
    expect(out).toMatch(/^s\.eh\.html:\d+:\d+: stripped-event-handler: /m);
    expect(await eh('check', '--strict', 's.eh.html')).toBe(1);
  });

  it('passes clean files', async () => {
    await cp(join(FIX, 'ehtml/02-minimal.ehtml'), join(dir, 'a.eh.html'));
    expect(await eh('check', '--strict', 'a.eh.html')).toBe(0);
  });
});

describe('eh convert', () => {
  it('converts a Markdown note into a browser-openable .eh.html next to it', async () => {
    await cp(join(FIX, 'md/03-headings-paragraphs.md'), join(dir, 'note.md'));
    expect(await eh('convert', 'note.md')).toBe(0);
    const html = await readFile(join(dir, 'note.eh.html'), 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('data-eh-version="0.1"');
    const { doc } = parse(html);
    expect(validateDoc(doc)).toEqual([]);
    expect(doc.root.length).toBeGreaterThan(0);
    // source untouched
    expect(await readFile(join(dir, 'note.md'), 'utf8')).toBe(
      await readFile(join(FIX, 'md/03-headings-paragraphs.md'), 'utf8'),
    );
  });

  it('never overwrites existing targets without --force, nor the source itself', async () => {
    await writeFile(join(dir, 'n.md'), '# hi\n');
    await writeFile(join(dir, 'n.eh.html'), 'keep me');
    expect(await eh('convert', 'n.md')).toBe(1);
    expect(await readFile(join(dir, 'n.eh.html'), 'utf8')).toBe('keep me');
    expect(await eh('convert', '--force', 'n.md')).toBe(0);
    expect(await readFile(join(dir, 'n.eh.html'), 'utf8')).toContain('<h1');
    await writeFile(join(dir, 'x.eh.html'), await readFile(join(dir, 'n.eh.html'), 'utf8'));
    expect(await eh('convert', '--to', 'ehtml', '--force', 'x.eh.html')).toBe(1);
    expect(err).toContain('refusing to overwrite the source');
  });

  it('converts .eh.html back to Markdown', async () => {
    await writeFile(join(dir, 'n.md'), '# 标题\n\n一段 **正文**。\n');
    await eh('convert', 'n.md', '-o', 'n.eh.html');
    expect(await eh('convert', 'n.eh.html', '-o', 'back.md')).toBe(0);
    expect(await readFile(join(dir, 'back.md'), 'utf8')).toBe('# 标题\n\n一段 **正文**。\n');
  });

  it('converts a whole folder into a mirrored tree, skipping dot-folders', async () => {
    const vault = join(dir, 'vault');
    await mkdir(join(vault, 'sub'), { recursive: true });
    await mkdir(join(vault, '.obsidian'), { recursive: true });
    await writeFile(join(vault, 'a.md'), '# A\n');
    await writeFile(join(vault, 'sub', 'b.md'), '- [ ] task\n');
    await writeFile(join(vault, '.obsidian', 'c.md'), '# ignored\n');
    expect(await eh('convert', 'vault', '-o', 'out')).toBe(0);
    expect((await readdir(join(dir, 'out'))).sort()).toEqual(['a.eh.html', 'sub']);
    expect(await readdir(join(dir, 'out', 'sub'))).toEqual(['b.eh.html']);
    expect(out).toContain('converted 2 file(s)');
  });

  it('converts every md fixture without failure', async () => {
    await cp(join(FIX, 'md'), join(dir, 'md'), { recursive: true });
    expect(await eh('convert', 'md', '-o', 'out')).toBe(0);
    for (const f of await readdir(join(dir, 'out'))) {
      const { doc } = parse(await readFile(join(dir, 'out', f), 'utf8'));
      expect(validateDoc(doc)).toEqual([]);
    }
  });
});
