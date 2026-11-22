/**
 * Obsidian 方言：叠加在 core EHMD（CommonMark + GFM + `$` 公式 + 指令块）之上的 {@link EhmdExtension}。
 *
 * 解析（docs/06-import.md §5）：
 * - `> [!type] 标题` callout → `callout {kind, title}`（`kind` 原样保存，不做归一化）；可折叠的
 *   `> [!type]-` / `> [!type]+` → `toggle {title, open}`，`attrs.kind` 保存原类型，折叠标记由 `open` 还原；
 * - ```` ```mermaid ```` → `mermaid {source}`；`$$…$$` → `math`（core）；行内 `$$…$$` → `math` 原子（`display=block`）；
 *   行内 `$…$` 按 Obsidian 规则：`$` 内侧紧邻空白、或结束 `$` 后紧跟数字时不是公式（保留为文本）；
 * - `[[目标#标题|别名]]` → `wikilink` 原子，`attrs = {target, heading?|block?, alias?}`（原文写法逐字保存）；
 * - `![[…]]`：单独成段时，图片 → `figure {src, alt, width?, height?, syntax: 'wikilink'}`，其他 → `note-embed`
 *   组件；段落中间的 → `embed` 原子；
 * - 脚注 `[^x]` → `footnote` 原子 `{label}`；脚注定义 → `footnote {label}` 容器；行内脚注 `^[…]` →
 *   `footnote` 原子 `{form: 'inline'}`；
 * - `%%注释%%` → 段落中：`comment` 原子；单独成段 / 跨段：`markdown {source}` 组件（`attrs.syntax = 'comment'`）；
 *   链接定义 `[x]: url` 同样保留为 `markdown` 组件（`syntax = 'definition'`）；
 * - HTML 中成对、但被空行分到不同 mdast 节点的 `<details>…</details>` → `toggle`；
 * - 源码中写明的块 ID 一律存入 `attrs['md-id']`（导出时只写回这些 ID）；不符合 `BLOCK_ID_RE` 的
 *   （如 `goal-1`）不作为块 ID，由 core 重新分配。
 *
 * 少量**纯写法**信息以 `md-` 开头的临时属性记录（`md-fence`、`md-hr`、`md-idstyle`），由导入器移出块属性、
 * 存进文档级的来源表（见 {@link ./source-info.ts}）。
 *
 * @module
 */
import {
  escapeEhmdText,
  isValidBlockId,
  type AtomSerializer,
  type BlockContext,
  type BlockHandler,
  type EhmdExtension,
  type EscapeHook,
  type InlineAtom,
  type InlineHandler,
  type InlineNode,
  type Mark,
  type PendingBlock,
} from '@edithtml/core';
import type { Blockquote, Paragraph, Parent, PhrasingContent, Root, RootContent } from 'mdast';
import { obsidianFromMarkdown, obsidianSyntax } from './syntax.js';

/** mdast 节点：跨节点配对的 `<details>…</details>`（由变换生成）。 */
export interface ObsDetailsNode extends Parent {
  type: 'obsDetails';
  title: string;
  open: boolean;
  children: RootContent[];
}
/** mdast 节点：块级 `%%…%%` 注释（可跨多段，由变换生成）。`value` 为原文。 */
export interface ObsCommentBlockNode {
  type: 'obsCommentBlock';
  value: string;
  position?: Paragraph['position'];
}

declare module 'mdast' {
  interface RootContentMap {
    obsDetails: ObsDetailsNode;
    obsCommentBlock: ObsCommentBlockNode;
  }
}

/** 双链 / 嵌入的结构化属性。拼接 `target + #heading|#^block + |alias` 恰好还原原文。 */
export interface WikiParts {
  target: string;
  heading?: string;
  block?: string;
  alias?: string;
}

