/**
 * 保真模式的撤销重做（T2.6，docs/03-algorithms.md §4）：在补丁层之下记录**可逆的 DOM 操作**。
 *
 * ## 为什么记录 DOM 操作而不是补丁
 *
 * 补丁层（T2.4）的状态是「当前 DOM 相对原文的差异」：{@link PreserveSession.patches} 每次都由 DOM 现算。
 * 所以只要把 DOM 还原，补丁与 `save()` 自然随之还原。难点在于还原 DOM 时必须**保留原来的节点对象**——
 * 挂载层用 `WeakMap<Node, SpanNode>` 把节点与原文区间配对，若撤销时重新创建节点，配对就丢了，
 * 之后的保存会把整段重写（撤销到底也得不到 `patches() = []`）。
 *
 * 因此一条历史项存的是一串**变动操作**，由挂载层转发的用户编辑 `MutationRecord` 翻译而来：
 * - `text`：某个文本/注释节点的 `data` 从 `old` 变成 `new`；
 * - `attr`：某元素某属性从 `old` 变成 `new`（`null` 表示不存在）；
 * - `child`：某父节点在 `prev`/`next` 之间移除了 `removed`、插入了 `added`（存的都是**节点对象本身**）。
 *
 * 撤销 = 倒序逆放（文本/属性写回旧值；子节点移除 `added`、把原来的 `removed` 节点插回 `next` 之前），
 * 重做 = 正序重放。因为倒序逆放时每一步之前的 DOM 恰好是该记录发生后的状态，`next` 一定还在原位，
 * 插回的就是原来那些节点，配对原封不动；撤销到底时 DOM 与打开时逐节点相同，补丁为空、`save() === source`。
 *
 * 撤销/重做自己造成的变动包在 {@link PreserveMount.userEdit} 里（挂载层不会把它们当成脚本改动标灰），
 * 且在回放期间收到的记录一律丢弃，不会成为新的历史项。回放后把受影响的元素记为已改动（`touch`），
 * 让补丁层重新比较它们。
 *
 * ## 输入合并（复用 T1.5）
 *
 * 一批用户变动（挂载层一次转发，通常对应一次 `input` 事件或一次 `userEdit` 命令）若只改了**同一个文本节点**，
 * 且新旧值之差是一段纯插入或纯删除，就把它描述为 core 的 {@link TextEdit}（`target` = 文本节点的会话内编号），
 * 用 core 的 {@link extendGroup} 判定能否并入栈顶的输入组（500ms 窗口、位置衔接、遇空白/标点断开）。
 * 可以合并时用 {@link UndoStack.replaceTop} 把新操作追加到栈顶项。其余批次（结构改动、富文本命令、属性、
 * 替换选区）都单独成为一项，并断开输入组。
 *
 * 输入法组合（`compositionstart` → `compositionend`）期间的所有批次并入同一项，组合结束后断开。
 * 工具栏等命令应在执行前后调用 {@link PreserveHistory.checkpoint}（或把整个命令放进一次 `userEdit`，
 * 一次 `userEdit` 只转发一批，天然就是一步）。
 *
 * 栈本身用 core 的通用 {@link UndoStack}（条目数 + 近似字节双阈值裁剪，新编辑清空 redo 分支）。
 *
 * ## 限制
 *
 * - 只记录挂载层判定为用户编辑的变动。若脚本在两次用户编辑之间改了同一片 DOM，回放时参照节点可能已不在原位，
 *   此时退化为在父节点末尾插入（不抛异常），结果未必与原状一致；
 * - 不拦截浏览器原生的撤销（`Ctrl/Cmd+Z` 触发的 `historyUndo`）：宿主（T2.7 打开器）应在 `keydown` 中
 *   `preventDefault` 并调用 {@link PreserveHistory.undo} / {@link PreserveHistory.redo}；
 * - happy-dom 把空串旧值报告为 `null`：属性旧值为 `null` 时，先查本会话见过的最后值，再查原文中的属性值。
 *
 * @module
 */
import {
  UndoStack,
  extendGroup,
  startGroup,
  type GroupOptions,
  type InputGroup,
  type StackLimits,
  type TextEdit,
} from '@edithtml/core';
import type { PreserveMount } from './mount.js';

/** 文本/注释节点的 `data` 变化。 */
interface TextOp {
  readonly type: 'text';
  readonly node: CharacterData;
  readonly old: string;
  readonly new: string;
}

