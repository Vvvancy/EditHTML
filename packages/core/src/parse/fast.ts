/**
 * 解析热路径的快速构造：与 `model.ts` 中 `normalizeInline` / `computeBlockHash` **输出完全一致**，
 * 但避免其通用实现中的临时分配（10k 块文档中二者占解析时间的大半）。
 *
 * 一致性由 `fast.test.ts` 的属性测试保证；解析结果另由 `validateDoc`（会校验哈希）检查。
 * 若 `model.ts` 的哈希/规范化定义变化，这里必须同步修改（测试会立即失败）。
 *
 * @module
 */
import {
  fnv1a,
  MARK_ORDER,
  type BlockData,
  type ComponentBlock,
  type HtmlBlock,
  type InlineNode,
  type Mark,
  type MarkType,
  type TableData,
  type TextBlock,
  type TextBlockType,
} from '../model.js';

const RANK: Readonly<Record<MarkType, number>> = Object.fromEntries(MARK_ORDER.map((t, i) => [t, i])) as Record<
  MarkType,
  number
>;

/** 等价于 `stableStringify`（对象键按 UTF-16 码元序，跳过 undefined 值）。 */
export function fastStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    let s = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) s += ',';
      s += fastStringify(value[i]);
    }
    return s + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys: string[] = [];
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k) || obj[k] === undefined) continue;
    // 插入排序：键通常很少
    let i = keys.length;
    keys.push(k);
    while (i > 0 && (keys[i - 1] as string) > k) {
      keys[i] = keys[i - 1] as string;
      i--;
    }
    keys[i] = k;
  }
  let s = '{';
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i] as string;
    if (i > 0) s += ',';
    s += JSON.stringify(k) + ':' + fastStringify(obj[k]);
  }
  return s + '}';
}

/** 数组下标形式的键：JS 对象总是先按数值序枚举它们，无法靠插入顺序表达字典序。 */
function isIndexKey(k: string): boolean {
  const c = k.charCodeAt(0);
  return c >= 0x30 && c <= 0x39 && /^(?:0|[1-9]\d{0,9})$/.test(k);
}

/** 无法用"按序重建 + JSON.stringify"表达时抛出，退回 {@link fastStringify}。 */
const NOT_CANONICAL = Symbol('not-canonical');

/** 深拷贝：键按字典序插入、去掉 undefined 值，使原生 `JSON.stringify` 的输出等于 `stableStringify`。 */
function canon(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const out = new Array<unknown>(value.length);
    for (let i = 0; i < value.length; i++) {
      const v: unknown = value[i];
      out[i] = v === undefined ? null : canon(v);
    }
    return out;
  }
  const obj = value as Record<string, unknown>;
  const keys: string[] = [];
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k) || obj[k] === undefined) continue;
    if (isIndexKey(k)) throw NOT_CANONICAL;
    let i = keys.length;
    keys.push(k);
    while (i > 0 && (keys[i - 1] as string) > k) {
      keys[i] = keys[i - 1] as string;
      i--;
    }
    keys[i] = k;
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = canon(obj[k]);
  return out;
}

/** 等价于 `computeBlockHash`。 */
export function fastBlockHash(block: BlockData): number {
  let s: string;
  try {
    s = JSON.stringify(canon(block));
  } catch (e) {
    if (e !== NOT_CANONICAL) throw e;
    s = fastStringify(block);
  }
  return fnv1a(s);
}

function sameMark(a: Mark, b: Mark): boolean {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  if (a.attrs === b.attrs) return true;
  return fastStringify(a.attrs ?? {}) === fastStringify(b.attrs ?? {});
}

function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameMark(a[i] as Mark, b[i] as Mark)) return false;
  return true;
}

/** 等价于 `sortMarks`：按 MARK_ORDER 排序，同类型后出现者覆盖先出现者。 */
function sortMarksFast(marks: readonly Mark[]): Mark[] {
  if (marks.length === 0) return [];
  if (marks.length === 1) return [marks[0] as Mark];
  const slots: (Mark | undefined)[] = new Array<Mark | undefined>(MARK_ORDER.length);
  for (const m of marks) slots[RANK[m.type]] = m;
  const out: Mark[] = [];
  for (const m of slots) if (m) out.push(m);
  return out;
}

/** 等价于 `normalizeInline`。 */
export function normalizeInlineFast(content: readonly InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of content) {
    const marks = sortMarksFast(node.marks);
    if (node.t === 'text') {
      if (node.text === '') continue;
      const prev = out[out.length - 1];
      if (prev && prev.t === 'text' && sameMarks(prev.marks, marks)) {
        out[out.length - 1] = { t: 'text', text: prev.text + node.text, marks: prev.marks };
        continue;
      }
      out.push({ t: 'text', text: node.text, marks });
    } else if (node.t === 'br') {
      out.push({ t: 'br', marks });
    } else {
      out.push({ t: 'atom', kind: node.kind, attrs: { ...node.attrs }, text: node.text, marks });
    }
  }
  return out;
}

/** 与 `textBlock` 结果等价的快速构造（`content` 与表格单元格须已规范化）。 */
export function makeTextBlock(
  id: string,
  type: TextBlockType,
  content: readonly InlineNode[],
  attrs: Record<string, string>,
  table?: TableData,
): TextBlock {
  const data: BlockData<TextBlock> = table
    ? { id, kind: 'text', type, attrs, content, table }
    : { id, kind: 'text', type, attrs, content };
  return { ...data, hash: fastBlockHash(data) };
}

/** 与 `componentBlock` 结果等价的快速构造。 */
export function makeComponentBlock(
  id: string,
  type: string,
  props: unknown,
  attrs: Record<string, string>,
  slots: string[][] | undefined,
  fallback: string | undefined,
): ComponentBlock {
  const data: BlockData<ComponentBlock> = {
    id,
    kind: 'component',
    type,
    props,
    attrs,
    ...(slots ? { slots } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
  };
  return { ...data, hash: fastBlockHash(data) };
}

/** 与 `htmlBlock` 结果等价的快速构造。 */
export function makeHtmlBlock(id: string, html: string): HtmlBlock {
  const data: BlockData<HtmlBlock> = { id, kind: 'html', html };
  return { ...data, hash: fastBlockHash(data) };
}
