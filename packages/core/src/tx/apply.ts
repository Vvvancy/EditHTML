/**
 * 事务应用（docs/02-architecture.md §3）：`apply(doc, tx)` 是纯函数，产出新 `Doc` 与变更集。
 *
 * ## 实现与代价
 *
 * - 写时复制：第一次改动块时把 `doc.blocks` 复制一次（**每个事务一次，不是每个 Op 一次**，
 *   O(块数) 的 Map 复制；10k 块约亚毫秒级，见 apply.test.ts 中的计时）。未改动的块对象按引用共享。
 * - 文本 Op 只触及目标块：O(该块行内节点数)。
 * - 哈希只在事务结束时对改动过的块各算一次。
 * - 结构 Op（移除/移动）需要"子块 → 父块"索引：首次需要时 O(块数) 构建，之后随事务增量维护，
 *   并缓存在结果 `Doc` 上（WeakMap）交给下一个事务复用（所有权转移：从某个 Doc 派生第二个
 *   事务时会重建）。因此连续编辑中结构 Op 是 O(父序列长度)。
 * - 校验：每个 Op 先完整校验再写入；任何 Op 抛 `TxError` 时整个事务作废，输入 Doc 不受影响。
 *
 * @module
 */
import {
  computeBlockHash,
  inlineLength,
  MARK_ORDER,
  normalizeInline,
  sortMarks,
  stableStringify,
  type Block,
  type BlockId,
  type ComponentBlock,
  type Doc,
  type DocHead,
  type DocMeta,
  type InlineNode,
  type Mark,
  type TableData,
  type TextBlock,
  type TextBlockType,
} from '../model.js';
import { isValidBlockId } from '../ids.js';
import { fail, TxError } from './errors.js';
import { assertBoundary, isNormalizedInline, mapMarks, markSegments, replaceInline } from './inline.js';
import { Mapping, type Assoc, type MapStep, type Pos } from './mapping.js';
import type { BlockPlace, HeadKey, InsertBlockOp, Op, PatchOp, Transaction } from './ops.js';
import { applyPatch } from './patch.js';

/** 合法的文本块类型。 */
export const TEXT_BLOCK_TYPES: ReadonlySet<TextBlockType> = new Set<TextBlockType>([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'quote',
  'code',
  'hr',
  'table',
  'figure',
]);

/** `setHead` 允许的键。 */
export const HEAD_KEYS: readonly HeadKey[] = ['lang', 'title', 'themeCss', 'userCss', 'runtimeSrc', 'extra'];

const COMPONENT_TYPE_RE = /^[a-z][a-z0-9-]*$/;

/**
 * 事务结果。
 *
 * ## 变更集语义（供渲染器 T2.1 使用）
 *
 * - `dirty`：事务前后**块对象不同**的块 ID：内容 / 属性 / 类型 / props / fallback / 表格 / 槽位
 *   发生实际变化的块（含因子块插入、移除、移出、移入而 `slots` 改变的**父容器**），
 *   以及新插入的块（整棵子树）和被移除的块（整棵子树）。
 *   - 判断"被移除"：`dirty` 中的 ID 不在 `result.doc.blocks` 中（亦见 `removed`）；渲染器应删除其 DOM。
 *   - 事务内先插入后删除的块不出现；改动后又改回原样的块会复用原块对象，也不出现。
 *   - 被**移动**的块本身不 dirty（内容没变）；其新旧父容器 dirty（或 `rootChanged`）。
 * - `rootChanged`：顶层顺序 `doc.root` 改变（顶层插入/移除/移动）。顶层没有父块 ID，故单列。
 * - `metaChanged` / `headChanged`：`meta` / `head` 改变。
 */
