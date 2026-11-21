/**
 * `.ehtml` 解析器（01 §6.1，03 §1）：单遍扫描 {@link Tokenizer} 的 token 流，**直接产出块**，
 * 不构建中间 DOM 树；规范外内容记录源区间 `[start, end)`，作为外来块原文切片保留。
 *
 * 流程：
 * 1. 扫描：识别文件骨架 / head，按块产出"待定块"（{@link Pending}，此时尚未分配最终 ID）；
 * 2. 扫描结束后按文档顺序处理块 ID：首次出现的合法 ID 保留，缺失/重复/不合法者用
 *    `createIdGenerator` 重新分配；
 * 3. 修正列表 indent 不变量，构造不可变 `Block`（计算哈希）与 `Doc`。
 *
 * 解析器从不抛错：损坏的输入尽力恢复并产生 {@link ParseWarning}。
 *
 * @module
 */
import { createIdGenerator, isValidBlockId } from '../ids.js';
import {
  createDoc,
  type Block,
  type BlockId,
  type CellAlign,
  type Doc,
  type DocHead,
  type DocMeta,
  type InlineNode,
  type Mark,
  type MarkType,
  type TableData,
  type TextBlockType,
} from '../model.js';
import { decodeEntities } from './entities.js';
import { makeComponentBlock, makeForeignBlock, makeTextBlock, normalizeInlineFast } from './fast.js';
import { isWhitespaceRange, Tokenizer, type Attr, type StartTagToken, type Token } from './tokenizer.js';
import type { ParseWarning, ParseWarningCode } from './warnings.js';

/** 解析选项。 */
export interface ParseOptions {
  /** 重新分配块 ID 时使用的前缀，默认 `'b'`（见 `createIdGenerator`）。 */
  readonly idPrefix?: string;
  /**
   * 结构嵌套（容器块、嵌套列表）的安全上限，默认 64。超过时容器块改为外来块、嵌套列表扁平化，
   * 并告警 `depth-limit`。这只是防止恶意输入导致栈溢出的保护，不是规范的嵌套上限（见 05 #5）。
   */
  readonly maxDepth?: number;
}

/** 解析结果。 */
export interface ParseResult {
  /** 解析得到的文档（`validateDoc(doc)` 恒为空）。 */
  readonly doc: Doc;
  /** 告警：扫描阶段的告警按源码顺序在前，块 ID 重新分配的告警在后。 */
  readonly warnings: ParseWarning[];
}

// ───────────────────────────── 待定块 ─────────────────────────────

interface PendingBase {
  /** 源码中的 `data-eh`（可能缺失/重复/不合法）。 */
  rawId: string | undefined;
  /** 块在源码中的起始偏移（告警定位）。 */
  offset: number;
  /** 最终 ID，第 2 步填入。 */
  id: BlockId;
}

interface PendingText extends PendingBase {
  k: 'text';
  type: TextBlockType;
  attrs: Record<string, string>;
  content: InlineNode[];
  table?: TableData;
}

interface PendingComponent extends PendingBase {
  k: 'component';
  type: string;
  props: unknown;
  attrs: Record<string, string>;
  slots?: Pending[][];
  fallback?: string;
}

interface PendingForeign extends PendingBase {
  k: 'foreign';
  html: string;
}

type Pending = PendingText | PendingComponent | PendingForeign;

/** 内部控制流：当前结构无法映射为规范块，回滚并改为外来块。 */
class AbortToForeign extends Error {
  /** 回滚后补发的告警（回滚会丢弃尝试期间产生的告警）。 */
  constructor(readonly warning?: ParseWarning) {
    super('abort');
  }
}

// ───────────────────────────── 元素分类 ─────────────────────────────

const MARK_TAGS: ReadonlyMap<string, MarkType> = new Map<string, MarkType>([
  ['strong', 'strong'],
  ['b', 'strong'],
  ['em', 'em'],
  ['i', 'em'],
  ['s', 's'],
  ['del', 's'],
  ['strike', 's'],
  ['mark', 'mark'],
  ['sub', 'sub'],
  ['sup', 'sup'],
  ['kbd', 'kbd'],
  ['code', 'code'],
]);

/** 白名单外、但属于行内语义的元素：去壳保留文本。隐式段落中也可出现。 */
const UNWRAP_INLINE = new Set([
  'span',
  'u',
  'ins',
  'small',
  'big',
  'font',
  'abbr',
  'cite',
  'q',
  'dfn',
  'time',
  'var',
  'samp',
  'tt',
  'bdi',
  'bdo',
  'data',
  'label',
  'nobr',
  'ruby',
  'rb',
  'rt',
  'rp',
]);

/** 文本块内整体丢弃（连同内容）的元素。 */
const DROP_IN_TEXT = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'iframe',
  'object',
  'svg',
  'math',
  'video',
  'audio',
  'canvas',
  'textarea',
  'select',
]);

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
  'keygen',
]);

/** 块级元素：开始标签会结束当前行内内容。 */
const BLOCK_LEVEL = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'caption',
  'col',
  'colgroup',
  'details',
  'dialog',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
const HEAD_ITEMS = new Set(['title', 'meta', 'link', 'style', 'script', 'base', 'noscript', 'template']);

const isBlockLevel = (name: string): boolean => BLOCK_LEVEL.has(name) || name.startsWith('eh-');
const isInlineName = (name: string): boolean =>
  MARK_TAGS.has(name) || UNWRAP_INLINE.has(name) || name === 'a' || name === 'br';

function getAttr(attrs: readonly Attr[], name: string): string | undefined {
  for (const a of attrs) if (a.name === name) return a.value;
  return undefined;
}

/** `javascript:` / `vbscript:` 链接（忽略大小写、空白与控制字符）。 */
function isScriptUrl(href: string): boolean {
  let s = '';
  for (let i = 0; i < href.length && s.length < 11; i++) {
    const c = href.charCodeAt(i);
    if (c <= 0x20) continue;
    s += href[i]?.toLowerCase();
  }
  return s.startsWith('javascript:') || s.startsWith('vbscript:');
}

const ALIGNS = new Set(['left', 'center', 'right']);

function cellAlign(attrs: readonly Attr[]): CellAlign {
  const v = (getAttr(attrs, 'data-eh-align') ?? getAttr(attrs, 'align'))?.trim().toLowerCase();
  if (v && ALIGNS.has(v)) return v as CellAlign;
  const style = getAttr(attrs, 'style');
  if (style) {
    const m = /text-align\s*:\s*(left|center|right)/i.exec(style);
    if (m?.[1]) return m[1].toLowerCase() as CellAlign;
  }
  return null;
}

