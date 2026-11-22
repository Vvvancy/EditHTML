/**
 * EHMD → {@link Doc}（T1.6）。规则见 docs/01-format-spec.md §7 与其"实现约定（T1.6，暂定）"。
 *
 * 流程：BOM/CRLF 规范化 → frontmatter → 指令预扫描（{@link scanDirectives}）→ micromark + mdast
 * （GFM、math、EHMD 行内语法与扩展）→ mdast 块 → 中间块（{@link PendingBlock}）→ 统一分配块 ID → `Doc`。
 * 解析从不抛错，所有降级都以告警报告。
 *
 * @module
 */
import type { Definition, Nodes, Paragraph, PhrasingContent, Root, RootContent, Table } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import { createIdGenerator, isValidBlockId } from '../ids.js';
import {
  componentBlock,
  createDoc,
  htmlBlock,
  textBlock,
  type Block,
  type BlockId,
  type CellAlign,
  type DocMeta,
  type InlineNode,
  type TableData,
} from '../model.js';
import { decodeEntities } from '../parse/entities.js';
import { parse as parseHtml } from '../parse/index.js';
import { splitTrailingAttrs } from './attrs.js';
import {
  BUILTIN_DIRECTIVES,
  HTML_DIRECTIVE,
  PROPS_DIRECTIVE,
  SLOT_DIRECTIVE,
  type DirectiveHead,
  type DirectiveSpec,
} from './directives.js';
import { InlineConverter } from './inline-parse.js';
import { scanDirectives, splitFrontmatter, type RawDirective, type ScanResult } from './prepass.js';
import { ehmdFromMarkdown, ehmdSyntax } from './syntax.js';
import type {
  BlockContext,
  BlockHandler,
  EhmdExtension,
  EhmdParseOptions,
  EhmdParseResult,
  EhmdSourceMap,
  EhmdSourceSegment,
  EhmdWarning,
  EhmdWarningCode,
  InlineHandler,
  PendingBlock,
} from './types.js';
import { loadYaml } from './yaml.js';

/** 容器内的子指令（槽位 / props）在块序列中的占位项。 */
type Item =
  | PendingBlock
  | { readonly k: 'slot'; name: string; head: DirectiveHead; blocks: PendingBlock[]; offset: number }
  | { readonly k: 'props'; value: unknown; offset: number }
  | { readonly k: 'idmark'; id: string; offset: number };

/** 容器上下文：哪些子指令名是槽位。 */
interface ContainerCtx {
  readonly slotNames: ReadonlySet<string>;
}

/** 指令嵌套的安全上限（防止恶意输入导致栈溢出；不是规范的嵌套上限，见 05 #5）。 */
const MAX_DEPTH = 64;

const ID_CHARS = '[A-Za-z0-9_-]+';
const CARET_ID_RE = new RegExp(`(^|[ \\t]+)\\^(${ID_CHARS})[ \\t]*$`);
const ANY_ID_RE = new RegExp(`(^|[ \\t]+)(?:\\^(${ID_CHARS})|\\{#([^\\s{}]+)\\})[ \\t]*$`);
const STANDALONE_ID_RE = new RegExp(`^\\^(${ID_CHARS})$`);

/**
 * GFM 的 mdast 扩展，去掉自动链接字面量的 `transforms`：那个变换在解码后的文本上再找一遍 URL，
 * 会无视源码中的转义（`www\.x`）；micromark 语法层的识别已经足够，且尊重转义。
 */
const GFM_FROM_MARKDOWN = gfmFromMarkdown().map(({ transforms: _t, ...e }) => e);

/** 已注册扩展合并后的配置。 */
interface Config {
  readonly micromark: NonNullable<EhmdExtension['micromark']>[number][];
  readonly fromMarkdown: NonNullable<EhmdExtension['fromMarkdown']>[number][];
  readonly transforms: NonNullable<EhmdExtension['transforms']>[number][];
  readonly pendingTransforms: NonNullable<EhmdExtension['pendingTransforms']>[number][];
  readonly blockHandlers: Map<string, BlockHandler[]>;
  readonly inlineHandlers: Map<string, InlineHandler[]>;
  readonly directives: Map<string, DirectiveSpec>;
}

/** 合并扩展（供 parse 与 serialize 共用）。 */
export function directiveRegistry(extensions: readonly EhmdExtension[] = []): Map<string, DirectiveSpec> {
  const m = new Map<string, DirectiveSpec>();
  for (const s of BUILTIN_DIRECTIVES) m.set(s.type, s);
  for (const e of extensions) for (const s of e.directives ?? []) m.set(s.type, s);
  return m;
}

