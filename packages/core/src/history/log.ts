/**
 * 历史映射日志：自最旧的历史项以来、文档经历的**全部**映射步骤（记录的编辑、不进历史的事务、撤销、重做），
 * 外加"镜像"配对。
 *
 * 每个历史项记下自己的正向步骤在日志中的区间 `[stepFrom, stepTo)`。撤销该项时，它的第 k 个逆 Op
 * 处于"正向第 k 个 Op 之后"的坐标系，于是用日志 `[该 Op 的步骤之后, 末尾)` 映射它——这一段包括
 * 本项后面几个 Op（它们已被逆向应用、并以镜像步骤追加到末尾）、以及之后发生的所有事务。
 *
 * **镜像**（与 ProseMirror history 相同的思路）：撤销时追加的步骤 `t` 与被撤销的正向步骤 `s`
 * 互为逆。映射穿过删除步骤 `s` 时，原本会塌缩到删除点的位置，若 `s` 有镜像 `t` 且 `t` 在映射范围内，
 * 就直接跳到 `t` 重新插入的内容中的对应偏移（"恢复"），从而撤销 → 再改 → 撤销更早一项时，
 * 位置仍然精确，撤销的是"那段文字"。
 *
 * 索引是绝对的（单调增），前缀可被 {@link StepLog.compact} 丢弃。
 *
 * @module
 */
import { Mapping, type Assoc, type MapResult, type MapStep, type Pos } from '../tx/mapping.js';

type TextStep = Extract<MapStep, { kind: 'text' }>;

/** 可变的步骤日志。 */
export class StepLog {
  private steps: MapStep[] = [];
  private base = 0;
  private readonly mirrors = new Map<number, number>();

  /** 日志末尾的绝对索引。 */
  get end(): number {
    return this.base + this.steps.length;
  }

  /** 日志中第一个保留步骤的绝对索引。 */
  get start(): number {
    return this.base;
  }

  /** 追加步骤；返回第一个追加步骤的绝对索引。 */
  append(steps: readonly MapStep[]): number {
    const at = this.end;
    for (const s of steps) this.steps.push(s);
    return at;
  }

  /** 截断到绝对索引 `end`（回滚未完成的追加）。 */
  truncate(end: number): void {
    if (end >= this.end) return;
    this.steps.length = Math.max(0, end - this.base);
    for (const [a, b] of this.mirrors) if (a >= end || b >= end) this.mirrors.delete(a);
  }

  /** 绝对索引处的步骤。 */
  at(i: number): MapStep | undefined {
    return this.steps[i - this.base];
  }

  /**
   * 登记镜像对 `s`（被撤销的步骤）↔ `t`（撤销产生的步骤）。只接受真正互逆的一对：
   * 同块文本步骤且 `s.deleted === t.inserted && s.inserted === t.deleted`，或互逆的块步骤。
   */
  setMirror(s: number, t: number): void {
    const a = this.at(s);
    const b = this.at(t);
    if (!a || !b || a.kind !== b.kind) return;
    if (a.kind === 'text' && b.kind === 'text') {
      if (a.block !== b.block || a.deleted !== b.inserted || a.inserted !== b.deleted) return;
    }
    this.mirrors.set(s, t);
    this.mirrors.set(t, s);
  }

  /** 镜像步骤的索引。 */
  mirror(i: number): number | undefined {
    return this.mirrors.get(i);
  }

  /** 从绝对索引 `from` 到当前末尾的映射（带镜像恢复）。 */
  mappingFrom(from: number): Mapping {
    const lo = Math.max(from, this.base);
    if (lo >= this.end) return Mapping.empty;
    return new LogMapping(this, lo, this.steps.slice(lo - this.base));
  }

  /** 丢弃绝对索引 `keepFrom` 之前的步骤（不再被任何历史项引用）。 */
  compact(keepFrom: number): void {
    if (keepFrom <= this.base) return;
    const cut = Math.min(keepFrom, this.end);
    this.steps = this.steps.slice(cut - this.base);
    this.base = cut;
    for (const [a, b] of this.mirrors) if (a < cut || b < cut) this.mirrors.delete(a);
  }

  /** 清空并把起点移到当前末尾（索引保持单调）。 */
  reset(): void {
    this.compact(this.end);
  }

  /** 当前保留的步骤数（测试/诊断用）。 */
  get size(): number {
    return this.steps.length;
  }
}

/** 单个文本步骤对偏移的映射，并给出"恢复"信息（位置落在删除区间内且不在关联方向的边界上）。 */
function mapText(p: number, s: TextStep, assoc: Assoc): { offset: number; recover: number | null } {
  const start = s.offset;
  const end = start + s.deleted;
  if (p < start || (p === start && s.deleted === 0 && assoc < 0)) return { offset: p, recover: null };
  if (p > end) return { offset: p - s.deleted + s.inserted, recover: null };
  const side = s.deleted === 0 ? assoc : p === start ? -1 : p === end ? 1 : assoc;
  const offset = side < 0 ? start : start + s.inserted;
  const recover = s.deleted > 0 && p !== (assoc < 0 ? start : end) ? p - start : null;
  return { offset, recover };
}

/** 日志的一段（`Mapping` 子类，可直接交给 `mapOp`），映射时利用镜像恢复被删除又被重新插入的位置。 */
class LogMapping extends Mapping {
  constructor(
    private readonly log: StepLog,
    private readonly from: number,
    steps: readonly MapStep[],
  ) {
    super(steps);
  }

  override mapResult(pos: Pos, assoc: Assoc = 1): MapResult {
    let offset = pos.offset;
    let deleted = false;
    const steps = this.steps;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i] as MapStep;
      if (s.kind === 'blocks') {
        if (s.removed.has(pos.block)) deleted = true;
        continue;
      }
      if (s.block !== pos.block) continue;
      const r = mapText(offset, s, assoc);
      if (r.recover !== null) {
        const m = this.log.mirror(this.from + i);
        const j = m === undefined ? -1 : m - this.from;
        if (j > i && j < steps.length) {
          offset = (steps[j] as TextStep).offset + r.recover;
          i = j;
          continue;
        }
        if (r.recover > 0 && r.recover < s.deleted) deleted = true;
      }
      offset = r.offset;
    }
    return { pos: offset === pos.offset ? pos : { block: pos.block, offset }, deleted };
  }
}