// ───────────────────────────── 行内解析 ─────────────────────────────

interface InlineCtx {
  /** 结束当前块的结束标签名（会被消费）。 */
  readonly closers: readonly string[];
  /** 隐式段落（裸文本）：遇到任何非行内元素或未匹配的结束标签即停止。 */
  readonly implicit?: boolean;
  /** `<p>` 去壳：多个段落之间插入 `br`（用于 li / blockquote / 单元格 / figcaption）。 */
  readonly unwrapP?: boolean;
  /** 遇到 `<ul>` / `<ol>` 时停止（交给列表项处理嵌套）。 */
  readonly stopOnList?: boolean;
  /** 列表项：开头的 `<input type=checkbox>` 视为任务状态。 */
  readonly li?: boolean;
}

interface InlineResult {
  nodes: InlineNode[];
  /** `closed`：遇到 closer；`block`：遇到块级开始标签（未消费）；`list`：遇到 ul/ol（未消费）；`end`：祖先结束/EOF。 */
  stop: 'closed' | 'block' | 'list' | 'end';
  /** 停止时的 token（未消费的情况）。 */
  tok?: Token;
  task?: 'done' | 'todo';
}

interface InlineFrame {
  readonly name: string;
  readonly mark: Mark | null;
}

// ───────────────────────────── 解析器 ─────────────────────────────

class Parser {
  private readonly src: string;
  private readonly tz: Tokenizer;
  private lookahead: Token | null = null;
  readonly warnings: ParseWarning[] = [];
  /** 全部待定块（先序 = 文档顺序）。 */
  readonly all: Pending[] = [];
  /** 顶层块序列。 */
  readonly root: Pending[] = [];
  /** 当前打开的结构元素（用于判断结束标签是否属于祖先）。 */
  private readonly open: string[] = ['html', 'body'];
  private depth = 0;
  private readonly maxDepth: number;

  // head 状态
  lang: string | undefined;
  title: string | undefined;
  meta: DocMeta | undefined;
  themeCss: string | undefined;
  userCss: string | undefined;
  runtimeSrc: string | undefined;
  private readonly extra: Slices;
  private mainFound = false;
  private inMain = false;
  private firstOutsideMain = -1;

  constructor(src: string, opts: ParseOptions) {
    this.src = src;
    this.maxDepth = opts.maxDepth ?? 64;
    this.tz = new Tokenizer(src, (code, message, offset) => this.warn(code, message, offset));
    this.extra = new Slices(src);
  }

  warn(code: ParseWarningCode, message: string, offset: number): void {
    this.warnings.push({ code, message, offset });
  }

  // ── token 流 ──

  private peek(): Token {
    if (this.lookahead === null) this.lookahead = this.tz.next();
    return this.lookahead;
  }

  private next(): Token {
    const t = this.peek();
    this.lookahead = null;
    return t;
  }

  private resetTo(pos: number): void {
    this.lookahead = null;
    this.tz.reset(pos);
  }

  private isAncestor(name: string): boolean {
    return this.open.lastIndexOf(name) >= 0;
  }

  private decodeText(start: number, end: number): string {
    return decodeEntities(this.src.slice(start, end), false, start, (c, m, o) => this.warn(c, m, o));
  }

  /** 过滤 `on*` 属性（告警），返回剩余属性。 */
  private safeAttrs(tok: StartTagToken): Attr[] {
    let out: Attr[] | null = null;
    tok.attrs.forEach((a, i) => {
      if (a.name.startsWith('on')) {
        this.warn('stripped-event-handler', `stripped ${a.name} attribute on <${tok.name}>`, tok.start);
        if (out === null) out = tok.attrs.slice(0, i);
      } else if (out !== null) out.push(a);
    });
    return out ?? (tok.attrs as Attr[]);
  }

  /** 文本块：只保留规范允许的属性，其余丢弃并告警。 */
  private checkTextAttrs(tok: StartTagToken, allowed: readonly string[]): Attr[] {
    const attrs = this.safeAttrs(tok);
    for (const a of attrs)
      if (a.name !== 'data-eh' && !allowed.includes(a.name))
        this.warn('dropped-attribute', `dropped attribute ${a.name} on <${tok.name}>`, tok.start);
    return attrs;
  }

  /**
   * p / h1–h6 / quote / hr：除 `data-eh` 与 `on*` 外的 HTML 属性原样存入 `attrs`
   * （序列化器把未知键原样写回为 HTML 属性）。
   */
  private keepAttrs(tok: StartTagToken): Record<string, string> {
    const out: Record<string, string> = {};
    for (const a of this.safeAttrs(tok)) if (a.name !== 'data-eh') out[a.name] = a.value;
    return out;
  }

  private add<P extends Pending>(seq: Pending[], p: P): P {
    this.all.push(p);
    seq.push(p);
    if (seq === this.root && !this.inMain && this.firstOutsideMain < 0) this.firstOutsideMain = p.offset;
    return p;
  }

  private rawIdOf(tok: StartTagToken): string | undefined {
    return getAttr(tok.attrs, 'data-eh')?.trim();
  }

  // ── 通用跳过：找到元素结束位置（外来块切片） ──

