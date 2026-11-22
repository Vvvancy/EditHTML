/**
 * Doc → `.md`（docs/06-import.md §5、docs/01-format-spec.md §7 最后一条）。
 *
 * 两种目标：
 * - `obsidian`：Obsidian 方言。未改动的顶层段按导入时保存的原文输出（见 {@link ./source-info.ts}），
 *   其余按模型生成：callout → `> [!type]`，可折叠 callout（带 `kind` 的 toggle）→ `> [!type]-/+`，
 *   mermaid → 围栏代码块，math → `$$`，双链/嵌入/脚注/注释 → 原写法；只写回源码中已有的块 ID
 *   （`attrs['md-id']`），从不写自动分配的 ID。没有 Obsidian 写法的组件（tabs、columns、chart…）写成
 *   EHMD 指令块（core 的 `serializeEhmd`）。
 * - `commonmark`：不使用原文，不写块 ID；组件降级：mermaid/math → 代码块；chart → 图片 + 数据代码块；
 *   其他 → 引用块 + 原始 YAML。双链 → 普通链接，标签/公式 → 文本/行内代码。
 *
 * 行内内容、列表、表格等的写法复用 core 的 EHMD 序列化器，通过 `serializeBlock` / `serializeAtom` 钩子定制。
 *
 * @module
 */
import {
  componentBlock,
  createDoc,
  ehmdDestination,
  emitYaml,
  escapeEhmdText,
  getBlock,
  htmlBlock,
  serializeEhmd,
  serializeEhmdInline,
  textBlock,
  type AtomSerializer,
  type Block,
  type BlockId,
  type ComponentBlock,
  type Doc,
  type EhmdExtension,
  type InlineContext,
  type InlineNode,
  type SerializeContext,
  type TextBlock,
} from '@edithtml/core';
import { formatImageParam, formatWikiTarget, obsidianAtom, obsidianEscape } from './extension.js';
import {
  blocksFingerprint,
  metaFingerprint,
  readSourceInfo,
  type MarkdownSourceInfo,
  type SegmentInfo,
} from './source-info.js';

/** 导出目标。 */
export type MarkdownFlavor = 'obsidian' | 'commonmark';

/** `exportMarkdown` 的选项。 */
export interface MarkdownExportOptions {
  /** 导出目标，默认 `'obsidian'`。 */
  readonly flavor?: MarkdownFlavor;
  /**
   * 是否对未改动的段使用导入时保存的原文（仅 `obsidian`），默认 `true`。
   * `false` 时一律按模型生成（用于测试生成器本身）。
   */
  readonly verbatim?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 只含给定键（且都是字符串）的对象。 */
function stringProps(v: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (!isObj(v)) return false;
  for (const k of Object.keys(v)) if (!required.includes(k) && !optional.includes(k)) return false;
  for (const k of required) if (typeof v[k] !== 'string') return false;
  for (const k of optional) if (k in v && typeof v[k] !== 'string') return false;
  return true;
}

/** 去掉 `md-` 开头的属性（导入器的内部属性）。 */
function publicAttrs(attrs: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) if (!k.startsWith('md-')) out[k] = v;
  return out;
}

/** 每行加引用前缀（空行写成 `>`）。 */
function quoteLines(body: string): string {
  return body
    .split('\n')
    .map((l) => (l === '' ? '>' : `> ${l}`))
    .join('\n');
}

