/**
 * 模型行内内容 → EHMD 行内 Markdown。
 *
 * 目标是**无损且确定**：`parseEhmd` 读回得到同一行内内容。做法：
 *
 * 1. 按 `MARK_ORDER` 把节点建成标记树（相邻节点共享最长外层标记前缀，与 HTML 序列化器相同）；
 * 2. 标记优先用 Markdown 语法（`**` `*` `~~` `==` `` ` `` `[](…)`），在定界符规则可能失效时
 *    （内侧首尾字符是空白/标点、外侧紧邻同一定界符字符）退回等价的行内 HTML（`<strong>` 等）；
 *    sub/sup/kbd 总是行内 HTML；
 * 3. 文本按保守规则转义（见 {@link escapeText}）；行首/行尾的空白、换行等写成数字字符引用；
 * 4. 原子优先用 `$tex$`、`[[…]]`、`#tag`，不满足语法前提时写成 `<span data-eh-inline="…">`。
 *
 * @module
 */
import { classifyCharacter } from 'micromark-util-classify-character';
import { MARK_ORDER, markEquals, type InlineAtom, type InlineNode, type Mark } from '../model.js';
import { isTagBody, isTagChar } from './syntax.js';
import type { AtomSerializer, EscapeHook } from './types.js';

/** 行内语境。 */
export interface InlineContext {
  /** 表格单元格：`|` 需要转义。 */
  readonly table?: boolean;
  /** 只能写成一行（标题、表格单元格）：`br` 写成 `<br>`。 */
  readonly singleLine?: boolean;
  /** 硬换行后续行的前缀（列表项缩进、引用的 `> `）。 */
  readonly prefix?: string;
  /** 原子序列化钩子（扩展用，见 `EhmdExtension.serializeAtom`）；返回 `undefined` 时用内置写法。 */
  readonly atom?: AtomSerializer;
  /** 额外的转义判定（扩展用，见 `EhmdExtension.escapeChar`）：返回 `true` 时该 ASCII 标点写成 `\c`。 */
  readonly escapeChar?: EscapeHook;
}

type Tree = { mark: Mark; children: Tree[] } | { leaf: InlineNode; index: number };

