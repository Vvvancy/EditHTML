/**
 * 文件字节 ↔ 文本（T2.7）。保真模式要求未改动的字节逐字节相同，因此：
 *
 * - 只接受合法的 UTF-8（`fatal: true`）：非法序列一旦被替换成 U+FFFD，写回就不可能逐字节相同；
 * - BOM 单独记录、不进入文本：`File.text()` / 默认的 `TextDecoder` 会悄悄吃掉 BOM，
 *   而把 BOM 留在文本里又会让 HTML 解析器把它当成正文字符（`<!doctype>` 随之失效、页面进入怪异模式）。
 *   浏览器直接打开文件时同样是先按 BOM 嗅探再丢弃它，所以「去掉 BOM 的文本」才是页面真正的源码；
 *   保存时再按 {@link HtmlText.bom} 补回 `EF BB BF`。
 *
 * @module
 */

/** 解码后的文件内容。 */
export interface HtmlText {
  /** 文件文本（不含 BOM），即区间索引所用的原文。 */
  readonly text: string;
  /** 原文件是否以 UTF-8 BOM 开头；保存时据此补回。 */
  readonly bom: boolean;
}

/** 文件不是合法的 UTF-8。 */
export class EncodingError extends Error {
  constructor(message = '暂只支持 UTF-8 编码的文件：其他编码无法保证保存时逐字节保真') {
    super(message);
    this.name = 'EncodingError';
  }
}

const BOM = '﻿';

/**
 * 把文件字节解码为文本，保留 BOM 信息。
 *
 * @throws {EncodingError} 字节不是合法的 UTF-8（含 UTF-16 BOM 的文件）。
 */
export function decodeHtml(bytes: ArrayBuffer | Uint8Array): HtmlText {
  let raw: string;
  try {
    // ignoreBOM: true —— 不让解码器吞掉 BOM，由我们自己判断并记录。
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new EncodingError();
  }
  return raw.startsWith(BOM) ? { text: raw.slice(1), bom: true } : { text: raw, bom: false };
}

/** {@link decodeHtml} 的逆：编码为 UTF-8，按需补回 BOM。 */
export function encodeHtml(content: HtmlText): Uint8Array {
  return new TextEncoder().encode(content.bom ? BOM + content.text : content.text);
}
