/**
 * 块 ID 分配（01 §3.1）：base36 短 ID，文档内唯一，一旦分配不再改变。
 *
 * @module
 */
import type { BlockId, Doc } from './model.js';

/** 合法块 ID：小写字母开头，后接小写字母/数字，长度 1–16。 */
export const BLOCK_ID_RE = /^[a-z][a-z0-9]{0,15}$/;

/** 是否为合法块 ID。 */
export function isValidBlockId(id: string): id is BlockId {
  return BLOCK_ID_RE.test(id);
}

/** ID 分配器。 */
export interface IdGenerator {
  /** 分配一个新的、未被占用的 ID，并标记为已占用。 */
  next(): BlockId;
  /** 把一个已有 ID 标记为已占用（解析时遇到的 ID）。返回 false 表示该 ID 已被占用（重复）。 */
  reserve(id: BlockId): boolean;
  /** 是否已占用。 */
  has(id: BlockId): boolean;
}

/**
 * 创建 ID 分配器。新 ID 形如 `b1`、`b2`… `b{base36 计数}`，跳过已占用的 ID。
 * 结果是确定性的：相同的已占用集合与调用顺序得到相同的 ID。
 */
export function createIdGenerator(existing: Iterable<BlockId> = [], prefix = 'b'): IdGenerator {
  const used = new Set<BlockId>(existing);
  let counter = 0;
  return {
    next() {
      let id: BlockId;
      do id = prefix + (++counter).toString(36);
      while (used.has(id));
      used.add(id);
      return id;
    },
    reserve(id) {
      if (used.has(id)) return false;
      used.add(id);
      return true;
    },
    has: (id) => used.has(id),
  };
}

/** 以文档中所有已存在 ID 初始化的分配器。 */
export function idGeneratorFor(doc: Doc): IdGenerator {
  return createIdGenerator(doc.blocks.keys());
}
