/**
 * 块模型的撤销/重做历史（T1.5，docs/03-algorithms.md §4）。
 *
 * ## 用法
 *
 * ```ts
 * const history = new History();
 * let doc = parse(src).doc;
 * // 每个事务（无论是否进历史）都必须交给 record：
 * const r = tr(doc).insertText('b1', 3, 'x').apply();
 * history.record(r, { selectionBefore, selectionAfter });
 * doc = r.doc;
 * // 不进历史、但之后的撤销要越过它（降级缓存回填、外部合并、远端变更）：
 * const fb = tr(doc).setFallback('b9', svg).apply();
 * history.record(fb, { addToHistory: false }); // 或 tx.meta.addToHistory === false
 * doc = fb.doc;
 * // 撤销 / 重做：
 * const u = history.undo(doc);
 * if (u) { doc = u.doc; render(u.result); restoreSelection(u.selection); }
 * ```
 *
 * ## 设计
 *
 * - **Op 日志 + 可逆 Op**：历史项存 `TxResult.tx.ops`（已解析的 Op），撤销 = 应用其逆，内存 O(改动量)。
 * - **映射**：所有事务的映射步骤都追加到 {@link StepLog}。撤销某一项时，它的每个逆 Op 先经
 *   日志中"该 Op 之后的全部步骤"`mapOp`，再应用——撤销的是"那段文字"而不是"那个偏移"。
 *   撤销/重做追加的步骤与被撤销的步骤登记为**镜像**，使"删掉的文字被撤销恢复"后位置仍能精确映射。
 *   没有后续事务时（最常见）直接应用逆事务，不做映射。
 * - **越过后续事务时的降级**：目标块已删除的逆 Op 被跳过；块下标（`insertBlock`/`moveBlock`）不被映射，
 *   超出序列长度时夹到末尾；映射后仍无效（`TxError`）的 Op 被跳过（结果中 `skipped` 计数）。
 * - **输入合并**：见 `group.ts`（同块、< 500ms、同类连续 `insertText` / 退格 / Delete，遇空白标点断开）。
 *   时间可注入（构造参数 `clock` 或 `record` 的 `now`）。
 * - **上限**：条目数 + 近似字节数（Op 载荷大小之和）双阈值，丢弃最旧的（见 `stack.ts`）。
 * - **快照**：每 `snapshotEvery` 次事务记录一次块哈希表，{@link History.verify} 校验。
 * - **选区**：每项可附带不透明的 `selectionBefore/After`，撤销返回前者、重做返回后者；历史不解释它们，
 *   也不映射它们。
 *
 * ## 给 T2.6（保真补丁层）的复用方式
 *
 * 通用部分与块模型无关，可直接复用：
 * - {@link UndoStack}`<E>`：两个栈、新编辑清空 redo、栈顶替换（合并）、条目数/字节双阈值裁剪；
 *   `E` 只需提供 `size`。补丁层的条目可以是 `{ patches, inverse, size, group, selectionBefore/After }`。
 * - `extendGroup` / `startGroup`（`group.ts`）：把"在原始 HTML 文本区间内输入/删除"描述成 `TextEdit`
 *   （`target` = 区间或文本节点 ID）即可得到同样的合并规则。
 * - `takeSnapshot` / `verifySnapshot`：对补丁层，可以把"字节区间 ID → 哈希"套同一结构，或直接比较
 *   整个文件哈希（验收："连续编辑后撤销到底 = 原文件字节"）。
 *
 * 需要自己提供的只有"怎么应用一个条目的逆、怎么越过之后的变更"：若补丁层的变更最终都是对 `eh-html`
 * 块的 `setHtml`/文本 Op（06 §4），直接用本 `History` 即可；若是独立的字节补丁，实现一个与本类同构的
 * 小类：`record` 时压栈/合并，`undo` 时 `popUndo` → 把逆补丁经之后的字节偏移映射 → 应用 → `pushRedo`。
 *
 * @module
 */