export interface TxResult {
  /** 新文档（`version + 1`）。 */
  readonly doc: Doc;
  /** 见上。 */
  readonly dirty: ReadonlySet<BlockId>;
  /** `dirty` 中事务前不存在、事务后存在的块。 */
  readonly inserted: ReadonlySet<BlockId>;
  /** `dirty` 中事务前存在、事务后不存在的块。 */
  readonly removed: ReadonlySet<BlockId>;
  readonly rootChanged: boolean;
  readonly metaChanged: boolean;
  readonly headChanged: boolean;
  /** 事务前位置 → 事务后位置。 */
  readonly mapping: Mapping;
  /** 已解析的 Op（捕获字段已填好），可直接 `invert`。 */
  readonly applied: readonly Op[];
  /** `{ ops: applied, meta }`，供历史记录存储。 */
  readonly tx: Transaction;
}

type ParentIndex = Map<BlockId, BlockId | null>;

/** 子块 → 父块索引缓存；所有权随事务转移（见模块说明）。 */
const parentCache = new WeakMap<Doc, ParentIndex>();

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function sameBlock(a: Block, b: Block): boolean {
  const { hash: _a, ...ra } = a;
  const { hash: _b, ...rb } = b;
  return stableStringify(ra) === stableStringify(rb);
}

function checkMarks(marks: unknown, what: string): readonly Mark[] {
  if (!Array.isArray(marks)) fail('invalid', `${what}: marks must be an array`);
  for (const m of marks as unknown[]) {
    const mk = m as Mark | null;
    if (!mk || typeof mk !== 'object' || !MARK_ORDER.includes(mk.type)) fail('invalid', `${what}: unknown mark`);
  }
  return marks as readonly Mark[];
}

function checkInline(content: unknown, what: string): readonly InlineNode[] {
  if (!Array.isArray(content)) fail('invalid', `${what}: content must be an array`);
  for (const n of content as unknown[]) {
    const node = n as InlineNode | null;
    if (!node || typeof node !== 'object') fail('invalid', `${what}: bad inline node`);
    if (node.t === 'text' || node.t === 'atom') {
      if (typeof node.text !== 'string') fail('invalid', `${what}: inline text must be a string`);
      if (node.t === 'atom' && (typeof node.kind !== 'string' || typeof node.attrs !== 'object'))
        fail('invalid', `${what}: bad atom`);
    } else if (node.t !== 'br') fail('invalid', `${what}: unknown inline node type`);
    checkMarks(node.marks, what);
  }
  return content as readonly InlineNode[];
}

function normalizeTable(table: TableData, what: string): TableData {
  if (!table || !Array.isArray(table.head) || !Array.isArray(table.body)) fail('invalid', `${what}: bad table`);
  const cell = (c: unknown): InlineNode[] => normalizeInline(checkInline(c, what));
  const body = table.body.map((row) => {
    if (!Array.isArray(row)) fail('invalid', `${what}: bad table row`);
    return row.map(cell);
  });
  const out: TableData = { head: table.head.map(cell), body };
  if (table.align !== undefined) {
    if (!Array.isArray(table.align)) fail('invalid', `${what}: bad table align`);
    return { ...out, align: table.align.slice() };
  }
  return out;
}

/**
 * 事务的可变工作状态（内部）。`apply` 与 {@link TxBuilder} 共用。
 * 工作中的块对象可能带有过期 `hash`，只在 `finish` 时修正，不对外暴露。
 */
class TxState {
  private blocks: Map<BlockId, Block> | null = null;
  private rootArr: BlockId[] | null = null;
  private meta: Readonly<DocMeta>;
  private head: DocHead;
  private readonly stale = new Set<BlockId>();
  private readonly touched = new Set<BlockId>();
  private parents: ParentIndex | null;
  readonly steps: MapStep[] = [];
  readonly applied: Op[] = [];

  constructor(readonly base: Doc) {
    this.meta = base.meta;
    this.head = base.head;
    this.parents = parentCache.get(base) ?? null;
    if (this.parents) parentCache.delete(base);
  }

  // ───────────── 读写原语 ─────────────

  get(id: BlockId): Block | undefined {
    return (this.blocks ?? this.base.blocks).get(id);
  }

  private must(id: BlockId): Block {
    const b = this.get(id);
    if (!b) fail('unknownBlock', `block not found: ${id}`);
    return b;
  }

  private text(id: BlockId): TextBlock {
    const b = this.must(id);
    if (b.kind !== 'text') fail('wrongKind', `block ${id} is not a text block`);
    return b;
  }

