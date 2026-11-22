/**
 * 文档模型（docs/02-architecture.md §2）。
 *
 * 约定：
 * - 所有模型对象视为**不可变**：修改只能通过 `Transaction`（packages/core/src/tx），
 *   产出新的 `Doc`（未改动的块对象按引用共享）。
 * - 块扁平存储在 `Doc.blocks` 中；顶层顺序在 `Doc.root`，容器块子块顺序在 `ComponentBlock.slots`。
 * - 行内内容始终保持**规范化**（见 {@link normalizeInline}）。
 *
 * @module
 */

/** 文档内唯一的短 ID（base36，如 `b1`、`k9x`），见 01 §3.1。 */
export type BlockId = string;

// ───────────────────────────── 行内内容 ─────────────────────────────

/** 行内格式标记类型，对应 01 §3.2 行内白名单中的格式元素。`link` 对应 `<a>`。 */
export type MarkType = 'link' | 'strong' | 'em' | 's' | 'mark' | 'sub' | 'sup' | 'kbd' | 'code';

/**
 * 标记的规范嵌套顺序（从外到内）。序列化时按此顺序嵌套输出；
 * `TextNode.marks` 也必须按此顺序排列。
 */
export const MARK_ORDER: readonly MarkType[] = ['link', 'strong', 'em', 's', 'mark', 'sub', 'sup', 'kbd', 'code'];

/** 行内格式标记。仅 `link` 使用 `attrs`（`href`，可选 `title`）。 */
export interface Mark {
  readonly type: MarkType;
  readonly attrs?: Readonly<Record<string, string>>;
}

/** 带标记的一段文本。`text` 非空。 */
export interface TextNode {
  readonly t: 'text';
  readonly text: string;
  /** 按 {@link MARK_ORDER} 排序、无重复类型。 */
  readonly marks: readonly Mark[];
}

/** 硬换行 `<br>`。偏移长度为 1。 */
export interface BreakNode {
  readonly t: 'br';
  readonly marks: readonly Mark[];
}

/**
 * 扩展行内元素 `span[data-eh-inline="kind"]`：行内公式（`math`）、双链（`wikilink`）、
 * 标签（`tag`）等。作为**原子**处理，偏移长度为 1。
 */
export interface InlineAtom {
  readonly t: 'atom';
  /** `data-eh-inline` 的值，如 `math` / `wikilink` / `tag`。 */
  readonly kind: string;
  /**
   * 除 `data-eh-inline` 以外的 `data-eh-*` 属性（不含前缀 `data-eh-`）。
   * 键 `inline` 保留（与 `data-eh-inline` 冲突，序列化时忽略）；键须是合法的 HTML 属性名片段。
   */
  readonly attrs: Readonly<Record<string, string>>;
  /** 元素的文本内容（如 TeX 源码、链接目标）。 */
  readonly text: string;
  readonly marks: readonly Mark[];
}

/** 行内节点。 */
export type InlineNode = TextNode | BreakNode | InlineAtom;

// ───────────────────────────── 块 ─────────────────────────────

/**
 * 文本块类型。
 *
 * 与 01 §3.2 的对应关系：
 * - `li`：**每个列表项是一个独立块**；连续的 `li` 块在序列化时归组为 `<ul>`/`<ol>`，
 *   嵌套由 `attrs.indent` 表示。`data-eh` 写在 `<li>` 上。
 * - `quote`：`<blockquote>`，内容为单段行内内容（多行用 `br`）。更复杂的引用用 `callout`。
 * - `code`：`content` 为单个无标记文本节点（或空），语言在 `attrs.lang`。
 * - `table`：结构在 {@link TextBlock.table}，`content` 为空。
 * - `figure`：图片 `attrs.src` / `attrs.alt`，`content` 为图注（figcaption）。
 * - `hr`：`content` 为空。
 */
export type TextBlockType =
  'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'li' | 'quote' | 'code' | 'hr' | 'table' | 'figure';

/** 列表项属性。 */
export interface ListItemAttrs {
  /** 所在列表类型。 */
  list: 'ul' | 'ol';
  /** 嵌套层级，十进制字符串，`'0'` 为最外层。 */
  indent: string;
  /** 任务项状态，对应 `li[data-eh-task]`。 */
  task?: 'done' | 'todo';
}

/** 表格单元格对齐。 */
export type CellAlign = 'left' | 'center' | 'right' | null;