function buildConfig(extensions: readonly EhmdExtension[]): Config {
  const blockHandlers = new Map<string, BlockHandler[]>();
  const inlineHandlers = new Map<string, InlineHandler[]>();
  // 后注册的优先
  for (const e of [...extensions].reverse()) {
    for (const [k, h] of Object.entries(e.blockHandlers ?? {}))
      blockHandlers.set(k, [...(blockHandlers.get(k) ?? []), h]);
    for (const [k, h] of Object.entries(e.inlineHandlers ?? {}))
      inlineHandlers.set(k, [...(inlineHandlers.get(k) ?? []), h]);
  }
  return {
    micromark: extensions.flatMap((e) => e.micromark ?? []),
    fromMarkdown: extensions.flatMap((e) => e.fromMarkdown ?? []),
    transforms: extensions.flatMap((e) => e.transforms ?? []),
    pendingTransforms: extensions.flatMap((e) => e.pendingTransforms ?? []),
    blockHandlers,
    inlineHandlers,
    directives: directiveRegistry(extensions),
  };
}

/** 段落/标题末尾的块 ID：从最后一个文本节点中剥离。 */
function stripTrailingId(
  children: readonly PhrasingContent[],
  src: string,
  start: number,
  end: number,
  re: RegExp,
): { id?: string; children: PhrasingContent[] } {
  const m = re.exec(src.slice(start, end).replace(/[ \t\n]+$/, ''));
  if (!m) return { children: [...children] };
  // 标记（含前导空白）在原文中的起点；标记本身是字面字符（ID 中的 `#` 可能被识别成标签节点，一并丢弃）
  const cut = start + m.index;
  const out: PhrasingContent[] = [];
  for (const c of children) {
    const cs = c.position?.start.offset ?? 0;
    const ce = c.position?.end.offset ?? 0;
    if (cs >= cut) continue;
    if (ce > cut) {
      if (c.type !== 'text') return { children: [...children] };
      const dropped = src.slice(cut, ce).replace(/[ \t\n]+$/, '').length;
      const v = c.value.replace(/[ \t]+$/, '');
      const value = v.slice(0, Math.max(0, v.length - dropped));
      if (value !== '') out.push({ ...c, value });
      continue;
    }
    out.push(c);
  }
  return { id: (m[2] ?? m[3]) as string, children: out };
}

/** 顶层源码区间（ID 分配前）。 */
interface RawSegment {
  start: number;
  end: number;
  items: PendingBlock[];
}

/** 递归解析器（每段 Markdown 文本一个实例）。 */
class BodyParser {
  constructor(
    private readonly cfg: Config,
    private readonly warnings: EhmdWarning[],
    private readonly src: string,
    private readonly base: number,
    private readonly container: ContainerCtx | null,
    private readonly depth: number,
    /** 只有文档顶层的解析器记录源码区间。 */
    private readonly segments: RawSegment[] | null = null,
  ) {}

  private scan!: ScanResult;
  private defs = new Map<string, { url: string; title: string | null }>();
  private inl!: InlineConverter;
  private ctx!: BlockContext;

  warn(code: EhmdWarningCode, message: string, offset: number): void {
    this.warnings.push({ code, message, offset });
  }

  /** `markdown` 中的偏移 → 原始输入中的偏移。 */
  private abs(off: number): number {
    return this.base + this.scan.mapOffset(off);
  }

  run(): Item[] {
    this.scan = scanDirectives(this.src);
    const tree: Root = fromMarkdown(this.scan.markdown, {
      extensions: [gfm(), math(), ...ehmdSyntax(), ...this.cfg.micromark],
      mdastExtensions: [...GFM_FROM_MARKDOWN, mathFromMarkdown(), ehmdFromMarkdown(), ...this.cfg.fromMarkdown],
    });
    for (const t of this.cfg.transforms) t(tree, this.scan.markdown);
    const defs = this.defs;
    const collect = (n: Nodes): void => {
      if (n.type === 'definition') {
        const d = n as Definition;
        if (!defs.has(d.identifier)) defs.set(d.identifier, { url: d.url, title: d.title ?? null });
      }
      if ('children' in n) for (const c of n.children) collect(c);
    };
    collect(tree);
    const md = this.scan.markdown;
    this.ctx = {
      source: md,
      raw: (n) => md.slice(n.position?.start.offset ?? 0, n.position?.end.offset ?? 0),
      blocks: (nodes) => this.blocksOf(this.attachIdMarks(this.flow(nodes))),
      inline: (nodes, marks) => this.inl.convert(nodes, marks ?? []),
      stripId: (node, allowBraces) =>
        stripTrailingId(
          node.children,
          md,
          node.position?.start.offset ?? 0,
          node.position?.end.offset ?? 0,
          allowBraces ? ANY_ID_RE : CARET_ID_RE,
        ),
      yaml: loadYaml,
      parseBody: (src, offset) => this.blocksOf(this.sub(src, offset, null)),
      offset: (n) => this.abs(n.position?.start.offset ?? 0),
      warn: (c, m, o) => this.warn(c, m, o),
    };
    this.inl = new InlineConverter(this.ctx, this.cfg.inlineHandlers, defs);
    if (this.segments) return this.flowSegments(tree.children, this.segments);
    return this.attachIdMarks(this.flow(tree.children));
  }

