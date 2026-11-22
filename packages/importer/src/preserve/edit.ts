/**
 * 编辑 → 补丁（T2.4，docs/06-import.md §2 第 4、7 步）。
 *
 * {@link openPreserve} 在已解析（脚本未运行）的文档上建立区间索引并挂载（T2.3），
 * 记录用户改过的元素；{@link PreserveSession.patches} 把这些元素的**当前 DOM** 与原文对比，生成最小的区间补丁（T2.2）。
 *
 * ## 混合序列化
 *
 * 对一个改过的元素，按 DOM 重新输出它的 HTML，但凡是**与原文配对且未改动**的部分都原样拷贝原文字节：
 * - 已配对、内容未变的文本 / 注释 → 原文切片（实体写法、CRLF 原样保留）；
 * - 已配对、内容变了的文本 → 只把变化的那一段重新转义，其余按原文（`&mdash;` 不会被改写成 `—`）；
 * - 已配对的元素 → 原开始标签（属性有变化时只改动变化的属性）+ 子节点 + 原结束标签；
 * - 两个在原文中相邻的已配对兄弟之间的原文（缩进、被解析器忽略的字符）原样保留；
 * - 新建节点 → 常规序列化（双引号属性、最少转义）。
 *
 * 最后与该元素的原文求公共前后缀，只留下真正不同的那一段作为补丁。于是未改动时补丁为空，
 * 改一个字时补丁只覆盖那个字（`git diff` 只有一行变化）。
 *
 * ## 结构操作
 *
 * {@link PreserveSession.insertAfter} / {@link PreserveSession.remove} 在 DOM 上新增/删除块，
 * 并沿用兄弟节点的缩进：新块之前插入一份与参照块之前相同的空白文本；删除块时连同它前面的空白一起删除。
 * 补丁同样由父元素的混合序列化得出。
 *
 * ## 区域源码替换（T2.5）
 *
 * {@link PreserveSession.replaceSource} 把一段已配对的兄弟元素（通常是一个顶层区域，图表容器连同其后的 `<script>`）
 * 整段换成用户写的 HTML。新 HTML 在原位置的上下文元素中按片段算法解析，并为它**单独建立区间索引**（区间相对这段 HTML）；
 * DOM 按 parse5 的片段树逐节点搭建（不经宿主解析器，保证与区间同形），再由挂载层把新节点与片段区间配对
 * （{@link PreserveMount.graft}）、对其中的文本容器开启编辑。混合序列化时，父元素的逻辑子序列把被替换的那段兄弟
 * 展开成片段的顶层节点，原文与片段之间的间隙按两份原文拼接。于是：
 * - 刚替换完，输出中该区间恰为用户写的 HTML（替换前会校验，做不到逐字节时抛错、不改动任何东西）；
 * - 之后在新内容里打字，只有改动的那几个字相对用户写的 HTML 变化——用户的缩进、实体写法、注释都保留；
 * - 可以再次编辑同一区域的源码（替换可嵌套）。
 *
 * 撤销历史记一项「移除旧节点、插入新节点」的子节点操作（保留节点对象本身），撤销时旧节点连同其配对原样回来、
 * 替换记录失效，`patches()` 随之还原。
 *
 * 一个会话对应一份原文：{@link PreserveSession.save} 返回新文本，但不会把会话变基到新文本上——
 * 打开器（T2.7）写回后用新文本重新打开。
 *
 * ## 撤销重做（T2.6）
 *
 * 会话自带 {@link PreserveHistory}（见 `history.ts`）：挂载层把判定为用户编辑的变动记录转发给它，
 * 它记录可逆的 DOM 操作（保留原节点对象，配对不丢），{@link PreserveSession.undo} 撤销到底时
 * `patches()` 为空、`save() === source`。
 *
 * @module
 */
