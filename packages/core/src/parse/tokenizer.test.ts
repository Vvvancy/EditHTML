import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Tokenizer, type Token } from './tokenizer.js';
import type { ParseWarningCode } from './warnings.js';

function tokens(src: string): { toks: Token[]; warns: ParseWarningCode[] } {
  const warns: ParseWarningCode[] = [];
  const tz = new Tokenizer(src, (c) => warns.push(c));
  const toks: Token[] = [];
  for (let t = tz.next(); t.type !== 'eof'; t = tz.next()) toks.push(t);
  return { toks, warns };
}

const summary = (src: string): string[] =>
  tokens(src).toks.map((t) => {
    switch (t.type) {
      case 'start':
        return `<${t.name}${t.attrs.map((a) => ` ${a.name}=${a.value}`).join('')}${t.selfClosing ? '/' : ''}>`;
      case 'end':
        return `</${t.name}>`;
      case 'comment':
        return `#${t.data}`;
      case 'doctype':
        return '!doctype';
      case 'text':
        return `${t.raw ? 'raw' : 'text'}:${src.slice(t.start, t.end)}`;
      default:
        return t.type;
    }
  });

describe('Tokenizer', () => {
  it('tags, attributes and text', () => {
    expect(summary('<!DOCTYPE html><P Class=a data-x=\'1 2\' id="q&amp;r" checked>hi</P>')).toEqual([
      '!doctype',
      '<p class=a data-x=1 2 id=q&r checked=>',
      'text:hi',
      '</p>',
    ]);
  });

  it('first duplicate attribute wins; self-closing', () => {
    expect(summary('<br a=1 a="2"/>')).toEqual(['<br a=1/>']);
  });

  it('literal < in text', () => {
    expect(summary('a < b <3 <> c')).toEqual(['text:a < b <3 <> c']);
  });

  it('raw text elements', () => {
    expect(summary('<script>if (a<b) x("</div>")</script><STYLE>p{}</style >')).toEqual([
      '<script>',
      'raw:if (a<b) x("</div>")',
      '</script>',
      '<style>',
      'raw:p{}',
      '</style>',
    ]);
    expect(summary('<script></scripty></SCRIPT>')).toEqual(['<script>', 'raw:</scripty>', '</script>']);
  });

  it('comments and bogus comments', () => {
    expect(summary('<!--a--><!----><!--><!---><!--x--!><?xml v?><!x></>')).toEqual([
      '#a',
      '#',
      '#',
      '#',
      '#x',
      '#?xml v?',
      '#x',
      '#',
    ]);
  });

  it('offsets are contiguous and cover the input', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom('<p>', '</p>', '<a href="x">', '<!--', '-->', '<script>', '</script>', 'x', '<', '&', '"'),
          {
            maxLength: 30,
          },
        ),
        (parts) => {
          const src = parts.join('');
          const { toks } = tokens(src);
          let pos = 0;
          for (const t of toks) {
            expect(t.start).toBe(pos);
            expect(t.end).toBeGreaterThan(t.start);
            pos = t.end;
          }
          expect(pos).toBe(src.length);
        },
      ),
    );
  });

  it('EOF inside tag / comment / raw text warns', () => {
    expect(tokens('<p class="x').warns).toEqual(['eof-in-tag']);
    expect(tokens('<!-- x').warns).toEqual(['eof-in-comment']);
    expect(tokens('<style>p{').warns).toEqual(['eof-in-raw-text']);
  });

  it('reset leaves raw-text state', () => {
    const tz = new Tokenizer('<script>x</script>');
    tz.next();
    tz.reset(8);
    expect(tz.next()).toMatchObject({ type: 'text', raw: false, start: 8, end: 9 });
  });
});