/** 表格数据（仅 thead/tbody/tr/th/td，见 01 §3.2）。 */
export interface TableData {
  /** 表头行（`<thead>` 中的 `<th>`）；空数组表示无表头。 */
  readonly head: readonly (readonly InlineNode[])[];
  /** 表体各行，每行若干单元格。 */
  readonly body: readonly (readonly (readonly InlineNode[])[])[];
  /** 每列对齐方式，长度等于列数；省略表示全部为 null。 */
  readonly align?: readonly CellAlign[];
}

/** 文本块。 */
export interface TextBlock {
  readonly id: BlockId;
  readonly kind: 'text';
  readonly type: TextBlockType;
  /**
   * 块属性。已知键：
   * - `li`：见 {@link ListItemAttrs}；
   * - `code`：`lang`；
   * - `figure`：`src`、`alt`；
   * 其余规范允许的属性原样保存。
   */
  readonly attrs: Readonly<Record<string, string>>;
  /** 规范化的行内内容。 */
  readonly content: readonly InlineNode[];
  /** 仅 `type === 'table'`。 */
  readonly table?: TableData;
  /** 内容哈希，见 {@link computeBlockHash}。 */
  readonly hash: number;
}

/** 组件块（01 §3.3）。 */
export interface ComponentBlock {
  readonly id: BlockId;
  readonly kind: 'component';
  /** 组件类型，`<eh-{type}>` 中的 `{type}`，如 `chart` / `tabs`。 */
  readonly type: string;
  /** 组件数据（块内 `<script type="application/json">`），唯一真实数据源。 */
  readonly props: unknown;
  /** `<eh-{type}>` 上除 `data-eh` 外的其他属性（如 `data-eh-props...`）。 */
  readonly attrs: Readonly<Record<string, string>>;
  /** 容器块的子块：`slots[i]` 为第 i 个 `<eh-slot>` 中的子块 ID 顺序。非容器块省略。 */
  readonly slots?: readonly (readonly BlockId[])[];
  /** 降级 HTML 缓存（`<!--eh:fallback-->` 标记之间的内容，不含标记本身）。 */
  readonly fallback?: string;
  readonly hash: number;
}

/**
 * HTML 块（`<eh-html>`，01 §3.5、06 §4）：无法映射为原生块的任意 HTML，原文切片保留。
 * 可编辑：通过 `setHtml` 替换整段 HTML（M2/M3 的区间补丁编辑最终归结为它）。
 * 06 中的源码区间索引 `spans` 属于运行期数据，随 M2（T2.1）引入，不进入序列化结果。
 */
export interface HtmlBlock {
  readonly id: BlockId;
  readonly kind: 'html';
  /** 原始 HTML 切片，序列化时原样输出。 */
  readonly html: string;
  readonly hash: number;
}

/** 块。 */
export type Block = TextBlock | ComponentBlock | HtmlBlock;

// ───────────────────────────── 文档 ─────────────────────────────

/** 文档元数据（`#eh-meta` JSON，frontmatter 等价物）。 */
export interface DocMeta {
  title?: string;
  created?: string;
  tags?: string[];
  theme?: string;
  [key: string]: unknown;
}

/** `<head>` 中除元数据外需要往返保留的部分（01 §2）。 */
export interface DocHead {
  /** `<html lang>`，默认 `zh-CN`。 */
  readonly lang?: string;
  /** `<title>` 文本；缺省时用 `meta.title`。 */
  readonly title?: string;
  /** `<style id="eh-theme">` 内容。 */
  readonly themeCss?: string;
  /** `<style id="eh-user-style">` 内容。 */
  readonly userCss?: string;
  /** `<script id="eh-runtime">` 的 `src`。 */
  readonly runtimeSrc?: string;
  /** `<head>` 中其他无法识别的内容，原样保留。 */
  readonly extra?: string;
}

/** 文档。 */
export interface Doc {
  readonly meta: Readonly<DocMeta>;
  readonly head: DocHead;
  /** 顶层块顺序。 */
  readonly root: readonly BlockId[];
  /** 全部块（含容器块的子块），扁平存储便于 O(1) 查找。 */
  readonly blocks: ReadonlyMap<BlockId, Block>;
  /** 每次事务 +1。 */
  readonly version: number;
}

// ───────────────────────────── 哈希 ─────────────────────────────

/** 32 位 FNV-1a 哈希（对 UTF-16 码元）。返回无符号 32 位整数。 */
export function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 稳定 JSON 序列化：对象键按字典序排列。用于哈希与相等性比较，
 * **不是**规范化输出格式（组件 JSON 的规范输出按 schema 顺序，见 01 §6）。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** 除 `hash` 字段以外的块内容。 */
export type BlockData<B extends Block = Block> = B extends Block ? Omit<B, 'hash'> : never;

