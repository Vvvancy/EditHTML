/**
 * `.md`（CommonMark + GFM + Obsidian 方言）→ Doc（docs/06-import.md §5）。
 *
 * 流程：去 BOM、换行统一为 `\n` → 等长预处理（{@link preprocessMarkdown}）→ core `parseEhmd` +
 * {@link obsidianExtension}（带源码区间）→ 把写法属性移入来源表 → 为每个顶层段记录指纹，按模型重新生成的写法
 * 与原文不同时保存原文 → 转换报告。
 *
 * @module
 */
import {
  componentBlock,
  createDoc,
  parseEhmd,
  textBlock,
  walkBlocks,
  type Block,
  type BlockId,
  type Doc,
  type EhmdExtension,
  type EhmdWarning,
  type InlineNode,
} from '@edithtml/core';
import { generateMarkdown } from './export.js';
import { obsidianExtension } from './extension.js';
import { preprocessMarkdown } from './preprocess.js';
import {
  blocksFingerprint,
  metaFingerprint,
  writeSourceInfo,
  type MarkdownSourceInfo,
  type SegmentInfo,
} from './source-info.js';

/** `importMarkdown` 的选项。 */
export interface MarkdownImportOptions {
  /** 新分配块 ID 的前缀，默认 `'b'`。 */
  readonly idPrefix?: string;
  /** 额外的 EHMD 扩展（在 Obsidian 方言之后注册，处理器优先）。 */
  readonly extensions?: readonly EhmdExtension[];
  /** 是否在 `doc.head.extra` 中保存来源表（无损导出所需），默认 `true`。 */
  readonly sourceInfo?: boolean;
}

/** 报告中的一条链接 / 引用（目标保持原文写法，供批量导入 T5.2 改写）。 */
export interface MarkdownLinkRef {
  readonly kind: 'wikilink' | 'embed' | 'link' | 'image' | 'note-embed' | 'definition' | 'frontmatter';
  /** 原文写法（如 `[[Roadmap#^goal-1|别名]]`、链接的 href）。 */
  readonly raw: string;
  readonly target: string;
  readonly heading?: string;
  readonly block?: string;
  readonly alias?: string;
  /** 所在块（frontmatter 中的为 `null`）。 */
  readonly blockId: BlockId | null;
}

/** 原样保留（导出时原样写回）的扩展语法 / 片段。 */
export interface PreservedSpan {
  readonly kind: 'comment' | 'definition' | 'extension-code' | 'inline-comment' | 'inline-footnote' | 'gap';
  readonly blockId: BlockId | null;
  readonly text: string;
}

/** 一条与块关联的告警。 */
export interface ReportIssue {
  readonly code: string;
  readonly message: string;
  readonly offset: number;
}

/** 单文件转换报告。 */
export interface MarkdownImportReport {
  /** 原生文本块数（含容器中的子块）。 */
  readonly nativeBlocks: number;
  /** 组件块数，按类型。 */
  readonly components: Readonly<Record<string, number>>;
  /** HTML 块数。 */
  readonly htmlBlocks: number;
  /** 保存了原文的顶层段数（按模型重新生成的写法与原文不同）。 */
  readonly verbatimSegments: number;
  /** 原样保留的扩展语法。 */
  readonly preserved: readonly PreservedSpan[];
  /** 模型表达不了、但原文已保存的部分（未编辑时可无损导出；编辑该段后会丢失）。 */
  readonly lossy: readonly ReportIssue[];
  /** 出于安全剔除的内容（`on*`、`javascript:` 等，01 §9，故意不往返）。 */
  readonly sanitized: readonly ReportIssue[];
  /** 丢失的内容（既不在模型中、也没有保存原文）。应为空。 */
  readonly dropped: readonly ReportIssue[];
  /** 所有链接目标（原文写法）。 */
  readonly links: readonly MarkdownLinkRef[];
  /** 源码中写明的块 ID：原 ID → 块 ID（不合法的 Obsidian ID 如 `goal-1` 存在 `attrs['md-id']`）。 */
  readonly sourceIds: readonly { readonly original: string; readonly blockId: BlockId }[];
}

/** `importMarkdown` 的结果。 */
export interface MarkdownImportResult {
  readonly doc: Doc;
  readonly warnings: EhmdWarning[];
  readonly report: MarkdownImportReport;
}

/** 有损（模型中丢掉了东西）的告警代码。 */
const LOSSY = new Set([
  'dropped-content',
  'dropped-attribute',
  'unwrapped-element',
  'unsupported-node',
  'flattened-quote',
  'flattened-list-item',
  'stray-end-tag',
  'unclosed-element',
]);
/** 安全剔除。 */
const SANITIZE = new Set(['stripped-event-handler', 'stripped-javascript-url']);
/** 视为"原样保留的扩展语法"的代码块语言。 */
const EXTENSION_LANGS = new Set(['dataview', 'dataviewjs', 'tasks', 'query', 'tracker', 'chart', 'excalidraw']);