  /** 逐个顶层节点转换并记录源码区间（`^id` 行附着到前一块时并入前一段）。 */
  private flowSegments(nodes: readonly RootContent[], segs: RawSegment[]): Item[] {
    const out: Item[] = [];
    for (const n of nodes) {
      const start = this.ctx.offset(n);
      let end = this.abs(n.position?.end.offset ?? 0);
      if (n.type === 'html') {
        const pm = this.scan.placeholder.exec(n.value.trim());
        const d = pm ? this.scan.directives[Number(pm[1])] : undefined;
        if (d) end = this.base + d.offset + d.raw.length;
      }
      const items = this.flow([n]);
      const kept: PendingBlock[] = [];
      let attached = false;
      for (const it of items) {
        if (it.k !== 'idmark') {
          if (it.k === 'text' || it.k === 'component' || it.k === 'html') kept.push(it);
          out.push(it);
          continue;
        }
        const p = this.attachIdMark(out, it);
        if (!p) attached = true;
        else {
          kept.push(p);
          out.push(p);
        }
      }
      const last = segs[segs.length - 1];
      if (attached && kept.length === 0 && last) last.end = end;
      else segs.push({ start, end, items: kept });
    }
    return out;
  }

  private sub(src: string, offset: number, container: ContainerCtx | null): Item[] {
    return new BodyParser(this.cfg, this.warnings, src, offset, container, this.depth + 1).run();
  }

  /** 单独一行的 `^id`：接到前一个不能内联 ID 的块上；否则是带 ID 的空段落。 */
  private attachIdMarks(items: Item[]): Item[] {
    const out: Item[] = [];
    for (const it of items) {
      if (it.k !== 'idmark') out.push(it);
      else {
        const p = this.attachIdMark(out, it);
        if (p) out.push(p);
      }
    }
    return out;
  }

  /** 把 `^id` 接到 `out` 的最后一项上；接不上时返回带该 ID 的空段落。 */
  private attachIdMark(out: readonly Item[], it: Extract<Item, { k: 'idmark' }>): PendingBlock | null {
    const prev = out[out.length - 1];
    if (
      prev &&
      (prev.k === 'text' || prev.k === 'component' || prev.k === 'html') &&
      prev.trailingId &&
      prev.id === undefined
    ) {
      prev.id = it.id;
      prev.trailingId = false;
      return null;
    }
    return { k: 'text', type: 'p', attrs: {}, content: [], id: it.id, offset: it.offset };
  }

  private flow(nodes: readonly RootContent[]): Item[] {
    const out: Item[] = [];
    for (const n of nodes) {
      const hs = this.cfg.blockHandlers.get(n.type) ?? [];
      const run = (k: number): Item[] => {
        const h = hs[k];
        if (!h) return this.builtin(n);
        return h(n, this.ctx, () => run(k + 1) as PendingBlock[]) ?? run(k + 1);
      };
      out.push(...run(0));
    }
    return out;
  }

  private text(
    type: Extract<PendingBlock, { k: 'text' }>['type'],
    content: InlineNode[],
    node: Nodes,
    extra: { attrs?: Record<string, string>; id?: string; table?: TableData; trailingId?: boolean } = {},
  ): PendingBlock {
    const p: PendingBlock = { k: 'text', type, attrs: extra.attrs ?? {}, content, offset: this.ctx.offset(node) };
    if (extra.id !== undefined) p.id = extra.id;
    if (extra.table) p.table = extra.table;
    if (extra.trailingId) p.trailingId = true;
    return p;
  }