import { inlineLength, sortMarks, stableStringify, type BlockId, type Doc, type InlineNode } from '../model.js';
import { apply, type TxResult } from '../tx/apply.js';
import { TxError } from '../tx/errors.js';
import { invert, mapOp } from '../tx/invert.js';
import type { Op, Transaction } from '../tx/ops.js';
import { DEFAULT_MERGE_WINDOW, extendGroup, isBreakChar, startGroup, type InputGroup, type TextEdit } from './group.js';
import { StepLog } from './log.js';
import { takeSnapshot, verifySnapshot, type HashSnapshot, type VerifyResult } from './snapshot.js';
import { UndoStack, type StackEntry, type StackLimits } from './stack.js';

/** {@link History} 构造参数。 */
export interface HistoryOptions extends Partial<StackLimits> {
  /** 输入合并时间窗（毫秒），默认 500。 */
  readonly mergeWindow?: number;
  /** 断开字符判定，默认空白与 Unicode 标点。 */
  readonly isBreak?: (ch: string) => boolean;
  /** 时钟（毫秒），默认 `Date.now`。测试中注入。 */
  readonly clock?: () => number;
  /** 每多少次事务拍一次块哈希快照，默认 100；0 关闭。 */
  readonly snapshotEvery?: number;
  /** 保留的快照数，默认 4。 */
  readonly maxSnapshots?: number;
}

/** {@link History.record} 参数。`S` 是编辑器的选区类型（历史不解释它）。 */
export interface RecordOptions<S = unknown> {
  /**
   * `false`：不进历史，但之后的撤销会越过它映射（默认取 `!(result.tx.meta?.addToHistory === false)`）。
   */
  readonly addToHistory?: boolean;
  /** 本次编辑的时间（毫秒），缺省取时钟。 */
  readonly now?: number;
  /** `false`：禁止与栈顶合并（粘贴、选区跳转、失焦后等）。默认允许（仍需满足合并规则）。 */
  readonly merge?: boolean;
  /** 编辑前的选区（撤销后恢复）。合并时保留组内第一项的值。 */
  readonly selectionBefore?: S;
  /** 编辑后的选区（重做后恢复）。合并时取最新值。 */
  readonly selectionAfter?: S;
}

/** {@link History.undo} / {@link History.redo} 的结果。 */
export interface HistoryResult<S = unknown> {
  /** 新文档（= `result.doc`）。 */
  readonly doc: Doc;
  /** 撤销/重做事务的结果（交给渲染器：`dirty` 等）。调用方**不要**再把它 `record`。 */
  readonly result: TxResult;
  /** 应恢复的选区：撤销为该项的 `selectionBefore`，重做为 `selectionAfter`。 */
  readonly selection: S | undefined;
  /** 越过后续事务时因目标不存在或无效而被跳过的 Op 数（无后续事务时总为 0）。 */
  readonly skipped: number;
}

/** 历史项（内部）。`ops` 是"已经应用过的"Op；弹出时应用其逆。 */
interface Item<S> extends StackEntry {
  readonly ops: readonly Op[];
  readonly meta: Readonly<Record<string, unknown>> | undefined;
  /** 本项正向步骤在日志中的区间。 */
  readonly stepFrom: number;
  readonly stepTo: number;
  /** `cum[k]` = 前 k+1 个 Op 产生的步骤数；与区间长度不符时为 `null`（不做逐 Op 映射与镜像）。 */
  readonly cum: readonly number[] | null;
  readonly group: InputGroup | null;
  readonly selectionBefore: S | undefined;
  readonly selectionAfter: S | undefined;
}

/** 单个已解析 Op 产生的映射步骤数（与 `apply` 一致）。 */
function stepCount(op: Op): number {
  switch (op.t) {
    case 'insertText':
      return op.text ? 1 : 0;
    case 'insertContent':
      return inlineLength(op.content) > 0 ? 1 : 0;
    case 'deleteText':
      return op.to > op.from ? 1 : 0;
    case 'insertBlock':
    case 'removeBlock':
      return 1;
    default:
      return 0;
  }
}

function cumulative(ops: readonly Op[], total: number, prefix?: readonly number[] | null): number[] | null {
  if (prefix === null) return null;
  const out = prefix ? prefix.slice() : [];
  let n = out.length ? (out[out.length - 1] as number) : 0;
  for (const op of ops) out.push((n += stepCount(op)));
  return n === total ? out : null;
}