/** 把 `md-` 写法属性（`md-id` 除外）移出块属性，返回新块与写法表。 */
function extractStyles(doc: Doc): { blocks: Block[]; styles: Record<BlockId, Record<string, string>> } {
  const styles: Record<BlockId, Record<string, string>> = {};
  const blocks: Block[] = [];
  for (const b of doc.blocks.values()) {
    if (b.kind === 'html') {
      blocks.push(b);
      continue;
    }
    const st: Record<string, string> = {};
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.attrs)) {
      if (k.startsWith('md-') && k !== 'md-id') st[k.slice(3)] = v;
      else attrs[k] = v;
    }
    if (Object.keys(st).length === 0) {
      blocks.push(b);
      continue;
    }
    styles[b.id] = st;
    if (b.kind === 'text') blocks.push(textBlock(b.id, b.type, b.content, attrs, b.table));
    else
      blocks.push(
        componentBlock(b.id, b.type, b.props, {
          attrs,
          ...(b.slots ? { slots: b.slots.map((s) => [...s]) } : {}),
          ...(b.fallback !== undefined ? { fallback: b.fallback } : {}),
        }),
      );
  }
  return { blocks, styles };
}

/**
 * 导入 Markdown。从不抛错。
 *
 * @param src Markdown 原文（任意字符串）。
 * @param opts 选项，见 {@link MarkdownImportOptions}。
 */
export function importMarkdown(src: string, opts: MarkdownImportOptions = {}): MarkdownImportResult {
  const bom = src.startsWith('\uFEFF');
  const body = bom ? src.slice(1) : src;
  const crlf = body.includes('\r\n') && !/(^|[^\r])\n/.test(body) && !/\r(?!\n)/.test(body);
  const text = body.replace(/\r\n?/g, '\n');
  const r = parseEhmd(preprocessMarkdown(text), {
    extensions: [obsidianExtension(), ...(opts.extensions ?? [])],
    sourceMap: true,
    ...(opts.idPrefix !== undefined ? { idPrefix: opts.idPrefix } : {}),
  });
  const sm = r.sourceMap as NonNullable<typeof r.sourceMap>;
  const { blocks, styles } = extractStyles(r.doc);
  const base = createDoc(blocks, { root: [...r.doc.root], meta: r.doc.meta });

  // 顶层段：指纹、原文（仅当生成写法不同）、段前空白
  const segments: SegmentInfo[] = [];
  const lossy: ReportIssue[] = [];
  const sanitized: ReportIssue[] = [];
  const dropped: ReportIssue[] = [];
  const preserved: PreservedSpan[] = [];
  const issue = (w: EhmdWarning): ReportIssue => ({ code: w.code, message: w.message, offset: w.offset });
  const placed = new Set<EhmdWarning>();
  let prevEnd = sm.frontmatterEnd ?? 0;
  for (const s of sm.segments) {
    if (s.blocks.length === 0) continue; // 其原文留在下一段的 gap 中
    const raw = text.slice(s.start, s.end);
    const ws = r.warnings.filter(
      (w) => w.offset >= s.start && (w.offset < s.end || (s.start === s.end && w.offset === s.end)),
    );
    ws.forEach((w) => placed.add(w));
    const isSanitized = ws.some((w) => SANITIZE.has(w.code));
    const regen = generateMarkdown(base, s.blocks, 'obsidian', styles);
    const keepSrc = regen !== raw && !isSanitized;
    for (const w of ws) {
      if (SANITIZE.has(w.code) || (isSanitized && LOSSY.has(w.code))) sanitized.push(issue(w));
      else if (LOSSY.has(w.code)) (keepSrc ? lossy : dropped).push(issue(w));
    }
    const gap = text.slice(prevEnd, s.start);
    const defGap = segments.length === 0 ? (sm.frontmatterEnd !== null ? '\n' : '') : '\n\n';
    if (/\S/.test(gap)) preserved.push({ kind: 'gap', blockId: s.blocks[0] as BlockId, text: gap.trim() });
    segments.push({
      ids: [...s.blocks],
      fp: blocksFingerprint(base, s.blocks),
      ...(keepSrc ? { src: raw } : {}),
      ...(gap !== defGap ? { gap } : {}),
    });
    prevEnd = s.end;
  }
  for (const w of r.warnings)
    if (!placed.has(w)) {
      if (SANITIZE.has(w.code)) sanitized.push(issue(w));
      else if (LOSSY.has(w.code)) dropped.push(issue(w));
    }
  const tail = text.slice(prevEnd);
  if (segments.length === 0 && /\S/.test(tail)) preserved.push({ kind: 'gap', blockId: null, text: tail.trim() });

  const info: MarkdownSourceInfo = {
    v: 1,
    ...(sm.frontmatterEnd !== null
      ? { frontmatter: { raw: text.slice(0, sm.frontmatterEnd), fp: metaFingerprint(base.meta) } }
      : {}),
    segments,
    ...(Object.keys(styles).length > 0 ? { style: styles } : {}),
    ...(tail !== (segments.length > 0 ? '\n' : '') ? { tail } : {}),
    ...(crlf ? { crlf: true } : {}),
    ...(bom ? { bom: true } : {}),
  };
  const doc: Doc = opts.sourceInfo === false ? base : { ...base, head: writeSourceInfo(base.head, info) };

  const report = buildReport(doc, {
    verbatimSegments: segments.filter((s) => s.src !== undefined).length,
    preserved,
    lossy,
    sanitized,
    dropped,
  });
  return { doc, warnings: r.warnings, report };
}