  private component(id: BlockId): ComponentBlock {
    const b = this.must(id);
    if (b.kind !== 'component') fail('wrongKind', `block ${id} is not a component block`);
    return b;
  }

  get root(): readonly BlockId[] {
    return this.rootArr ?? this.base.root;
  }

  private put(b: Block): void {
    if (!this.blocks) this.blocks = new Map(this.base.blocks);
    this.blocks.set(b.id, b);
    this.stale.add(b.id);
    this.touched.add(b.id);
  }

  private drop(id: BlockId): void {
    if (!this.blocks) this.blocks = new Map(this.base.blocks);
    this.blocks.delete(id);
    this.stale.delete(id);
    this.touched.add(id);
  }

  /** 取块并确保其哈希正确（用于捕获到 Op 中）。 */
  private seal(id: BlockId): Block {
    const b = this.must(id);
    if (!this.stale.has(id)) return b;
    const hash = computeBlockHash(b);
    const sealed = hash === b.hash ? b : ({ ...b, hash } as Block);
    (this.blocks as Map<BlockId, Block>).set(id, sealed);
    this.stale.delete(id);
    return sealed;
  }

  private index(): ParentIndex {
    if (this.parents) return this.parents;
    const idx: ParentIndex = new Map();
    for (const id of this.root) idx.set(id, null);
    for (const b of (this.blocks ?? this.base.blocks).values())
      if (b.kind === 'component' && b.slots) for (const s of b.slots) for (const c of s) idx.set(c, b.id);
    this.parents = idx;
    return idx;
  }

  /** 序列 `(parent, slot)`，校验父块与槽位。 */
  private seq(parent: BlockId | null, slot: number): readonly BlockId[] {
    if (parent === null) {
      if (slot !== 0) fail('range', `root has only slot 0`);
      return this.root;
    }
    const p = this.must(parent);
    if (p.kind !== 'component' || !p.slots) fail('wrongKind', `block ${parent} is not a container`);
    if (!Number.isInteger(slot) || slot < 0 || slot >= p.slots.length)
      fail('range', `slot ${slot} out of range for ${parent}`);
    return p.slots[slot] as readonly BlockId[];
  }

  private writeSeq(parent: BlockId | null, slot: number, seq: BlockId[]): void {
    if (parent === null) {
      this.rootArr = seq;
      return;
    }
    const p = this.must(parent) as ComponentBlock;
    const slots = (p.slots as readonly (readonly BlockId[])[]).slice();
    slots[slot] = seq;
    this.put({ ...p, slots });
  }

  private locate(id: BlockId): BlockPlace {
    this.must(id);
    const parent = this.index().get(id);
    if (parent === undefined) fail('unknownBlock', `block ${id} is not attached`);
    if (parent === null) return { parent, slot: 0, index: this.root.indexOf(id) };
    const slots = (this.must(parent) as ComponentBlock).slots ?? [];
    for (let s = 0; s < slots.length; s++) {
      const i = (slots[s] as readonly BlockId[]).indexOf(id);
      if (i >= 0) return { parent, slot: s, index: i };
    }
    return fail('unknownBlock', `block ${id} not found in parent ${parent}`);
  }

  private subtree(id: BlockId): BlockId[] {
    const out: BlockId[] = [];
    const visit = (bid: BlockId): void => {
      out.push(bid);
      const b = this.must(bid);
      if (b.kind === 'component' && b.slots) for (const s of b.slots) for (const c of s) visit(c);
    };
    visit(id);
    return out;
  }

  private checkIndex(index: number, len: number): void {
    if (!Number.isInteger(index) || index < 0 || index > len) fail('range', `index ${index} out of [0, ${len}]`);
  }

  // ───────────── Op ─────────────

  /** 应用一个 Op（先完整校验再写入）。 */
  step(op: Op): void {
    this.applied.push(this.applyOp(op));
  }

