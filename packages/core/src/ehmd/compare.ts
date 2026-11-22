/**
 * EHMD 往返比较：EHMD 不承载降级内容（fallback，可由渲染器重建的缓存）与 `head`，
 * 比较 `Doc` 时忽略这两部分。
 *
 * @module
 */
import { getBlock, stableStringify, type BlockId, type Doc } from '../model.js';

/** 比较选项。 */
export interface EhmdCompareOptions {
  /** 是否忽略 `head`（默认 `true`）。 */
  readonly ignoreHead?: boolean;
}

/** 文档的可比较字符串：忽略 `hash`、`version`、组件的 `fallback`，默认也忽略 `head`。 */
export function ehmdComparable(doc: Doc, opts: EhmdCompareOptions = {}): string {
  const expand = (ids: readonly BlockId[]): unknown[] =>
    ids.map((id) => {
      const { hash: _h, ...rest } = getBlock(doc, id);
      if (rest.kind === 'component') {
        const { fallback: _f, ...c } = rest;
        return c.slots ? { ...c, slots: c.slots.map(expand) } : c;
      }
      return rest;
    });
  const head = opts.ignoreHead === false ? doc.head : {};
  return stableStringify({ meta: doc.meta, head, root: expand(doc.root) });
}

/** 两个文档在 EHMD 意义下是否相等（忽略 fallback，默认忽略 head）。 */
export function ehmdDocEquals(a: Doc, b: Doc, opts: EhmdCompareOptions = {}): boolean {
  return ehmdComparable(a, opts) === ehmdComparable(b, opts);
}