/** 统计与链接收集。 */
function buildReport(
  doc: Doc,
  partial: Pick<MarkdownImportReport, 'verbatimSegments' | 'preserved' | 'lossy' | 'sanitized' | 'dropped'>,
): MarkdownImportReport {
  let nativeBlocks = 0;
  let htmlBlocks = 0;
  const components: Record<string, number> = {};
  const links: MarkdownLinkRef[] = [];
  const preserved = [...partial.preserved];
  const sourceIds: { original: string; blockId: BlockId }[] = [];

  const scanInline = (content: readonly InlineNode[], blockId: BlockId): void => {
    let lastHref: string | undefined;
    for (const n of content) {
      const href = n.marks.find((m) => m.type === 'link')?.attrs?.href;
      if (href !== undefined && href !== lastHref) links.push({ kind: 'link', raw: href, target: href, blockId });
      lastHref = href;
      if (n.t !== 'atom') continue;
      if (n.kind === 'wikilink' || n.kind === 'embed') {
        const a = n.attrs;
        links.push({
          kind: n.kind,
          raw: n.text,
          target: a.target ?? '',
          ...(a.heading !== undefined ? { heading: a.heading } : {}),
          ...(a.block !== undefined ? { block: a.block } : {}),
          ...(a.alias !== undefined ? { alias: a.alias } : {}),
          blockId,
        });
      } else if (n.kind === 'comment') preserved.push({ kind: 'inline-comment', blockId, text: n.text });
      else if (n.kind === 'footnote' && n.attrs.form === 'inline')
        preserved.push({ kind: 'inline-footnote', blockId, text: n.text });
    }
  };

  for (const [b] of walkBlocks(doc)) {
    if (b.kind !== 'html' && b.attrs['md-id'] !== undefined)
      sourceIds.push({ original: b.attrs['md-id'], blockId: b.id });
    if (b.kind === 'html') {
      htmlBlocks++;
      continue;
    }
    if (b.kind === 'component') {
      components[b.type] = (components[b.type] ?? 0) + 1;
      const p = b.props as Record<string, unknown> | null;
      if (b.type === 'markdown' && p && typeof p.source === 'string') {
        const syntax = b.attrs.syntax === 'definition' ? 'definition' : 'comment';
        preserved.push({ kind: syntax, blockId: b.id, text: p.source });
        const dm = syntax === 'definition' ? /^\s*\[[^\]]*\]:\s*<?([^\s>]*)/.exec(p.source) : null;
        if (dm) links.push({ kind: 'definition', raw: p.source, target: dm[1] as string, blockId: b.id });
      }
      if (b.type === 'note-embed' && p && typeof p.target === 'string') {
        const s = (k: string): Record<string, string> => (typeof p[k] === 'string' ? { [k]: p[k] as string } : {});
        links.push({
          kind: 'note-embed',
          raw: `![[${[p.target, p.block !== undefined ? `#^${String(p.block)}` : p.heading !== undefined ? `#${String(p.heading)}` : '', p.alias !== undefined ? `|${String(p.alias)}` : ''].join('')}]]`,
          target: p.target,
          ...s('heading'),
          ...s('block'),
          ...s('alias'),
          blockId: b.id,
        });
      }
      continue;
    }
    nativeBlocks++;
    scanInline(b.content, b.id);
    if (b.table) for (const row of [b.table.head, ...b.table.body]) for (const c of row) scanInline(c, b.id);
    if (b.type === 'figure' && b.attrs.src !== undefined)
      links.push({
        kind: b.attrs.syntax === 'wikilink' ? 'embed' : 'image',
        raw: b.attrs.src,
        target: b.attrs.src,
        blockId: b.id,
      });
    if (b.type === 'code' && b.attrs.lang !== undefined && EXTENSION_LANGS.has(b.attrs.lang))
      preserved.push({
        kind: 'extension-code',
        blockId: b.id,
        text: b.content.map((n) => (n.t === 'text' ? n.text : '')).join(''),
      });
  }
  const scanMeta = (v: unknown): void => {
    if (typeof v === 'string')
      for (const m of v.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
        const inner = m[1] as string;
        const bar = inner.indexOf('|');
        const left = bar < 0 ? inner : inner.slice(0, bar);
        const hash = left.indexOf('#');
        links.push({ kind: 'frontmatter', raw: m[0], target: hash < 0 ? left : left.slice(0, hash), blockId: null });
      }
    else if (Array.isArray(v)) v.forEach(scanMeta);
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(scanMeta);
  };
  scanMeta(doc.meta);
  return { nativeBlocks, components, htmlBlocks, links, sourceIds, ...partial, preserved };
}