/** 拆分 `[[…]]` 方括号内的原文（`|` 之前第一个 `#` 起为子目标）。 */
export function parseWikiTarget(value: string): WikiParts {
  const bar = value.indexOf('|');
  const left = bar < 0 ? value : value.slice(0, bar);
  const out: WikiParts = { target: left };
  const hash = left.indexOf('#');
  if (hash >= 0) {
    out.target = left.slice(0, hash);
    const sub = left.slice(hash + 1);
    if (sub.startsWith('^')) out.block = sub.slice(1);
    else out.heading = sub;
  }
  if (bar >= 0) out.alias = value.slice(bar + 1);
  return out;
}

/** {@link parseWikiTarget} 的逆运算。 */
export function formatWikiTarget(p: Readonly<Partial<WikiParts>>): string {
  const sub = p.block !== undefined ? `#^${p.block}` : p.heading !== undefined ? `#${p.heading}` : '';
  return `${p.target ?? ''}${sub}${p.alias !== undefined ? `|${p.alias}` : ''}`;
}

/** 原子属性形式的 {@link WikiParts}。 */
function wikiAttrs(value: string): Record<string, string> {
  const p = parseWikiTarget(value);
  const a: Record<string, string> = { target: p.target };
  if (p.heading !== undefined) a.heading = p.heading;
  if (p.block !== undefined) a.block = p.block;
  if (p.alias !== undefined) a.alias = p.alias;
  return a;
}

/** 可以写成 `[[…]]` 的方括号内文本（与 core 的双链语法一致）。 */
const WIKI_INNER_RE = /^[^[\]\n\r\\]+$/;

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|svg|webp|bmp|avif|tiff?|ico)$/i;

/** 图片嵌入的 `|` 参数：`alt`、`200`、`120x80`、`alt|200`。 */
function imageParam(alias: string | undefined): { alt: string; width?: string; height?: string } {
  if (alias === undefined) return { alt: '' };
  const m = /^(?:(.*)\|)?(\d+)(?:x(\d+))?$/.exec(alias);
  if (!m) return { alt: alias };
  const out: { alt: string; width?: string; height?: string } = { alt: m[1] ?? '', width: m[2] as string };
  if (m[3] !== undefined) out.height = m[3];
  return out;
}

/** 由 figure 属性还原图片嵌入的 `|` 参数（{@link imageParam} 的逆运算）。 */
export function formatImageParam(attrs: Readonly<Record<string, string>>): string | undefined {
  const alt = attrs.alt ?? '';
  const w = attrs.width;
  if (w === undefined) return alt === '' ? undefined : alt;
  const size = attrs.height !== undefined ? `${w}x${attrs.height}` : w;
  return alt === '' ? size : `${alt}|${size}`;
}

const pos = (n: { position?: Paragraph['position'] } | undefined): [number, number] => [
  n?.position?.start.offset ?? 0,
  n?.position?.end.offset ?? 0,
];

// ───────────────────────────── mdast 变换 ─────────────────────────────

/** 是否整段都是一个 `%%…%%` 注释（第一个结束标记就在末尾）。 */
function isWholeComment(raw: string): boolean {
  return raw.length >= 4 && raw.startsWith('%%') && raw.endsWith('%%') && raw.indexOf('%%', 2) === raw.length - 2;
}

/** 顶层：合并跨段的 `%%` 注释。 */
function mergeComments(tree: Root, source: string): void {
  const kids = tree.children;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i] as RootContent;
    if (n.type !== 'paragraph') continue;
    const [s, e] = pos(n);
    const raw = source.slice(s, e);
    if (!raw.startsWith('%%')) continue;
    if (isWholeComment(raw)) {
      kids[i] = { type: 'obsCommentBlock', value: raw, position: n.position };
      continue;
    }
    if (raw.indexOf('%%', 2) >= 0) continue;
    for (let j = i + 1; j < kids.length; j++) {
      const [, ej] = pos(kids[j]);
      const rj = source.slice(pos(kids[j])[0], ej);
      const k = rj.indexOf('%%');
      if (k < 0) continue;
      if (k === rj.length - 2) {
        const node: ObsCommentBlockNode = {
          type: 'obsCommentBlock',
          value: source.slice(s, ej),
          position: {
            start: (n.position as NonNullable<Paragraph['position']>).start,
            end: kids[j]?.position?.end ?? { line: 0, column: 0, offset: ej },
          },
        };
        kids.splice(i, j - i + 1, node);
      }
      break;
    }
  }
}

