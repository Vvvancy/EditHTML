import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EncodingError, decodeHtml, encodeHtml } from './encoding.js';

const bytes = (...xs: number[]): Uint8Array => new Uint8Array(xs);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const BOM = [0xef, 0xbb, 0xbf];

describe('decodeHtml / encodeHtml', () => {
  it('默认的 TextDecoder 会吞掉 BOM（因此不能直接用 File.text()）', () => {
    expect(new TextDecoder().decode(bytes(...BOM, 0x61))).toBe('a');
  });

  it('BOM 单独记录，不进入文本，保存时补回', () => {
    const src = bytes(...BOM, ...utf8('<!doctype html><p>你好</p>'));
    const d = decodeHtml(src);
    expect(d).toEqual({ text: '<!doctype html><p>你好</p>', bom: true });
    expect(encodeHtml(d)).toEqual(src);
  });

  it('没有 BOM 时不添加', () => {
    const src = utf8('<p>x</p>\r\n');
    const d = decodeHtml(src);
    expect(d.bom).toBe(false);
    expect(encodeHtml(d)).toEqual(src);
  });

  it('只去掉第一个 BOM（第二个是正文字符）', () => {
    const src = bytes(...BOM, ...BOM, 0x61);
    const d = decodeHtml(src);
    expect(d.text).toBe('﻿a');
    expect(encodeHtml(d)).toEqual(src);
  });

  it('非法 UTF-8 / UTF-16 文件报 EncodingError，而不是替换成 U+FFFD', () => {
    expect(() => decodeHtml(bytes(0x3c, 0xff, 0x3e))).toThrow(EncodingError);
    expect(() => decodeHtml(bytes(0xff, 0xfe, 0x3c, 0x00))).toThrow(EncodingError);
    expect(() => decodeHtml(bytes(0xc4, 0xe3))).toThrow(/UTF-8/); // GBK「你」
  });

  it('属性：任意合法 UTF-8（含或不含 BOM）逐字节往返', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), fc.boolean(), (s, bom) => {
        const src = bom ? bytes(...BOM, ...utf8(s)) : utf8(s);
        expect(encodeHtml(decodeHtml(src))).toEqual(src);
      }),
    );
  });
});