function buildTree(nodes: readonly InlineNode[]): Tree[] {
  const root: Tree[] = [];
  const stack: { mark: Mark; children: Tree[] }[] = [];
  nodes.forEach((node, index) => {
    const marks = MARK_ORDER.flatMap((t) => node.marks.filter((m) => m.type === t));
    let k = 0;
    while (k < stack.length && k < marks.length && markEquals((stack[k] as { mark: Mark }).mark, marks[k] as Mark)) k++;
    stack.length = k;
    for (let i = k; i < marks.length; i++) {
      const span = { mark: marks[i] as Mark, children: [] as Tree[] };
      (i === 0 ? root : (stack[i - 1] as { children: Tree[] }).children).push(span);
      stack.push(span);
    }
    (marks.length === 0 ? root : (stack[marks.length - 1] as { children: Tree[] }).children).push({
      leaf: node,
      index,
    });
  });
  return root;
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

const isWs = (c: string | undefined): boolean => c === ' ' || c === '\t';

/** 一个字符的数字字符引用。 */
function charRef(c: string): string {
  return `&#x${(c.codePointAt(0) as number).toString(16).toUpperCase()};`;
}

/**
 * 转义一段文本（不含标记语义）。
 *
 * 总是转义：`\` `` ` `` `*` `[` `]` `<` `$` `~`、表格中的 `|`；
 * 按上下文转义：`_`（两侧不都是字母数字时）、`=`（与 `=` 相邻或在节点边缘）、`#`（其后是标签字符或在节点末尾）、
 * `^`（在空白之后或节点开头）、`{`（其后是 `#` 或在节点末尾）、`!` `&`（在节点末尾，或 `&` 形如实体）、
 * `:`（其后是 `/`）、`.`（在 `w` 之后）、`@`（在邮箱字符之后或节点开头）；
 * `\n` 在两侧都是非空白字符且允许多行时写成软换行（续行加 `ctx.prefix`，按行首处理），否则与 `\r` 一样写成字符引用；
 * 行首（`lineStart` 或软换行之后）的空白写成字符引用，多行语境下行首 ASCII 标点与 `1.` 也转义；
 * `lineEnd` 时行尾空白写成字符引用。
 */
export function escapeText(s: string, ctx: InlineContext, lineStart: boolean, lineEnd: boolean): string {
  let out = '';
  const multi = ctx.singleLine !== true;
  let atLineStart = lineStart;
  let escapeAt = -1;
  const ws = (ch: string | undefined): boolean =>
    ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    const prev = s[i - 1];
    const next = s[i + 1];
    const atEnd = i === s.length - 1;
    const lineHead = atLineStart;
    atLineStart = false;
    if (c === '\n' && multi && i > 0 && !atEnd && !ws(prev) && !ws(next)) {
      out += `\n${ctx.prefix ?? ''}`;
      atLineStart = true;
      continue;
    }
    if (lineHead && multi) {
      const m = /^\d{1,9}[.)]/.exec(s.slice(i));
      if (m) escapeAt = i + m[0].length - 1;
    }
    let esc = false;
    switch (c) {
      case '\\':
      case '`':
      case '*':
      case '[':
      case ']':
      case '<':
      case '$':
      case '~':
        esc = true;
        break;
      case '|':
        esc = ctx.table === true;
        break;
      case '_': {
        const other = (ch: string | undefined): boolean =>
          ch !== undefined && classifyCharacter(ch.charCodeAt(0)) === undefined;
        esc = !(other(prev) && other(next));
        break;
      }
      case '=':
        esc = i === 0 || atEnd || prev === '=' || next === '=';
        break;
      case '#':
        esc = atEnd || isTagChar(next?.charCodeAt(0) ?? null);
        break;
      case '^':
        esc = i === 0 || isWs(prev);
        break;
      case '{':
        esc = atEnd || next === '#';
        break;
      case '!':
        esc = atEnd || next === '[';
        break;
      case '&':
        esc = atEnd || /^&(?:#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]*;)/.test(s.slice(i));
        break;
      case ':':
        esc = next === '/';
        break;
      case '.':
        esc = prev === 'w' || prev === 'W';
        break;
      case '@':
        esc = i === 0 || /[A-Za-z0-9._+-]/.test(prev ?? '');
        break;
      case '\n':
      case '\r':
        out += charRef(c);
        continue;
    }
    if (i === escapeAt) esc = true;
    if (!esc && ctx.escapeChar && ASCII_PUNCT.test(c) && ctx.escapeChar(c, prev, next)) esc = true;
    if (lineHead) {
      if (isWs(c)) {
        out += charRef(c);
        continue;
      }
      if (multi && ASCII_PUNCT.test(c)) esc = true;
    }
    if (atEnd && lineEnd && isWs(c)) {
      out += charRef(c);
      continue;
    }
    if (c === '\u0000') {
      out += '\uFFFD';
      continue;
    }
    out += esc ? `\\${c}` : c;
  }
  return out;
}

/** 换行写成字符引用（链接目标、标题中的字符引用会被解码）。 */
const encodeBreaks = (s: string): string => s.replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');

/**
 * 链接/图片目标：简单时原样，否则写成 `<…>`（转义 `\ < >`、形如实体的 `&`、表格中的 `|`，换行写成字符引用）。
 */
export function destination(href: string, table: boolean): string {
  // eslint-disable-next-line no-control-regex
  if (href !== '' && !/[\s<>()\\&|]/.test(href) && !/[\u0000-\u001f\u007f]/.test(href)) return href;
  let t = href.replace(/[\\<>]/g, '\\$&').replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&');
  if (table) t = t.replace(/\|/g, '\\|');
  return `<${encodeBreaks(t)}>`;
}