/** 近似内存占用（字节）：字符串按 UTF-16 计，其余按固定开销。 */
export function approxSize(value: unknown): number {
  if (typeof value === 'string') return 16 + value.length * 2;
  if (value === null || typeof value !== 'object') return 8;
  let n = 16;
  if (Array.isArray(value)) for (const v of value) n += approxSize(v);
  else for (const [k, v] of Object.entries(value)) n += k.length * 2 + approxSize(v);
  return n;
}

function isNoop(r: TxResult): boolean {
  return r.dirty.size === 0 && !r.rootChanged && !r.metaChanged && !r.headChanged;
}

/** 单个 `insertText` / 纯文本 `deleteText` 事务 → `TextEdit`；其余返回 `null`（不参与合并）。 */
function describe(ops: readonly Op[]): TextEdit | null {
  if (ops.length !== 1) return null;
  const op = ops[0] as Op;
  if (op.t === 'insertText' && op.text)
    return {
      kind: 'insert',
      target: op.block,
      from: op.offset,
      to: op.offset + op.text.length,
      text: op.text,
      style: stableStringify(sortMarks(op.marks ?? [])),
    };
  if (op.t === 'deleteText' && op.to > op.from && op.deleted?.every((n: InlineNode) => n.t === 'text'))
    return {
      kind: 'delete',
      target: op.block,
      from: op.from,
      to: op.to,
      text: op.deleted.map((n) => (n.t === 'text' ? n.text : '')).join(''),
    };
  return null;
}

function withMeta(ops: readonly Op[], meta: Readonly<Record<string, unknown>> | undefined): Transaction {
  return meta ? { ops, meta } : { ops };
}

/** 块下标不被映射：越过后续事务后若超出序列长度，夹到末尾。 */
function clampIndex(op: Op, doc: Doc): Op {
  if (op.t !== 'insertBlock' && op.t !== 'moveBlock') return op;
  let seq: readonly BlockId[] | undefined;
  if (op.parent === null) seq = op.slot === 0 ? doc.root : undefined;
  else {
    const p = doc.blocks.get(op.parent);
    seq = p?.kind === 'component' ? p.slots?.[op.slot] : undefined;
  }
  if (!seq) return op;
  const len = op.t === 'moveBlock' && seq.includes(op.id) ? seq.length - 1 : seq.length;
  return op.index > len ? { ...op, index: len } : op;
}

/**
 * 撤销/重做历史（可变的小类；所有事务都必须经 {@link History.record}，撤销/重做产生的事务除外）。
 *
 * @typeParam S - 编辑器选区类型（不透明）。
 */
export class History<S = unknown> {
  private readonly stack: UndoStack<Item<S>>;
  private readonly log = new StepLog();
  private readonly window: number;
  private readonly isBreak: (ch: string) => boolean;
  private readonly clock: () => number;
  private readonly snapshotEvery: number;
  private readonly maxSnapshots: number;
  private readonly snaps: HashSnapshot[] = [];
  private txCount = 0;
  private docVersion: number | undefined;
  private compactAt = 1024;

  constructor(opts: HistoryOptions = {}) {
    const limits: Partial<StackLimits> = {};
    if (opts.maxItems !== undefined) (limits as { maxItems: number }).maxItems = opts.maxItems;
    if (opts.maxBytes !== undefined) (limits as { maxBytes: number }).maxBytes = opts.maxBytes;
    this.stack = new UndoStack<Item<S>>(limits);
    this.window = opts.mergeWindow ?? DEFAULT_MERGE_WINDOW;
    this.isBreak = opts.isBreak ?? isBreakChar;
    this.clock = opts.clock ?? Date.now;
    this.snapshotEvery = opts.snapshotEvery ?? 100;
    this.maxSnapshots = Math.max(1, opts.maxSnapshots ?? 4);
  }

  /** 是否可撤销。 */
  canUndo(): boolean {
    return this.stack.undoDepth > 0;
  }

  /** 是否可重做。 */
  canRedo(): boolean {
    return this.stack.redoDepth > 0;
  }

  /** undo 栈深度。 */
  get undoDepth(): number {
    return this.stack.undoDepth;
  }

  /** redo 栈深度。 */
  get redoDepth(): number {
    return this.stack.redoDepth;
  }

  /** 两个栈合计的近似字节数。 */
  get bytes(): number {
    return this.stack.bytes;
  }

  /** 已经历的事务数（record + 撤销 + 重做）。 */
  get transactions(): number {
    return this.txCount;
  }