/** 不短于 `min`、比 `body` 中行首最长的同字符序列多一个的围栏。 */
function fenceFor(body: string, ch: '`' | '~', min = 3): string {
  let longest = 0;
  const re = ch === '`' ? /^ {0,3}(`+)/gm : /^ {0,3}(~+)/gm;
  for (const m of body.matchAll(re)) longest = Math.max(longest, (m[1] as string).length);
  return ch.repeat(Math.max(min, longest + 1));
}

const SIMPLE_LANG_RE = /^[^\s`~{}\\&]+(?: [^\s`~{}\\&]+)*$/;

/** 围栏代码块。`style.fence` 为原文的围栏（如 `~~~`）。 */
function fencedCode(
  lang: string | undefined,
  text: string,
  style: Readonly<Record<string, string>>,
  id: string | undefined,
): string {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const ch = style.fence?.[0] === '~' ? '~' : '`';
  const f = fenceFor(body, ch, style.fence?.length ?? 3);
  const brace = id !== undefined && style.idstyle === 'brace';
  const info = [lang ?? '', brace ? `{#${id}}` : ''].filter((x) => x !== '').join(' ');
  const trailing = id !== undefined && !brace ? `\n\n^${id}` : '';
  return (text === '' ? `${f}${info}\n${f}` : `${f}${info}\n${body}\n${f}`) + trailing;
}

const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const WIKI_INNER_RE = /^[^[\]\n\r\\]+$/;

/** 段落/块中写原子的 Obsidian 行内上下文。 */
const OBSIDIAN_INLINE: Pick<InlineContext, 'atom' | 'escapeChar'> = { atom: obsidianAtom, escapeChar: obsidianEscape };

// ───────────────────────────── 生成器 ─────────────────────────────

interface Mini {
  readonly doc: Doc;
  readonly keep: Set<BlockId>;
  /** 小文档中的 ID → 原文档中的 ID。 */
  readonly orig: Map<BlockId, BlockId>;
}

/**
 * 为一组顶层块建一个"小文档"：源码中写明的 ID（`md-id`）作为块 ID（这样 core 写出的就是原 ID），
 * 其余块换成不会被写出的临时 ID；去掉内部属性；去掉没有源码 ID 的空段落（Markdown 无法表示）。
 */
function miniDoc(doc: Doc, ids: readonly BlockId[], keepSourceIds: boolean): Mini {
  const all: Block[] = [];
  const visit = (xs: readonly BlockId[]): void => {
    for (const id of xs) {
      const b = getBlock(doc, id);
      all.push(b);
      if (b.kind === 'component') for (const s of b.slots ?? []) visit(s);
    }
  };
  visit(ids);
  const used = new Set<BlockId>();
  const name = new Map<BlockId, BlockId>();
  const keep = new Set<BlockId>();
  if (keepSourceIds)
    for (const b of all) {
      const md = b.kind === 'html' ? undefined : b.attrs['md-id'];
      if (md !== undefined && md !== '' && !used.has(md)) {
        used.add(md);
        name.set(b.id, md);
        keep.add(md);
      }
    }
  let n = 0;
  for (const b of all) {
    if (name.has(b.id)) continue;
    let fresh: string;
    do fresh = `zz${(n++).toString(36)}`;
    while (used.has(fresh));
    used.add(fresh);
    name.set(b.id, fresh);
  }
  const orig = new Map<BlockId, BlockId>();
  for (const [o, m] of name) orig.set(m, o);
  const droppable = (id: BlockId): boolean => {
    const b = getBlock(doc, id);
    return b.kind === 'text' && b.type === 'p' && b.content.length === 0 && !keep.has(name.get(id) as BlockId);
  };
  const out: Block[] = [];
  const build = (xs: readonly BlockId[]): BlockId[] =>
    xs
      .filter((id) => !droppable(id))
      .map((id) => {
        const b = getBlock(doc, id);
        const nid = name.get(id) as BlockId;
        if (b.kind === 'html') out.push(htmlBlock(nid, b.html));
        else if (b.kind === 'text') out.push(textBlock(nid, b.type, b.content, publicAttrs(b.attrs), b.table));
        else {
          const slots = b.slots?.map(build);
          out.push(
            componentBlock(nid, b.type, b.props, {
              attrs: publicAttrs(b.attrs),
              ...(slots ? { slots } : {}),
              ...(b.fallback !== undefined ? { fallback: b.fallback } : {}),
            }),
          );
        }
        return nid;
      });
  const root = build(ids);
  return { doc: createDoc(out, { root }), keep, orig };
}

type Styles = Readonly<Record<BlockId, Readonly<Record<string, string>>>>;

/** Obsidian 目标的块写法钩子。 */
function obsidianBlocks(styles: Styles, orig: ReadonlyMap<BlockId, BlockId>): EhmdExtension['serializeBlock'] {
  return (b: Block, ctx: SerializeContext): string | undefined => {
    const style = styles[orig.get(b.id) ?? ''] ?? {};
    const id = ctx.emitId(b.id) ? b.id : undefined;
    const trailing = id !== undefined ? `\n\n^${id}` : '';
    const caret = id !== undefined ? ` ^${id}` : '';
    if (b.kind === 'text') return obsidianText(b, style, id);
    if (b.kind !== 'component') return undefined;
    const p = b.props;
    const attrs = publicAttrs(b.attrs);
    const nAttrs = Object.keys(attrs).length;
    // 指令块只在顶格识别：引用 / 缩进中的内容含指令时，整个容器改用指令写法（交给 core）
    const slot0 = (): string | undefined => {
      const body = ctx.blocks(b.slots?.[0] ?? []);
      return /^::/m.test(body) ? undefined : body;
    };
    const oneSlot = b.slots?.length === 1;
    switch (b.type) {
      case 'callout': {
        if (!oneSlot || nAttrs > 0 || !stringProps(p, ['kind', 'title'])) return undefined;
        const { kind, title } = p as { kind: string; title: string };
        if (!calloutHeadOk(kind, title)) return undefined;
        const body = slot0();
        if (body === undefined) return undefined;
        return quoteLines(`[!${kind}]${title ? ` ${title}` : ''}${body ? `\n${body}` : ''}`) + trailing;
      }
      case 'toggle': {
        if (!oneSlot || !isObj(p) || typeof p.title !== 'string' || typeof p.open !== 'boolean') return undefined;
        if (Object.keys(p).length !== 2) return undefined;
        const title = p.title;
        if (nAttrs === 1 && typeof attrs.kind === 'string') {
          if (!calloutHeadOk(attrs.kind, title)) return undefined;
          const body = slot0();
          if (body === undefined) return undefined;
          const head = `[!${attrs.kind}]${p.open ? '+' : '-'}${title ? ` ${title}` : ''}`;
          return quoteLines(`${head}${body ? `\n${body}` : ''}`) + trailing;
        }
        if (nAttrs === 1 && attrs.syntax === 'html' && !/[\n\r]/.test(title) && title === title.trim()) {
          const body = ctx.blocks(b.slots?.[0] ?? []);
          return (
            `<details${p.open ? ' open' : ''}>\n<summary>${escHtml(title)}</summary>\n\n` +
            (body ? `${body}\n\n` : '') +
            `</details>${trailing}`
          );
        }
        return undefined;
      }
      case 'math': {
        if (nAttrs > 0 || !stringProps(p, ['tex'])) return undefined;
        const tex = (p as { tex: string }).tex;
        if (/^[ \t]*\$\$/m.test(tex) || tex.includes('$$')) return undefined;
        // ID 写在其后单独一行（`$$ ^id` 的写法只在顶层由预处理识别，引用中不行）
        return (tex === '' ? '$$\n$$' : `$$\n${tex}\n$$`) + trailing;
      }
      case 'mermaid': {
        if (nAttrs > 0 || !stringProps(p, ['source'])) return undefined;
        const src = (p as { source: string }).source;
        return fencedCode('mermaid', src === '' ? '' : `${src}\n`, style, id);
      }
      case 'markdown': {
        if (!stringProps(p, ['source'])) return undefined;
        return (p as { source: string }).source;
      }
      case 'footnote': {
        if (!oneSlot || nAttrs > 0 || !stringProps(p, ['label'])) return undefined;
        const label = (p as { label: string }).label;
        if (!/^[^\s[\]\\^]+$/.test(label)) return undefined;
        const body = slot0();
        if (body === undefined) return undefined;
        const [first, ...rest] = body.split('\n');
        const head = `[^${label}]:${first ? ` ${first}` : ''}`;
        return [head, ...rest.map((l) => (l === '' ? '' : `    ${l}`))].join('\n');
      }
      case 'note-embed': {
        if (nAttrs > 0 || !stringProps(p, ['target'], ['heading', 'block', 'alias'])) return undefined;
        const inner = formatWikiTarget(p as Record<string, string>);
        if (!WIKI_INNER_RE.test(inner)) return undefined;
        return `![[${inner}]]${caret}`;
      }
      default:
        return undefined;
    }
  };
}

/** callout 标题行能否写成 `[!kind] 标题`。 */
function calloutHeadOk(kind: string, title: string): boolean {
  return /^[^\]\s]+$/.test(kind) && !/[\n\r]/.test(title) && title === title.trim();
}

function obsidianText(
  b: TextBlock,
  style: Readonly<Record<string, string>>,
  id: string | undefined,
): string | undefined {
  switch (b.type) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      if (id === undefined) return undefined;
      const text = serializeEhmdInline(b.content, { singleLine: true, ...OBSIDIAN_INLINE });
      const mark = style.idstyle === 'brace' ? `{#${id}}` : `^${id}`;
      return `${'#'.repeat(Number(b.type[1]))}${text ? ` ${text}` : ''} ${mark}`;
    }
    case 'hr':
      return (style.hr ?? '---') + (id !== undefined ? `\n\n^${id}` : '');
    case 'code': {
      const { lang, ...rest } = publicAttrs(b.attrs);
      if (Object.keys(rest).length > 0) return undefined;
      if (lang !== undefined && lang !== '' && !SIMPLE_LANG_RE.test(lang)) return undefined;
      const text = b.content.map((n) => (n.t === 'text' ? n.text : '')).join('');
      return fencedCode(lang || undefined, text, style, id);
    }
    case 'figure': {
      if (b.attrs.syntax !== 'wikilink' || b.content.length > 0) return undefined;
      const param = formatImageParam(b.attrs);
      const inner = `${b.attrs.src ?? ''}${param !== undefined ? `|${param}` : ''}`;
      if (!WIKI_INNER_RE.test(inner)) return undefined;
      return `![[${inner}]]${id !== undefined ? ` ^${id}` : ''}`;
    }
    default:
      return undefined;
  }
}

