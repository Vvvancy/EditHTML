/**
 * 块级规范输出（01 §6.1「文本块」「列表」「组件块」「HTML 块」）。
 *
 * 输出单位是**段（segment）**：一个块序列（`doc.root` 或某个槽位）被切分为若干段，
 * 每段要么是一个非 `li` 块，要么是一组连续的 `li` 块（列表组）。一个块序列的输出
 * 恰好等于其各段输出的拼接，且每段输出只依赖该段内的块（及容器块的后代），
 * 这使得按段缓存（T3.6 增量序列化）天然正确。
 *
 * 所有函数返回若干完整的行：每行以 `depth * 2` 个空格开头、以 `\n` 结尾
 * （代码块、fallback、HTML 块等内容中的换行原样保留，不额外缩进）。
 *
 * @module
 */
import {
  getBlock,
  type Block,
  type BlockId,
  type ComponentBlock,
  type Doc,
  type InlineNode,
  type TextBlock,
} from '../model.js';
import { embedJson, escapeAttr, escapeText, serializeAttrs } from './escape.js';
import { serializeInline } from './inline.js';

const INDENTS: string[] = [];

/** `depth` 层缩进（每层 2 空格）。 */
export function indent(depth: number): string {
  return (INDENTS[depth] ??= '  '.repeat(depth));
}

/** 顶层块在文件中的缩进层数（`<main id="eh-doc">` 内，6 个空格）。 */
export const TOP_LEVEL_DEPTH = 3;

/** 块序列中的一段：单个非列表块，或一组连续的 `li` 块（列表组）。 */
export type Segment =
  { readonly kind: 'block'; readonly id: BlockId } | { readonly kind: 'list'; readonly ids: readonly BlockId[] };

function isListItem(b: Block): b is TextBlock {
  return b.kind === 'text' && b.type === 'li';
}

/**
 * 把一个块序列（`doc.root` 或某个槽位的 ID 列表）切分为段。
 * 列表组 = 极大的连续 `li` 块串；其余每个块单独成段。O(ids.length)，不做序列化。
 */
export function segmentBlocks(doc: Doc, ids: readonly BlockId[]): Segment[] {
  const out: Segment[] = [];
  let run: BlockId[] | null = null;
  for (const id of ids) {
    if (isListItem(getBlock(doc, id))) {
      if (run) run.push(id);
      else out.push({ kind: 'list', ids: (run = [id]) });
    } else {
      run = null;
      out.push({ kind: 'block', id });
    }
  }
  return out;
}

/** 序列化一段（见 {@link segmentBlocks}）。 */
export function serializeSegment(doc: Doc, segment: Segment, depth: number): string {
  return segment.kind === 'list'
    ? serializeListGroup(doc, segment.ids, depth)
    : serializeBlockAt(doc, getBlock(doc, segment.id), depth);
}

/**
 * 序列化一个块序列：各段输出的拼接。
 * 等价于 `segmentBlocks(doc, ids).map((s) => serializeSegment(doc, s, depth)).join('')`。
 */
export function serializeSequence(doc: Doc, ids: readonly BlockId[], depth: number): string {
  let out = '';
  for (const s of segmentBlocks(doc, ids)) out += serializeSegment(doc, s, depth);
  return out;
}

/**
 * 序列化单个块在缩进 `depth` 处的规范行（容器块包含其全部后代）。
 *
 * `li` 块单独调用时按**只含它一项的列表组**输出（`indent` 视为 0）；在文档中，
 * 连续的 `li` 必须作为一组用 {@link serializeListGroup} 输出——整篇序列化按段进行，见 {@link segmentBlocks}。
 *
 * @throws 块不存在时。
 */
export function serializeBlock(doc: Doc, id: BlockId, depth: number): string {
  return serializeBlockAt(doc, getBlock(doc, id), depth);
}

function serializeBlockAt(doc: Doc, b: Block, depth: number): string {
  if (b.kind === 'text') {
    return b.type === 'li' ? serializeListGroup(doc, [b.id], depth) : serializeTextBlock(b, depth);
  }
  if (b.kind === 'component') return serializeComponent(doc, b, depth);
  return `${indent(depth)}<eh-html data-eh="${escapeAttr(b.id)}">${b.html}</eh-html>\n`;
}