  /** 已保留的快照（旧 → 新）。 */
  get snapshots(): readonly HashSnapshot[] {
    return this.snaps;
  }

  /** 映射日志当前保留的步骤数（诊断用）。 */
  get logSize(): number {
    return this.log.size;
  }

  /**
   * 记录一个已应用的事务。
   *
   * - 进历史（默认）：可合并时并入栈顶，否则压入新项；清空 redo 栈。空操作（无任何变化）被忽略。
   * - `addToHistory: false`（或 `result.tx.meta.addToHistory === false`）：不进历史，只把其映射追加到日志，
   *   并打断输入合并。
   */
  record(result: TxResult, opts: RecordOptions<S> = {}): void {
    this.docVersion = result.doc.version;
    this.tick(result.doc);
    const add = opts.addToHistory ?? result.tx.meta?.['addToHistory'] !== false;
    const steps = result.mapping.steps;
    if (!add) {
      if (this.stack.undoDepth + this.stack.redoDepth === 0) this.log.reset();
      else this.log.append(steps);
      return;
    }
    if (isNoop(result)) return;
    const ops = result.tx.ops;
    const now = opts.now ?? this.clock();
    const edit = describe(ops);
    const top = this.stack.peekUndo();
    if (opts.merge !== false && edit && top?.group && top.stepTo === this.log.end && this.stack.redoDepth === 0) {
      const group = extendGroup(top.group, edit, now, { window: this.window, isBreak: this.isBreak });
      if (group) {
        this.log.append(steps);
        const stepTo = this.log.end;
        const merged: Item<S> = {
          ...top,
          ops: [...top.ops, ...ops],
          stepTo,
          cum: cumulative(ops, stepTo - top.stepFrom, top.cum),
          group,
          selectionAfter: 'selectionAfter' in opts ? opts.selectionAfter : top.selectionAfter,
          size: top.size + approxSize(ops),
        };
        this.stack.replaceTop(merged);
        return;
      }
    }
    const stepFrom = this.log.append(steps);
    this.stack.push({
      ops,
      meta: result.tx.meta,
      stepFrom,
      stepTo: this.log.end,
      cum: cumulative(ops, steps.length),
      group: edit ? startGroup(edit, now) : null,
      selectionBefore: opts.selectionBefore,
      selectionAfter: opts.selectionAfter,
      size: 64 + approxSize(ops),
    });
    this.maybeCompact();
  }

  /** 结束当前输入组：下一次编辑一定新开一项（选区跳转、失焦、切换输入法等时调用）。 */
  closeGroup(): void {
    const top = this.stack.peekUndo();
    if (top?.group) this.stack.replaceTop({ ...top, group: null });
  }

  /**
   * 撤销一步。`doc` 必须是最近一次 `record` / `undo` / `redo` 得到的文档。
   * 无可撤销项时返回 `null`。
   */
  undo(doc: Doc): HistoryResult<S> | null {
    this.checkDoc(doc);
    const item = this.stack.popUndo();
    if (!item) return null;
    let out: ReturnType<History<S>['revert']>;
    try {
      out = this.revert(doc, item);
    } catch (e) {
      this.stack.pushUndo(item);
      throw e;
    }
    const { result, next, skipped } = out;
    this.stack.pushRedo(next);
    this.after(result);
    return { doc: result.doc, result, selection: item.selectionBefore, skipped };
  }

  /** 重做一步（参数与返回同 {@link History.undo}）。 */
  redo(doc: Doc): HistoryResult<S> | null {
    this.checkDoc(doc);
    const item = this.stack.popRedo();
    if (!item) return null;
    let out: ReturnType<History<S>['revert']>;
    try {
      out = this.revert(doc, item);
    } catch (e) {
      this.stack.pushRedo(item);
      throw e;
    }
    const { result, next, skipped } = out;
    this.stack.pushUndo(next);
    this.after(result);
    return { doc: result.doc, result, selection: item.selectionAfter, skipped };
  }

  /** 清空历史（快照保留）。 */
  clear(): void {
    this.stack.clear();
    this.log.reset();
  }

  /** 立即对 `doc` 拍一次快照并返回。 */
  snapshot(doc: Doc): HashSnapshot {
    const s = takeSnapshot(doc, this.txCount);
    this.snaps.push(s);
    if (this.snaps.length > this.maxSnapshots) this.snaps.shift();
    return s;
  }

