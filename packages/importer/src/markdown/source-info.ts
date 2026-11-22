/**
 * Markdown 来源表：导入时记录、导出时使用的**纯写法**信息，存放在 `doc.head.extra` 中的
 * `<script type="application/json" id="eh-md-source">`（与模型内容分开，`.ehtml` 往返时原样保留）。
 *
 * - `frontmatter`：原 frontmatter 文本（含 `---` 行）与导入时 `meta` 的指纹；`meta` 未改动时原样写回；
 * - `segments`：每个顶层 Markdown 节点对应的顶层块 ID、导入时的内容指纹，以及（仅当按模型重新生成的写法与原文
 *   不同才保存的）原文 `src`；块前的空白 `gap`（不是 `\n\n` 时才保存）；
 * - `style`：按块 ID 记录的写法（围栏字符、分割线写法、ID 写法）；
 * - `tail`：最后一块之后的文本（不是 `\n` 时才保存）；`crlf` / `bom`：原文的换行与 BOM。
 *
 * 导出时，指纹与当前内容一致的段（未被编辑）按原文输出；否则按模型重新生成。
 *
 * @module
 */
import { fnv1a, stableStringify, type BlockId, type Doc, type DocHead } from '@edithtml/core';

/** 一个顶层源码段的记录。 */
export interface SegmentInfo {
  /** 该段产生的顶层块 ID（按顺序）。 */
  readonly ids: readonly BlockId[];
  /** 导入时这些块（含子块）内容的指纹，见 {@link blocksFingerprint}。 */
  readonly fp: string;
  /** 原文（仅当重新生成的写法与原文不同时保存）。 */
  readonly src?: string;
  /** 该段之前的空白（仅当不是默认值时保存）。 */
  readonly gap?: string;
}

/** 来源表。 */
export interface MarkdownSourceInfo {
  readonly v: 1;
  readonly frontmatter?: { readonly raw: string; readonly fp: string };
  readonly segments: readonly SegmentInfo[];
  readonly style?: Readonly<Record<BlockId, Readonly<Record<string, string>>>>;
  readonly tail?: string;
  readonly crlf?: boolean;
  readonly bom?: boolean;
}

const SCRIPT_RE = /<script type="application\/json" id="eh-md-source">([\s\S]*?)<\/script>\n?/;

/** 64 位（两个 FNV-1a）指纹，base36。 */
export function fingerprint(s: string): string {
  return fnv1a(s).toString(36) + fnv1a(s, 0x01000193).toString(36);
}

/** 一组块（含容器子块，忽略 `hash` 与 `fallback`）的内容指纹。 */
export function blocksFingerprint(doc: Doc, ids: readonly BlockId[]): string {
  const expand = (xs: readonly BlockId[]): unknown[] =>
    xs.map((id) => {
      const b = doc.blocks.get(id);
      if (!b) return null;
      if (b.kind === 'component') {
        const { hash: _h, fallback: _f, slots, ...rest } = b;
        return slots ? { ...rest, slots: slots.map(expand) } : rest;
      }
      const { hash: _h, ...rest } = b;
      return rest;
    });
  return fingerprint(stableStringify(expand(ids)));
}

/** `meta` 的指纹。 */
export function metaFingerprint(meta: unknown): string {
  return fingerprint(stableStringify(meta));
}

/** 读取文档中的来源表（没有或损坏时返回 `null`）。 */
export function readSourceInfo(doc: Doc): MarkdownSourceInfo | null {
  const m = SCRIPT_RE.exec(doc.head.extra ?? '');
  if (!m) return null;
  try {
    const v = JSON.parse(m[1] as string) as MarkdownSourceInfo;
    if (v && v.v === 1 && Array.isArray(v.segments)) return v;
  } catch {
    // 损坏的来源表：忽略，全部按模型生成
  }
  return null;
}

/** 把来源表写进 `head.extra`（替换已有的来源表）。 */
export function writeSourceInfo(head: DocHead, info: MarkdownSourceInfo): DocHead {
  const json = JSON.stringify(info)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const script = `<script type="application/json" id="eh-md-source">${json}</script>\n`;
  const rest = (head.extra ?? '').replace(SCRIPT_RE, '');
  return { ...head, extra: rest + script };
}

/** 从 `head.extra` 中去掉来源表。 */
export function stripSourceInfo(head: DocHead): DocHead {
  if (head.extra === undefined) return head;
  const extra = head.extra.replace(SCRIPT_RE, '');
  const { extra: _e, ...rest } = head;
  return extra === '' ? rest : { ...rest, extra };
}
