/**
 * 手写的单遍状态机 HTML 分词器（03 §1）。
 *
 * 只做分词，不建树、不依赖 DOM：按需（pull）逐个产出 {@link Token}，每个 token 带源偏移
 * `[start, end)`，便于外来块按原文切片保留。行为参照 HTML 规范的分词阶段，但做了简化：
 *
 * - 标签名、属性名转为小写；重复属性以首次出现为准；属性值解码字符引用；
 * - `script` / `style` / `textarea` / `title` 等开始标签之后进入原始文本状态，直到对应结束标签；
 * - `<` 后不是字母、`/`、`!`、`?` 时按普通文本处理；
 * - 注释、DOCTYPE、`<!…>` / `<?…>`（伪注释）各自成 token；
 * - 文件在标签/注释/原始文本中途结束时尽力产出 token 并告警，**从不抛错**。
 *
 * 文本 token 不解码实体（只给出区间），由调用方按需解码。
 *
 * @module
 */
import { decodeEntities } from './entities.js';
import type { WarnFn } from './warnings.js';

/** 一个属性（名称小写，值已解码）。 */
export interface Attr {
  readonly name: string;
  readonly value: string;
}

/** 开始标签。 */
export interface StartTagToken {
  readonly type: 'start';
  /** 小写标签名。 */
  readonly name: string;
  readonly attrs: readonly Attr[];
  /** 是否以 `/>` 结尾。 */
  readonly selfClosing: boolean;
  readonly start: number;
  readonly end: number;
}

/** 结束标签。 */
export interface EndTagToken {
  readonly type: 'end';
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/** 文本（含原始文本元素内容）。`raw` 为 true 表示来自 `script`/`style` 等原始文本元素。 */
export interface TextToken {
  readonly type: 'text';
  readonly raw: boolean;
  readonly start: number;
  readonly end: number;
}

/** 注释（含伪注释）。`data` 为注释内容。 */
export interface CommentToken {
  readonly type: 'comment';
  readonly data: string;
  readonly start: number;
  readonly end: number;
}

/** `<!doctype …>`。 */
export interface DoctypeToken {
  readonly type: 'doctype';
  readonly start: number;
  readonly end: number;
}

/** 输入结束。 */
export interface EofToken {
  readonly type: 'eof';
  readonly start: number;
  readonly end: number;
}

/** 分词器产出的 token。 */
export type Token = StartTagToken | EndTagToken | TextToken | CommentToken | DoctypeToken | EofToken;

/** 内容为原始文本（不识别标签）的元素。 */
/** 原始文本元素：内容只在匹配的结束标签处终止。 */
export const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

const isWs = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0c || c === 0x0d;
const isAlpha = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** 状态机分词器。 */
export class Tokenizer {
  /** 当前扫描位置。 */
  private pos = 0;
  /** 非 null 时处于原始文本状态，值为等待的结束标签名。 */
  private rawEnd: string | null = null;
  private readonly src: string;
  private readonly warn: WarnFn;

  /**
   * @param src 源 HTML。
   * @param warn 告警回调。
   * @param start 起始偏移，默认 0。
   */
  constructor(src: string, warn: WarnFn = () => {}, start = 0) {
    this.src = src;
    this.warn = warn;
    this.pos = start;
  }

  /** 当前扫描位置（下一个 token 的起点）。 */
  get position(): number {
    return this.pos;
  }

  /** 跳到指定位置并退出原始文本状态（用于解析器回滚）。 */
  reset(pos: number): void {
    this.pos = pos;
    this.rawEnd = null;
  }

  /** 产出下一个 token；到达末尾后始终返回 `eof`。 */
  next(): Token {
    const src = this.src;
    const n = src.length;
    const start = this.pos;
    if (start >= n) return { type: 'eof', start: n, end: n };
    if (this.rawEnd !== null) return this.rawText();

    if (src.charCodeAt(start) === 0x3c /* < */ && start + 1 < n) {
      const c = src.charCodeAt(start + 1);
      if (isAlpha(c)) return this.startTag();
      if (c === 0x2f /* / */) {
        const c2 = start + 2 < n ? src.charCodeAt(start + 2) : -1;
        if (isAlpha(c2)) return this.endTag();
        if (c2 === 0x3e /* > */) {
          // `</>`：按规范直接忽略，作为空注释返回以保持偏移连续
          this.pos = start + 3;
          return { type: 'comment', data: '', start, end: this.pos };
        }
        if (c2 !== -1) return this.bogusComment(start + 2);
      }
      if (c === 0x21 /* ! */) return this.markup();
      if (c === 0x3f /* ? */) return this.bogusComment(start + 1);
    }
    return this.text();
  }