import { decodeHTML, decodeHTMLAttribute } from 'entities/decode';
import { STYLE_ATTR, mountPreserve, type MountOptions, type PreserveMount } from './mount.js';
import { createPreserveHistory, type PreserveHistory, type PreserveHistoryOptions } from './history.js';
import { buildFragmentDom } from './fragment-dom.js';
import { applyPatches, type Patch } from './patch.js';
import {
  RAW_TEXT_TAGS,
  buildFragmentIndex,
  buildSpanIndex,
  type DocumentSpan,
  type ElementSpan,
  type Span,
  type SpanIndex,
  type SpanNode,
  type TextSpan,
} from './span-index.js';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;
const DOCTYPE = 10;

/** 没有结束标签的空元素。 */
const VOID_TAGS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/** {@link openPreserve} 的选项。 */
export interface PreserveOptions extends Omit<MountOptions, 'onUserEdit'> {
  /** 用户编辑了某个容器（在会话记录之后回调）。 */
  onUserEdit?: (container: HTMLElement) => void;
  /** 插入文本中的换行写成什么；默认 `auto`：原文以 CRLF 为主则用 `\r\n`。 */
  lineEnding?: 'auto' | '\n' | '\r\n';
  /** 撤销重做的选项（合并时间窗、上限、时钟、变化回调）。 */
  history?: PreserveHistoryOptions;
}

/** 区域源码编辑的目标：一个元素，或同一父元素下从 `first` 到 `last`（含）的一段兄弟（连同其间的空白、注释）。 */
export type SourceTarget = Element | { readonly first: Element; readonly last: Element };

/** {@link PreserveSession.replaceSource} 的选项。 */
export interface ReplaceSourceOptions {
  /**
   * 是否让新源码中的 `<script>` 执行（页面脚本已在运行时传 `true`，图表才会按新数据重绘）。
   * 默认 `false`：脚本元素照常插入、照常保存，只是不执行。
   */
  readonly runScripts?: boolean;
}

/** 一次区域替换：主原文（或上一层片段）中 `first`…`last` 这段兄弟被片段 `src` 代替。 */
interface Replacement {
  readonly first: SpanNode;
  readonly last: SpanNode;
  readonly root: DocumentSpan;
  readonly src: string;
  /** 撤销后为 `false`，重做后恢复。 */
  active: boolean;
}

/** 父区间的逻辑子序列（替换展开后），见 `virtual`。 */
interface Virtual {
  readonly items: readonly SpanNode[];
  readonly gaps: readonly (string | null)[];
  readonly pos: ReadonlyMap<SpanNode, number>;
}

/** 保真编辑会话。 */
export interface PreserveSession {
  readonly source: string;
  readonly index: SpanIndex;
  readonly mount: PreserveMount;
  /** 记为已改动（编辑器自己改 DOM 后调用；用户在容器里输入会自动记录）。 */
  touch(node: Node): void;
  /** 目前记录的改动元素（未去重）。 */
  dirty(): readonly Element[];
  /** 相对**原文**的补丁，已按 start 升序、互不重叠。 */
  patches(): Patch[];
  /** 应用补丁后的新文本；没有改动时与原文 `===`。 */
  save(): string;
  /** 在 `ref` 之后插入块元素（沿用 `ref` 前的缩进），新块若是文本容器则可编辑。返回新元素。 */
  insertAfter(ref: Element, tag?: string, text?: string): HTMLElement;
  /** 删除块元素（连同其前面的缩进空白）。 */
  remove(el: Element): void;
  /**
   * 区域当前的 HTML 源码（T2.5）：按混合序列化输出，未改动的部分就是原文字节；
   * 已替换过的区域输出用户写下的那段 HTML（及其后的改动）。脚本生成的 DOM 不在其中。
   *
   * @throws Error 区域无效（`last` 不是 `first` 之后的兄弟、元素不在文档中）。
   */
  getSource(target: SourceTarget): string;
  /**
   * 用 `html` 整段替换区域的源码（T2.5，见模块说明「区域源码替换」）：保存结果中该区域的区间**恰好**是 `html`
   * （用户自己的写法逐字节保留），其余字节不变；DOM 即时换成 `html` 在该位置解析出的节点，
   * 其中的文本容器照常可编辑。作为一步记入撤销历史。返回插入的顶层节点。
   *
   * @throws Error 区域未与源码配对、跨越不同父元素、是 `<head>`/`<body>` 本身，或 `html` 的写法无法逐字节保留；
   *   抛错时 DOM 与历史均未改动。
   */
  replaceSource(target: SourceTarget, html: string, options?: ReplaceSourceOptions): Node[];
  /** 卸载挂载层。 */
  close(): void;
  /** 补丁层撤销重做（T2.6）。 */
  readonly history: PreserveHistory;
  /** 撤销一步（同 `history.undo()`）；没有可撤销的返回 `false`。 */
  undo(): boolean;
  /** 重做一步（同 `history.redo()`）；没有可重做的返回 `false`。 */
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** 断开输入组，之后的编辑开始新的一步（工具栏命令前后调用）。 */
  checkpoint(): void;
}