  private applyOp(op: Op): Op {
    switch (op.t) {
      case 'insertText': {
        if (typeof op.text !== 'string') fail('invalid', 'insertText: text must be a string');
        const marks = sortMarks(checkMarks(op.marks ?? [], 'insertText'));
        return this.insertInline(op, op.block, op.offset, op.text ? [{ t: 'text', text: op.text, marks }] : []);
      }
      case 'insertContent':
        return this.insertInline(op, op.block, op.offset, checkInline(op.content, 'insertContent'));
      case 'deleteText': {
        const b = this.text(op.block);
        const len = inlineLength(b.content);
        this.checkRange(b, op.from, op.to, len);
        const { content, removed } = replaceInline(b.content, op.from, op.to, []);
        if (op.to > op.from) {
          this.put({ ...b, content });
          this.steps.push({ kind: 'text', block: b.id, offset: op.from, deleted: op.to - op.from, inserted: 0 });
        }
        return { ...op, deleted: removed };
      }
      case 'setMark': {
        const b = this.text(op.block);
        const [mark] = checkMarks([op.mark], 'setMark');
        const m: Mark = (mark as Mark).attrs
          ? { type: (mark as Mark).type, attrs: (mark as Mark).attrs }
          : { type: (mark as Mark).type };
        this.checkRange(b, op.from, op.to, inlineLength(b.content));
        const segs = markSegments(b.content, op.from, op.to, m.type);
        const prev = segs.filter((s) =>
          op.value ? s.mark === null || stableStringify(s.mark) !== stableStringify(m) : s.mark !== null,
        );
        if (prev.length > 0) {
          const content = mapMarks(b.content, op.from, op.to, (marks) =>
            op.value
              ? sortMarks([...marks.filter((x) => x.type !== m.type), m])
              : marks.filter((x) => x.type !== m.type),
          );
          this.put({ ...b, content });
        }
        return { ...op, mark: m, prev };
      }
      case 'insertBlock':
        return this.insertBlock(op);
      case 'removeBlock': {
        const place = this.locate(op.id);
        const ids = this.subtree(op.id);
        const sealed = ids.map((id) => this.seal(id));
        const seq = this.seq(place.parent, place.slot).slice();
        seq.splice(place.index, 1);
        this.writeSeq(place.parent, place.slot, seq);
        const idx = this.index();
        for (const id of ids) {
          this.drop(id);
          idx.delete(id);
        }
        this.steps.push({ kind: 'blocks', removed: new Set(ids), inserted: new Set() });
        return { ...op, removed: { ...place, block: sealed[0] as Block, descendants: sealed.slice(1) } };
      }
      case 'moveBlock': {
        const from = this.locate(op.id);
        const idx = this.index();
        const src = this.seq(from.parent, from.slot);
        const same = op.parent === from.parent && op.slot === from.slot;
        const tgtLen = same ? src.length - 1 : this.seq(op.parent, op.slot).length;
        this.checkIndex(op.index, tgtLen);
        for (let p: BlockId | null | undefined = op.parent; p != null; p = idx.get(p))
          if (p === op.id) fail('cycle', `cannot move ${op.id} into itself or its descendant`);
        const s1 = src.slice();
        s1.splice(from.index, 1);
        this.writeSeq(from.parent, from.slot, s1);
        const s2 = this.seq(op.parent, op.slot).slice();
        s2.splice(op.index, 0, op.id);
        this.writeSeq(op.parent, op.slot, s2);
        idx.set(op.id, op.parent);
        return { ...op, from };
      }
      case 'setType': {
        const b = this.must(op.id);
        if (b.kind === 'html') fail('wrongKind', `HTML block ${op.id} has no type; use setHtml`);
        if (b.kind === 'text' && !TEXT_BLOCK_TYPES.has(op.type as TextBlockType))
          fail('invalid', `unknown text block type ${op.type}`);
        if (b.kind === 'component' && !COMPONENT_TYPE_RE.test(op.type))
          fail('invalid', `invalid component type ${op.type}`);
        if (b.type !== op.type) this.put({ ...b, type: op.type } as Block);
        return { ...op, prev: b.type };
      }
      case 'setProps': {
        const b = this.component(op.id);
        const { value, inverse } = applyPatch(b.props, op.patch);
        this.put({ ...b, props: value });
        return { ...op, inverse };
      }
      case 'setAttrs': {
        const b = this.must(op.id);
        if (b.kind === 'html') fail('wrongKind', `HTML block ${op.id} has no attrs; use setHtml`);
        const attrs = new Map(Object.entries(b.attrs));
        const prev: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(op.attrs)) {
          if (v !== null && typeof v !== 'string') fail('invalid', `setAttrs: value of ${k} must be string or null`);
          prev[k] = attrs.get(k) ?? null;
          if (v === null) attrs.delete(k);
          else attrs.set(k, v);
        }
        this.put({ ...b, attrs: Object.fromEntries(attrs) } as Block);
        return { ...op, prev };
      }
      case 'setTable': {
        const b = this.text(op.id);
        const prev = b.table ?? null;
        if (op.table === null) {
          const { table: _t, ...rest } = b;
          this.put(rest as TextBlock);
        } else this.put({ ...b, table: normalizeTable(op.table, 'setTable') });
        return { ...op, prev };
      }
      case 'setCell': {
        const b = this.text(op.id);
        if (!b.table) fail('wrongKind', `block ${op.id} has no table`);
        const content = normalizeInline(checkInline(op.content, 'setCell'));
        const rows = op.section === 'head' ? [b.table.head] : op.section === 'body' ? b.table.body : null;
        if (!rows) fail('invalid', `setCell: bad section`);
        const row = Number.isInteger(op.row) ? rows[op.row] : undefined;
        if (!row) fail('range', `setCell: row ${op.row} out of range`);
        if (!Number.isInteger(op.col) || op.col < 0 || op.col >= row.length)
          fail('range', `setCell: col ${op.col} out of range`);
        const prev = row[op.col] as readonly InlineNode[];
        const newRow = row.slice();
        newRow[op.col] = content;
        const table: Mutable<TableData> = { ...b.table };
        if (op.section === 'head') table.head = newRow;
        else {
          const body = b.table.body.slice();
          body[op.row] = newRow;
          table.body = body;
        }
        this.put({ ...b, table });
        return { ...op, prev };
      }
      case 'setFallback': {
        const b = this.component(op.id);
        if (op.fallback !== null && typeof op.fallback !== 'string') fail('invalid', 'setFallback: bad value');
        const prev = b.fallback ?? null;
        if (op.fallback === null) {
          const { fallback: _f, ...rest } = b;
          this.put(rest);
        } else this.put({ ...b, fallback: op.fallback });
        return { ...op, prev };
      }
      case 'setHtml': {
        const b = this.must(op.id);
        if (b.kind !== 'html') fail('wrongKind', `setHtml: ${op.id} is not an HTML block`);
        if (typeof op.html !== 'string') fail('invalid', 'setHtml: html must be a string');
        if (b.html !== op.html) this.put({ ...b, html: op.html });
        return { ...op, prev: b.html };
      }
      case 'insertSlot': {
        const b = this.component(op.id);
        const created = b.slots === undefined;
        const slots = (b.slots ?? []).slice();
        this.checkIndex(op.slot, slots.length);
        slots.splice(op.slot, 0, []);
        this.put({ ...b, slots });
        return { ...op, created };
      }
      case 'removeSlot': {
        const b = this.component(op.id);
        if (!b.slots) fail('wrongKind', `block ${op.id} is not a container`);
        if (!Number.isInteger(op.slot) || op.slot < 0 || op.slot >= b.slots.length)
          fail('range', `slot ${op.slot} out of range for ${op.id}`);
        if ((b.slots[op.slot] as readonly BlockId[]).length > 0)
          fail('invalid', `slot ${op.slot} of ${op.id} is not empty`);
        const slots = b.slots.filter((_, i) => i !== op.slot);
        const unset = op.unset === true && slots.length === 0;
        if (unset) {
          const { slots: _s, ...rest } = b;
          this.put(rest);
        } else this.put({ ...b, slots });
        return { ...op, unset };
      }
      case 'setMeta': {
        const { value, inverse } = applyPatch(this.meta, op.patch);
        if (value === null || typeof value !== 'object' || Array.isArray(value))
          fail('invalid', 'setMeta: meta must remain an object');
        this.meta = value as DocMeta;
        return { ...op, inverse };
      }
      case 'setHead': {
        const head = new Map(Object.entries(this.head) as [HeadKey, string][]);
        const prev: Partial<Record<HeadKey, string | null>> = {};
        for (const [k, v] of Object.entries(op.head)) {
          const key = k as HeadKey;
          if (!HEAD_KEYS.includes(key)) fail('invalid', `setHead: unknown key ${k}`);
          if (v !== null && typeof v !== 'string') fail('invalid', `setHead: value of ${k} must be string or null`);
          prev[key] = this.head[key] ?? null;
          if (v === null) head.delete(key);
          else head.set(key, v);
        }
        this.head = Object.fromEntries(head) as DocHead;
        return { ...op, prev };
      }
      default: {
        const never: never = op;
        return fail('invalid', `unknown op ${(never as { t?: unknown }).t as string}`);
      }
    }
  }

  private checkRange(b: TextBlock, from: number, to: number, len: number): void {
    assertBoundary(b.content, from, len, 'from');
    assertBoundary(b.content, to, len, 'to');
    if (from > to) fail('range', `from ${from} > to ${to}`);
  }

  private insertInline(op: Op, id: BlockId, offset: number, nodes: readonly InlineNode[]): Op {
    const b = this.text(id);
    assertBoundary(b.content, offset, inlineLength(b.content), 'offset');
    const n = inlineLength(nodes);
    if (n > 0) {
      const { content } = replaceInline(b.content, offset, offset, nodes);
      this.put({ ...b, content });
      this.steps.push({ kind: 'text', block: id, offset, deleted: 0, inserted: n });
    }
    return op;
  }

  private insertBlock(op: InsertBlockOp): Op {
    const seq = this.seq(op.parent, op.slot);
    this.checkIndex(op.index, seq.length);
    // 收集并校验子树。
    const given = new Map<BlockId, Block>();
    for (const b of [op.block, ...(op.descendants ?? [])]) {
      if (!b || typeof b !== 'object') fail('invalid', 'insertBlock: bad block');
      if (typeof b.id !== 'string' || !isValidBlockId(b.id))
        fail('invalid', `insertBlock: invalid block id ${String(b.id)}`);
      if (given.has(b.id)) fail('duplicateId', `insertBlock: duplicate id ${b.id} in subtree`);
      if (this.get(b.id)) fail('duplicateId', `insertBlock: block ${b.id} already exists`);
      if (b.kind === 'text') {
        if (!TEXT_BLOCK_TYPES.has(b.type)) fail('invalid', `insertBlock: unknown text block type ${b.type}`);
        checkInline(b.content, 'insertBlock');
      } else if (b.kind === 'component') {
        if (!COMPONENT_TYPE_RE.test(b.type)) fail('invalid', `insertBlock: invalid component type ${b.type}`);
      } else if (b.kind !== 'html') fail('invalid', `insertBlock: unknown block kind`);
      given.set(b.id, b);
    }
    const order: Block[] = [];
    const visit = (b: Block): void => {
      order.push(b);
      if (b.kind !== 'component' || !b.slots) return;
      for (const s of b.slots)
        for (const c of s) {
          const child = given.get(c);
          if (!child) fail('invalid', `insertBlock: child ${c} of ${b.id} missing from descendants`);
          if (order.includes(child)) fail('invalid', `insertBlock: block ${c} referenced more than once`);
          visit(child);
        }
    };
    visit(op.block);
    if (order.length !== given.size) fail('invalid', 'insertBlock: descendants contain blocks outside the subtree');
    // 写入。
    const s = seq.slice();
    s.splice(op.index, 0, op.block.id);
    this.writeSeq(op.parent, op.slot, s);
    const idx = this.parents;
    for (const b of order) {
      const fixed =
        b.kind === 'text' && !isNormalizedInline(b.content) ? { ...b, content: normalizeInline(b.content) } : b;
      this.put(fixed);
      if (idx && b.kind === 'component' && b.slots) for (const sl of b.slots) for (const c of sl) idx.set(c, b.id);
    }
    if (idx) idx.set(op.block.id, op.parent);
    this.steps.push({ kind: 'blocks', removed: new Set(), inserted: new Set(order.map((b) => b.id)) });
    return op;
  }

  // ───────────── 结束 ─────────────

  finish(meta?: Readonly<Record<string, unknown>>): TxResult {
    const base = this.base;
    const dirty = new Set<BlockId>();
    const inserted = new Set<BlockId>();
    const removed = new Set<BlockId>();
    const blocks = this.blocks;
    if (blocks) {
      for (const id of this.touched) {
        const orig = base.blocks.get(id);
        let cur = blocks.get(id);
        if (cur && this.stale.has(id)) {
          const hash = computeBlockHash(cur);
          if (hash !== cur.hash) cur = { ...cur, hash } as Block;
        }
        if (cur && orig && cur !== orig && cur.hash === orig.hash && sameBlock(cur, orig)) cur = orig;
        if (cur) blocks.set(id, cur);
        if (cur !== orig) {
          dirty.add(id);
          if (!orig) inserted.add(id);
          if (!cur) removed.add(id);
        }
      }
    }
    let root = base.root;
    let rootChanged = false;
    if (this.rootArr) {
      const r = this.rootArr;
      rootChanged = r.length !== root.length || r.some((id, i) => id !== root[i]);
      if (rootChanged) root = r;
    }
    let docMeta = base.meta;
    const metaChanged = this.meta !== base.meta && stableStringify(this.meta) !== stableStringify(base.meta);
    if (metaChanged) docMeta = this.meta;
    let head = base.head;
    const headChanged = this.head !== base.head && HEAD_KEYS.some((k) => this.head[k] !== base.head[k]);
    if (headChanged) head = this.head;
    const doc: Doc = { meta: docMeta, head, root, blocks: blocks ?? base.blocks, version: base.version + 1 };
    if (this.parents) parentCache.set(doc, this.parents);
    const applied = this.applied.slice();
    return {
      doc,
      dirty,
      inserted,
      removed,
      rootChanged,
      metaChanged,
      headChanged,
      mapping: new Mapping(this.steps.slice()),
      applied,
      tx: meta ? { ops: applied, meta } : { ops: applied },
    };
  }
}