  /**
   * 从已消费的开始标签起，按标签栈匹配跳到元素结束。遇到祖先的结束标签或 EOF 时视为未闭合。
   * 返回内容结束偏移（结束标签起点）与元素结束偏移。
   */
  private skipElement(tok: StartTagToken): { inner: number; end: number } {
    if (VOID.has(tok.name) || tok.selfClosing) return { inner: tok.end, end: tok.end };
    const stack: string[] = [tok.name];
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') {
        this.warn('unclosed-element', `unclosed <${tok.name}>`, tok.start);
        return { inner: t.start, end: t.start };
      }
      if (t.type === 'start') {
        this.next();
        if (!VOID.has(t.name) && !t.selfClosing) stack.push(t.name);
      } else if (t.type === 'end') {
        const idx = stack.lastIndexOf(t.name);
        if (idx >= 0) {
          this.next();
          stack.length = idx;
          if (idx === 0) return { inner: t.start, end: t.end };
        } else if (this.isAncestor(t.name)) {
          this.warn('unclosed-element', `unclosed <${tok.name}>`, tok.start);
          return { inner: t.start, end: t.start };
        } else this.next();
      } else this.next();
    }
  }

  /** 把已消费开始标签的整个元素作为外来块。 */
  private foreignElement(tok: StartTagToken, seq: Pending[]): void {
    const { end } = this.skipElement(tok);
    this.addForeign(seq, tok.start, end, this.rawIdOf(tok));
  }

  private addForeign(seq: Pending[], start: number, end: number, rawId?: string): void {
    this.warn('foreign-content', 'out-of-spec content kept as a foreign block', start);
    this.add<PendingForeign>(seq, { k: 'foreign', rawId, offset: start, id: '', html: this.src.slice(start, end) });
  }

  // ── 回滚 ──

  private save(seq: Pending[]): () => void {
    const all = this.all.length;
    const s = seq.length;
    const w = this.warnings.length;
    const open = this.open.length;
    const depth = this.depth;
    const firstOutside = this.firstOutsideMain;
    return () => {
      this.all.length = all;
      seq.length = s;
      this.warnings.length = w;
      this.open.length = open;
      this.depth = depth;
      this.firstOutsideMain = firstOutside;
    };
  }

  /** 尝试按规范结构解析；失败时回滚并把整个元素作为外来块。 */
  private attempt(tok: StartTagToken, seq: Pending[], fn: () => void): void {
    const restore = this.save(seq);
    try {
      fn();
    } catch (e) {
      if (!(e instanceof AbortToForeign)) throw e;
      restore();
      if (e.warning) this.warnings.push(e.warning);
      this.resetTo(tok.end);
      this.foreignElement(tok, seq);
    }
  }

  // ── 文档 ──

  parseDocument(): void {
    let bodyStarted = false;
    let inHead = false;
    // 跳过 BOM
    if (this.src.charCodeAt(0) === 0xfeff) this.resetTo(1);
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') break;
      if (!bodyStarted) {
        if (t.type === 'doctype') this.next();
        else if (t.type === 'comment') {
          this.next();
          if (inHead) this.extra.add(t.start, t.end);
        } else if (t.type === 'text' && isWhitespaceRange(this.src, t.start, t.end)) this.next();
        else if (t.type === 'start' && t.name === 'html') {
          this.next();
          this.lang ??= getAttr(t.attrs, 'lang');
        } else if (t.type === 'start' && t.name === 'head') {
          this.next();
          inHead = true;
        } else if (t.type === 'end' && (t.name === 'head' || t.name === 'html' || t.name === 'body')) {
          this.next();
          inHead = false;
        } else if (t.type === 'start' && t.name === 'body') {
          this.next();
          bodyStarted = true;
        } else if (t.type === 'start' && HEAD_ITEMS.has(t.name)) {
          this.next();
          this.headItem(t);
        } else bodyStarted = true;
        continue;
      }
      if (t.type === 'start' && (t.name === 'html' || t.name === 'head' || t.name === 'body')) {
        this.next();
        this.warn('stray-end-tag', `ignored misplaced <${t.name}>`, t.start);
      } else if (t.type === 'end' && (t.name === 'html' || t.name === 'head' || t.name === 'body')) this.next();
      else if (t.type === 'doctype') this.next();
      else this.parseBlocks(this.root, null);
    }
    if (this.mainFound && this.firstOutsideMain >= 0)
      this.warn(
        'content-outside-main',
        'content outside main#eh-doc merged into top-level blocks',
        this.firstOutsideMain,
      );
  }

  private headItem(t: StartTagToken): void {
    const id = getAttr(t.attrs, 'id');
    if (t.name === 'meta') {
      const name = getAttr(t.attrs, 'name')?.toLowerCase();
      if (getAttr(t.attrs, 'charset') !== undefined || name === 'viewport') return;
      this.extra.add(t.start, t.end);
      return;
    }
    const { inner, end } = this.skipElement(t);
    const content = this.src.slice(t.end, inner);
    if (t.name === 'title' && this.title === undefined) {
      this.title = decodeEntities(content, false, t.end, (c, m, o) => this.warn(c, m, o));
      return;
    }
    if (t.name === 'style' && id === 'eh-theme' && this.themeCss === undefined) {
      this.themeCss = content;
      return;
    }
    if (t.name === 'style' && id === 'eh-user-style' && this.userCss === undefined) {
      this.userCss = content;
      return;
    }
    if (t.name === 'script' && id === 'eh-meta' && this.meta === undefined) {
      try {
        const v: unknown = JSON.parse(content);
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          this.meta = v as DocMeta;
          return;
        }
      } catch {
        // 落到下面的告警
      }
      this.warn('invalid-meta', '#eh-meta is not a JSON object; kept in head.extra', t.start);
    } else if (t.name === 'script' && id === 'eh-runtime' && this.runtimeSrc === undefined) {
      const src = getAttr(t.attrs, 'src');
      if (src !== undefined && content.trim() === '') {
        this.runtimeSrc = src;
        return;
      }
    }
    this.extra.add(t.start, end);
  }

  /** head 字段（省略默认值）。 */
  head(): DocHead {
    const head: { -readonly [K in keyof DocHead]: DocHead[K] } = {};
    if (this.lang !== undefined && this.lang !== 'zh-CN') head.lang = this.lang;
    const metaTitle = this.meta?.title;
    if (this.title !== undefined && this.title !== (metaTitle ?? '')) head.title = this.title;
    if (this.themeCss !== undefined) head.themeCss = this.themeCss;
    if (this.userCss !== undefined) head.userCss = this.userCss;
    const extra = this.extra.join('\n    ');
    if (extra !== '') head.extra = extra;
    if (this.runtimeSrc !== undefined) head.runtimeSrc = this.runtimeSrc;
    return head;
  }

  // ── 块序列 ──

  /**
   * 解析块序列，直到 `closer` 结束标签（消费）、祖先结束标签（不消费）或 EOF。
   */
  private parseBlocks(seq: Pending[], closer: string | null): void {
    for (;;) {
      const t = this.peek();
      switch (t.type) {
        case 'eof':
          if (closer !== null) this.warn('unclosed-element', `unclosed <${closer}>`, t.start);
          return;
        case 'end':
          if (t.name === closer) {
            this.next();
            return;
          }
          if (this.isAncestor(t.name)) {
            if (closer !== null) this.warn('unclosed-element', `unclosed <${closer}>`, t.start);
            return;
          }
          this.next();
          this.warn('stray-end-tag', `stray </${t.name}>`, t.start);
          break;
        case 'text':
          if (isWhitespaceRange(this.src, t.start, t.end)) this.next();
          else this.implicitParagraph(seq, t);
          break;
        case 'comment':
          this.next();
          this.addForeign(seq, t.start, t.end);
          break;
        case 'doctype':
          this.next();
          break;
        case 'start':
          if (isInlineName(t.name)) this.implicitParagraph(seq, t);
          else {
            this.next();
            this.blockStart(t, seq);
          }
          break;
      }
    }
  }

  /** 已消费块级开始标签，按类型分派。 */
  private blockStart(t: StartTagToken, seq: Pending[]): void {
    const name = t.name;
    switch (name) {
      case 'p':
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        this.simpleText(t, seq, name, name === 'p' ? ['p'] : HEADINGS);
        return;
      case 'blockquote':
        this.attempt(t, seq, () => this.blockquote(t, seq));
        return;
      case 'pre':
        this.codeBlock(t, seq);
        return;
      case 'hr':
        this.add<PendingText>(seq, this.text(t, 'hr', this.keepAttrs(t)));
        return;
      case 'ul':
      case 'ol':
        this.list(t, 0, seq);
        return;
      case 'li':
        this.listItem(t, 'ul', 0, seq);
        return;
      case 'table':
        this.attempt(t, seq, () => this.table(t, seq));
        return;
      case 'figure':
        this.attempt(t, seq, () => this.figure(t, seq));
        return;
      case 'main':
        if (!this.mainFound && getAttr(t.attrs, 'id') === 'eh-doc' && seq === this.root) {
          this.mainFound = true;
          this.inMain = true;
          this.open.push('main');
          this.parseBlocks(seq, 'main');
          this.open.pop();
          this.inMain = false;
          return;
        }
        break;
      case 'eh-foreign': {
        const { inner } = this.skipElement(t);
        this.add<PendingForeign>(seq, {
          k: 'foreign',
          rawId: this.rawIdOf(t),
          offset: t.start,
          id: '',
          html: this.src.slice(t.end, Math.max(inner, t.end)),
        });
        return;
      }
      case 'eh-slot':
        this.warn('stray-end-tag', 'ignored <eh-slot> outside a container component', t.start);
        return;
    }
    if (name.startsWith('eh-') && name.length > 3) {
      if (this.depth >= this.maxDepth) {
        this.warn('depth-limit', `nesting deeper than ${this.maxDepth}; kept as foreign`, t.start);
        this.foreignElement(t, seq);
        return;
      }
      this.attempt(t, seq, () => this.component(t, seq));
      return;
    }
    this.foreignElement(t, seq);
  }

  private text(t: StartTagToken | null, type: TextBlockType, attrs: Record<string, string>): PendingText {
    return {
      k: 'text',
      rawId: t ? this.rawIdOf(t) : undefined,
      offset: t ? t.start : this.peek().start,
      id: '',
      type,
      attrs,
      content: [],
    };
  }

  private simpleText(
    t: StartTagToken,
    seq: Pending[],
    type: 'p' | `h${1 | 2 | 3 | 4 | 5 | 6}`,
    closers: string[],
  ): void {
    const rec = this.add<PendingText>(seq, this.text(t, type, this.keepAttrs(t)));
    rec.content = this.inline({ closers }).nodes;
  }

  private implicitParagraph(seq: Pending[], first: Token): void {
    const rec = this.add<PendingText>(seq, this.text(null, 'p', {}));
    rec.offset = first.start;
    const r = this.inline({ closers: [], implicit: true });
    const nodes = r.nodes;
    // 结构空白：去掉首尾空白
    const head = nodes[0];
    if (head?.t === 'text') nodes[0] = { ...head, text: head.text.replace(/^[ \t\n\f\r]+/, '') };
    const tail = nodes[nodes.length - 1];
    if (tail?.t === 'text') nodes[nodes.length - 1] = { ...tail, text: tail.text.replace(/[ \t\n\f\r]+$/, '') };
    rec.content = nodes;
    // 保证前进：隐式段落未消费任何 token 时丢弃该 token
    if (this.peek() === first) {
      this.next();
      this.warn('dropped-content', 'dropped unparseable content', first.start);
    }
  }

  private blockquote(t: StartTagToken, seq: Pending[]): void {
    const rec = this.add<PendingText>(seq, this.text(t, 'quote', this.keepAttrs(t)));
    this.open.push('blockquote');
    const r = this.inline({ closers: ['blockquote'], unwrapP: true });
    this.open.pop();
    if (r.stop === 'block' || r.stop === 'list') throw new AbortToForeign();
    rec.content = r.nodes;
  }

  private codeBlock(t: StartTagToken, seq: Pending[]): void {
    const attrs = this.checkTextAttrs(t, ['data-lang']);
    let lang = getAttr(attrs, 'data-lang');
    const rec = this.add<PendingText>(seq, this.text(t, 'code', {}));
    let out = '';
    let sawCode = false;
    let codeClosed = false;
    let tail = '';
    for (;;) {
      const tok = this.peek();
      if (tok.type === 'eof') {
        this.warn('unclosed-element', 'unclosed <pre>', t.start);
        break;
      }
      if (tok.type === 'end') {
        if (tok.name === 'pre') {
          this.next();
          break;
        }
        if (this.isAncestor(tok.name)) {
          this.warn('unclosed-element', 'unclosed <pre>', t.start);
          break;
        }
        this.next();
        if (tok.name === 'code' && sawCode) codeClosed = true;
        continue;
      }
      this.next();
      if (tok.type === 'text') {
        const s = this.decodeText(tok.start, tok.end);
        if (codeClosed) tail += s;
        else out += s;
      } else if (tok.type === 'start') {
        if (tok.name === 'code' && !sawCode) {
          sawCode = true;
          if (out.trim() === '') out = '';
          if (lang === undefined) {
            const m = /(?:^|\s)(?:language|lang)-(\S+)/.exec(getAttr(tok.attrs, 'class') ?? '');
            if (m?.[1]) lang = m[1];
          }
        } else if (tok.name === 'br') out += '\n';
        else if (DROP_IN_TEXT.has(tok.name)) {
          this.warn('dropped-element', `dropped <${tok.name}> inside code block`, tok.start);
          this.skipElement(tok);
        }
      }
    }
    // `</code>` 之后的内容：空白视为格式空白丢弃，否则并入代码
    if (tail.trim() !== '') out += tail;
    // 无 <code> 时按 HTML 规范去掉紧跟 <pre> 的一个换行
    if (!sawCode && out.startsWith('\n')) out = out.slice(1);
    if (lang) rec.attrs = { lang };
    rec.content = out === '' ? [] : [{ t: 'text', text: out, marks: [] }];
  }

  // ── 列表 ──

  private list(t: StartTagToken, indent: number, seq: Pending[]): void {
    const type = t.name as 'ul' | 'ol';
    this.open.push(type);
    this.depth++;
    for (;;) {
      const tok = this.peek();
      if (tok.type === 'eof') {
        this.warn('unclosed-element', `unclosed <${type}>`, t.start);
        break;
      }
      if (tok.type === 'end') {
        if (tok.name === type) {
          this.next();
          break;
        }
        if (this.isAncestor(tok.name)) {
          this.warn('unclosed-element', `unclosed <${type}>`, t.start);
          break;
        }
        this.next();
        this.warn('stray-end-tag', `stray </${tok.name}>`, tok.start);
        continue;
      }
      if (tok.type === 'text') {
        this.next();
        if (!isWhitespaceRange(this.src, tok.start, tok.end))
          this.warn('dropped-content', `dropped text directly inside <${type}>`, tok.start);
        continue;
      }
      if (tok.type !== 'start') {
        this.next();
        continue;
      }
      this.next();
      if (tok.name === 'li') this.listItem(tok, type, indent, seq);
      else if ((tok.name === 'ul' || tok.name === 'ol') && this.depth < this.maxDepth) this.list(tok, indent + 1, seq);
      else if (tok.name === 'ul' || tok.name === 'ol')
        this.warn('depth-limit', `list nesting deeper than ${this.maxDepth}; flattened`, tok.start);
      else this.blockStart(tok, seq);
    }
    this.depth--;
    this.open.pop();
  }

  private listItem(t: StartTagToken, list: 'ul' | 'ol', indent: number, seq: Pending[]): void {
    const attrs = this.checkTextAttrs(t, ['data-eh-task']);
    const rec = this.add<PendingText>(seq, this.text(t, 'li', {}));
    let task: 'done' | 'todo' | undefined;
    const rawTask = getAttr(attrs, 'data-eh-task');
    if (rawTask === 'done' || rawTask === 'todo') task = rawTask;
    else if (rawTask !== undefined) this.warn('dropped-attribute', `invalid data-eh-task="${rawTask}"`, t.start);
    this.open.push('li');
    const content: InlineNode[] = [];
    let nested = false;
    for (;;) {
      const r = this.inline({ closers: ['li'], stopOnList: true, unwrapP: true, li: !nested && content.length === 0 });
      if (r.task && task === undefined) task = r.task;
      if (!nested) content.push(...r.nodes);
      else if (r.nodes.some((n) => n.t !== 'text' || n.text.trim() !== '')) {
        this.warn('dropped-content', 'content after a nested list merged into the parent item', t.start);
        content.push(...r.nodes);
      }
      if (r.stop !== 'list') break;
      const lt = this.next() as StartTagToken;
      if (this.depth >= this.maxDepth) {
        this.warn('depth-limit', `list nesting deeper than ${this.maxDepth}; flattened`, lt.start);
        break;
      }
      nested = true;
      this.list(lt, indent + 1, seq);
    }
    this.open.pop();
    rec.attrs = { list, indent: String(indent), ...(task ? { task } : {}) };
    rec.content = content;
  }

  // ── 表格 ──

  private table(t: StartTagToken, seq: Pending[]): void {
    this.checkTextAttrs(t, []);
    const rec = this.add<PendingText>(seq, this.text(t, 'table', {}));
    this.open.push('table');
    interface Row {
      cells: { content: InlineNode[]; align: CellAlign; th: boolean }[];
      head: boolean;
    }
    const rows: Row[] = [];
    let section: string | null = null;
    for (;;) {
      const tok = this.peek();
      if (tok.type === 'eof') {
        this.warn('unclosed-element', 'unclosed <table>', t.start);
        break;
      }
      if (tok.type === 'end') {
        if (tok.name === 'table') {
          this.next();
          break;
        }
        if (tok.name === section) {
          this.next();
          this.open.pop();
          section = null;
          continue;
        }
        if (this.isAncestor(tok.name)) {
          this.warn('unclosed-element', 'unclosed <table>', t.start);
          break;
        }
        this.next();
        this.warn('stray-end-tag', `stray </${tok.name}>`, tok.start);
        continue;
      }
      if (tok.type === 'text') {
        if (!isWhitespaceRange(this.src, tok.start, tok.end)) throw new AbortToForeign();
        this.next();
        continue;
      }
      if (tok.type !== 'start') {
        this.next();
        continue;
      }
      if (tok.name === 'thead' || tok.name === 'tbody') {
        this.next();
        if (section !== null) this.open.pop();
        section = tok.name;
        this.open.push(section);
        continue;
      }
      if (tok.name === 'tr') {
        this.next();
        rows.push({ cells: this.tableRow(), head: section === 'thead' });
        continue;
      }
      throw new AbortToForeign();
    }
    if (section !== null) this.open.pop();
    this.open.pop();

    let head: InlineNode[][] = [];
    const body: InlineNode[][][] = [];
    const firstHead = rows.findIndex((r) => r.head);
    const headIdx =
      firstHead >= 0 ? firstHead : rows[0] && rows[0].cells.length > 0 && rows[0].cells.every((c) => c.th) ? 0 : -1;
    rows.forEach((r, i) => {
      const cells = r.cells.map((c) => normalizeInlineFast(c.content));
      if (i === headIdx) head = cells;
      else body.push(cells);
    });
    const cols = Math.max(0, ...rows.map((r) => r.cells.length));
    const ordered = headIdx >= 0 ? [rows[headIdx] as Row, ...rows.filter((_, i) => i !== headIdx)] : rows;
    const align: CellAlign[] = [];
    for (let c = 0; c < cols; c++) {
      let a: CellAlign = null;
      for (const r of ordered) {
        const v = r.cells[c]?.align;
        if (v) {
          a = v;
          break;
        }
      }
      align.push(a);
    }
    rec.table = { head, body, align };
  }

  private tableRow(): { content: InlineNode[]; align: CellAlign; th: boolean }[] {
    const cells: { content: InlineNode[]; align: CellAlign; th: boolean }[] = [];
    this.open.push('tr');
    for (;;) {
      const tok = this.peek();
      if (tok.type === 'eof') break;
      if (tok.type === 'end') {
        if (tok.name === 'tr') {
          this.next();
          break;
        }
        if (this.isAncestor(tok.name)) break;
        this.next();
        this.warn('stray-end-tag', `stray </${tok.name}>`, tok.start);
        continue;
      }
      if (tok.type === 'text') {
        if (!isWhitespaceRange(this.src, tok.start, tok.end)) throw new AbortToForeign();
        this.next();
        continue;
      }
      if (tok.type !== 'start') {
        this.next();
        continue;
      }
      if (tok.name === 'tr' || tok.name === 'thead' || tok.name === 'tbody') break; // 未闭合的 tr
      if (tok.name !== 'td' && tok.name !== 'th') throw new AbortToForeign();
      this.next();
      const attrs = this.safeAttrs(tok);
      if (getAttr(attrs, 'rowspan') !== undefined || getAttr(attrs, 'colspan') !== undefined)
        throw new AbortToForeign();
      for (const a of attrs)
        if (a.name !== 'data-eh-align' && a.name !== 'align' && a.name !== 'style')
          this.warn('dropped-attribute', `dropped attribute ${a.name} on <${tok.name}>`, tok.start);
      this.open.push(tok.name);
      const r = this.inline({ closers: [tok.name], unwrapP: true });
      this.open.pop();
      if (r.stop === 'list') throw new AbortToForeign();
      if (r.stop === 'block' && r.tok?.type === 'start' && !['td', 'th', 'tr', 'thead', 'tbody'].includes(r.tok.name))
        throw new AbortToForeign();
      cells.push({ content: r.nodes, align: cellAlign(attrs), th: tok.name === 'th' });
    }
    this.open.pop();
    return cells;
  }

  // ── 图片 ──

  private figure(t: StartTagToken, seq: Pending[]): void {
    this.checkTextAttrs(t, []);
    const rec = this.add<PendingText>(seq, this.text(t, 'figure', {}));
    this.open.push('figure');
    let img: Attr[] | null = null;
    let caption: InlineNode[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok.type === 'eof') {
        this.warn('unclosed-element', 'unclosed <figure>', t.start);
        break;
      }
      if (tok.type === 'end') {
        if (tok.name === 'figure') {
          this.next();
          break;
        }
        if (this.isAncestor(tok.name)) {
          this.warn('unclosed-element', 'unclosed <figure>', t.start);
          break;
        }
        this.next();
        this.warn('stray-end-tag', `stray </${tok.name}>`, tok.start);
        continue;
      }
      if (tok.type === 'text') {
        if (!isWhitespaceRange(this.src, tok.start, tok.end)) throw new AbortToForeign();
        this.next();
        continue;
      }
      if (tok.type !== 'start') {
        this.next();
        continue;
      }
      this.next();
      if (tok.name === 'img' && img === null) {
        img = this.safeAttrs(tok);
        for (const a of img)
          if (a.name !== 'src' && a.name !== 'alt')
            this.warn('dropped-attribute', `dropped attribute ${a.name} on <img>`, tok.start);
      } else if (tok.name === 'figcaption') {
        this.open.push('figcaption');
        const r = this.inline({ closers: ['figcaption'], unwrapP: true });
        this.open.pop();
        if (r.stop === 'block' || r.stop === 'list') throw new AbortToForeign();
        caption = caption.concat(r.nodes);
      } else throw new AbortToForeign();
    }
    this.open.pop();
    if (img === null) throw new AbortToForeign();
    const attrs: Record<string, string> = {};
    const src = getAttr(img, 'src');
    const alt = getAttr(img, 'alt');
    if (src !== undefined) attrs.src = src;
    if (alt !== undefined) attrs.alt = alt;
    rec.attrs = attrs;
    rec.content = caption;
  }

  // ── 组件 ──

  private component(t: StartTagToken, seq: Pending[]): void {
    const type = t.name.slice(3);
    const attrs: Record<string, string> = {};
    for (const a of this.safeAttrs(t)) if (a.name !== 'data-eh') attrs[a.name] = a.value;
    const rec = this.add<PendingComponent>(seq, {
      k: 'component',
      rawId: this.rawIdOf(t),
      offset: t.start,
      id: '',
      type,
      props: undefined,
      attrs,
    });
    if (t.selfClosing) {
      rec.props = {};
      this.warn('missing-props', `<${t.name}> has no JSON data`, t.start);
      return;
    }
    this.open.push(t.name);
    this.depth++;
    const fallback = new Slices(this.src);
    let hasFallback = false;
    let slots: Pending[][] | undefined;
    for (;;) {
      const tok = this.peek();
      if (tok.type === 'eof') {
        this.warn('unclosed-element', `unclosed <${t.name}>`, t.start);
        break;
      }
      if (tok.type === 'end') {
        if (tok.name === t.name) {
          this.next();
          break;
        }
        if (this.isAncestor(tok.name)) {
          this.warn('unclosed-element', `unclosed <${t.name}>`, t.start);
          break;
        }
        this.next();
        this.warn('stray-end-tag', `stray </${tok.name}>`, tok.start);
        continue;
      }
      if (tok.type === 'text' && isWhitespaceRange(this.src, tok.start, tok.end)) {
        this.next();
        continue;
      }
      if (tok.type === 'comment' && tok.data === 'eh:fallback') {
        this.next();
        hasFallback = true;
        fallback.add(tok.end, this.fallbackEnd(tok.end, t));
        continue;
      }
      this.next();
      if (
        tok.type === 'start' &&
        tok.name === 'script' &&
        rec.props === undefined &&
        getAttr(tok.attrs, 'type')?.trim().toLowerCase() === 'application/json'
      ) {
        const { inner } = this.skipElement(tok);
        try {
          rec.props = JSON.parse(this.src.slice(tok.end, inner));
        } catch {
          throw new AbortToForeign({
            code: 'invalid-json',
            message: `invalid JSON in <${t.name}>; kept as foreign`,
            offset: tok.start,
          });
        }
        continue;
      }
      if (tok.type === 'start' && tok.name === 'eh-slot') {
        slots ??= [];
        const raw = getAttr(tok.attrs, 'data-eh-slot');
        const idx = raw !== undefined && /^\d{1,4}$/.test(raw.trim()) ? Number(raw.trim()) : slots.length;
        while (slots.length <= idx) slots.push([]);
        const slot = slots[idx] as Pending[];
        if (!tok.selfClosing) {
          this.open.push('eh-slot');
          this.parseBlocks(slot, 'eh-slot');
          this.open.pop();
        }
        continue;
      }
      // 宽容：标记外的其他内容视为降级内容
      if (tok.type === 'start') {
        const { end } = this.skipElement(tok);
        fallback.add(tok.start, end);
      } else fallback.add(tok.start, tok.end);
      hasFallback = true;
    }
    this.depth--;
    this.open.pop();
    if (rec.props === undefined) {
      rec.props = {};
      this.warn('missing-props', `<${t.name}> has no JSON data`, t.start);
    }
    if (slots) rec.slots = slots;
    if (hasFallback) rec.fallback = fallback.join('');
  }

  /** 从 `<!--eh:fallback-->` 之后扫描到配对的结束标记，返回降级内容结束偏移。 */
  private fallbackEnd(start: number, owner: StartTagToken): number {
    const stack: string[] = [];
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') {
        this.warn('missing-fallback-end', `missing closing <!--eh:fallback--> in <${owner.name}>`, start);
        return t.start;
      }
      if (t.type === 'comment' && t.data === 'eh:fallback') {
        this.next();
        return t.start;
      }
      if (t.type === 'start') {
        this.next();
        if (!VOID.has(t.name) && !t.selfClosing) stack.push(t.name);
      } else if (t.type === 'end') {
        const idx = stack.lastIndexOf(t.name);
        if (idx >= 0) {
          this.next();
          stack.length = idx;
        } else if (this.isAncestor(t.name)) {
          this.warn('missing-fallback-end', `missing closing <!--eh:fallback--> in <${owner.name}>`, start);
          return t.start;
        } else this.next();
      } else this.next();
    }
  }

  // ── 行内 ──

  private inline(ctx: InlineCtx): InlineResult {
    const nodes: InlineNode[] = [];
    const stack: InlineFrame[] = [];
    let marks: Mark[] = [];
    const recompute = (): void => {
      marks = [];
      for (const f of stack) if (f.mark) marks.push(f.mark);
    };
    // unwrapP：段落外的空白暂存，遇到后续内容才写入
    let inP = false;
    let sawP = false;
    let pendingWs: InlineNode | null = null;
    const push = (n: InlineNode): void => {
      if (pendingWs) {
        nodes.push(pendingWs);
        pendingWs = null;
      }
      nodes.push(n);
    };
    // 未闭合的行内元素在块结束时隐式闭合
    const result = (stop: InlineResult['stop'], tok?: Token, task?: 'done' | 'todo'): InlineResult => {
      // 段落之后的空白是格式空白；没有段落时（如 `<li> </li>`）保留
      if (pendingWs && !sawP) nodes.push(pendingWs);
      return { nodes, stop, ...(tok ? { tok } : {}), ...(task ? { task } : {}) };
    };
    let task: 'done' | 'todo' | undefined;

    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') {
        if (ctx.closers.length > 0) this.warn('unclosed-element', `unclosed <${ctx.closers[0]}>`, t.start);
        return result('end', undefined, task);
      }
      if (t.type === 'text') {
        this.next();
        const value = this.decodeText(t.start, t.end);
        if (value === '') continue;
        const node: InlineNode = { t: 'text', text: value, marks };
        if (ctx.unwrapP && !inP && stack.length === 0 && (sawP || nodes.length === 0) && value.trim() === '') {
          pendingWs = node;
          continue;
        }
        push(node);
        continue;
      }
      if (t.type === 'comment' || t.type === 'doctype') {
        this.next();
        continue;
      }
      if (t.type === 'end') {
        const name = t.name;
        if (ctx.closers.includes(name)) {
          this.next();
          return result('closed', undefined, task);
        }
        if (ctx.unwrapP && name === 'p' && inP) {
          this.next();
          inP = false;
          continue;
        }
        let idx = -1;
        for (let i = stack.length - 1; i >= 0; i--)
          if ((stack[i] as InlineFrame).name === name) {
            idx = i;
            break;
          }
        if (idx >= 0) {
          this.next();
          stack.length = idx;
          recompute();
          continue;
        }
        if (ctx.implicit || this.isAncestor(name)) {
          if (!ctx.implicit) this.warn('unclosed-element', `unclosed <${ctx.closers[0] ?? 'p'}>`, t.start);
          return result('end', t, task);
        }
        this.next();
        this.warn('stray-end-tag', `stray </${name}>`, t.start);
        continue;
      }
      // start tag
      const name = t.name;
      const mark = MARK_TAGS.get(name);
      if (mark) {
        this.next();
        if (!t.selfClosing) {
          stack.push({ name, mark: { type: mark } });
          recompute();
        }
        continue;
      }
      if (name === 'br') {
        this.next();
        push({ t: 'br', marks });
        continue;
      }
      if (name === 'a') {
        this.next();
        const attrs = this.safeAttrs(t);
        const href = getAttr(attrs, 'href');
        let m: Mark | null = null;
        if (href !== undefined) {
          if (isScriptUrl(href)) this.warn('stripped-javascript-url', 'stripped script link, kept text', t.start);
          else {
            const title = getAttr(attrs, 'title');
            m = { type: 'link', attrs: title !== undefined ? { href, title } : { href } };
          }
        }
        if (!t.selfClosing) {
          stack.push({ name, mark: m });
          recompute();
        }
        continue;
      }
      if (name === 'span' && getAttr(t.attrs, 'data-eh-inline') !== undefined) {
        this.next();
        push(this.atom(t, marks));
        continue;
      }
      if (ctx.unwrapP && name === 'p') {
        this.next();
        pendingWs = null;
        if (sawP || nodes.length > 0) {
          const last = nodes[nodes.length - 1];
          if (nodes.length > 0 && last?.t !== 'br') nodes.push({ t: 'br', marks: [] });
        }
        sawP = true;
        inP = true;
        continue;
      }
      if (ctx.stopOnList && (name === 'ul' || name === 'ol')) return result('list', t, task);
      if (ctx.li && name === 'input' && nodes.length === 0 && getAttr(t.attrs, 'type')?.toLowerCase() === 'checkbox') {
        this.next();
        task = getAttr(t.attrs, 'checked') !== undefined ? 'done' : 'todo';
        // GFM：复选框后的一个空格属于格式
        const nt = this.peek();
        if (nt.type === 'text' && this.src.charCodeAt(nt.start) === 0x20) {
          this.next();
          const rest = this.decodeText(nt.start + 1, nt.end);
          if (rest !== '') push({ t: 'text', text: rest, marks });
        }
        continue;
      }
      if (isBlockLevel(name)) return result('block', t, task);
      if (ctx.implicit && !isInlineName(name)) return result('block', t, task);
      this.next();
      if (DROP_IN_TEXT.has(name)) {
        this.warn('dropped-element', `dropped <${name}> inside a text block`, t.start);
        this.skipElement(t);
        continue;
      }
      if (VOID.has(name) || t.selfClosing) {
        this.warn(name === 'img' ? 'dropped-element' : 'unwrapped-element', `dropped <${name}>`, t.start);
        continue;
      }
      if (name !== 'span') this.warn('unwrapped-element', `unwrapped non-whitelisted <${name}>`, t.start);
      stack.push({ name, mark: null });
    }
  }

  /** `span[data-eh-inline]`（开始标签已消费）→ 原子节点。 */
  private atom(t: StartTagToken, marks: Mark[]): InlineNode {
    const attrs: Record<string, string> = {};
    let kind = '';
    for (const a of this.safeAttrs(t)) {
      if (a.name === 'data-eh-inline') kind = a.value;
      else if (a.name.startsWith('data-eh-')) attrs[a.name.slice(8)] = a.value;
    }
    let text = '';
    let depth = 0;
    if (!t.selfClosing)
      for (;;) {
        const tok = this.peek();
        if (tok.type === 'eof') {
          this.warn('unclosed-element', 'unclosed inline atom <span>', t.start);
          break;
        }
        if (tok.type === 'end') {
          if (tok.name === 'span' && depth === 0) {
            this.next();
            break;
          }
          if (tok.name !== 'span' && this.isAncestor(tok.name)) {
            this.warn('unclosed-element', 'unclosed inline atom <span>', t.start);
            break;
          }
          this.next();
          if (tok.name === 'span') depth--;
          continue;
        }
        if (tok.type === 'start' && isBlockLevel(tok.name)) {
          this.warn('unclosed-element', 'unclosed inline atom <span>', t.start);
          break;
        }
        this.next();
        if (tok.type === 'text') text += this.decodeText(tok.start, tok.end);
        else if (tok.type === 'start') {
          if (tok.name === 'span' && !tok.selfClosing) depth++;
          else if (tok.name === 'br') text += '\n';
          else if (DROP_IN_TEXT.has(tok.name)) this.skipElement(tok);
        }
      }
    return { t: 'atom', kind, attrs, text, marks };
  }
}