/**
 * 计算块的内容哈希（03 §2）。覆盖块的全部字段（除 `hash` 本身），包括 `id`；
 * 容器块的哈希只覆盖自身的 `slots` ID 列表，不递归子块内容。
 */
export function computeBlockHash(block: BlockData): number {
  const { hash: _ignored, ...rest } = block as BlockData & { hash?: number };
  return fnv1a(stableStringify(rest));
}

/** 由不含哈希的块数据构造块，自动计算哈希。 */
export function withHash<B extends Block>(data: BlockData<B>): B {
  return { ...data, hash: computeBlockHash(data) } as unknown as B;
}

// ───────────────────────────── 行内工具 ─────────────────────────────

/** 两个标记是否相同（类型与属性都相同）。 */
export function markEquals(a: Mark, b: Mark): boolean {
  return a.type === b.type && stableStringify(a.attrs ?? {}) === stableStringify(b.attrs ?? {});
}

/** 两组标记是否相同。 */
export function marksEqual(a: readonly Mark[], b: readonly Mark[]): boolean {
  return a.length === b.length && a.every((m, i) => markEquals(m, b[i] as Mark));
}

/** 按 {@link MARK_ORDER} 排序并按类型去重（后出现者覆盖先出现者）。 */
export function sortMarks(marks: readonly Mark[]): Mark[] {
  const byType = new Map<MarkType, Mark>();
  for (const m of marks) byType.set(m.type, m);
  return MARK_ORDER.flatMap((t) => {
    const m = byType.get(t);
    return m ? [m] : [];
  });
}

/** 行内节点的偏移长度：文本为 UTF-16 码元数，`br` 与 `atom` 为 1。 */
export function nodeLength(node: InlineNode): number {
  return node.t === 'text' ? node.text.length : 1;
}

/** 行内内容的总偏移长度。 */
export function inlineLength(content: readonly InlineNode[]): number {
  let n = 0;
  for (const node of content) n += nodeLength(node);
  return n;
}

/** 行内内容的纯文本（`br` → `\n`，`atom` → 其 `text`）。 */
export function inlineText(content: readonly InlineNode[]): string {
  return content.map((n) => (n.t === 'text' ? n.text : n.t === 'br' ? '\n' : n.text)).join('');
}

/**
 * 规范化行内内容：去掉空文本节点、标记排序去重、合并相邻同标记文本节点。
 * 模型中保存的行内内容必须是规范化的；规范化是幂等的。
 */
export function normalizeInline(content: readonly InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of content) {
    const marks = sortMarks(node.marks);
    if (node.t === 'text') {
      if (node.text === '') continue;
      const prev = out[out.length - 1];
      if (prev && prev.t === 'text' && marksEqual(prev.marks, marks)) {
        out[out.length - 1] = { t: 'text', text: prev.text + node.text, marks: prev.marks };
        continue;
      }
      out.push({ t: 'text', text: node.text, marks });
    } else if (node.t === 'br') {
      out.push({ t: 'br', marks });
    } else {
      out.push({ t: 'atom', kind: node.kind, attrs: { ...node.attrs }, text: node.text, marks });
    }
  }
  return out;
}

// ───────────────────────────── 构造器 ─────────────────────────────

/** 构造文本节点。 */
export function text(value: string, marks: readonly Mark[] = []): TextNode {
  return { t: 'text', text: value, marks: sortMarks(marks) };
}

/** 构造文本块（自动规范化内容、计算哈希）。 */
export function textBlock(
  id: BlockId,
  type: TextBlockType,
  content: readonly InlineNode[] = [],
  attrs: Record<string, string> = {},
  table?: TableData,
): TextBlock {
  const data: BlockData<TextBlock> = { id, kind: 'text', type, attrs, content: normalizeInline(content) };
  return withHash<TextBlock>(table ? { ...data, table } : data);
}

/** 构造组件块。 */
export function componentBlock(
  id: BlockId,
  type: string,
  props: unknown,
  opts: { attrs?: Record<string, string>; slots?: BlockId[][]; fallback?: string } = {},
): ComponentBlock {
  const data: BlockData<ComponentBlock> = { id, kind: 'component', type, props, attrs: opts.attrs ?? {} };
  return withHash<ComponentBlock>({
    ...data,
    ...(opts.slots ? { slots: opts.slots } : {}),
    ...(opts.fallback !== undefined ? { fallback: opts.fallback } : {}),
  });
}

/** 构造HTML 块。 */
export function htmlBlock(id: BlockId, html: string): HtmlBlock {
  return withHash<HtmlBlock>({ id, kind: 'html', html });
}