const DETAILS_OPEN_RE = /^<details(\s[^>]*)?>\s*(?:<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>)?\s*$/i;
const DETAILS_CLOSE_RE = /^<\/details>$/i;

/** 把被空行拆开的 `<details>` / `</details>` 配对成一个 {@link ObsDetailsNode}（就地，递归）。 */
function pairDetails(parent: { children: RootContent[] }): void {
  const kids = parent.children;
  for (const k of kids) if (k.type === 'blockquote' || k.type === 'obsDetails') pairDetails(k);
  const stack: number[] = [];
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i] as RootContent;
    if (n.type !== 'html') continue;
    const v = n.value.trim();
    if (DETAILS_OPEN_RE.test(v) && !/<\/details>/i.test(v)) stack.push(i);
    else if (DETAILS_CLOSE_RE.test(v) && stack.length > 0) {
      const o = stack.pop() as number;
      const open = kids[o] as Extract<RootContent, { type: 'html' }>;
      const m = DETAILS_OPEN_RE.exec(open.value.trim()) as RegExpExecArray;
      const node: ObsDetailsNode = {
        type: 'obsDetails',
        open: /(^|\s)open(\s|=|$)/i.test(m[1] ?? ''),
        title: decodeBasicEntities((m[2] ?? '').replace(/<[^>]*>/g, '')).trim(),
        children: kids.slice(o + 1, i),
      };
      if (open.position && n.position) node.position = { start: open.position.start, end: n.position.end };
      kids.splice(o, i - o + 1, node);
      i = o;
    }
  }
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ───────────────────────────── 块处理器 ─────────────────────────────

const CALLOUT_RE = /^\[!([^\]\s]+)\]([+-]?)(?:[ \t]+(.*?))?[ \t]*$/;

/** `> [!type]± 标题` → callout / toggle；不是 callout 时返回 `undefined`。 */
function callout(node: Blockquote, ctx: BlockContext): PendingBlock[] | undefined {
  const first = node.children[0];
  if (first?.type !== 'paragraph') return undefined;
  const [ps, pe] = pos(first);
  const src = ctx.source;
  const nl = src.indexOf('\n', ps);
  const lineEnd = nl < 0 || nl > pe ? pe : nl;
  const m = CALLOUT_RE.exec(src.slice(ps, lineEnd));
  if (!m) return undefined;
  const rest: PhrasingContent[] = [];
  for (const c of first.children) {
    const [cs, ce] = pos(c);
    if (ce <= lineEnd) continue;
    if (cs > lineEnd) {
      rest.push(c);
      continue;
    }
    if (c.type === 'break') continue;
    if (c.type !== 'text') return undefined;
    const k = c.value.indexOf('\n');
    if (k < 0) return undefined;
    const v = c.value.slice(k + 1);
    if (v === '') continue;
    const skip = /^(?:[ \t]*>[ \t]?)*/.exec(src.slice(lineEnd + 1))?.[0].length ?? 0;
    const start = { line: (c.position?.start.line ?? 0) + 1, column: 1, offset: lineEnd + 1 + skip };
    rest.push({ ...c, value: v, position: { start, end: c.position?.end ?? start } });
  }
  const body: RootContent[] = [];
  if (rest.length > 0) {
    const para: Paragraph = { type: 'paragraph', children: rest };
    const s0 = rest[0]?.position?.start;
    if (s0 && first.position) para.position = { start: s0, end: first.position.end };
    body.push(para);
  }
  body.push(...node.children.slice(1));
  const blocks = ctx.blocks(body);
  const kind = m[1] as string;
  const fold = m[2] as string;
  const title = m[3] ?? '';
  const offset = ctx.offset(node);
  if (fold !== '')
    return [
      {
        k: 'component',
        type: 'toggle',
        props: { title, open: fold === '+' },
        attrs: { kind },
        slots: [blocks],
        offset,
        trailingId: true,
      },
    ];
  return [
    { k: 'component', type: 'callout', props: { kind, title }, attrs: {}, slots: [blocks], offset, trailingId: true },
  ];
}