  /** 普通文本：直到下一个可能开启标签的 `<`。 */
  private text(): TextToken {
    const src = this.src;
    const n = src.length;
    const start = this.pos;
    let i = start + 1;
    for (;;) {
      i = src.indexOf('<', i);
      if (i < 0 || i + 1 >= n) {
        i = n;
        break;
      }
      const c = src.charCodeAt(i + 1);
      if (isAlpha(c) || c === 0x2f || c === 0x21 || c === 0x3f) break;
      i++;
    }
    this.pos = i;
    return { type: 'text', raw: false, start, end: i };
  }

  /** 原始文本：直到 `</name` + (空白 | `/` | `>`)，大小写不敏感。 */
  private rawText(): Token {
    const src = this.src;
    const n = src.length;
    const name = this.rawEnd as string;
    const start = this.pos;
    let i = start;
    for (;;) {
      i = src.indexOf('</', i);
      if (i < 0) break;
      let j = i + 2;
      let k = 0;
      while (k < name.length && j < n && (src.charCodeAt(j) | 0x20) === name.charCodeAt(k)) {
        j++;
        k++;
      }
      if (k === name.length) {
        const c = j < n ? src.charCodeAt(j) : -1;
        if (c === -1 || isWs(c) || c === 0x2f || c === 0x3e) break;
      }
      i += 2;
    }
    this.rawEnd = null;
    if (i < 0) {
      this.warn('eof-in-raw-text', `unterminated <${name}> content`, start);
      this.pos = n;
      return { type: 'text', raw: true, start, end: n };
    }
    if (i === start) return this.endTag();
    this.pos = i;
    return { type: 'text', raw: true, start, end: i };
  }

  /** 读取标签名（`pos` 指向名称首字符），返回小写名并推进 `pos`。 */
  private tagName(): string {
    const src = this.src;
    const n = src.length;
    const s = this.pos;
    let i = s;
    let upper = false;
    for (; i < n; i++) {
      const c = src.charCodeAt(i);
      if (isWs(c) || c === 0x2f || c === 0x3e) break;
      if (c >= 0x41 && c <= 0x5a) upper = true;
    }
    this.pos = i;
    const name = src.slice(s, i);
    return upper ? name.toLowerCase() : name;
  }

  private startTag(): StartTagToken {
    const src = this.src;
    const n = src.length;
    const start = this.pos;
    this.pos = start + 1;
    const name = this.tagName();
    const attrs: Attr[] = [];
    let seen: Set<string> | null = null;
    let selfClosing = false;
    let closed = false;
    // 状态：属性前空白 → 属性名 → 属性名后 → 值前 → 值（引号/无引号）→ 值后
    while (this.pos < n) {
      let c = src.charCodeAt(this.pos);
      if (isWs(c)) {
        this.pos++;
        continue;
      }
      if (c === 0x3e /* > */) {
        this.pos++;
        closed = true;
        break;
      }
      if (c === 0x2f /* / */) {
        this.pos++;
        if (this.pos < n && src.charCodeAt(this.pos) === 0x3e) {
          this.pos++;
          selfClosing = true;
          closed = true;
          break;
        }
        continue;
      }
      // 属性名（首字符可以是 `=`，按规范视为名称的一部分）
      const ns = this.pos;
      this.pos++;
      while (this.pos < n) {
        c = src.charCodeAt(this.pos);
        if (isWs(c) || c === 0x2f || c === 0x3e || c === 0x3d) break;
        this.pos++;
      }
      const attrName = src.slice(ns, this.pos).toLowerCase();
      while (this.pos < n && isWs(src.charCodeAt(this.pos))) this.pos++;
      let value = '';
      if (this.pos < n && src.charCodeAt(this.pos) === 0x3d /* = */) {
        this.pos++;
        while (this.pos < n && isWs(src.charCodeAt(this.pos))) this.pos++;
        const q = this.pos < n ? src.charCodeAt(this.pos) : -1;
        if (q === 0x22 || q === 0x27) {
          const vs = this.pos + 1;
          let ve = src.indexOf(q === 0x22 ? '"' : "'", vs);
          if (ve < 0) ve = n;
          value = decodeEntities(src.slice(vs, ve), true, vs, this.warn);
          this.pos = Math.min(ve + 1, n);
        } else if (q !== 0x3e && q !== -1) {
          const vs = this.pos;
          while (this.pos < n) {
            c = src.charCodeAt(this.pos);
            if (isWs(c) || c === 0x3e) break;
            this.pos++;
          }
          value = decodeEntities(src.slice(vs, this.pos), true, vs, this.warn);
        }
      }
      if (seen === null) seen = new Set();
      if (!seen.has(attrName)) {
        seen.add(attrName);
        attrs.push({ name: attrName, value });
      }
    }
    if (!closed) this.warn('eof-in-tag', `end of input inside <${name}> tag`, start);
    if (RAW_TEXT.has(name)) this.rawEnd = name;
    return { type: 'start', name, attrs, selfClosing, start, end: this.pos };
  }