// ───────────────────────────── CommonMark 降级 ─────────────────────────────

/** 行内代码（反引号数比内容中最长的连续反引号多一个）。 */
function codeSpan(s: string): string {
  let longest = 0;
  for (const m of s.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const f = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') || s.startsWith(' ') || s.endsWith(' ') ? ' ' : '';
  return `${f}${pad}${s}${pad}${f}`;
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|svg|webp|bmp|avif|tiff?|ico)$/i;

/** 双链 / 嵌入的显示文本与链接目标。 */
function wikiLinkParts(attrs: Readonly<Record<string, string>>): { label: string; href: string } {
  const target = attrs.target ?? '';
  const sub = attrs.block !== undefined ? `^${attrs.block}` : attrs.heading;
  const label = attrs.alias ?? `${target}${sub !== undefined ? `#${sub}` : ''}`;
  const anchor = attrs.block ?? attrs.heading;
  const href = `${target}${anchor !== undefined ? `#${anchor}` : ''}`;
  return { label, href };
}

const commonmarkAtom: AtomSerializer = (a, ctx) => {
  const c = { table: ctx.table === true, singleLine: true };
  const text = (s: string): string => escapeEhmdText(s, c, false, false);
  const link = (label: string, href: string): string =>
    serializeEhmdInline([{ t: 'text', text: label || href, marks: [{ type: 'link', attrs: { href } }] }], c);
  switch (a.kind) {
    case 'wikilink': {
      const { label, href } = wikiLinkParts(a.attrs);
      return href === '' ? text(a.text) : link(label, href);
    }
    case 'embed': {
      const target = a.attrs.target ?? '';
      if (IMAGE_EXT_RE.test(target)) {
        const prm = a.attrs.alias !== undefined && !/^\d+(x\d+)?$/.test(a.attrs.alias) ? a.attrs.alias : '';
        return `![${text(prm)}](${ehmdDestination(target, ctx.table === true)})`;
      }
      const { label, href } = wikiLinkParts(a.attrs);
      return href === '' ? text(a.text) : link(label, href);
    }
    case 'tag':
      return text(a.text);
    case 'math':
      return codeSpan(a.attrs.display === 'block' ? `$$${a.text}$$` : `$${a.text}$`);
    case 'footnote':
      if (a.attrs.form === 'inline') return text(`^[${a.text}]`);
      return a.attrs.label !== undefined && /^[^\s[\]\\^|]+$/.test(a.attrs.label)
        ? `[^${a.attrs.label}]`
        : text(a.text);
    case 'comment':
      return `<!--${a.text.replace(/--/g, '- -').replace(/-$/, '- ')}-->`;
    default:
      return undefined;
  }
};

/** CommonMark 目标的块写法钩子。 */
function commonmarkBlocks(styles: Styles, orig: ReadonlyMap<BlockId, BlockId>): EhmdExtension['serializeBlock'] {
  return (b: Block, ctx: SerializeContext): string | undefined => {
    const style = styles[orig.get(b.id) ?? ''] ?? {};
    if (b.kind === 'html') return b.html;
    if (b.kind === 'text') {
      if (b.type === 'hr') return style.hr ?? '---';
      if (b.type === 'code') {
        const { lang, ...rest } = publicAttrs(b.attrs);
        if (Object.keys(rest).length > 0 || (lang !== undefined && lang !== '' && !SIMPLE_LANG_RE.test(lang)))
          return undefined;
        return fencedCode(
          lang || undefined,
          b.content.map((n) => (n.t === 'text' ? n.text : '')).join(''),
          style,
          undefined,
        );
      }
      return undefined;
    }
    return commonmarkComponent(b, ctx, style);
  };
}

function commonmarkComponent(
  b: ComponentBlock,
  ctx: SerializeContext,
  style: Readonly<Record<string, string>>,
): string {
  const p = b.props;
  switch (b.type) {
    case 'mermaid':
      if (stringProps(p, ['source'])) {
        const s = (p as { source: string }).source;
        return fencedCode('mermaid', s === '' ? '' : `${s}\n`, style, undefined);
      }
      break;
    case 'math':
      if (stringProps(p, ['tex'])) {
        const s = (p as { tex: string }).tex;
        return fencedCode('math', s === '' ? '' : `${s}\n`, {}, undefined);
      }
      break;
    case 'chart': {
      const yaml = emitYaml(p ?? {});
      const parts: string[] = [];
      const src = /<img\b[^>]*\bsrc="([^"]+)"/i.exec(b.fallback ?? '')?.[1];
      const title = isObj(p) && isObj(p.options) && typeof p.options.title === 'string' ? p.options.title : 'chart';
      if (src)
        parts.push(`![${escapeEhmdText(title, { singleLine: true }, false, false)}](${ehmdDestination(src, false)})`);
      parts.push(fencedCode('yaml', `${yaml}\n`, {}, undefined));
      return parts.join('\n\n');
    }
    case 'markdown':
      if (stringProps(p, ['source'])) {
        const s = (p as { source: string }).source;
        if (b.attrs.syntax === 'comment')
          return `<!--${s
            .replace(/^%%|%%$/g, '')
            .replace(/--/g, '- -')
            .replace(/-$/, '- ')}-->`;
        return s;
      }
      break;
    case 'footnote':
      if (b.slots?.length === 1 && stringProps(p, ['label']) && /^[^\s[\]\\^]+$/.test((p as { label: string }).label)) {
        const [first, ...rest] = ctx.blocks(b.slots[0] ?? []).split('\n');
        return [
          `[^${(p as { label: string }).label}]:${first ? ` ${first}` : ''}`,
          ...rest.map((l) => (l ? `    ${l}` : '')),
        ].join('\n');
      }
      break;
    case 'note-embed':
      if (stringProps(p, ['target'], ['heading', 'block', 'alias'])) {
        const { label, href } = wikiLinkParts(p as Record<string, string>);
        const node: InlineNode = {
          t: 'text',
          text: label || href || ' ',
          marks: href ? [{ type: 'link', attrs: { href } }] : [],
        };
        return serializeEhmdInline([node]);
      }
      break;
  }
  // 其他：引用块 + 原始 YAML（+ 槽位内容）
  const data: Record<string, unknown> = { [b.type]: p ?? {} };
  const attrs = publicAttrs(b.attrs);
  if (Object.keys(attrs).length > 0) data.attrs = attrs;
  const yaml = emitYaml(data);
  const parts = [fencedCode('yaml', `${yaml}\n`, {}, undefined)];
  for (const s of b.slots ?? []) {
    const body = ctx.blocks(s);
    if (body) parts.push(body);
  }
  return quoteLines(parts.join('\n\n'));
}