/** 从 `attrs` 中去掉已被映射为专门输出的键。 */
function without(attrs: Readonly<Record<string, string>>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(attrs)) if (!keys.includes(k)) out[k] = attrs[k] as string;
  return out;
}

const NO_KEYS: readonly string[] = [];
const CODE_KEYS: readonly string[] = ['lang', 'data-lang'];
const FIGURE_KEYS: readonly string[] = ['src', 'alt'];
const LI_KEYS: readonly string[] = ['list', 'indent', 'task', 'data-eh-task'];

function plainAttrs(b: TextBlock, keys: readonly string[]): string {
  const a = keys.length === 0 || Object.keys(b.attrs).length === 0 ? b.attrs : without(b.attrs, keys);
  return serializeAttrs(b.id, a);
}

function serializeTextBlock(b: TextBlock, depth: number): string {
  const ind = indent(depth);
  switch (b.type) {
    case 'p':
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `${ind}<${b.type}${plainAttrs(b, NO_KEYS)}>${serializeInline(b.content)}</${b.type}>\n`;
    case 'quote':
      return `${ind}<blockquote${plainAttrs(b, NO_KEYS)}>${serializeInline(b.content)}</blockquote>\n`;
    case 'hr':
      return `${ind}<hr${plainAttrs(b, NO_KEYS)}>\n`;
    case 'code': {
      const attrs = without(b.attrs, CODE_KEYS);
      if (b.attrs.lang !== undefined) attrs['data-lang'] = b.attrs.lang;
      let code = '';
      for (const n of b.content) code += n.t === 'br' ? '\n' : n.text;
      return `${ind}<pre${serializeAttrs(b.id, attrs)}><code>${escapeText(code)}</code></pre>\n`;
    }
    case 'figure': {
      const { src, alt } = b.attrs;
      const img = `<img${alt !== undefined ? ` alt="${escapeAttr(alt)}"` : ''}${
        src !== undefined ? ` src="${escapeAttr(src)}"` : ''
      }>`;
      const cap = b.content.length > 0 ? `<figcaption>${serializeInline(b.content)}</figcaption>` : '';
      return `${ind}<figure${plainAttrs(b, FIGURE_KEYS)}>${img}${cap}</figure>\n`;
    }
    case 'table':
      return serializeTable(b, depth);
    case 'li':
      throw new Error('li blocks are serialized as list groups');
    default: {
      const never: never = b.type;
      throw new Error(`unknown text block type: ${String(never)}`);
    }
  }
}

function serializeTable(b: TextBlock, depth: number): string {
  const head = b.table?.head ?? [];
  const body = b.table?.body ?? [];
  const align = b.table?.align ?? [];
  const cell = (tag: 'th' | 'td', content: readonly InlineNode[], col: number): string => {
    const a = align[col];
    return `<${tag}${a ? ` data-eh-align="${escapeAttr(a)}"` : ''}>${serializeInline(content)}</${tag}>`;
  };
  const row = (tag: 'th' | 'td', cells: readonly (readonly InlineNode[])[]): string => {
    let out = '<tr>';
    cells.forEach((c, i) => (out += cell(tag, c, i)));
    return `${out}</tr>`;
  };
  const i0 = indent(depth);
  const i1 = indent(depth + 1);
  const i2 = indent(depth + 2);
  let out = `${i0}<table${plainAttrs(b, NO_KEYS)}>\n`;
  if (head.length > 0) out += `${i1}<thead>${row('th', head)}</thead>\n`;
  if (body.length === 0) out += `${i1}<tbody></tbody>\n`;
  else {
    out += `${i1}<tbody>\n`;
    for (const r of body) out += `${i2}${row('td', r)}\n`;
    out += `${i1}</tbody>\n`;
  }
  return `${out}${i0}</table>\n`;
}

/**
 * 列表项的有效层级：首项为 0；其余为 `attrs.indent` 截断到 `[0, 前一项层级 + 1]`
 * （非法 / 非数字的 indent 视为 0）。对满足模型不变量的文档，等于 `attrs.indent`。
 */
function effectiveLevel(b: TextBlock, prev: number): number {
  const n = Number.parseInt(b.attrs.indent ?? '0', 10);
  if (!(n > 0)) return 0;
  return Math.min(n, prev + 1);
}