/**
 * 应用事务。纯函数：输入 `doc` 不被修改；未改动的块按引用共享；只对改动块重算哈希；
 * 结果 `version + 1` 并满足 `validateDoc`。任何无效 Op 抛 {@link TxError}（`opIndex` 指明是第几个）。
 */
export function apply(doc: Doc, tx: Transaction | readonly Op[]): TxResult {
  const ops: readonly Op[] = Array.isArray(tx) ? tx : (tx as Transaction).ops;
  const meta = Array.isArray(tx) ? undefined : (tx as Transaction).meta;
  const st = new TxState(doc);
  ops.forEach((op, i) => runStep(st, op, i));
  return st.finish(meta);
}

function runStep(st: TxState, op: Op, i: number): void {
  try {
    st.step(op);
  } catch (e) {
    if (e instanceof TxError) e.opIndex = i;
    throw e;
  }
}

/**
 * 事务构建器：`tr(doc).insertText(...).deleteText(...).apply()`。
 *
 * 每次调用立即校验并应用到内部工作状态（与 `apply` 共用实现，整个事务只复制一次块表）。
 * **每个 Op 的位置都以前面所有步骤之后的文档为准**；要把起始文档中的位置换算到当前，
 * 用 {@link TxBuilder.map}（即 `builder.mapping.map`）。
 *
 * 任一步抛出 `TxError` 后构建器失效（之后的调用抛 `TxError('finished')`）；起始文档不受影响。
 */