/**
 * 按模型生成一组顶层块的 Markdown（不含首尾空行，不以 `\n` 结尾）。
 *
 * @param doc 文档。
 * @param ids 顶层块 ID（连续的 `li` 归为一个列表）。
 * @param flavor 导出目标。
 * @param styles 写法记录（来源表中的 `style`）。
 */
export function generateMarkdown(
  doc: Doc,
  ids: readonly BlockId[],
  flavor: MarkdownFlavor = 'obsidian',
  styles: Styles = {},
): string {
  const mini = miniDoc(doc, ids, flavor === 'obsidian');
  const ext: EhmdExtension =
    flavor === 'obsidian'
      ? { serializeBlock: obsidianBlocks(styles, mini.orig), serializeAtom: obsidianAtom, escapeChar: obsidianEscape }
      : { serializeBlock: commonmarkBlocks(styles, mini.orig), serializeAtom: commonmarkAtom };
  const out = serializeEhmd(mini.doc, {
    ids: flavor === 'obsidian' ? 'referenced' : 'none',
    keepIds: mini.keep,
    extensions: [ext],
    fragment: true,
  });
  return out.replace(/\n$/, '');
}

/** meta 键的输出顺序：与 `#eh-meta` 一致（01 §6.1）。 */
function orderedMeta(meta: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const order = ['title', 'created', 'tags', 'theme'];
  const out: Record<string, unknown> = {};
  for (const k of order) if (meta[k] !== undefined) out[k] = meta[k];
  for (const k of Object.keys(meta).sort()) if (!order.includes(k) && meta[k] !== undefined) out[k] = meta[k];
  return out;
}