  private builtin(n: RootContent): Item[] {
    const off = this.ctx.offset(n);
    switch (n.type) {
      case 'paragraph':
        return this.paragraph(n, true);
      case 'heading': {
        const { id, children } = this.ctx.stripId(n, true);
        return [this.text(`h${n.depth}` as 'h1', this.ctx.inline(children), n, { id })];
      }
      case 'thematicBreak':
        return [this.text('hr', [], n, { trailingId: true })];
      case 'blockquote':
        return this.blockquote(n.children, n);
      case 'list':
        return this.list(n, 0);
      case 'code':
        return [this.code(n)];
      case 'math':
        return [{ k: 'component', type: 'math', props: { tex: n.value }, attrs: {}, offset: off, trailingId: true }];
      case 'table':
        return [this.table(n)];
      case 'html':
        return this.html(n.value, off);
      case 'definition':
        return [];
      case 'footnoteDefinition': {
        const [first, ...rest] = n.children;
        const label: InlineNode = { t: 'text', text: `[^${n.label ?? n.identifier}]: `, marks: [] };
        const head =
          first?.type === 'paragraph'
            ? [this.text('p', [label, ...this.ctx.inline(first.children)], n)]
            : [this.text('p', [label], n), ...(first ? this.flow([first]) : [])];
        return [...head, ...this.flow(rest)];
      }
      default: {
        this.warn('unsupported-node', `unsupported block node ${n.type}; kept as a code block`, off);
        const raw = this.ctx.raw(n);
        return [
          this.text('code', raw ? [{ t: 'text', text: raw + '\n', marks: [] }] : [], n, {
            attrs: { lang: 'markdown' },
          }),
        ];
      }
    }
  }

  /** 段落：单独的 `^id`、figure（以图片开头）、普通段落。 */
  private paragraph(n: Paragraph, topLevel: boolean): Item[] {
    const raw = this.ctx.raw(n).replace(/^[ \t\n]+|[ \t\n]+$/g, '');
    const sm = STANDALONE_ID_RE.exec(raw);
    if (topLevel && sm && n.children.length === 1 && n.children[0]?.type === 'text')
      return [{ k: 'idmark', id: sm[1] as string, offset: this.ctx.offset(n) }];
    const { id, children } = this.ctx.stripId(n);
    if (!children.some((c) => c.type === 'image' || c.type === 'imageReference'))
      return [this.text('p', this.ctx.inline(children), n, { id })];
    // 按图片拆分：图片之前的内容是段落，每张图片连同其后的内容（到下一张图片为止）是一个 figure
    const out: PendingBlock[] = [];
    let cur: PhrasingContent[] = [];
    let img: Extract<PhrasingContent, { type: 'image' | 'imageReference' }> | null = null;
    const flush = (): void => {
      if (img) out.push(this.figure(img, cur, n));
      else if (cur.some((c) => c.type !== 'text' || /[^ \t\n]/.test(c.value)))
        out.push(this.text('p', this.ctx.inline(cur), n));
      cur = [];
    };
    for (const c of children) {
      if (c.type === 'image' || c.type === 'imageReference') {
        flush();
        img = c;
      } else cur.push(c);
    }
    flush();
    if (out.length > 1)
      this.warn('split-paragraph', 'paragraph with images split into figure blocks', this.ctx.offset(n));
    const first = out[0];
    if (first && id !== undefined) first.id = id;
    return out;
  }

  private figure(
    img: Extract<PhrasingContent, { type: 'image' | 'imageReference' }>,
    rest: PhrasingContent[],
    para: Nodes,
  ): PendingBlock {
    let url: string;
    let title: string | null;
    if (img.type === 'image') {
      url = img.url;
      title = img.title ?? null;
    } else {
      const def = this.findDefinition(img.identifier);
      url = def?.url ?? '';
      title = def?.title ?? null;
    }
    // 去掉图片后的分隔空白（按原文中字面空白的个数）
    const caption = [...rest];
    const first = caption[0];
    if (first?.type === 'text') {
      const lead = /^[ \t]*/.exec(this.ctx.raw(first))?.[0].length ?? 0;
      const v = first.value.slice(lead);
      if (v === '') caption.shift();
      else caption[0] = { ...first, value: v };
    }
    let content: InlineNode[];
    if (caption.length > 0) content = this.ctx.inline(caption);
    else content = title ? [{ t: 'text', text: title, marks: [] }] : [];
    return this.text('figure', content, para, { attrs: { src: url, alt: img.alt ?? '' } });
  }

  private findDefinition(identifier: string): { url: string; title: string | null } | undefined {
    return this.defs.get(identifier);
  }