/** 由顶层块（及容器块的子块）构造文档。`blocks` 中需包含所有被引用的块。 */
export function createDoc(
  blocks: readonly Block[],
  opts: { root?: BlockId[]; meta?: DocMeta; head?: DocHead; version?: number } = {},
): Doc {
  const map = new Map<BlockId, Block>();
  const children = new Set<BlockId>();
  for (const b of blocks) {
    if (map.has(b.id)) throw new Error(`duplicate block id: ${b.id}`);
    map.set(b.id, b);
    if (b.kind === 'component') for (const slot of b.slots ?? []) for (const c of slot) children.add(c);
  }
  const root = opts.root ?? blocks.filter((b) => !children.has(b.id)).map((b) => b.id);
  return { meta: opts.meta ?? {}, head: opts.head ?? {}, root, blocks: map, version: opts.version ?? 0 };
}

/** 空文档。 */
export function emptyDoc(): Doc {
  return createDoc([]);
}

// ───────────────────────────── 查询 ─────────────────────────────

/** 取块；不存在时抛错。 */
export function getBlock(doc: Doc, id: BlockId): Block {
  const b = doc.blocks.get(id);
  if (!b) throw new Error(`block not found: ${id}`);
  return b;
}

/** 块的位置：父容器（`null` 为顶层）、槽位与在该序列中的下标。 */
export interface BlockLocation {
  readonly parent: BlockId | null;
  readonly slot: number;
  readonly index: number;
}

/** 构建 子块 → 位置 的索引，O(块数)。 */
export function buildParentIndex(doc: Doc): Map<BlockId, BlockLocation> {
  const index = new Map<BlockId, BlockLocation>();
  doc.root.forEach((id, i) => index.set(id, { parent: null, slot: 0, index: i }));
  for (const b of doc.blocks.values()) {
    if (b.kind !== 'component' || !b.slots) continue;
    b.slots.forEach((slot, s) => slot.forEach((id, i) => index.set(id, { parent: b.id, slot: s, index: i })));
  }
  return index;
}

/** 按文档顺序（深度优先，先序）遍历全部可达块。 */
export function* walkBlocks(doc: Doc, ids: readonly BlockId[] = doc.root, depth = 0): Generator<[Block, number]> {
  for (const id of ids) {
    const b = getBlock(doc, id);
    yield [b, depth];
    if (b.kind === 'component' && b.slots) for (const slot of b.slots) yield* walkBlocks(doc, slot, depth + 1);
  }
}

/**
 * 结构相等：比较 meta、head、块树（按顺序）与每个块的内容（忽略 `hash` 与 `version`）。
 * 用于往返/撤销测试。
 */
export function docEquals(a: Doc, b: Doc): boolean {
  return docToComparable(a) === docToComparable(b);
}

/** 把文档转为可比较的稳定字符串（忽略 `hash` 与 `version`，按树形展开）。用于测试断言的 diff 输出。 */
export function docToComparable(doc: Doc): string {
  const expand = (ids: readonly BlockId[]): unknown[] =>
    ids.map((id) => {
      const { hash: _h, ...rest } = getBlock(doc, id);
      if (rest.kind === 'component' && rest.slots) return { ...rest, slots: rest.slots.map(expand) };
      return rest;
    });
  return stableStringify({ meta: doc.meta, head: doc.head, root: expand(doc.root) });
}

/**
 * 校验文档不变量；返回问题列表（空数组表示有效）：
 * ID 唯一且与 key 一致、引用的块存在、每个块恰好被引用一次、哈希正确、行内内容已规范化。
 */
export function validateDoc(doc: Doc): string[] {
  const problems: string[] = [];
  const seen = new Set<BlockId>();
  const visit = (ids: readonly BlockId[], where: string): void => {
    for (const id of ids) {
      const b = doc.blocks.get(id);
      if (!b) {
        problems.push(`${where}: missing block ${id}`);
        continue;
      }
      if (seen.has(id)) problems.push(`${where}: block ${id} referenced more than once`);
      seen.add(id);
      if (b.id !== id) problems.push(`block key ${id} != block.id ${b.id}`);
      if (b.hash !== computeBlockHash(b)) problems.push(`block ${id}: stale hash`);
      if (b.kind === 'text' && stableStringify(b.content) !== stableStringify(normalizeInline(b.content)))
        problems.push(`block ${id}: inline content not normalized`);
      if (b.kind === 'component' && b.slots) b.slots.forEach((s, i) => visit(s, `${id}.slot[${i}]`));
    }
  };
  visit(doc.root, 'root');
  for (const id of doc.blocks.keys()) if (!seen.has(id)) problems.push(`orphan block ${id}`);
  return problems;
}