interface Unit {
  readonly ids: readonly BlockId[];
  readonly seg?: SegmentInfo;
}

/** 把顶层块切成单元：与来源表中某段完全对应的连续块是一个单元，其余相邻块合成一个单元。 */
function units(doc: Doc, info: MarkdownSourceInfo | null): Unit[] {
  const byFirst = new Map<BlockId, SegmentInfo>();
  for (const s of info?.segments ?? []) if (s.ids.length > 0) byFirst.set(s.ids[0] as BlockId, s);
  const out: Unit[] = [];
  let free: BlockId[] = [];
  const root = doc.root;
  for (let i = 0; i < root.length;) {
    const s = byFirst.get(root[i] as BlockId);
    if (s && s.ids.every((id, k) => root[i + k] === id)) {
      if (free.length) out.push({ ids: free });
      free = [];
      out.push({ ids: s.ids, seg: s });
      i += s.ids.length;
    } else free.push(root[i++] as BlockId);
  }
  if (free.length) out.push({ ids: free });
  return out;
}

/**
 * 把文档导出为 Markdown。
 *
 * - `obsidian`（默认）：未改动的内容与导入的原文逐字节一致（含 frontmatter、空行、`\r\n` 与 BOM）；
 * - `commonmark`：见模块说明。
 *
 * @param doc 文档（通常来自 `importMarkdown`；任何文档都可以导出）。
 * @param opts 选项，见 {@link MarkdownExportOptions}。
 */