  /** 引用：每段（及标题）一个 quote 块；嵌套引用递归展开；其他块原样输出。 */
  private blockquote(children: readonly RootContent[], node: Nodes): Item[] {
    if (children.length === 0) return [this.text('quote', [], node, { trailingId: true })];
    if (children.length > 1 || children[0]?.type !== 'paragraph')
      this.warn('flattened-quote', 'multi-block quote flattened into quote blocks', this.ctx.offset(node));
    const out: Item[] = [];
    for (const c of children) {
      if (c.type === 'paragraph' || c.type === 'heading') {
        const { id, children: kids } = this.ctx.stripId(c, c.type === 'heading');
        out.push(this.text('quote', this.ctx.inline(kids), c, { id, trailingId: id === undefined }));
      } else if (c.type === 'blockquote') out.push(...this.blockquote(c.children, c));
      else out.push(...this.flow([c]));
    }
    return out;
  }

  private list(n: Extract<RootContent, { type: 'list' }>, indent: number): Item[] {
    const out: Item[] = [];
    for (const item of n.children) {
      const attrs: Record<string, string> = { list: n.ordered ? 'ol' : 'ul', indent: String(indent) };
      if (item.checked === true) attrs.task = 'done';
      else if (item.checked === false) attrs.task = 'todo';
      const [first, ...rest] = item.children;
      let content: InlineNode[] = [];
      let id: string | undefined;
      let tail = item.children;
      if (first?.type === 'paragraph') {
        const r = this.ctx.stripId(first);
        id = r.id;
        content = this.ctx.inline(r.children);
        tail = rest;
      }
      const li = this.text('li', content, item, { attrs, id });
      out.push(li);
      let nested = false;
      for (const c of tail) {
        if (c.type === 'list') {
          nested = true;
          out.push(...this.list(c, indent + 1));
        } else if (c.type === 'paragraph' && !nested && li.k === 'text') {
          this.warn('flattened-list-item', 'extra paragraph in list item merged with a line break', this.ctx.offset(c));
          li.content = [...li.content, { t: 'br', marks: [] }, ...this.ctx.inline(c.children)];
        } else {
          this.warn('flattened-list-item', `${c.type} inside list item moved out of the list`, this.ctx.offset(c));
          out.push(...this.flow([c]));
        }
      }
    }
    return out;
  }