/** 属性变化（`null` = 不存在）。 */
interface AttrOp {
  readonly type: 'attr';
  readonly el: Element;
  readonly ns: string | null;
  /** 限定名（含前缀），写回时用。 */
  readonly name: string;
  readonly old: string | null;
  readonly new: string | null;
}

/** 子节点变化：在 `prev` 与 `next` 之间移除 `removed`、插入 `added`。 */
interface ChildOp {
  readonly type: 'child';
  readonly parent: Node;
  readonly added: readonly Node[];
  readonly removed: readonly Node[];
  readonly next: Node | null;
}

/** 一个可逆的 DOM 操作。 */
export type DomOp = TextOp | AttrOp | ChildOp;

/** 一条历史项。 */
interface Entry {
  readonly ops: readonly DomOp[];
  readonly size: number;
  /** 栈顶输入组的合并状态；`null` 表示这一项不接受合并。 */
  readonly group: InputGroup | null;
  /** 输入法组合期间开启的项（组合结束前的批次都并入它）。 */
  readonly composition: boolean;
}

/** {@link createPreserveHistory} 的选项。 */
export interface PreserveHistoryOptions extends GroupOptions {
  /** 历史上限（缺省为 core 的 `DEFAULT_STACK_LIMITS`）。 */
  readonly limits?: Partial<StackLimits>;
  /** 时钟（毫秒），测试可注入；默认 `Date.now`。 */
  readonly now?: () => number;
  /** 历史变化（新增/合并/撤销/重做/清空）后回调，便于刷新工具栏按钮状态。 */
  readonly onChange?: () => void;
}

/** 历史层依赖的会话部件。 */
export interface PreserveHistoryHost {
  readonly doc: Document;
  readonly mount: PreserveMount;
  /** 把节点所在元素记为已改动（补丁层据此重新比较）。 */
  readonly touch: (node: Node) => void;
  /** 原文中该元素该属性的（解码后）值；不存在或元素未配对时返回 `null`。 */
  readonly originalAttr?: (el: Element, name: string) => string | null;
}

/** 保真会话的撤销重做。 */
export interface PreserveHistory {
  /** 记录一批用户变动（由挂载层的 `onUserMutations` 调用）。回放期间的记录会被忽略。 */
  record(records: readonly MutationRecord[]): void;
  /** 撤销一步；没有可撤销的返回 `false`。 */
  undo(): boolean;
  /** 重做一步；没有可重做的返回 `false`。 */
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** 断开输入组：之后的编辑一定开始新的一步（工具栏命令前后调用）。 */
  checkpoint(): void;
  /** 清空历史。 */
  clear(): void;
  readonly undoDepth: number;
  readonly redoDepth: number;
  /** 移除事件监听。 */
  dispose(): void;
}

const opSize = (op: DomOp): number =>
  64 +
  (op.type === 'text'
    ? 2 * (op.old.length + op.new.length)
    : op.type === 'attr'
      ? 2 * ((op.old?.length ?? 0) + (op.new?.length ?? 0) + op.name.length)
      : 16 * (op.added.length + op.removed.length));

/** 把同一个父节点中的 `ref` 作为插入参照；它已不在该父节点中时退化为末尾。 */
const refIn = (parent: Node, ref: Node | null): Node | null => (ref && ref.parentNode === parent ? ref : null);

function apply(op: DomOp, forward: boolean): void {
  switch (op.type) {
    case 'text':
      op.node.data = forward ? op.new : op.old;
      return;
    case 'attr': {
      const v = forward ? op.new : op.old;
      if (v === null) {
        if (op.ns === null) op.el.removeAttribute(op.name);
        else op.el.removeAttributeNS(op.ns, op.name.slice(op.name.indexOf(':') + 1));
      } else if (op.ns === null) op.el.setAttribute(op.name, v);
      else op.el.setAttributeNS(op.ns, op.name, v);
      return;
    }
    case 'child': {
      const out = forward ? op.removed : op.added;
      const into = forward ? op.added : op.removed;
      for (const n of out) if (n.parentNode === op.parent) op.parent.removeChild(n);
      const ref = refIn(op.parent, op.next);
      for (const n of into) op.parent.insertBefore(n, ref);
      return;
    }
  }
}