  /**
   * 用快照校验文档（默认最近的快照；没有快照时只做哈希完整性检查）。
   * 若 `doc.version` 等于快照版本，`ok` 为 true 即说明文档与拍摄时一致。
   */
  verify(doc: Doc, snap: HashSnapshot | undefined = this.snaps[this.snaps.length - 1]): VerifyResult {
    return verifySnapshot(doc, snap ?? takeSnapshot(doc, this.txCount));
  }

  // ───────────── 内部 ─────────────

  private checkDoc(doc: Doc): void {
    if (this.docVersion !== undefined && doc.version !== this.docVersion)
      throw new Error(
        `History: doc version ${doc.version} does not match the last recorded version ${this.docVersion}; ` +
          'every transaction must be passed to record()',
      );
  }

  private after(result: TxResult): void {
    this.docVersion = result.doc.version;
    this.tick(result.doc);
    this.maybeCompact();
  }

  private tick(doc: Doc): void {
    this.txCount++;
    if (this.snapshotEvery > 0 && this.txCount % this.snapshotEvery === 0) this.snapshot(doc);
  }

  /** 应用 `item` 的逆，追加映射步骤与镜像，返回结果与放到另一个栈上的条目。 */
  private revert(doc: Doc, item: Item<S>): { result: TxResult; next: Item<S>; skipped: number } {
    const { ops, stepFrom, stepTo, cum } = item;
    // 逆 Op 序列：每个附带"从哪里开始映射"与"镜像源步骤"。
    const seq: { op: Op; mapFrom: number; src: number }[] = [];
    for (let k = ops.length - 1; k >= 0; k--) {
      const op = ops[k] as Op;
      const mapFrom = cum ? stepFrom + (cum[k] as number) : stepTo;
      const src = cum && stepCount(op) === 1 ? mapFrom - 1 : -1;
      for (const inv of invert(op)) seq.push({ op: inv, mapFrom, src });
    }
    const start = this.log.end;
    let result: TxResult;
    let skipped = 0;
    try {
      if (start === stepTo) {
        // 之后没有任何事务：直接应用逆事务。
        result = apply(
          doc,
          withMeta(
            seq.map((s) => s.op),
            item.meta,
          ),
        );
        let at = this.log.append(result.mapping.steps);
        result.applied.forEach((op, i) => {
          const n = stepCount(op);
          const src = (seq[i] as { src: number }).src;
          if (n === 1 && src >= 0) this.log.setMirror(src, at);
          at += n;
        });
      } else {
        let cur = doc;
        const final: Op[] = [];
        for (const s of seq) {
          const mapped = mapOp(s.op, this.log.mappingFrom(s.mapFrom));
          if (!mapped) {
            skipped++;
            continue;
          }
          const op = clampIndex(mapped, cur);
          let r: TxResult;
          try {
            r = apply(cur, [op]);
          } catch (e) {
            if (!(e instanceof TxError)) throw e;
            skipped++;
            continue;
          }
          const at = this.log.append(r.mapping.steps);
          if (s.src >= 0 && r.mapping.steps.length === 1) this.log.setMirror(s.src, at);
          final.push(op);
          cur = r.doc;
        }
        result = apply(doc, withMeta(final, item.meta));
      }
    } catch (e) {
      this.log.truncate(start);
      throw e;
    }
    const applied = result.applied;
    const end = this.log.end;
    const next: Item<S> = {
      ops: applied,
      meta: item.meta,
      stepFrom: start,
      stepTo: end,
      cum: cumulative(applied, end - start),
      group: null,
      selectionBefore: item.selectionBefore,
      selectionAfter: item.selectionAfter,
      size: 64 + approxSize(applied),
    };
    return { result, next, skipped };
  }

  /** 丢弃不再被任何历史项引用的日志前缀。 */
  private maybeCompact(): void {
    if (this.stack.undoDepth + this.stack.redoDepth === 0) {
      this.log.reset();
      return;
    }
    if (this.log.size < this.compactAt) return;
    let min = this.log.end;
    for (const e of this.stack.entries()) if (e.stepFrom < min) min = e.stepFrom;
    this.log.compact(min);
    this.compactAt = Math.max(1024, this.log.size * 2);
  }
}