/** 源区间收集器：相邻区间之间只有空白时合并（保留原始空白），否则以分隔符连接。 */
class Slices {
  private readonly ranges: [number, number][] = [];
  constructor(private readonly src: string) {}

  add(start: number, end: number): void {
    const last = this.ranges[this.ranges.length - 1];
    if (last && isWhitespaceRange(this.src, last[1], start)) last[1] = end;
    else this.ranges.push([start, end]);
  }

  join(sep: string): string {
    return this.ranges.map(([s, e]) => this.src.slice(s, e)).join(sep);
  }
}

// ───────────────────────────── 第 2/3 步：ID 与构造 ─────────────────────────────

function assignIds(p: Parser, prefix: string): void {
  const keep = new Set<BlockId>();
  const reassign: { rec: Pending; code: ParseWarningCode }[] = [];
  for (const rec of p.all) {
    const raw = rec.rawId;
    if (raw === undefined || raw === '') reassign.push({ rec, code: 'missing-id' });
    else if (!isValidBlockId(raw)) reassign.push({ rec, code: 'invalid-id' });
    else if (keep.has(raw)) reassign.push({ rec, code: 'duplicate-id' });
    else {
      keep.add(raw);
      rec.id = raw;
    }
  }
  const gen = createIdGenerator(keep, prefix);
  for (const { rec, code } of reassign) {
    rec.id = gen.next();
    const what =
      code === 'missing-id' ? 'missing' : code === 'invalid-id' ? `invalid "${rec.rawId}"` : `duplicate "${rec.rawId}"`;
    p.warn(code, `block id ${what}; assigned ${rec.id}`, rec.offset);
  }
}