/** 受影响、需要重新比较的节点。 */
const targetOf = (op: DomOp): Node => (op.type === 'text' ? op.node : op.type === 'attr' ? op.el : op.parent);

/** 新旧文本之差若是纯插入或纯删除，返回对应的 {@link TextEdit}。 */
function diffText(target: string, before: string, after: string): TextEdit | null {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let q = 0;
  while (q < max - p && before.charCodeAt(before.length - 1 - q) === after.charCodeAt(after.length - 1 - q)) q++;
  const del = before.slice(p, before.length - q);
  const ins = after.slice(p, after.length - q);
  if (del && !ins) return { kind: 'delete', target, from: p, to: p + del.length, text: del };
  if (ins && !del) return { kind: 'insert', target, from: p, to: p + ins.length, text: ins };
  return null;
}

/**
 * 为保真会话建立撤销重做。通常不直接调用：{@link openPreserve} 会建立并接好挂载层的转发，
 * 通过 `session.history` / `session.undo()` 使用。
 */
export function createPreserveHistory(
  host: PreserveHistoryHost,
  options: PreserveHistoryOptions = {},
): PreserveHistory {
  const { doc, mount, touch } = host;
  const now = options.now ?? Date.now;
  const stack = new UndoStack<Entry>(options.limits);
  /** 本会话见过的属性最后值（补 happy-dom 空串旧值报告为 `null` 的缺陷）。 */
  const lastAttr = new WeakMap<Element, Map<string, string | null>>();
  /** 文本节点的会话内编号（输入合并的 `target`）。 */
  const ids = new WeakMap<Node, string>();
  let nextId = 0;
  const idOf = (n: Node): string => {
    let id = ids.get(n);
    if (id === undefined) ids.set(n, (id = `t${nextId++}`));
    return id;
  };
  let replaying = false;
  let composing = false;
  /** 下一批是否必须开新项。 */
  let broken = true;

  const changed = (): void => options.onChange?.();

  const attrKey = (ns: string | null, local: string): string => `${ns ?? ''}|${local}`;
  const readAttr = (el: Element, ns: string | null, local: string): string | null =>
    ns === null ? el.getAttribute(local) : el.getAttributeNS(ns, local);

  /** 把一批记录翻译成操作；每个操作的「新值」取同一目标下一条记录的旧值，最后一条取当前值。 */
  const translate = (records: readonly MutationRecord[]): DomOp[] => {
    const ops: DomOp[] = [];
    const afterText = new Map<Node, string>();
    const afterAttr = new Map<Node, Map<string, string | null>>();
    /** 每个父节点「该记录发生后」的子节点序列（从当前 DOM 倒推）。 */
    const kids = new Map<Node, Node[]>();
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i] as MutationRecord;
      if (r.type === 'characterData') {
        const node = r.target as CharacterData;
        const nv = afterText.get(node) ?? node.data;
        const ov = r.oldValue ?? '';
        afterText.set(node, ov);
        ops.push({ type: 'text', node, old: ov, new: nv });
      } else if (r.type === 'attributes') {
        const el = r.target as Element;
        const local = r.attributeName ?? '';
        const ns = r.attributeNamespace;
        const key = attrKey(ns, local);
        let m = afterAttr.get(el);
        if (!m) afterAttr.set(el, (m = new Map()));
        const nv = m.has(key) ? (m.get(key) ?? null) : readAttr(el, ns, local);
        const seen = lastAttr.get(el);
        const ov =
          r.oldValue ??
          (seen?.has(key) ? (seen.get(key) ?? null) : ns === null ? (host.originalAttr?.(el, local) ?? null) : null);
        m.set(key, ov);
        const name = ns === null ? local : (el.getAttributeNodeNS(ns, local)?.name ?? local);
        ops.push({ type: 'attr', el, ns, name, old: ov, new: nv });
      } else {
        // 插入位置不直接用 r.nextSibling：happy-dom 的插入记录不带兄弟信息，且同一批里后续记录可能已挪动它。
        // 改为在倒推的子节点序列里取最后一个插入节点之后的那个。
        const parent = r.target;
        const added = Array.from(r.addedNodes);
        const removed = Array.from(r.removedNodes);
        let list = kids.get(parent);
        if (!list) kids.set(parent, (list = Array.from(parent.childNodes)));
        let next = r.nextSibling;
        const last = added[added.length - 1];
        if (last) {
          const at = list.indexOf(last);
          if (at >= 0) next = list[at + 1] ?? null;
        }
        const gone = new Set(added);
        list = list.filter((n) => !gone.has(n));
        const at = next ? list.indexOf(next) : -1;
        list.splice(at >= 0 ? at : list.length, 0, ...removed);
        kids.set(parent, list);
        ops.push({ type: 'child', parent, added, removed, next });
      }
    }
    ops.reverse();
    for (const op of ops)
      if (op.type === 'attr') {
        let m = lastAttr.get(op.el);
        if (!m) lastAttr.set(op.el, (m = new Map()));
        m.set(attrKey(op.ns, op.name.slice(op.name.indexOf(':') + 1)), op.new);
      }
    return ops;
  };

  /** 一批操作若只改了同一个文本节点，返回合并用的 {@link TextEdit}。 */
  const asTextEdit = (ops: readonly DomOp[]): TextEdit | null => {
    const first = ops[0];
    if (first?.type !== 'text') return null;
    if (!ops.every((o) => o.type === 'text' && o.node === first.node)) return null;
    const last = ops[ops.length - 1] as TextOp;
    return diffText(idOf(first.node), first.old, last.new);
  };

  const sizeOf = (ops: readonly DomOp[]): number => ops.reduce((s, o) => s + opSize(o), 0);

  const record = (records: readonly MutationRecord[]): void => {
    if (replaying || records.length === 0) return;
    const ops = translate(records);
    if (ops.length === 0) return;
    const t = now();
    const top = stack.peekUndo();
    const edit = asTextEdit(ops);
    if (top && !broken && composing && top.composition) {
      const all = [...top.ops, ...ops];
      stack.replaceTop({ ops: all, size: sizeOf(all), group: null, composition: true });
    } else {
      const merged = top && !broken && top.group && edit ? extendGroup(top.group, edit, t, options) : null;
      if (top && merged) {
        const all = [...top.ops, ...ops];
        stack.replaceTop({ ops: all, size: sizeOf(all), group: merged, composition: false });
      } else {
        stack.push({
          ops,
          size: sizeOf(ops),
          group: edit && !composing ? startGroup(edit, t) : null,
          composition: composing,
        });
      }
    }
    broken = false;
    changed();
  };

  const replay = (entry: Entry, forward: boolean): void => {
    replaying = true;
    try {
      mount.userEdit(() => {
        if (forward) for (const op of entry.ops) apply(op, true);
        else for (let i = entry.ops.length - 1; i >= 0; i--) apply(entry.ops[i] as DomOp, false);
      });
    } finally {
      replaying = false;
    }
    for (const op of entry.ops) {
      if (op.type === 'attr')
        lastAttr.get(op.el)?.set(attrKey(op.ns, op.name.slice(op.name.indexOf(':') + 1)), forward ? op.new : op.old);
      touch(targetOf(op));
    }
    broken = true;
  };

  const onCompositionStart = (): void => {
    composing = true;
    broken = true;
  };
  const onCompositionEnd = (): void => {
    composing = false;
    broken = true;
  };
  // 挂载层先注册（同为捕获阶段），它在 compositionend 中先 flush，此时这里仍处于组合状态。
  doc.addEventListener('compositionstart', onCompositionStart, true);
  doc.addEventListener('compositionend', onCompositionEnd, true);

  return {
    record,
    undo() {
      mount.flush(); // 先把尚未派发的用户输入记下来
      const e = stack.popUndo();
      if (!e) return false;
      replay(e, false);
      stack.pushRedo(e);
      changed();
      return true;
    },
    redo() {
      mount.flush();
      const e = stack.popRedo();
      if (!e) return false;
      replay(e, true);
      stack.pushUndo(e);
      changed();
      return true;
    },
    canUndo: () => stack.undoDepth > 0,
    canRedo: () => stack.redoDepth > 0,
    checkpoint() {
      mount.flush();
      broken = true;
    },
    clear() {
      stack.clear();
      broken = true;
      changed();
    },
    get undoDepth() {
      return stack.undoDepth;
    },
    get redoDepth() {
      return stack.redoDepth;
    },
    dispose() {
      doc.removeEventListener('compositionstart', onCompositionStart, true);
      doc.removeEventListener('compositionend', onCompositionEnd, true);
    },
  };
}
