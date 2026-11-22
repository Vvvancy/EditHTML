/**
 * 通用撤销/重做栈（03 §4"历史上限按操作数和内存双阈值裁剪"）。
 *
 * 与具体的变更类型无关：块模型的 {@link History} 用它存放 Op 事务，
 * 保真模式的补丁层（T2.6）可以用同一个栈存放字节区间补丁。栈只负责：
 *
 * - 两个栈（undo / redo）的进出；新编辑（{@link UndoStack.push}）清空 redo 栈；
 * - 栈顶替换（输入合并：{@link UndoStack.replaceTop}）；
 * - 按条目数与近似字节数（条目的 `size` 之和，undo + redo 两个栈一起计）裁剪，**丢弃最旧的**
 *   （先丢 undo 栈底；undo 栈空后再丢 redo 栈底——它是最后才会被重做的一项，丢掉它不影响其余项的重做顺序）。
 *
 * 栈本身不做撤销——如何把条目应用到文档（映射、重定位）由使用方决定。
 *
 * @module
 */

/** 栈条目的最小约束：近似内存占用（字节，估算即可）。 */
export interface StackEntry {
  readonly size: number;
}

/** 历史上限。 */
export interface StackLimits {
  /** 两个栈合计的最大条目数（≥ 1）。 */
  readonly maxItems: number;
  /** 两个栈合计的最大近似字节数。最新的一项即使单独超限也会保留。 */
  readonly maxBytes: number;
}

/** 默认上限：500 项 / 16 MiB。 */
export const DEFAULT_STACK_LIMITS: StackLimits = { maxItems: 500, maxBytes: 16 * 1024 * 1024 };

/**
 * 通用 undo/redo 栈（可变的小类）。`E` 是条目类型。
 *
 * @typeParam E - 条目类型，须提供 `size`。
 */
export class UndoStack<E extends StackEntry> {
  private readonly done: E[] = [];
  private readonly undone: E[] = [];
  private total = 0;
  private readonly limits: StackLimits;
  private readonly onDrop: ((entry: E) => void) | undefined;

  /**
   * @param limits - 上限（缺省字段取 {@link DEFAULT_STACK_LIMITS}）。
   * @param onDrop - 条目因裁剪或清空 redo 栈而被丢弃时回调（用于释放使用方的附属数据）。
   */
  constructor(limits: Partial<StackLimits> = {}, onDrop?: (entry: E) => void) {
    this.limits = { ...DEFAULT_STACK_LIMITS, ...limits };
    if (!(this.limits.maxItems >= 1)) throw new RangeError('maxItems must be >= 1');
    this.onDrop = onDrop;
  }

  /** undo 栈深度。 */
  get undoDepth(): number {
    return this.done.length;
  }

  /** redo 栈深度。 */
  get redoDepth(): number {
    return this.undone.length;
  }

  /** 两个栈合计的近似字节数。 */
  get bytes(): number {
    return this.total;
  }

  /** undo 栈顶（不弹出）。 */
  peekUndo(): E | undefined {
    return this.done[this.done.length - 1];
  }

  /** redo 栈顶（不弹出）。 */
  peekRedo(): E | undefined {
    return this.undone[this.undone.length - 1];
  }

  /** 全部条目（undo 栈底 → 栈顶，然后 redo 栈底 → 栈顶）。 */
  *entries(): IterableIterator<E> {
    yield* this.done;
    yield* this.undone;
  }

  /** 记录一次**新**编辑：压入 undo 栈并清空 redo 栈，然后裁剪。 */
  push(entry: E): void {
    for (const e of this.undone.splice(0)) this.discard(e);
    this.add(this.done, entry);
  }

  /** 用 `entry` 替换 undo 栈顶（输入合并）。undo 栈为空时等价于 {@link push}。不清空 redo 栈。 */
  replaceTop(entry: E): void {
    const top = this.done.pop();
    if (top === undefined) return this.push(entry);
    this.total -= top.size;
    this.add(this.done, entry);
  }

  /** 弹出 undo 栈顶（撤销）。调用方应在应用后把产生的逆条目 {@link pushRedo}。 */
  popUndo(): E | undefined {
    return this.take(this.done);
  }

  /** 弹出 redo 栈顶（重做）。调用方应在应用后把产生的条目 {@link pushUndo}。 */
  popRedo(): E | undefined {
    return this.take(this.undone);
  }

  /** 撤销产生的条目压入 redo 栈。 */
  pushRedo(entry: E): void {
    this.add(this.undone, entry);
  }

  /** 重做产生的条目压回 undo 栈（**不**清空 redo 栈）。 */
  pushUndo(entry: E): void {
    this.add(this.done, entry);
  }

  /** 清空两个栈（每个条目回调 `onDrop`）。 */
  clear(): void {
    for (const e of [...this.done.splice(0), ...this.undone.splice(0)]) this.discard(e);
  }

  private take(stack: E[]): E | undefined {
    const e = stack.pop();
    if (e !== undefined) this.total -= e.size;
    return e;
  }

  private add(stack: E[], entry: E): void {
    stack.push(entry);
    this.total += entry.size;
    this.trim(entry);
  }

  private discard(e: E): void {
    this.total -= e.size;
    this.onDrop?.(e);
  }

  /** 丢弃最旧的条目直到满足上限；`keep`（刚加入的一项）永不丢弃。 */
  private trim(keep: E): void {
    const { maxItems, maxBytes } = this.limits;
    while (this.done.length + this.undone.length > maxItems || this.total > maxBytes) {
      const stack = this.done.length > 0 && this.done[0] !== keep ? this.done : this.undone;
      if (stack.length === 0 || stack[0] === keep) break;
      this.discard(stack.shift() as E);
    }
  }
}