/** 强制列表不变量（01 §6.1）：同组第一个 li 的 indent 为 0，且每项 indent ≤ 前一项 + 1。 */
function fixIndents(seq: readonly Pending[]): void {
  let prev = -1;
  for (const rec of seq) {
    if (rec.k === 'text' && rec.type === 'li') {
      const want = Math.min(Number(rec.attrs.indent ?? '0'), prev + 1);
      if (String(want) !== rec.attrs.indent) rec.attrs = { ...rec.attrs, indent: String(want) };
      prev = want;
    } else prev = -1;
  }
}

function build(p: Parser): Block[] {
  const blocks: Block[] = [];
  const ids = (seq: readonly Pending[]): BlockId[] => seq.map((r) => r.id);
  fixIndents(p.root);
  for (const rec of p.all) {
    if (rec.k === 'text')
      blocks.push(makeTextBlock(rec.id, rec.type, normalizeInlineFast(rec.content), rec.attrs, rec.table));
    else if (rec.k === 'foreign') blocks.push(makeForeignBlock(rec.id, rec.html));
    else {
      rec.slots?.forEach(fixIndents);
      blocks.push(makeComponentBlock(rec.id, rec.type, rec.props, rec.attrs, rec.slots?.map(ids), rec.fallback));
    }
  }
  return blocks;
}