const blockquote: BlockHandler = (node, ctx) => callout(node as Blockquote, ctx);

const code: BlockHandler = (node, ctx, next) => {
  const out = next();
  const p = out[0];
  if (out.length !== 1 || !p || p.k !== 'text' || p.type !== 'code' || node.type !== 'code') return out;
  const fm = /^[ \t]*(`{3,}|~{3,})/.exec(ctx.raw(node));
  const style: Record<string, string> = {};
  if (fm && fm[1] !== '```') style['md-fence'] = fm[1] as string;
  if (p.id !== undefined) style['md-idstyle'] = 'brace';
  if (fm && p.attrs.lang === 'mermaid' && Object.keys(p.attrs).length === 1) {
    const c: PendingBlock = {
      k: 'component',
      type: 'mermaid',
      props: { source: node.value },
      attrs: style,
      offset: p.offset,
    };
    if (p.id !== undefined) c.id = p.id;
    if (p.trailingId) c.trailingId = true;
    return [c];
  }
  p.attrs = { ...p.attrs, ...style };
  return out;
};

const thematicBreak: BlockHandler = (node, ctx, next) => {
  const out = next();
  const p = out[0];
  const raw = ctx.raw(node).trim();
  if (p?.k === 'text' && raw !== '---') p.attrs = { ...p.attrs, 'md-hr': raw };
  return out;
};

const heading: BlockHandler = (node, ctx, next) => {
  const out = next();
  const p = out[0];
  if (p?.k === 'text' && p.id !== undefined && /\{#[^\s{}]+\}[ \t]*$/.test(ctx.raw(node).replace(/[ \t#]+$/, '')))
    p.attrs = { ...p.attrs, 'md-idstyle': 'brace' };
  return out;
};

/** `markdown` 组件：原样保留、原样写回的 Markdown 片段。 */
function rawMarkdown(source: string, syntax: string, offset: number): PendingBlock {
  return { k: 'component', type: 'markdown', props: { source }, attrs: { syntax }, offset };
}

const paragraph: BlockHandler = (node, ctx) => {
  if (node.type !== 'paragraph') return undefined;
  const raw = ctx.raw(node).trim();
  if (!raw.includes('\n') && isWholeComment(raw)) return [rawMarkdown(raw, 'comment', ctx.offset(node))];
  const { id, children } = ctx.stripId(node);
  const kids = children.filter((c) => !(c.type === 'text' && /^[ \t\n]*$/.test(c.value)));
  const only = kids[0];
  if (kids.length !== 1 || only?.type !== 'obsEmbed') return undefined;
  const parts = parseWikiTarget(only.value);
  let p: PendingBlock;
  if (IMAGE_EXT_RE.test(parts.target) && parts.heading === undefined && parts.block === undefined) {
    const prm = imageParam(parts.alias);
    const attrs: Record<string, string> = { src: parts.target, alt: prm.alt, syntax: 'wikilink' };
    if (prm.width !== undefined) attrs.width = prm.width;
    if (prm.height !== undefined) attrs.height = prm.height;
    // 参数无法由属性还原时（如 `|` 后为空），不按图片处理
    if (formatImageParam(attrs) !== parts.alias) return undefined;
    p = { k: 'text', type: 'figure', attrs, content: [], offset: ctx.offset(node) };
  } else p = { k: 'component', type: 'note-embed', props: { ...parts }, attrs: {}, offset: ctx.offset(node) };
  if (id !== undefined) p.id = id;
  return [p];
};

const definition: BlockHandler = (node, ctx) => [rawMarkdown(ctx.raw(node), 'definition', ctx.offset(node))];

const footnoteDefinition: BlockHandler = (node, ctx) => {
  if (node.type !== 'footnoteDefinition') return undefined;
  return [
    {
      k: 'component',
      type: 'footnote',
      props: { label: node.label ?? node.identifier },
      attrs: {},
      slots: [ctx.blocks(node.children)],
      offset: ctx.offset(node),
    },
  ];
};

const obsCommentBlock: BlockHandler = (node, ctx) => [
  rawMarkdown((node as unknown as ObsCommentBlockNode).value, 'comment', ctx.offset(node)),
];

const obsDetails: BlockHandler = (node, ctx) => {
  const n = node as unknown as ObsDetailsNode;
  return [
    {
      k: 'component',
      type: 'toggle',
      props: { title: n.title, open: n.open },
      attrs: { syntax: 'html' },
      slots: [ctx.blocks(n.children)],
      offset: ctx.offset(node),
      trailingId: true,
    },
  ];
};

// ───────────────────────────── 行内处理器 ─────────────────────────────

const atom = (kind: string, attrs: Record<string, string>, text: string, marks: readonly Mark[]): InlineNode[] => [
  { t: 'atom', kind, attrs, text, marks: [...marks] },
];

const inlineHandlers: Record<string, InlineHandler> = {
  ehWikiLink: (n, marks) =>
    n.type === 'ehWikiLink' ? atom('wikilink', wikiAttrs(n.value), `[[${n.value}]]`, marks) : undefined,
  obsEmbed: (n, marks) =>
    n.type === 'obsEmbed' ? atom('embed', wikiAttrs(n.value), `![[${n.value}]]`, marks) : undefined,
  footnoteReference: (n, marks) => {
    if (n.type !== 'footnoteReference') return undefined;
    const label = n.label ?? n.identifier;
    return atom('footnote', { label }, label, marks);
  },
  obsInlineFootnote: (n, marks) =>
    n.type === 'obsInlineFootnote' ? atom('footnote', { form: 'inline' }, n.value, marks) : undefined,
  obsComment: (n, marks) => (n.type === 'obsComment' ? atom('comment', {}, n.value, marks) : undefined),
  inlineMath: (n, marks, ctx) => {
    if ((n.type as string) !== 'inlineMath') return undefined;
    const value = (n as unknown as { value: string }).value;
    const [s, e] = pos(n);
    const raw = ctx.source.slice(s, e);
    if (raw.startsWith('$$')) return atom('math', { display: 'block' }, value, marks);
    const inner = raw.slice(1, -1);
    if (/^\s|\s$/.test(inner) || /[0-9]/.test(ctx.source[e] ?? ''))
      return [{ t: 'text', text: raw, marks: [...marks] }];
    return undefined;
  },
};

// ───────────────────────────── 中间块变换 ─────────────────────────────

/** 源码中写明的块 ID → `attrs['md-id']`；不合法的不作为块 ID。 */
function recordSourceIds(seq: PendingBlock[]): void {
  for (const p of seq) {
    if (p.k === 'component') for (const s of p.slots ?? []) recordSourceIds(s);
    if (p.id === undefined || p.k === 'html') continue;
    p.attrs = { ...p.attrs, 'md-id': p.id };
    if (!isValidBlockId(p.id)) delete p.id;
  }
}

// ───────────────────────────── 序列化钩子 ─────────────────────────────

const edgeFirst = (n: InlineNode | undefined): string | undefined =>
  n === undefined ? undefined : n.t === 'br' ? '\n' : n.text[0];

/** Obsidian 行内原子的写法；不能安全书写时返回 `undefined`（core 退回 span）。 */
export const obsidianAtom: AtomSerializer = (a: InlineAtom, ctx, prev, next) => {
  const t = a.text;
  switch (a.kind) {
    case 'wikilink':
    case 'embed': {
      if (a.attrs.target === undefined) return undefined;
      const inner = formatWikiTarget(a.attrs);
      if (!WIKI_INNER_RE.test(inner)) return undefined;
      const body = ctx.table ? inner.replace(/\|/g, '\\|') : inner;
      return `${a.kind === 'embed' ? '!' : ''}[[${body}]]`;
    }
    case 'math': {
      const keys = Object.keys(a.attrs);
      const display = a.attrs.display === 'block' && keys.length === 1;
      if (!display && keys.length > 0) return undefined;
      const unsafe = t === '' || /[$\n\r]/.test(t) || /^\s|\s$/.test(t) || (ctx.table === true && t.includes('|'));
      const adjacentMath = (n: InlineNode | undefined): boolean => n?.t === 'atom' && n.kind === 'math';
      if (unsafe || adjacentMath(prev) || adjacentMath(next) || (!display && /^[0-9]/.test(edgeFirst(next) ?? '')))
        return spanAtom(a, ctx);
      return display ? `$$${t}$$` : `$${t}$`;
    }
    case 'footnote': {
      if (a.attrs.form === 'inline' && Object.keys(a.attrs).length === 1) {
        if (t === '' || /[\n\r]/.test(t) || !balanced(t) || t.endsWith('\\') || (ctx.table && t.includes('|')))
          return undefined;
        return `^[${t}]`;
      }
      const label = a.attrs.label;
      if (label === undefined || Object.keys(a.attrs).length !== 1 || t !== label) return undefined;
      if (!/^[^\s[\]\\^]+$/.test(label) || (ctx.table && label.includes('|'))) return undefined;
      // `[^1]` 紧跟 `:` 时，在行首会被读成脚注定义 `[^1]:` —— 退回 span 写法。
      if (edgeFirst(next) === ':') return undefined;
      return `[^${label}]`;
    }
    case 'comment': {
      if (Object.keys(a.attrs).length > 0 || t === '' || /[\n\r]/.test(t) || t.includes('%%') || t.endsWith('%'))
        return undefined;
      if (ctx.table && t.includes('|')) return undefined;
      return `%%${t}%%`;
    }
    default:
      return undefined;
  }
};

/** 方括号是否配对（行内脚注内容）。 */
function balanced(s: string): boolean {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '[') d++;
    else if (c === ']' && --d < 0) return false;
  }
  return d === 0;
}

const escAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 强制写成 `<span data-eh-inline>`（与 core 的退回写法相同）。 */
function spanAtom(a: InlineAtom, ctx: { readonly table?: boolean }): string {
  const attrs = Object.keys(a.attrs)
    .sort()
    .map((k) => ` data-eh-${k}="${escAttr(a.attrs[k] as string)}"`)
    .join('');
  const open = `<span data-eh-inline="${escAttr(a.kind)}"${attrs}>`;
  return `${ctx.table ? open.replace(/\|/g, '&#124;') : open}${escapeEhmdText(a.text, { table: ctx.table === true, singleLine: true }, false, false)}</span>`;
}

/** Obsidian 新增的行内语法需要的额外转义：`%%`（注释）、`^[`（行内脚注）。 */
export const obsidianEscape: EscapeHook = (c, prev, next) => {
  if (c === '%') return prev === '%' || next === '%' || next === undefined || prev === undefined;
  // `^[` 是行内脚注；`[^` 是脚注引用/定义（`[^1]`、行首 `[^1]:`），字面文本必须转义，否则再导入会变成脚注。
  if (c === '^') return next === '[' || next === undefined || prev === '[';
  return false;
};

/**
 * Obsidian 方言的 {@link EhmdExtension}（解析 + 行内原子/转义的写法）。块级写法见 {@link ./export.ts}。
 */
export function obsidianExtension(): EhmdExtension {
  return {
    micromark: obsidianSyntax(),
    fromMarkdown: obsidianFromMarkdown(),
    transforms: [
      (tree, source) => {
        pairDetails(tree);
        mergeComments(tree, source);
      },
    ],
    blockHandlers: {
      blockquote,
      code,
      thematicBreak,
      heading,
      paragraph,
      definition,
      footnoteDefinition,
      obsCommentBlock,
      obsDetails,
    },
    inlineHandlers,
    pendingTransforms: [recordSourceIds],
    serializeAtom: obsidianAtom,
    escapeChar: obsidianEscape,
  };
}