const nameOf = (el: Element): string => (el.namespaceURI === HTML_NS ? el.tagName.toLowerCase() : el.localName);

function childrenOf(n: Node): Node[] {
  const host = n.nodeType === ELEMENT && nameOf(n as Element) === 'template' ? (n as HTMLTemplateElement).content : n;
  const out: Node[] = [];
  for (let c = host.firstChild; c; c = c.nextSibling) if (c.nodeType !== DOCTYPE) out.push(c);
  return out;
}

const isWhitespaceText = (n: Node | null): n is Text => n?.nodeType === TEXT && /^\s*$/.test((n as Text).data);

/** 文本转义（与 parse5 / 浏览器序列化一致）。 */
export function escapeText(s: string): string {
  return s.replace(/[&<>\u00a0]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&nbsp;'));
}

/** 属性值转义（双引号）。 */
export function escapeAttr(s: string): string {
  return s.replace(/[&"\u00a0]/g, (c) => (c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&nbsp;'));
}

/** 文本原文的一个单元：一个字符、一个 CRLF，或一个字符引用。 */
interface Unit {
  readonly raw: number;
  readonly val: number;
}

const CHAR_REF = /&(?:#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[A-Za-z][A-Za-z0-9]*;?)/y;

/** 把文本原文切成单元；若拼出的值与 `value` 不符（极少见的解析细节）返回 `null`，调用方整体重写。 */
function textUnits(raw: string, value: string): Unit[] | null {
  const units: Unit[] = [];
  let out = '';
  for (let i = 0; i < raw.length;) {
    const c = raw[i];
    if (c === '\r') {
      const n = raw[i + 1] === '\n' ? 2 : 1;
      units.push({ raw: n, val: 1 });
      out += '\n';
      i += n;
    } else if (c === '&') {
      CHAR_REF.lastIndex = i;
      const m = CHAR_REF.exec(raw);
      const ref = m ? m[0] : '&';
      const dec = m ? decodeHTML(ref) : '&';
      units.push({ raw: ref.length, val: dec.length });
      out += dec;
      i += ref.length;
    } else {
      units.push({ raw: 1, val: 1 });
      out += c;
      i++;
    }
  }
  return out === value ? units : null;
}

/** 原文是否以 CRLF 为主。 */
function prefersCrlf(source: string): boolean {
  const crlf = source.split('\r\n').length - 1;
  const lf = source.split('\n').length - 1;
  return crlf > 0 && crlf * 2 >= lf;
}

/** 解析原文中的一个属性片段 `name="value"`，得到解码后的值。 */
function attrValue(raw: string): string {
  const eq = raw.indexOf('=');
  if (eq < 0) return '';
  let v = raw.slice(eq + 1).trimStart();
  if (v.startsWith('"') || v.startsWith("'")) v = v.slice(1, v.endsWith(v[0] ?? '') && v.length > 1 ? -1 : undefined);
  return decodeHTMLAttribute(v);
}

/**
 * 在已解析的文档上开启保真编辑会话：建立索引、挂载、记录改动并生成补丁。
 *
 * @param doc 由 `source` 解析得到、脚本尚未运行的文档（见 {@link mountPreserve} 的调用时机）。
 * @param source 原文。
 */
export function openPreserve(doc: Document, source: string, options: PreserveOptions = {}): PreserveSession {
  const index = buildSpanIndex(source);
  const dirty: Element[] = [];
  const nl = options.lineEnding === '\r\n' || (options.lineEnding !== '\n' && prefersCrlf(source)) ? '\r\n' : '\n';
  const fixNl = (s: string): string => (nl === '\n' ? s : s.replace(/\r?\n/g, nl));

  const touch = (node: Node): void => {
    const el = node.nodeType === ELEMENT ? (node as Element) : node.parentElement;
    if (el) dirty.push(el);
  };

  /** 历史层在挂载之后才建立；挂载层的转发回调经由这里找到它。 */
  const late: { history?: PreserveHistory } = {};
  const mount = mountPreserve(doc, index, {
    ...options,
    onUserMutations(records) {
      for (const r of records) touch(r.target); // 编辑器命令改属性/结构时也无需手动 touch
      late.history?.record(records);
      options.onUserMutations?.(records);
    },
    onUserEdit(c) {
      dirty.push(c);
      options.onUserEdit?.(c);
    },
  });
  const raw = (s: { start: number; end: number }): string => source.slice(s.start, s.end);
  const hist = createPreserveHistory(
    {
      doc,
      mount,
      touch,
      originalAttr(el, name) {
        const s = mount.spanOf(el);
        const sp = s?.kind === 'element' ? s.attrs.get(name) : undefined;
        return s && sp ? attrValue(rawOf(s, sp)) : null;
      },
    },
    options.history,
  );
  late.history = hist;

  // ---- 区域源码替换（T2.5）的片段层 ----

  /** 片段区间 → 片段原文；不在表中的区间属于主原文。 */
  const fragSrc = new WeakMap<SpanNode, string>();
  /** 替换记录，按被替换的第一个区间索引（同一区间可能先后被替换、撤销多次，至多一条生效）。 */
  const replacedAt = new Map<SpanNode, Replacement[]>();
  const srcOf = (s: SpanNode): string => fragSrc.get(s) ?? source;
  const rawOf = (s: SpanNode, sp: Span): string => srcOf(s).slice(sp.start, sp.end);

  // 会话可能开在已运行过脚本的 DOM 上（打开器保存后就地重挂）：与原文不同的属性只能是脚本改的，补记下来。
  for (const s of index.nodes) {
    if (s.kind !== 'element') continue;
    const n = mount.nodeOf(s);
    if (n?.nodeType !== ELEMENT) continue;
    const el = n as Element;
    for (const [name, sp] of s.attrs) {
      if (mount.owns(el, name)) continue;
      const v = el.getAttribute(name);
      if (v === null || v !== attrValue(raw(sp))) mount.markScripted(el, name);
    }
    if (el.attributes.length > 0)
      for (const a of Array.from(el.attributes))
        if (!s.attrs.has(a.name) && !mount.owns(el, a.name)) mount.markScripted(el, a.name);
  }

  // ---- 混合序列化 ----

  const changedText = (s: TextSpan, sp: Span, data: string): string => {
    const r = rawOf(s, sp);
    const old = s.value;
    const units = textUnits(r, old);
    if (!units) return escapeText(fixNl(data));
    const max = Math.min(old.length, data.length);
    let p = 0;
    while (p < max && old.charCodeAt(p) === data.charCodeAt(p)) p++;
    let q = 0;
    while (q < max - p && old.charCodeAt(old.length - 1 - q) === data.charCodeAt(data.length - 1 - q)) q++;
    // 收缩到单元边界：前缀只保留完整落在 p 之内的单元，后缀同理。
    let ri = 0;
    let vi = 0;
    let ui = 0;
    for (; ui < units.length; ui++) {
      const u = units[ui] as Unit;
      if (vi + u.val > p) break;
      ri += u.raw;
      vi += u.val;
    }
    let rj = r.length;
    let vj = old.length;
    for (let k = units.length - 1; k >= ui; k--) {
      const u = units[k] as Unit;
      if (old.length - (vj - u.val) > q) break;
      rj -= u.raw;
      vj -= u.val;
    }
    const tail = old.length - vj;
    return r.slice(0, ri) + escapeText(fixNl(data.slice(vi, data.length - tail))) + r.slice(rj);
  };

  /** 序列化时忽略的属性：挂载层自己写的，以及脚本改过的（后者沿用原文）。 */
  const ignored = (el: Element, name: string): boolean => mount.owns(el, name) || mount.scripted(el, name);

  const emitAttrs = (el: Element): string => {
    let out = '';
    for (const a of Array.from(el.attributes)) {
      if (ignored(el, a.name)) continue;
      out += a.value === '' ? ` ${a.name}` : ` ${a.name}="${escapeAttr(a.value)}"`;
    }
    return out;
  };

  /** 已配对元素的开始标签：属性没变时原样；变了只改动对应属性。 */
  const startTag = (el: Element, s: ElementSpan, tag: Span): string => {
    const tagRaw = rawOf(s, tag);
    const base = tag.start;
    const cur = new Map<string, string>();
    for (const a of Array.from(el.attributes)) if (!ignored(el, a.name)) cur.set(a.name, a.value);
    const edits: Patch[] = [];
    for (const [name, sp] of s.attrs) {
      if (mount.scripted(el, name)) continue;
      const v = cur.get(name);
      if (v === undefined) {
        // 连同前面的空白一起删除
        let st = sp.start - base;
        while (st > 0 && /\s/.test(tagRaw[st - 1] ?? '')) st--;
        edits.push({ start: st, end: sp.end - base, text: '' });
      } else if (v !== attrValue(rawOf(s, sp))) {
        edits.push({
          start: sp.start - base,
          end: sp.end - base,
          text: v === '' ? name : `${name}="${escapeAttr(v)}"`,
        });
      }
      cur.delete(name);
    }
    if (cur.size > 0) {
      let at = tagRaw.length - 1; // `>` 之前
      if (tagRaw[at - 1] === '/') at--;
      while (at > 0 && /\s/.test(tagRaw[at - 1] ?? '')) at--;
      let add = '';
      for (const [name, v] of cur) add += v === '' ? ` ${name}` : ` ${name}="${escapeAttr(v)}"`;
      edits.push({ start: at, end: at, text: add });
    }
    return edits.length === 0 ? tagRaw : applyPatches(tagRaw, edits);
  };

  /**
   * 把父区间 `s` 的子区间展开成「逻辑子序列」：生效的替换记录用其片段的顶层区间代替被替换的那一段兄弟（可嵌套）。
   * `gaps[i]` 是第 i 项之前、与上一项（或内容起点）之间的原文；`gaps[items.length]` 是最后一项到内容终点的原文。
   * 原文未知（隐式元素、区间缺失）时为 `null`。跨越替换边界的间隙由两份原文拼成。
   */
  const virtual = (s: SpanNode | undefined): Virtual => {
    const items: SpanNode[] = [];
    const gaps: (string | null)[] = [];
    const cat = (a: string | null, b: string | null): string | null => (a === null || b === null ? null : a + b);
    const expand = (
      children: readonly SpanNode[],
      src: string,
      start: number | null,
      end: number | null,
      lead: string | null,
    ): string | null => {
      let pending = lead;
      let pos = start;
      const upTo = (to: number | null): string | null => (pos === null || to === null ? null : src.slice(pos, to));
      for (let i = 0; i < children.length; i++) {
        const c = children[i] as SpanNode;
        const r = replacedAt.get(c)?.find((x) => x.active);
        const j = r ? children.indexOf(r.last, i) : -1;
        if (r && j >= 0 && c.span && r.last.span) {
          pending = expand(r.root.children, r.src, 0, r.src.length, cat(pending, upTo(c.span.start)));
          pos = r.last.span.end;
          i = j;
          continue;
        }
        gaps.push(cat(pending, upTo(c.span?.start ?? null)));
        items.push(c);
        pending = '';
        pos = c.span?.end ?? null;
      }
      return cat(pending, upTo(end));
    };
    if (s?.kind === 'element' || s?.kind === 'document') {
      const inner = s.kind === 'element' ? s.inner : s.span;
      gaps.push(expand(s.children, srcOf(s), inner?.start ?? null, inner?.end ?? null, inner ? '' : null));
    } else gaps.push(null);
    const pos = new Map<SpanNode, number>();
    items.forEach((it, i) => pos.set(it, i));
    return { items, gaps, pos };
  };

  /**
   * 输出一串子节点。与逻辑子序列中相邻的已配对节点之间补上原文间隙；`lead` / `trail` 决定是否输出
   * 第一项之前、最后一项之后的间隙（输出整个父元素内容时为真，只输出其中一段时为假）。脚本新增的节点整棵跳过。
   */
  const emitKids = (kids: readonly Node[], v: Virtual, lead: boolean, trail: boolean): string => {
    let out = '';
    let prev = lead ? -1 : -3; // 上一个输出的逻辑子序列下标；-2 表示上一个是新节点/移入节点
    let count = 0;
    for (const k of kids) {
      if (mount.scriptMade(k)) continue;
      count++;
      const ks = mount.spanOf(k);
      const j = ks?.span ? (v.pos.get(ks) ?? -1) : -1;
      if (j >= 0) {
        if (j === 0 && prev === -1) out += v.gaps[0] ?? '';
        else if (j > 0 && prev === j - 1) out += v.gaps[j] ?? '';
        prev = j;
      } else prev = -2;
      out += emitNode(k);
    }
    if (trail) {
      const n = v.items.length;
      if (n === 0 && count === 0) out += v.gaps[0] ?? '';
      else if (prev >= 0 && prev === n - 1) out += v.gaps[n] ?? '';
    }
    return out;
  };

  const emitChildren = (n: Node, s: SpanNode | undefined): string => emitKids(childrenOf(n), virtual(s), true, true);

  const emitNode = (n: Node): string => {
    const s = mount.spanOf(n);
    if (n.nodeType === TEXT) {
      const data = (n as Text).data;
      if (s?.kind === 'text' && s.span) {
        // `</body>` / `</html>` 之后的空白会被解析器并进 body 的最后一个文本：它的区间越过父元素的结束标签。
        // 只输出父元素内容之内的那段，越出的原文由祖先结束标签之后的原文覆盖（否则会重复输出结束标签）。
        const inner = s.parent?.kind === 'element' ? s.parent.inner : null;
        const sp = inner && s.span.start < inner.end && s.span.end > inner.end ? { ...s.span, end: inner.end } : s.span;
        return data === s.value || mount.scriptText(n) ? rawOf(s, sp) : changedText(s, sp, data);
      }
      const p = n.parentElement;
      return p && RAW_TEXT_TAGS.has(nameOf(p)) ? data : escapeText(fixNl(data));
    }
    if (n.nodeType === COMMENT) {
      const data = (n as Comment).data;
      if (s?.kind === 'comment' && s.span && (data === s.value || mount.scriptText(n))) return rawOf(s, s.span);
      return `<!--${data}-->`;
    }
    if (n.nodeType !== ELEMENT) return '';
    const el = n as Element;
    const tag = nameOf(el);
    if (s?.kind === 'element' && s.span) {
      const open = s.startTag ? startTag(el, s, s.startTag) : '';
      if (s.startTag && !s.inner) return open; // 空元素
      return open + emitChildren(el, s) + (s.endTag ? rawOf(s, s.endTag) : '');
    }
    if (!s && el.hasAttribute(STYLE_ATTR)) return ''; // 挂载层注入的样式
    // 解析器补出的隐式元素（`<table>` 里的 `<tbody>` 等）：原文中没有它的标签，只输出子节点。
    if (s?.kind === 'element' && !s.startTag && !s.endTag) return emitChildren(el, s);
    const open = `<${tag}${emitAttrs(el)}>`;
    if (VOID_TAGS.has(tag)) return open;
    return open + emitChildren(el, undefined) + `</${tag}>`;
  };

  /**
   * 选出要重新输出的节点：每个改动点上溯到最近的、有开始标签的**主原文**配对元素，再去掉被祖先覆盖的。
   * 一直找不到（改动直接落在省略了 `<body>` / `<html>` 标签的隐式元素里，如剪贴板片段）时，退到整个文档。
   */
  const roots = (): Node[] => {
    const set = new Set<Node>();
    for (const d of dirty) {
      if (!d.isConnected) continue;
      let found = false;
      for (let e: Element | null = d; e; e = e.parentElement) {
        const s = mount.spanOf(e);
        if (s?.kind === 'element' && s.startTag && s.span && !fragSrc.has(s)) {
          set.add(e);
          found = true;
          break;
        }
      }
      if (!found) set.add(doc);
    }
    if (set.has(doc)) return [doc];
    return [...set].filter((e) => {
      for (let p = e.parentNode; p; p = p.parentNode) if (set.has(p)) return false;
      return true;
    });
  };

  // ---- 区域源码：读取与整段替换 ----

  /** `first` 到 `last`（含）之间的所有兄弟节点。 */
  const between = (first: Element, last: Element): Node[] => {
    const out: Node[] = [];
    for (let n: Node | null = first; n; n = n.nextSibling) {
      out.push(n);
      if (n === last) return out;
    }
    throw new Error('区域无效：last 必须是 first 之后的兄弟节点');
  };
  const rangeOf = (t: SourceTarget): { first: Element; last: Element } =>
    'first' in t ? { first: t.first, last: t.last } : { first: t, last: t };

  const getSource = (target: SourceTarget): string => {
    const { first, last } = rangeOf(target);
    const parent = first.parentNode;
    if (!parent) throw new Error('区域无效：元素不在文档中');
    return emitKids(between(first, last), virtual(mount.spanOf(parent)), false, false);
  };

  /** 把新插入的脚本换成新建的同内容脚本（插入时才会执行），区间随之转移；返回替换后的顶层节点。 */
  const activate = (nodes: readonly Node[]): Node[] => {
    const out = [...nodes];
    const scripts: Element[] = [];
    for (const n of nodes) {
      if (n.nodeType !== ELEMENT) continue;
      const el = n as Element;
      if (el.localName === 'script') scripts.push(el);
      scripts.push(...Array.from(el.querySelectorAll('script')));
    }
    for (const old of scripts) {
      const fresh =
        old.namespaceURI === HTML_NS ? doc.createElement('script') : doc.createElementNS(old.namespaceURI, 'script');
      for (const a of Array.from(old.attributes))
        if (a.namespaceURI) fresh.setAttributeNS(a.namespaceURI, a.name, a.value);
        else fresh.setAttribute(a.name, a.value);
      while (old.firstChild) fresh.appendChild(old.firstChild);
      mount.transfer(old, fresh);
      old.replaceWith(fresh);
      const i = out.indexOf(old);
      if (i >= 0) out[i] = fresh;
    }
    return out;
  };

  const replaceSource = (target: SourceTarget, html: string, opts: ReplaceSourceOptions = {}): Node[] => {
    const { first, last } = rangeOf(target);
    const fs = mount.spanOf(first);
    const ls = mount.spanOf(last);
    const parent = first.parentNode;
    const ctx = first.parentElement;
    if (fs?.kind !== 'element' || !fs.span || ls?.kind !== 'element' || !ls.span || !parent || !ctx)
      throw new Error('区域无效：元素未与源码配对，无法按区间替换');
    const sibs = fs.parent?.kind === 'element' || fs.parent?.kind === 'document' ? fs.parent.children : [];
    const fi = sibs.indexOf(fs);
    if (fs.parent !== ls.parent || fs.parent === index.root || fi < 0 || sibs.indexOf(ls) < fi)
      throw new Error('区域无效：first 与 last 必须是源码中同一父元素下的兄弟');
    if (nameOf(ctx) === 'html') throw new Error('区域无效：不能替换 <head> / <body> 本身');
    const removed = between(first, last);
    hist.checkpoint();

    const { index: fx, tree } = buildFragmentIndex(html, { tag: nameOf(ctx), namespace: ctx.namespaceURI ?? HTML_NS });
    for (const n of fx.nodes) fragSrc.set(n, html);
    const nodes = buildFragmentDom(doc, tree);
    mount.graft(nodes, fx.root, parent);
    if (emitKids(nodes, virtual(fx.root), true, true) !== html)
      throw new Error('这段 HTML 无法逐字节保留（例如表格中的游离文本），请调整后重试');

    const next = last.nextSibling;
    hist.silently(() =>
      mount.userEdit(() => {
        for (const n of removed) parent.removeChild(n);
        for (const n of nodes) parent.insertBefore(n, next);
      }),
    );
    const rec: Replacement = { first: fs, last: ls, root: fx.root, src: html, active: true };
    replacedAt.set(fs, [...(replacedAt.get(fs) ?? []), rec]);
    const added = opts.runScripts ? activate(nodes) : nodes;
    hist.push([
      {
        type: 'child',
        parent,
        added,
        removed,
        next,
        after: (forward) => {
          rec.active = forward;
        },
      },
    ]);
    touch(parent);
    return added;
  };

  const patches = (): Patch[] => {
    const out: Patch[] = [];
    for (const el of roots()) {
      const s = el === doc ? index.root : mount.spanOf(el);
      if ((s?.kind !== 'element' && s?.kind !== 'document') || !s.span) continue;
      const before = raw(s.span);
      const after = el === doc ? emitChildren(doc, index.root) : emitNode(el);
      if (before === after) continue;
      const max = Math.min(before.length, after.length);
      let p = 0;
      while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
      let q = 0;
      while (q < max - p && before.charCodeAt(before.length - 1 - q) === after.charCodeAt(after.length - 1 - q)) q++;
      out.push({ start: s.span.start + p, end: s.span.end - q, text: after.slice(p, after.length - q) });
    }
    return out.sort((a, b) => a.start - b.start);
  };

  return {
    source,
    index,
    mount,
    touch,
    dirty: () => dirty,
    patches,
    save: () => {
      const ps = patches();
      return ps.length === 0 ? source : applyPatches(source, ps);
    },
    insertAfter(ref, tag = 'p', text = '') {
      const parent = ref.parentNode;
      if (!parent) throw new Error('insertAfter: reference element is detached');
      const el = doc.createElement(tag);
      if (text) el.textContent = text;
      mount.userEdit(() => {
        const ws = isWhitespaceText(ref.previousSibling)
          ? ref.previousSibling
          : isWhitespaceText(ref.nextSibling) && ref.nextSibling.nextSibling
            ? ref.nextSibling
            : null;
        if (ws) ref.after(doc.createTextNode(ws.data), el);
        else ref.after(el);
      });
      mount.adopt(el);
      touch(parent);
      return el;
    },
    remove(el) {
      const parent = el.parentNode;
      if (!parent) return;
      mount.userEdit(() => {
        const ws = isWhitespaceText(el.previousSibling)
          ? el.previousSibling
          : isWhitespaceText(el.nextSibling)
            ? el.nextSibling
            : null;
        ws?.remove();
        el.remove();
      });
      touch(parent);
    },
    getSource,
    replaceSource,
    close: () => {
      hist.dispose();
      mount.unmount();
    },
    history: hist,
    undo: () => hist.undo(),
    redo: () => hist.redo(),
    canUndo: () => hist.canUndo(),
    canRedo: () => hist.canRedo(),
    checkpoint: () => hist.checkpoint(),
  };
}