function liOpen(b: TextBlock): string {
  const attrs = without(b.attrs, LI_KEYS);
  if (b.attrs.task !== undefined) attrs['data-eh-task'] = b.attrs.task;
  return `<li${serializeAttrs(b.id, attrs)}>${serializeInline(b.content)}`;
}

function listType(b: TextBlock): string {
  return b.attrs.list === 'ol' ? 'ol' : 'ul';
}

/**
 * 序列化一个列表组（连续的 `li` 块，按文档顺序）在缩进 `depth` 处的规范行。
 *
 * 规则（01 §6.1「列表」）：
 * - 外层 `<ul>`/`<ol>` 与 `</ul>` 各占一行（缩进 `depth`）；层级 L 的 `<li>` 行缩进 `depth + 1 + L`；
 * - 子列表的开始标签紧跟父项内容（`…内容<ul>`），子列表以 `</ul></li>` 收尾（缩进 `depth + L`）；
 * - 同一层级 `list` 类型变化时关闭当前列表并开启新列表：层级 0 写成两行 `</ul>` / `<ol>`
 *   （与两个独立列表组的输出相同），层级 L ≥ 1 写成一行 `</ul><ol>`（缩进 `depth + L`）；
 * - 子列表的类型取其第一项的 `list`；`list` 缺失或非 `ol` 时按 `ul`；
 * - 层级按 {@link effectiveLevel} 截断，保证输出总是良构。
 *
 * @param ids 至少一个 `li` 块的 ID。
 */
export function serializeListGroup(doc: Doc, ids: readonly BlockId[], depth: number): string {
  let out = '';
  const stack: string[] = []; // stack[L] = 层级 L 当前打开的列表类型
  let pending = ''; // 当前 <li> 行（尚未收尾）
  for (const id of ids) {
    const b = getBlock(doc, id);
    if (!isListItem(b)) throw new Error(`block ${id} is not a list item`);
    const t = listType(b);
    if (stack.length === 0) {
      out += `${indent(depth)}<${t}>\n`;
      stack.push(t);
    } else {
      const prev = stack.length - 1;
      const level = effectiveLevel(b, prev);
      if (level === prev + 1) {
        out += `${pending}<${t}>\n`;
        stack.push(t);
      } else {
        out += `${pending}</li>\n`;
        while (stack.length - 1 > level) {
          const k = stack.length - 1;
          out += `${indent(depth + k)}</${stack.pop() as string}></li>\n`;
        }
        const cur = stack[level] as string;
        if (cur !== t) {
          out +=
            level === 0
              ? `${indent(depth)}</${cur}>\n${indent(depth)}<${t}>\n`
              : `${indent(depth + level)}</${cur}><${t}>\n`;
          stack[level] = t;
        }
      }
    }
    pending = `${indent(depth + stack.length)}${liOpen(b)}`;
  }
  if (stack.length === 0) return '';
  out += `${pending}</li>\n`;
  while (stack.length > 1) {
    const k = stack.length - 1;
    out += `${indent(depth + k)}</${stack.pop() as string}></li>\n`;
  }
  return `${out}${indent(depth)}</${stack[0] as string}>\n`;
}

/**
 * 组件块：开始标签行、JSON 行、各槽位、fallback 行、结束标签行。
 * 槽位 `<eh-slot data-eh-slot="i">` 独占一行、子块缩进 +2、`</eh-slot>` 独占一行；空槽位单行。
 * `fallback === undefined` 时省略 fallback 行（空字符串仍输出一对标记）。
 */
function serializeComponent(doc: Doc, b: ComponentBlock, depth: number): string {
  const i0 = indent(depth);
  const i1 = indent(depth + 1);
  const tag = `eh-${b.type}`;
  let out = `${i0}<${tag}${serializeAttrs(b.id, b.attrs)}>\n`;
  out += `${i1}<script type="application/json">${embedJson(b.props)}</script>\n`;
  if (b.slots) {
    b.slots.forEach((slot, i) => {
      if (slot.length === 0) out += `${i1}<eh-slot data-eh-slot="${i}"></eh-slot>\n`;
      else out += `${i1}<eh-slot data-eh-slot="${i}">\n${serializeSequence(doc, slot, depth + 2)}${i1}</eh-slot>\n`;
    });
  }
  if (b.fallback !== undefined) out += `${i1}<!--eh:fallback-->${b.fallback}<!--eh:fallback-->\n`;
  return `${out}${i0}</${tag}>\n`;
}