/**
 * 解析 `.ehtml`（或任意 HTML）为 {@link Doc}。
 *
 * 规范形式（01 §6.1）的输入被精确还原；非规范输入按宽容规则映射：
 * 标签名大小写不敏感，`b`/`i`/`del`/`strike` 映射为对应标记，白名单外的行内元素去壳，
 * 文本块中的 `script`/`style` 丢弃，`on*` 属性与 `javascript:` 链接剔除，
 * 缺失/重复的块 ID 在扫描结束后按文档顺序重新分配，没有 `main#eh-doc` 时解析 `body`，
 * 规范外内容作为外来块保留原文切片。
 *
 * **从不抛错**：任何输入都返回一个通过 `validateDoc` 的文档，问题记录在 `warnings` 中。
 * 不依赖 DOM，可在 Node 与 Web Worker 中运行；时间复杂度 O(n)。
 *
 * @param html 源 HTML 字符串。
 * @param opts 解析选项。
 * @returns 文档与告警。
 */
export function parse(html: string, opts: ParseOptions = {}): ParseResult {
  const p = new Parser(html, opts);
  p.parseDocument();
  assignIds(p, opts.idPrefix ?? 'b');
  const blocks = build(p);
  const doc = createDoc(blocks, {
    root: p.root.map((r) => r.id),
    meta: p.meta ?? {},
    head: p.head(),
  });
  return { doc, warnings: p.warnings };
}