export function exportMarkdown(doc: Doc, opts: MarkdownExportOptions = {}): string {
  const flavor = opts.flavor ?? 'obsidian';
  const info = readSourceInfo(doc);
  const useSrc = flavor === 'obsidian' && opts.verbatim !== false;
  const styles = info?.style ?? {};

  let fm = '';
  if (info?.frontmatter && metaFingerprint(doc.meta) === info.frontmatter.fp) fm = info.frontmatter.raw;
  else if (Object.keys(doc.meta).length > 0) fm = `---\n${emitYaml(orderedMeta(doc.meta))}\n---\n`;

  const first = info?.segments[0];
  // 决定每个单元用原文还是重新生成；相邻的两个重新生成的单元若在列表项处相接，合并后一起生成
  // （否则 `- a` 与 `- b` 之间的空行会让它们在读回时成为同一个列表，导出不幂等）
  const isLi = (id: BlockId | undefined): boolean => {
    const b = id === undefined ? undefined : doc.blocks.get(id);
    return b?.kind === 'text' && b.type === 'li';
  };
  const plan: { ids: BlockId[]; seg?: SegmentInfo; unchanged: boolean; src?: string }[] = [];
  for (const u of units(doc, info)) {
    const unchanged = u.seg !== undefined && blocksFingerprint(doc, u.ids) === u.seg.fp;
    const src = unchanged && useSrc ? u.seg?.src : undefined;
    const prev = plan[plan.length - 1];
    if (
      prev &&
      prev.src === undefined &&
      src === undefined &&
      !(useSrc && prev.unchanged && unchanged) &&
      isLi(prev.ids[prev.ids.length - 1]) &&
      isLi(u.ids[0])
    ) {
      prev.ids.push(...u.ids);
      prev.unchanged = false;
      continue;
    }
    plan.push({ ids: [...u.ids], ...(u.seg ? { seg: u.seg } : {}), unchanged, ...(src !== undefined ? { src } : {}) });
  }
  let out = fm;
  let prevUnchanged = false;
  let emitted = 0;
  for (const u of plan) {
    const unchanged = u.unchanged;
    // 输出与原文完全相同（原文本身，或导入时已确认生成结果等于原文）
    const exact = unchanged && (u.src !== undefined || u.seg?.src === undefined);
    let text = u.src ?? generateMarkdown(doc, u.ids, flavor, styles);
    if (text === '') continue;
    const gap = u.seg?.gap;
    let sep: string;
    if (emitted === 0) {
      sep = u.seg !== undefined && u.seg === first && gap !== undefined ? gap : fm ? '\n' : '';
      // 文首的 `---` 分割线会被读成 frontmatter 的开始：改写成 `***`
      const b0 = doc.blocks.get(u.ids[0] as BlockId);
      if (fm === '' && !exact && b0?.kind === 'text' && b0.type === 'hr' && /^-/.test(text))
        text = text.replace(/^[^\n]*/, '***');
    } else if (gap !== undefined && u.seg !== first && (/\n[ \t]*\n|[^\s]/.test(gap) || (prevUnchanged && exact)))
      sep = gap;
    else sep = '\n\n';
    out += sep + text;
    prevUnchanged = exact;
    emitted++;
  }
  out += info?.tail ?? (emitted > 0 ? '\n' : '');
  if (info?.crlf) out = out.replace(/\n/g, '\r\n');
  if (info?.bom) out = `\uFEFF${out}`;
  return out;
}