  private endTag(): EndTagToken {
    const src = this.src;
    const n = src.length;
    const start = this.pos;
    this.pos = start + 2;
    const name = this.tagName();
    // 跳过结束标签中的（非法）属性，尊重引号
    let closed = false;
    while (this.pos < n) {
      const c = src.charCodeAt(this.pos);
      if (c === 0x3e) {
        this.pos++;
        closed = true;
        break;
      }
      if (c === 0x22 || c === 0x27) {
        const e = src.indexOf(c === 0x22 ? '"' : "'", this.pos + 1);
        this.pos = e < 0 ? n : e + 1;
        continue;
      }
      this.pos++;
    }
    if (!closed) this.warn('eof-in-tag', `end of input inside </${name}> tag`, start);
    return { type: 'end', name, start, end: this.pos };
  }

  /** `<!` 开头：注释、DOCTYPE 或伪注释。 */
  private markup(): Token {
    const src = this.src;
    const start = this.pos;
    if (src.startsWith('<!--', start)) return this.comment();
    if (src.length - start >= 9 && src.slice(start + 2, start + 9).toLowerCase() === 'doctype') {
      const e = src.indexOf('>', start);
      this.pos = e < 0 ? src.length : e + 1;
      if (e < 0) this.warn('eof-in-tag', 'end of input inside <!doctype>', start);
      return { type: 'doctype', start, end: this.pos };
    }
    return this.bogusComment(start + 2);
  }

  private comment(): CommentToken {
    const src = this.src;
    const start = this.pos;
    const ds = start + 4;
    // `<!-->` 与 `<!--->`：规范中的"突然闭合"注释
    if (src.startsWith('>', ds)) {
      this.pos = ds + 1;
      return { type: 'comment', data: '', start, end: this.pos };
    }
    if (src.startsWith('->', ds)) {
      this.pos = ds + 2;
      return { type: 'comment', data: '', start, end: this.pos };
    }
    // 结束于第一个 `-->` 或 `--!>`
    let i = ds;
    for (;;) {
      i = src.indexOf('--', i);
      if (i < 0) {
        this.warn('eof-in-comment', 'unterminated comment', start);
        this.pos = src.length;
        return { type: 'comment', data: src.slice(ds), start, end: this.pos };
      }
      const c = src.charCodeAt(i + 2);
      if (c === 0x3e /* > */) {
        this.pos = i + 3;
        break;
      }
      if (c === 0x21 /* ! */ && src.charCodeAt(i + 3) === 0x3e) {
        this.pos = i + 4;
        break;
      }
      i++;
    }
    return { type: 'comment', data: src.slice(ds, i), start, end: this.pos };
  }

  /** 伪注释：从 `dataStart` 到下一个 `>`。 */
  private bogusComment(dataStart: number): CommentToken {
    const src = this.src;
    const start = this.pos;
    const e = src.indexOf('>', dataStart);
    this.pos = e < 0 ? src.length : e + 1;
    return { type: 'comment', data: src.slice(dataStart, e < 0 ? src.length : e), start, end: this.pos };
  }
}

/** 是否全为 HTML 空白（空格、制表、换行、换页、回车）。 */
export function isWhitespaceRange(src: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (!isWs(src.charCodeAt(i))) return false;
  return true;
}
