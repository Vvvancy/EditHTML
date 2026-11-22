/**
 * 轻量快照（03 §4）：每 N 次事务只记录"块 ID → 哈希"表，用于快速校验与崩溃恢复。
 *
 * 典型用法：
 * - 崩溃恢复：持久化最近的快照与之后的事务日志；重放到快照的 `version` 时用 {@link verifySnapshot}
 *   比对，不一致就说明重放出错，回退到全量重载；
 * - 调试校验：任意时刻 {@link verifySnapshot}`(doc, snapshot)` 列出自快照以来内容变化的块；
 *   `corrupt` 列出存储哈希与内容不符的块（O(文档) 重新计算，仅在校验时做）。
 *
 * @module
 */
import { computeBlockHash, type BlockId, type Doc } from '../model.js';

/** 块哈希快照。 */
export interface HashSnapshot {
  /** 拍摄时的 `doc.version`。 */
  readonly version: number;
  /** 拍摄时已经历的事务数（{@link History} 的计数）。 */
  readonly txCount: number;
  readonly root: readonly BlockId[];
  readonly hashes: ReadonlyMap<BlockId, number>;
}

/** 校验结果。 */
export interface VerifyResult {
  /** `corrupt`、`changed`、`added`、`missing` 全空且顶层顺序相同。 */
  readonly ok: boolean;
  /** 存储的 `hash` 与按内容重新计算的不一致的块（文档损坏）。 */
  readonly corrupt: readonly BlockId[];
  /** 两边都有但哈希不同的块。 */
  readonly changed: readonly BlockId[];
  /** 文档中有、快照中没有的块。 */
  readonly added: readonly BlockId[];
  /** 快照中有、文档中没有的块。 */
  readonly missing: readonly BlockId[];
  /** 顶层顺序是否与快照一致。 */
  readonly rootEqual: boolean;
}

/** 拍摄快照：O(块数)，只复制哈希（不重新计算）。 */
export function takeSnapshot(doc: Doc, txCount = 0): HashSnapshot {
  const hashes = new Map<BlockId, number>();
  for (const [id, b] of doc.blocks) hashes.set(id, b.hash);
  return { version: doc.version, txCount, root: doc.root.slice(), hashes };
}

/** 用快照校验文档（并重新计算每个块的哈希以发现损坏）。 */
export function verifySnapshot(doc: Doc, snap: HashSnapshot): VerifyResult {
  const corrupt: BlockId[] = [];
  const changed: BlockId[] = [];
  const added: BlockId[] = [];
  const missing: BlockId[] = [];
  for (const [id, b] of doc.blocks) {
    if (computeBlockHash(b) !== b.hash) corrupt.push(id);
    const h = snap.hashes.get(id);
    if (h === undefined) added.push(id);
    else if (h !== b.hash) changed.push(id);
  }
  for (const id of snap.hashes.keys()) if (!doc.blocks.has(id)) missing.push(id);
  const rootEqual = doc.root.length === snap.root.length && doc.root.every((id, i) => id === snap.root[i]);
  const ok = rootEqual && !corrupt.length && !changed.length && !added.length && !missing.length;
  return { ok, corrupt, changed, added, missing, rootEqual };
}
