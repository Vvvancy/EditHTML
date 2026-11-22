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
import { applyPatches, type Patch } from './patch.js';
import {
  RAW_TEXT_TAGS,
  buildSpanIndex,
  type ElementSpan,
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
        return sp ? attrValue(raw(sp)) : null;
      },
    },
    options.history,
  );
  late.history = hist;

  // ---- 混合序列化 ----

  const changedText = (s: TextSpan & { span: { start: number; end: number } }, data: string): string => {
    const r = raw(s.span);
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

  const emitAttrs = (el: Element): string => {
    let out = '';
    for (const a of Array.from(el.attributes)) {
      if (mount.owns(el, a.name)) continue;
      out += a.value === '' ? ` ${a.name}` : ` ${a.name}="${escapeAttr(a.value)}"`;
    }
    return out;
  };

  /** 已配对元素的开始标签：属性没变时原样；变了只改动对应属性。 */
  const startTag = (el: Element, s: ElementSpan & { startTag: { start: number; end: number } }): string => {
    const tagRaw = raw(s.startTag);
    const base = s.startTag.start;
    const cur = new Map<string, string>();
    for (const a of Array.from(el.attributes)) if (!mount.owns(el, a.name)) cur.set(a.name, a.value);
    const edits: Patch[] = [];
    for (const [name, sp] of s.attrs) {
      const v = cur.get(name);
      if (v === undefined) {
        // 连同前面的空白一起删除
        let st = sp.start - base;
        while (st > 0 && /\s/.test(tagRaw[st - 1] ?? '')) st--;
        edits.push({ start: st, end: sp.end - base, text: '' });
      } else if (v !== attrValue(raw(sp))) {
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

  const emitChildren = (n: Node, s: SpanNode | undefined): string => {
    const kids = childrenOf(n);
    const orig = s && (s.kind === 'element' || s.kind === 'document') ? s.children : [];
    const inner = s?.kind === 'element' ? s.inner : s?.kind === 'document' ? s.span : null;
    let out = '';
    let prev = -1; // 上一个输出的、作为本父节点原子节点配对的下标；-2 表示上一个是新节点/移入节点
    for (const k of kids) {
      const ks = mount.spanOf(k);
      const j = ks && ks.parent === s ? orig.indexOf(ks) : -1;
      if (j >= 0 && ks?.span) {
        if (j === 0 && prev === -1 && inner) out += source.slice(inner.start, ks.span.start);
        else if (j > 0 && prev === j - 1) {
          const ps = (orig[j - 1] as SpanNode).span;
          if (ps) out += source.slice(ps.end, ks.span.start);
        }
        prev = j;
      } else prev = -2;
      out += emitNode(k);
    }
    if (inner) {
      if (orig.length === 0 && kids.length === 0) out += raw(inner);
      else if (prev >= 0 && prev === orig.length - 1) {
        const ls = (orig[prev] as SpanNode).span;
        if (ls) out += source.slice(ls.end, inner.end);
      }
    }
    return out;
  };

  const emitNode = (n: Node): string => {
    const s = mount.spanOf(n);
    if (n.nodeType === TEXT) {
      const data = (n as Text).data;
      if (s?.kind === 'text' && s.span) {
        // `</body>` / `</html>` 之后的空白会被解析器并进 body 的最后一个文本：它的区间越过父元素的结束标签。
        // 只输出父元素内容之内的那段，越出的原文由祖先结束标签之后的原文覆盖（否则会重复输出结束标签）。
        const inner = s.parent?.kind === 'element' ? s.parent.inner : null;
        const sp = inner && s.span.start < inner.end && s.span.end > inner.end ? { ...s.span, end: inner.end } : s.span;
        return data === s.value ? raw(sp) : changedText({ ...s, span: sp }, data);
      }
      const p = n.parentElement;
      return p && RAW_TEXT_TAGS.has(nameOf(p)) ? data : escapeText(fixNl(data));
    }
    if (n.nodeType === COMMENT) {
      const data = (n as Comment).data;
      if (s?.kind === 'comment' && s.span && data === s.value) return raw(s.span);
      return `<!--${data}-->`;
    }
    if (n.nodeType !== ELEMENT) return '';
    const el = n as Element;
    const tag = nameOf(el);
    if (s?.kind === 'element' && s.span) {
      const open = s.startTag ? startTag(el, { ...s, startTag: s.startTag }) : '';
      if (s.startTag && !s.inner) return open; // 空元素
      return open + emitChildren(el, s) + (s.endTag ? raw(s.endTag) : '');
    }
    if (!s && el.hasAttribute(STYLE_ATTR)) return ''; // 挂载层注入的样式
    // 解析器补出的隐式元素（`<table>` 里的 `<tbody>` 等）：原文中没有它的标签，只输出子节点。
    if (s?.kind === 'element' && !s.startTag && !s.endTag) return emitChildren(el, s);
    const open = `<${tag}${emitAttrs(el)}>`;
    if (VOID_TAGS.has(tag)) return open;
    return open + emitChildren(el, undefined) + `</${tag}>`;
  };

  /** 选出要重新输出的元素：每个改动点上溯到最近的、有开始标签的已配对元素，再去掉被祖先覆盖的。 */
  const roots = (): Element[] => {
    const set = new Set<Element>();
    for (const d of dirty) {
      for (let e: Element | null = d; e; e = e.parentElement) {
        const s = mount.spanOf(e);
        if (s?.kind === 'element' && s.startTag && s.span && e.isConnected) {
          set.add(e);
          break;
        }
      }
    }
    return [...set].filter((e) => {
      for (let p = e.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
  };

  const patches = (): Patch[] => {
    const out: Patch[] = [];
    for (const el of roots()) {
      const s = mount.spanOf(el);
      if (s?.kind !== 'element' || !s.span) continue;
      const before = raw(s.span);
      const after = emitNode(el);
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