/** 链接/图片标题（双引号形式）。 */
export function titleString(title: string, table: boolean): string {
  let t = title.replace(/[\\"]/g, '\\$&').replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&');
  if (table) t = t.replace(/\|/g, '\\|');
  return `"${encodeBreaks(t)}"`;
}

const escAttr = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');

function htmlOpen(m: Mark, table: boolean): string {
  if (m.type !== 'link') return `<${m.type}>`;
  const href = m.attrs?.href ?? '';
  const title = m.attrs?.title;
  let s = `<a href="${escAttr(href)}"${title !== undefined ? ` title="${escAttr(title)}"` : ''}>`;
  if (table) s = s.replace(/\|/g, '&#124;');
  return s;
}

const DELIMS: Partial<Record<Mark['type'], string>> = { strong: '**', em: '*', s: '~~', mark: '==' };

/** 内侧首尾字符可以紧贴定界符（不是空白或标点）。 */
function innerOk(s: string): boolean {
  if (s === '') return false;
  const first = s.charCodeAt(0);
  const last = s.charCodeAt(s.length - 1);
  return classifyCharacter(first) === undefined && classifyCharacter(last) === undefined;
}

const isMath = (n: InlineNode | undefined): boolean => n?.t === 'atom' && n.kind === 'math';

/** 原子的规范语法；不满足前提时返回 `null`（改用 span）。 */
function atomSyntax(
  a: InlineAtom,
  ctx: InlineContext,
  prevNode: InlineNode | undefined,
  nextNode: InlineNode | undefined,
): string | null {
  if (Object.keys(a.attrs).length > 0) return null;
  const t = a.text;
  const prevChar = edgeChar(prevNode, 'last');
  const nextChar = edgeChar(nextNode, 'first');
  switch (a.kind) {
    case 'math': {
      if (t === '' || t.trim() === '' || /[$\n\r]/.test(t)) return null;
      if (ctx.table && t.includes('|')) return null;
      if (isMath(prevNode) || isMath(nextNode)) return null;
      const pad = t.startsWith(' ') && t.endsWith(' ') ? ' ' : '';
      return `$${pad}${t}${pad}$`;
    }
    case 'wikilink': {
      if (!/^\[\[[^[\]\n\r\\]+\]\]$/.test(t)) return null;
      return ctx.table ? t.replace(/\|/g, '\\|') : t;
    }
    case 'tag': {
      if (!t.startsWith('#') || !isTagBody(t.slice(1))) return null;
      if (prevChar !== undefined && (isTagChar(prevChar.charCodeAt(0)) || prevChar === '#')) return null;
      if (nextChar !== undefined && isTagChar(nextChar.charCodeAt(0))) return null;
      return t;
    }
    default:
      return null;
  }
}

/** 节点在原始序列中的"模型字符"（用于原子语法的邻接判断）。 */
function edgeChar(node: InlineNode | undefined, side: 'first' | 'last'): string | undefined {
  if (!node) return undefined;
  if (node.t === 'br') return '\n';
  const s = node.text;
  return side === 'first' ? s[0] : s[s.length - 1];
}

/**
 * 序列化行内内容为单行（或以硬换行分成多行）Markdown。`ctx.prefix` 写在每个硬换行之后。
 */
export function serializeInline(nodes: readonly InlineNode[], ctx: InlineContext = {}): string {
  if (nodes.length === 0) return '';
  const tree = buildTree(nodes);
  const last = nodes.length - 1;
  const prefix = ctx.prefix ?? '';
  const table = ctx.table === true;

  const leaf = (node: InlineNode, index: number, inCode: boolean): string => {
    const prevNode = nodes[index - 1];
    const nextNode = nodes[index + 1];
    const lineStart = index === 0 || prevNode?.t === 'br';
    const lineEnd = index === last || nextNode?.t === 'br';
    if (node.t === 'br') {
      if (ctx.singleLine || index === last) return index === 0 ? '<br><!---->' : '<br>';
      return `\\\n${prefix}`;
    }
    if (node.t === 'atom') {
      const custom = inCode || !ctx.atom ? undefined : ctx.atom(node, ctx, prevNode, nextNode);
      if (custom !== undefined) return custom;
      const syn = inCode ? null : atomSyntax(node, ctx, prevNode, nextNode);
      if (syn !== null) return syn;
      const attrs = Object.keys(node.attrs)
        .sort()
        .map((k) => ` data-eh-${k}="${escAttr(node.attrs[k] as string)}"`)
        .join('');
      const open = `<span data-eh-inline="${escAttr(node.kind)}"${attrs}>`;
      return `${table ? open.replace(/\|/g, '&#124;') : open}${escapeText(node.text, ctx, false, false)}</span>`;
    }
    return escapeText(node.text, ctx, lineStart, lineEnd);
  };

  /** 代码标记：能写成反引号代码就用，否则 `<code>`。 */
  const codeSpan = (children: Tree[]): string | null => {
    if (children.length !== 1) return null;
    const only = children[0] as Tree;
    if (!('leaf' in only) || only.leaf.t !== 'text') return null;
    const t = only.leaf.text;
    if (/[\n\r]/.test(t) || /``/.test(t)) return null;
    if (table && t.includes('\\')) return null;
    const allSpace = /^ +$/.test(t);
    const pad = !allSpace && (t.startsWith(' ') || t.endsWith(' ') || t.startsWith('`') || t.endsWith('`')) ? ' ' : '';
    const fence = t.includes('`') ? '``' : '`';
    const body = table ? t.replace(/\|/g, '\\|') : t;
    return `${fence}${pad}${body}${pad}${fence}`;
  };

  const render = (items: Tree[], inCode: boolean): string => {
    const parts: string[] = [];
    // 先暂定每一项（右邻居的暂定输出用于左边的判断；暂定输出只会从定界符改成 HTML，不会反过来）
    const tentative = items.map((it) => renderItem(it, inCode, undefined, undefined));
    items.forEach((it, i) => {
      const prevOut = parts[i - 1];
      const prevChar = prevOut ? prevOut[prevOut.length - 1] : undefined;
      const nextOut = tentative[i + 1];
      const nextChar = nextOut ? nextOut[0] : undefined;
      parts.push(renderItem(it, inCode, prevChar, nextChar));
    });
    return parts.join('');
  };

  const renderItem = (
    it: Tree,
    inCode: boolean,
    prevChar: string | undefined,
    nextChar: string | undefined,
  ): string => {
    if ('leaf' in it) return leaf(it.leaf, it.index, inCode);
    const m = it.mark;
    if (m.type === 'code') {
      const cs = codeSpan(it.children);
      if (cs !== null) return cs;
      return `<code>${render(it.children, true)}</code>`;
    }
    const inner = render(it.children, inCode);
    if (m.type === 'link') {
      const href = m.attrs?.href ?? '';
      const title = m.attrs?.title;
      // 自动链接 `<https://…>`：链接文本就是目标本身
      const only = it.children.length === 1 ? it.children[0] : undefined;
      if (
        title === undefined &&
        only &&
        'leaf' in only &&
        only.leaf.t === 'text' &&
        only.leaf.text === href &&
        // eslint-disable-next-line no-control-regex
        /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>&\\|\u0000-\u001f\u007f]*$/.test(href)
      )
        return `<${href}>`;
      if (inner !== '') {
        const t = title !== undefined ? ` ${titleString(title, table)}` : '';
        return `[${inner}](${destination(href, table)}${t})`;
      }
      return `${htmlOpen(m, table)}${inner}</a>`;
    }
    const d = DELIMS[m.type];
    if (d && innerOk(inner) && prevChar !== d[0] && nextChar !== d[0]) return `${d}${inner}${d}`;
    return `${htmlOpen(m, table)}${inner}</${m.type}>`;
  };

  return render(tree, false);
}