  private code(n: Extract<RootContent, { type: 'code' }>): PendingBlock {
    const raw = this.ctx.raw(n);
    const lines = raw.split('\n');
    const fm = /^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$/.exec(lines[0] ?? '');
    const fenced = fm !== null;
    // 信息串取原文（属性块中的 `\"` 等转义由属性解析处理）；其余部分按 Markdown 规则反转义
    const info = fm ? (fm[2] as string).trim() : '';
    const { rest, block } = splitTrailingAttrs(info);
    const attrs: Record<string, string> = {};
    const lang = decodeEntities(rest.replace(/\\([!-/:-@[-`{-~])/g, '$1'));
    if (lang !== '') attrs.lang = lang;
    for (const [k, v] of Object.entries(block?.attrs ?? {})) attrs[k] = v;
    if (attrs.lang === '') delete attrs.lang;
    // 内容行数：围栏之间至少一行时，内容 = value + '\n'（与 CommonMark 的 HTML 输出一致）
    let contentLines: number;
    if (!fenced) contentLines = lines.length;
    else {
      const closed = lines.length >= 2 && /^[\s>]*(`{3,}|~{3,})[ \t]*$/.test(lines[lines.length - 1] ?? '');
      contentLines = lines.length - 1 - (closed ? 1 : 0);
    }
    const text = contentLines > 0 ? n.value + '\n' : '';
    return this.text('code', text ? [{ t: 'text', text, marks: [] }] : [], n, {
      attrs,
      id: block?.id,
      trailingId: block?.id === undefined,
    });
  }

  private table(n: Table): PendingBlock {
    const cols = n.align?.length ?? n.children[0]?.children.length ?? 0;
    const rows = n.children.map((r) => {
      const cells = r.children.slice(0, cols).map((c) => this.ctx.inline(c.children));
      if (r.children.length > cols)
        this.warn(
          'dropped-content',
          'table row has more cells than the header; extra cells dropped',
          this.ctx.offset(r),
        );
      while (cells.length < cols) cells.push([]);
      return cells;
    });
    let head = rows[0] ?? [];
    if (head.every((c) => c.length === 0)) head = [];
    const align: CellAlign[] = Array.from({ length: cols }, (_, i) => (n.align?.[i] ?? null) as CellAlign);
    return this.text('table', [], n, { table: { head, body: rows.slice(1), align }, trailingId: true });
  }

  /** 块级 HTML：占位注释 → 指令；否则交给 HTML 解析器（能识别的成为原生块，其余为 HTML 块）。 */
  private html(value: string, off: number): Item[] {
    const pm = this.scan.placeholder.exec(value.trim());
    if (pm) {
      const d = this.scan.directives[Number(pm[1])];
      if (d) return this.directive(d);
    }
    // 占位注释混在其他 HTML 中（例如 HTML 块里的指令行）：还原原文
    const restored = value.replace(new RegExp(this.scan.placeholder.source.slice(1, -1), 'g'), (_m, i: string) => {
      const d = this.scan.directives[Number(i)];
      return d ? d.raw : '';
    });
    const html = restored.replace(/^\n+|\n+$/g, '');
    if (html.trim() === '') return [];
    return htmlToPending(html, off, (c, m, o) => this.warn(c, m, o));
  }

  // ───────────────────────────── 指令 ─────────────────────────────

  private directive(d: RawDirective): Item[] {
    const off = this.base + d.offset;
    const bodyOff = this.base + d.bodyOffset;
    if (this.depth > MAX_DEPTH) {
      this.warn('depth-limit', `directives nested deeper than ${MAX_DEPTH}; kept as an ehmd code block`, off);
      return [
        {
          k: 'text',
          type: 'code',
          attrs: { lang: 'ehmd' },
          content: [{ t: 'text', text: d.raw + '\n', marks: [] }],
          offset: off,
        },
      ];
    }
    if (!d.closed) this.warn('unclosed-directive', `:::${d.name} has no closing fence; extends to the end`, off);
    const { rest, block } = splitTrailingAttrs(d.rest);
    let label: string | undefined = rest.trim();
    if (/^\[.*\]$/.test(label)) label = label.slice(1, -1).trim();
    if (label === '') label = undefined;
    const attrs = { ...(block?.attrs ?? {}) };
    const head: DirectiveHead = label !== undefined ? { label, attrs } : { attrs };
    const id = block?.id;
    if (label !== undefined && 'title' in attrs)
      this.warn('ignored-directive-part', `:::${d.name}: title attribute overrides the label`, off);

    if (this.container?.slotNames.has(d.name)) {
      if (id !== undefined) this.warn('ignored-directive-part', `id on :::${d.name} slot ignored`, off);
      return [{ k: 'slot', name: d.name, head, blocks: this.blocksOf(this.sub(d.body, bodyOff, null)), offset: off }];
    }
    if (this.container && d.name === PROPS_DIRECTIVE) {
      const y = loadYaml(d.body);
      if (!y.ok) this.warn('invalid-yaml', `invalid YAML in :::props (${y.error}); using {}`, bodyOff);
      return [{ k: 'props', value: y.ok ? (y.value ?? {}) : {}, offset: off }];
    }
    if (d.name === HTML_DIRECTIVE) {
      const p: PendingBlock = { k: 'html', html: d.body, offset: off };
      if (id !== undefined) p.id = id;
      return [p];
    }
    const spec = this.cfg.directives.get(d.name);
    const generic = scanDirectives(d.body).directives.some(
      (x) => x.name === SLOT_DIRECTIVE || x.name === PROPS_DIRECTIVE,
    );
    if (spec || generic) return [this.containerDirective(d, spec, head, id, generic, off, bodyOff)];
    // 叶子组件：YAML 体
    if (label !== undefined) this.warn('ignored-directive-part', `label on leaf directive :::${d.name} ignored`, off);
    const y = loadYaml(d.body);
    if (!y.ok) {
      this.warn('invalid-yaml', `invalid YAML in :::${d.name} (${y.error}); kept as an ehmd code block`, bodyOff);
      return [
        {
          k: 'text',
          type: 'code',
          attrs: { lang: 'ehmd' },
          content: [{ t: 'text', text: d.raw + '\n', marks: [] }],
          offset: off,
        },
      ];
    }
    const p: PendingBlock = { k: 'component', type: d.name, props: y.value ?? {}, attrs, offset: off };
    if (id !== undefined) p.id = id;
    return [p];
  }

  private blocksOf(items: Item[]): PendingBlock[] {
    return items.filter((x): x is PendingBlock => x.k === 'text' || x.k === 'component' || x.k === 'html');
  }

  private containerDirective(
    d: RawDirective,
    spec: DirectiveSpec | undefined,
    head: DirectiveHead,
    id: string | undefined,
    generic: boolean,
    off: number,
    bodyOff: number,
  ): PendingBlock {
    const slotNames = new Set([SLOT_DIRECTIVE]);
    if (spec?.slot) slotNames.add(spec.slot);
    const items = this.sub(d.body, bodyOff, { slotNames });
    const slotItems = items.filter((x) => x.k === 'slot');
    const propsItem = items.find((x) => x.k === 'props');
    const isGeneric = generic || !spec || propsItem !== undefined || slotItems.some((s) => s.name === SLOT_DIRECTIVE);
    let props: unknown;
    let attrs: Record<string, string>;
    let slots: PendingBlock[][] | undefined;
    const collectSlots = (): PendingBlock[][] => {
      const res: PendingBlock[][] = [];
      for (const it of items) {
        if (it.k === 'slot') res.push([...it.blocks]);
        else if (it.k === 'text' || it.k === 'component' || it.k === 'html') {
          this.warn(
            'stray-slot-content',
            `content outside slot directives in :::${d.name} merged into a slot`,
            it.offset,
          );
          if (res.length === 0) res.push([]);
          (res[res.length - 1] as PendingBlock[]).push(it);
        }
      }
      return res;
    };
    if (isGeneric) {
      props = propsItem?.k === 'props' ? propsItem.value : {};
      attrs = { ...head.attrs };
      if (head.label !== undefined)
        this.warn('ignored-directive-part', `label on generic container :::${d.name} ignored`, off);
      const s = collectSlots();
      slots = s.length > 0 ? s : undefined;
    } else if (spec?.slot) {
      slots = collectSlots();
      const heads = slotItems.map((s) => (s.k === 'slot' ? s.head : { attrs: {} }));
      while (heads.length < slots.length) heads.unshift({ attrs: {} });
      const dec = spec.decode(head, heads);
      props = dec.props;
      attrs = dec.attrs;
    } else {
      slots = [this.blocksOf(items)];
      const dec = (spec as DirectiveSpec).decode(head, []);
      props = dec.props;
      attrs = dec.attrs;
    }
    const p: PendingBlock = { k: 'component', type: d.name, props, attrs, offset: off };
    if (slots) p.slots = slots;
    if (id !== undefined) p.id = id;
    return p;
  }
}

/** 已有块（HTML 解析器产出）→ 中间块；`explicit` 判断某个 ID 是否写在原文中。 */
function blockToPending(
  b: Block,
  blocks: ReadonlyMap<BlockId, Block>,
  explicit: (id: string) => boolean,
  offset: number,
): PendingBlock {
  let p: PendingBlock;
  if (b.kind === 'text') {
    p = { k: 'text', type: b.type, attrs: { ...b.attrs }, content: [...b.content], offset };
    if (b.table) p.table = b.table;
  } else if (b.kind === 'html') p = { k: 'html', html: b.html, offset };
  else {
    p = { k: 'component', type: b.type, props: b.props, attrs: { ...b.attrs }, offset };
    if (b.slots)
      p.slots = b.slots.map((s) => s.map((cid) => blockToPending(blocks.get(cid) as Block, blocks, explicit, offset)));
  }
  if (explicit(b.id)) p.id = b.id;
  else p.trailingId = true;
  return p;
}

/** 原始 HTML 块 → 中间块：交给 `.ehtml` 解析器；解析结果会丢内容时（head/meta）整段保留为 HTML 块。 */
function htmlToPending(
  html: string,
  offset: number,
  warn: (c: EhmdWarningCode, m: string, o: number) => void,
): PendingBlock[] {
  const { doc, warnings } = parseHtml(html);
  const h = doc.head;
  const lossy =
    doc.root.length === 0 ||
    Object.keys(doc.meta).length > 0 ||
    h.extra !== undefined ||
    h.title !== undefined ||
    h.themeCss !== undefined ||
    h.userCss !== undefined ||
    h.runtimeSrc !== undefined ||
    h.lang !== undefined;
  if (lossy) return [{ k: 'html', html, offset, trailingId: true }];
  for (const w of warnings)
    if (w.code !== 'missing-id' && w.code !== 'html-block' && w.code !== 'duplicate-id' && w.code !== 'invalid-id')
      warn(w.code, w.message, offset + w.offset);
  const explicit = (id: string): boolean => new RegExp(`data-eh\\s*=\\s*["']?${id}(?![\\w-])`).test(html);
  return doc.root.map((id) => blockToPending(doc.blocks.get(id) as Block, doc.blocks, explicit, offset));
}

/** 中间块序列的列表不变量：组内首项 indent 为 0，且每项 indent ≤ 前一项 + 1。 */
function fixIndents(seq: PendingBlock[]): void {
  let prev = -1;
  for (const p of seq) {
    if (p.k === 'text' && p.type === 'li') {
      const want = Math.min(Number(p.attrs.indent ?? '0') || 0, prev + 1);
      p.attrs = { ...p.attrs, indent: String(want) };
      prev = want;
    } else {
      prev = -1;
      if (p.k === 'component' && p.slots) p.slots.forEach(fixIndents);
    }
  }
}

/**
 * 解析 EHMD（Markdown + 指令块）为文档。从不抛错。
 *
 * - frontmatter（YAML 映射）→ `meta`；无 frontmatter 时 `meta = {}`；
 * - 写明的块 ID（`^id`、`{#id}`）保留；缺失、重复（第二次起）或不合法（不符合 `BLOCK_ID_RE`）的
 *   按文档顺序用 `createIdGenerator` 重新分配；
 * - 降级内容（fallback）不在 EHMD 中，结果中的组件块没有 `fallback`。
 *
 * @param src EHMD 文本。
 * @param opts 选项，见 {@link EhmdParseOptions}。
 */
export function parseEhmd(src: string, opts: EhmdParseOptions = {}): EhmdParseResult {
  const warnings: EhmdWarning[] = [];
  const cfg = buildConfig(opts.extensions ?? []);
  const text = src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const fm = splitFrontmatter(text);
  let meta: DocMeta = {};
  const pre: PendingBlock[] = [];
  if (fm.yaml !== null) {
    const y = loadYaml(fm.yaml);
    if (y.ok && (y.value === undefined || (y.value !== null && typeof y.value === 'object' && !Array.isArray(y.value))))
      meta = (y.value ?? {}) as DocMeta;
    else {
      warnings.push({
        code: 'invalid-frontmatter',
        message: `frontmatter is not a YAML mapping${y.ok ? '' : ` (${y.error})`}; kept as a yaml code block`,
        offset: 0,
      });
      pre.push({
        k: 'text',
        type: 'code',
        attrs: { lang: 'yaml' },
        content: [{ t: 'text', text: fm.yaml + '\n', marks: [] }],
        offset: 0,
      });
    }
  }
  const rawSegs: RawSegment[] | null = opts.sourceMap ? [] : null;
  const items = new BodyParser(cfg, warnings, fm.rest, fm.restOffset, null, 0, rawSegs).run();
  const seq = [
    ...pre,
    ...items.filter((x): x is PendingBlock => x.k === 'text' || x.k === 'component' || x.k === 'html'),
  ];
  fixIndents(seq);
  for (const t of cfg.pendingTransforms) t(seq);

  // 统一分配块 ID：先按文档顺序保留合法且首次出现的 ID，再为其余块分配新 ID
  const all: PendingBlock[] = [];
  const walk = (ps: readonly PendingBlock[]): void => {
    for (const p of ps) {
      all.push(p);
      if (p.k === 'component') for (const s of p.slots ?? []) walk(s);
    }
  };
  walk(seq);
  const gen = createIdGenerator([], opts.idPrefix ?? 'b');
  const ids = new Map<PendingBlock, BlockId>();
  for (const p of all) {
    if (p.id === undefined) continue;
    if (!isValidBlockId(p.id))
      warnings.push({ code: 'invalid-id', message: `invalid block id "${p.id}" reassigned`, offset: p.offset });
    else if (!gen.reserve(p.id))
      warnings.push({ code: 'duplicate-id', message: `duplicate block id "${p.id}" reassigned`, offset: p.offset });
    else ids.set(p, p.id);
  }
  for (const p of all) if (!ids.has(p)) ids.set(p, gen.next());

  const blocks: Block[] = [];
  const build = (p: PendingBlock): BlockId => {
    const id = ids.get(p) as BlockId;
    if (p.k === 'text') blocks.push(textBlock(id, p.type, p.content, p.attrs, p.table));
    else if (p.k === 'html') blocks.push(htmlBlock(id, p.html));
    else {
      const slots = p.slots?.map((s) => s.map(build));
      blocks.push(componentBlock(id, p.type, p.props, { attrs: p.attrs, ...(slots ? { slots } : {}) }));
    }
    return id;
  };
  const root = seq.map(build);
  const doc = createDoc(blocks, { root, meta, ...(opts.head ? { head: opts.head } : {}) });
  if (!rawSegs) return { doc, warnings };
  const segments: EhmdSourceSegment[] = [];
  const preBlock = pre[0];
  if (preBlock) {
    const end = fm.restOffset > 0 && text[fm.restOffset - 1] === '\n' ? fm.restOffset - 1 : fm.restOffset;
    segments.push({ start: 0, end, blocks: [ids.get(preBlock) as BlockId] });
  }
  for (const s of rawSegs)
    segments.push({ start: s.start, end: s.end, blocks: s.items.map((p) => ids.get(p) as BlockId) });
  const sourceMap: EhmdSourceMap = {
    text,
    frontmatterEnd: fm.yaml !== null && !preBlock ? fm.restOffset : null,
    segments,
  };
  return { doc, warnings, sourceMap };
}
