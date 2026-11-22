/**
 * 逆操作与 Op 映射。
 *
 * `invert` 只依赖**已解析**的 Op（`apply` 返回的 `applied`，捕获字段已填好），不需要文档。
 * 对 `apply(d, ops)` 得到的 `{doc, applied}`，有 `docEquals(apply(doc, invertOps(applied)).doc, d)`，
 * 且块哈希、props 键顺序都复原。
 *
 * @module
 */
import { inlineLength } from '../model.js';
import { fail } from './errors.js';
import type { Mapping } from './mapping.js';
import type { Op, Transaction } from './ops.js';

function need<T>(v: T | undefined, op: Op, field: string): T {
  if (v === undefined) fail('notResolved', `${op.t}.${field} missing: invert requires an op returned by apply()`);
  return v;
}

/**
 * 单个已解析 Op 的逆操作（可能是多个 Op，如 `setMark` 按分段恢复；无变化时为空数组）。
 * 逆操作的位置处于**该 Op 应用之后**的文档中。
 */
export function invert(op: Op): Op[] {
  switch (op.t) {
    case 'insertText':
      return op.text ? [{ t: 'deleteText', block: op.block, from: op.offset, to: op.offset + op.text.length }] : [];
    case 'insertContent': {
      const n = inlineLength(op.content);
      return n ? [{ t: 'deleteText', block: op.block, from: op.offset, to: op.offset + n }] : [];
    }
    case 'deleteText': {
      const deleted = need(op.deleted, op, 'deleted');
      return deleted.length ? [{ t: 'insertContent', block: op.block, offset: op.from, content: deleted }] : [];
    }
    case 'setMark':
      return need(op.prev, op, 'prev').map((s) =>
        s.mark
          ? { t: 'setMark', block: op.block, from: s.from, to: s.to, mark: s.mark, value: true }
          : { t: 'setMark', block: op.block, from: s.from, to: s.to, mark: op.mark, value: false },
      );
    case 'insertBlock':
      return [{ t: 'removeBlock', id: op.block.id }];
    case 'removeBlock': {
      const r = need(op.removed, op, 'removed');
      return [
        {
          t: 'insertBlock',
          parent: r.parent,
          slot: r.slot,
          index: r.index,
          block: r.block,
          descendants: r.descendants,
        },
      ];
    }
    case 'moveBlock': {
      const f = need(op.from, op, 'from');
      return [{ t: 'moveBlock', id: op.id, parent: f.parent, slot: f.slot, index: f.index }];
    }
    case 'setType':
      return [{ t: 'setType', id: op.id, type: need(op.prev, op, 'prev') }];
    case 'setProps':
      return [{ t: 'setProps', id: op.id, patch: need(op.inverse, op, 'inverse') }];
    case 'setAttrs':
      return [{ t: 'setAttrs', id: op.id, attrs: need(op.prev, op, 'prev') }];
    case 'setTable':
      return [{ t: 'setTable', id: op.id, table: need(op.prev, op, 'prev') }];
    case 'setCell':
      return [
        { t: 'setCell', id: op.id, section: op.section, row: op.row, col: op.col, content: need(op.prev, op, 'prev') },
      ];
    case 'setFallback':
      return [{ t: 'setFallback', id: op.id, fallback: need(op.prev, op, 'prev') }];
    case 'setHtml':
      return [{ t: 'setHtml', id: op.id, html: need(op.prev, op, 'prev') }];
    case 'insertSlot':
      return [{ t: 'removeSlot', id: op.id, slot: op.slot, unset: need(op.created, op, 'created') }];
    case 'removeSlot':
      return [{ t: 'insertSlot', id: op.id, slot: op.slot }];
    case 'setMeta':
      return [{ t: 'setMeta', patch: need(op.inverse, op, 'inverse') }];
    case 'setHead':
      return [{ t: 'setHead', head: need(op.prev, op, 'prev') }];
    default: {
      const never: never = op;
      return fail('invalid', `unknown op ${(never as { t?: unknown }).t as string}`);
    }
  }
}

/** 已解析 Op 序列的逆：逆序取各 Op 的逆。作用于事务**之后**的文档。 */
export function invertOps(ops: readonly Op[]): Op[] {
  const out: Op[] = [];
  for (let i = ops.length - 1; i >= 0; i--) out.push(...invert(ops[i] as Op));
  return out;
}

/** 已解析事务（如 `TxResult.tx`）的逆事务（保留 `meta`）。 */
export function invertTransaction(tx: Transaction): Transaction {
  const ops = invertOps(tx.ops);
  return tx.meta ? { ops, meta: tx.meta } : { ops };
}

/**
 * 把 Op 的位置经 `mapping` 变换（用于撤销时越过之后发生的变更）。
 * 目标块已被删除时返回 `null`。
 *
 * 规则：插入点用 `assoc = 1`；范围 `[from, to)` 的 `from` 用 `1`、`to` 用 `-1`（不吞并边界处后来插入的内容），
 * 收缩为空时 `to = from`。块下标（`insertBlock` / `moveBlock` 的 `index`）**不被映射**，
 * 调用方需自行处理越界（例如夹到序列长度）。捕获字段原样保留——`apply` 会重新计算。
 */
export function mapOp(op: Op, mapping: Mapping): Op | null {
  if (mapping.isEmpty) return op;
  const gone = (id: string | null): boolean => id !== null && mapping.isBlockRemoved(id);
  switch (op.t) {
    case 'insertText':
    case 'insertContent': {
      if (gone(op.block)) return null;
      const offset = mapping.map({ block: op.block, offset: op.offset }, 1).offset;
      return offset === op.offset ? op : { ...op, offset };
    }
    case 'deleteText':
    case 'setMark': {
      if (gone(op.block)) return null;
      const from = mapping.map({ block: op.block, offset: op.from }, 1).offset;
      const to = Math.max(from, mapping.map({ block: op.block, offset: op.to }, -1).offset);
      return from === op.from && to === op.to ? op : { ...op, from, to };
    }
    case 'insertBlock':
      return gone(op.parent) ? null : op;
    case 'moveBlock':
      return gone(op.id) || gone(op.parent) ? null : op;
    case 'setMeta':
    case 'setHead':
      return op;
    default:
      return gone(op.id) ? null : op;
  }
}
