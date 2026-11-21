/**
 * 位置映射（03 §4）：把事务前的位置变换为事务后的位置，使撤销作用于"那段文字"而非"那个偏移"。
 *
 * 位置是 `{block, offset}`（块内行内偏移）。映射只跟踪：
 * - 文本步骤：某块内 `[offset, offset + deleted)` 被替换为长度 `inserted` 的内容；
 * - 块步骤：块被移除 / 插入（移动块不改变其内位置，不产生步骤）。
 *
 * 块在父容器中的**下标**不被映射（块用稳定 ID 定位）。
 *
 * @module
 */
import type { BlockId } from '../model.js';

/** 文档内位置。 */
export interface Pos {
  readonly block: BlockId;
  readonly offset: number;
}

/** 映射结果。 */
export interface MapResult {
  readonly pos: Pos;
  /**
   * 位置是否被删除：所在块被移除，或位置严格位于某个被删除的文本范围内部。
   * 一旦为 true 就保持为 true（即使块之后被重新插入）。
   */
  readonly deleted: boolean;
}

/** 映射步骤。 */
export type MapStep =
  | {
      readonly kind: 'text';
      readonly block: BlockId;
      readonly offset: number;
      readonly deleted: number;
      readonly inserted: number;
    }
  | { readonly kind: 'blocks'; readonly removed: ReadonlySet<BlockId>; readonly inserted: ReadonlySet<BlockId> };

/** 关联方向：`-1` 贴左（插入点处的位置留在插入内容之前），`1` 贴右（移到插入内容之后）。 */
export type Assoc = 1 | -1;

/** 单个文本步骤对偏移的映射（与 ProseMirror StepMap 相同的边界规则）。 */
function mapOffset(
  p: number,
  step: { offset: number; deleted: number; inserted: number },
  assoc: Assoc,
): { offset: number; deleted: boolean } {
  const start = step.offset;
  const end = start + step.deleted;
  if (p < start || (p === start && step.deleted === 0 && assoc < 0)) return { offset: p, deleted: false };
  if (p > end) return { offset: p - step.deleted + step.inserted, deleted: false };
  // start <= p <= end
  const side = step.deleted === 0 ? assoc : p === start ? -1 : p === end ? 1 : assoc;
  const inside = step.deleted > 0 && p > start && p < end;
  return { offset: side < 0 ? start : start + step.inserted, deleted: inside };
}

/** 不可变的位置映射；由若干步骤顺序组成。 */
export class Mapping {
  /** 空映射。 */
  static readonly empty = new Mapping([]);

  /** 步骤（按应用顺序）。 */
  readonly steps: readonly MapStep[];

  constructor(steps: readonly MapStep[] = []) {
    this.steps = steps;
  }

  /** 是否没有任何步骤。 */
  get isEmpty(): boolean {
    return this.steps.length === 0;
  }

  /** 映射位置（`assoc` 默认 1）。 */
  map(pos: Pos, assoc: Assoc = 1): Pos {
    return this.mapResult(pos, assoc).pos;
  }

  /** 映射位置并报告是否被删除。 */
  mapResult(pos: Pos, assoc: Assoc = 1): MapResult {
    let offset = pos.offset;
    let deleted = false;
    for (const step of this.steps) {
      if (step.kind === 'blocks') {
        if (step.removed.has(pos.block)) deleted = true;
        continue;
      }
      if (step.block !== pos.block) continue;
      const r = mapOffset(offset, step, assoc);
      offset = r.offset;
      if (r.deleted) deleted = true;
    }
    return { pos: offset === pos.offset ? pos : { block: pos.block, offset }, deleted };
  }

  /** 块是否在映射中被移除（且之后没有被重新插入）。 */
  isBlockRemoved(id: BlockId): boolean {
    let removed = false;
    for (const step of this.steps) {
      if (step.kind !== 'blocks') continue;
      if (step.removed.has(id)) removed = true;
      if (step.inserted.has(id)) removed = false;
    }
    return removed;
  }

  /** 组合：先 `this` 后 `other`。 */
  append(other: Mapping): Mapping {
    if (other.isEmpty) return this;
    if (this.isEmpty) return other;
    return new Mapping([...this.steps, ...other.steps]);
  }

  /**
   * 逆映射：把事务后的位置映射回事务前。对未被删除的位置，
   * `m.invert().map(m.map(p, a), a)` 在插入点以外与 `p` 相同。
   */
  invert(): Mapping {
    const out: MapStep[] = [];
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const s = this.steps[i] as MapStep;
      out.push(
        s.kind === 'text'
          ? { kind: 'text', block: s.block, offset: s.offset, deleted: s.inserted, inserted: s.deleted }
          : { kind: 'blocks', removed: s.inserted, inserted: s.removed },
      );
    }
    return new Mapping(out);
  }

  /** 子映射 `steps[from, to)`。 */
  slice(from = 0, to = this.steps.length): Mapping {
    return new Mapping(this.steps.slice(from, to));
  }
}