export class TxBuilder {
  private readonly st: TxState;
  private done = false;

  constructor(doc: Doc) {
    this.st = new TxState(doc);
  }

  /** 起始文档。 */
  get doc(): Doc {
    return this.st.base;
  }

  /** 至今为止已解析的 Op。 */
  get ops(): readonly Op[] {
    return this.st.applied;
  }

  /** 起始文档 → 当前状态的映射。 */
  get mapping(): Mapping {
    return new Mapping(this.st.steps.slice());
  }

  /** 把起始文档中的位置映射到当前状态。 */
  map(pos: Pos, assoc: Assoc = 1): Pos {
    return this.mapping.map(pos, assoc);
  }

  /** 读取当前状态中的块（注意：其 `hash` 可能尚未更新）。 */
  get(id: BlockId): Block | undefined {
    return this.st.get(id);
  }

  /** 当前顶层顺序。 */
  get root(): readonly BlockId[] {
    return this.st.root;
  }

  /** 追加任意 Op。 */
  step(op: Op): this {
    if (this.done) fail('finished', 'transaction builder already finished');
    try {
      runStep(this.st, op, this.st.applied.length);
    } catch (e) {
      this.done = true;
      throw e;
    }
    return this;
  }

  insertText(block: BlockId, offset: number, text: string, marks?: readonly Mark[]): this {
    return this.step(
      marks ? { t: 'insertText', block, offset, text, marks } : { t: 'insertText', block, offset, text },
    );
  }
  insertContent(block: BlockId, offset: number, content: readonly InlineNode[]): this {
    return this.step({ t: 'insertContent', block, offset, content });
  }
  deleteText(block: BlockId, from: number, to: number): this {
    return this.step({ t: 'deleteText', block, from, to });
  }
  setMark(block: BlockId, from: number, to: number, mark: Mark, value: boolean): this {
    return this.step({ t: 'setMark', block, from, to, mark, value });
  }
  insertBlock(parent: BlockId | null, slot: number, index: number, block: Block, descendants?: readonly Block[]): this {
    return this.step(
      descendants
        ? { t: 'insertBlock', parent, slot, index, block, descendants }
        : { t: 'insertBlock', parent, slot, index, block },
    );
  }
  removeBlock(id: BlockId): this {
    return this.step({ t: 'removeBlock', id });
  }
  moveBlock(id: BlockId, parent: BlockId | null, slot: number, index: number): this {
    return this.step({ t: 'moveBlock', id, parent, slot, index });
  }
  setType(id: BlockId, type: string): this {
    return this.step({ t: 'setType', id, type });
  }
  setProps(id: BlockId, patch: readonly PatchOp[]): this {
    return this.step({ t: 'setProps', id, patch });
  }
  setAttrs(id: BlockId, attrs: Readonly<Record<string, string | null>>): this {
    return this.step({ t: 'setAttrs', id, attrs });
  }
  setTable(id: BlockId, table: TableData | null): this {
    return this.step({ t: 'setTable', id, table });
  }
  setCell(id: BlockId, section: 'head' | 'body', row: number, col: number, content: readonly InlineNode[]): this {
    return this.step({ t: 'setCell', id, section, row, col, content });
  }
  setFallback(id: BlockId, fallback: string | null): this {
    return this.step({ t: 'setFallback', id, fallback });
  }

  /** 替换 HTML 块的原始 HTML。 */
  setHtml(id: BlockId, html: string): this {
    return this.step({ t: 'setHtml', id, html });
  }
  insertSlot(id: BlockId, slot: number): this {
    return this.step({ t: 'insertSlot', id, slot });
  }
  removeSlot(id: BlockId, slot: number, unset?: boolean): this {
    return this.step(unset === undefined ? { t: 'removeSlot', id, slot } : { t: 'removeSlot', id, slot, unset });
  }
  setMeta(patch: readonly PatchOp[]): this {
    return this.step({ t: 'setMeta', patch });
  }
  setHead(head: Readonly<Partial<Record<HeadKey, string | null>>>): this {
    return this.step({ t: 'setHead', head });
  }

  /** 结束并产出结果（等价于 `apply(doc, ops)`）。之后构建器失效。 */
  apply(meta?: Readonly<Record<string, unknown>>): TxResult {
    if (this.done) fail('finished', 'transaction builder already finished');
    this.done = true;
    return this.st.finish(meta);
  }
}

/** 创建事务构建器。 */
export function tr(doc: Doc): TxBuilder {
  return new TxBuilder(doc);
}
