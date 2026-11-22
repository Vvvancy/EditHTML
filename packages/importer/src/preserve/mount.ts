/**
 * 可编辑判定 + 挂载（T2.3，docs/06-import.md §2 第 2–3 步与「页面脚本的处理」）。
 *
 * {@link mountPreserve} 把 {@link buildSpanIndex} 得到的区间树与**刚解析完、脚本尚未改动**的 live DOM
 * 做并行结构遍历，建立 `WeakMap<Node, SpanNode>`（不在 DOM 上写任何映射属性），再为「文本容器」
 * 开启 `contenteditable`，并用 `MutationObserver` 把脚本后来生成/改动的内容标灰、收回可编辑。
 *
 * ## 调用时机（T2.7 打开器必须保证）
 *
 * 配对只在 DOM 与原文同形时成立，所以必须在**任何页面脚本运行之前**挂载。行内脚本在解析过程中就会执行，
 * 等到 `DOMContentLoaded` 再挂载已经太晚。推荐做法：
 *
 * 1. 先以「脚本不执行」的方式得到 DOM：`DOMParser`、不带 `allow-scripts` 的 sandbox iframe，或
 *    `srcdoc` + CSP `script-src 'none'`；
 * 2. 在这个 DOM 上调用 `mountPreserve`；
 * 3. 之后由打开器按文档顺序**激活**脚本：把每个 `<script>` 换成一个新建的同内容 `<script>`（新节点插入时才会执行），
 *    并调用 {@link PreserveMount.transfer} 把旧节点的区间转给新节点，脚本元素本身就不会被误判为「脚本生成」。
 *
 * 若配对时发现分歧（挂载前 DOM 已被改动，或宿主解析器不完全符合 WHATWG，如 happy-dom），
 * 绝不错配：分歧处的节点保持未配对，所在子树不可编辑，未配对的元素标灰。
 *
 * ## 可编辑判定
 *
 * 自顶向下遍历，遇到第一个满足以下全部条件的元素即设为容器（`contenteditable="true"`），不再深入：
 * - HTML 命名空间，不在禁用集（`script/style/template/svg/math/canvas/iframe/表单控件/媒体` 等，且不深入其内部），
 *   不是结构元素（`html/body/table/tr/ul/ol/dl` 等），原文没有自带 `contenteditable`；
 * - 有 `inner` 区间（有开始标签、非空元素）；
 * - 子树完整：所有后代都已与区间配对，且没有任何一层出现分歧；
 * - 内容全是文本、注释与短语元素（`a span em strong code br img …`，以及 Word 粘贴的 `o:p` 这类带冒号的旧标签），
 *   且至少有一段非空白文本。
 *
 * 于是 `<p>` / `<h1>` / `<li>` / `<td>` 整段成为一个容器，而不是每个行内 `<span>` 各自一个；
 * 只有当父元素混有块级内容时，行内元素才会作为最外层容器单独开启。
 * 用 `"true"` 而非 `"plaintext-only"`：T2.8 的粗体/斜体/链接需要富文本编辑。
 *
 * ## 用户改动 vs 脚本改动
 *
 * 观察 `childList` + `characterData`（不观察属性：本层只负责内容，属性补丁在 T2.4/T2.5）。
 * 一条变动记录被视为**用户编辑**，当且仅当：
 * - 发生在 {@link PreserveMount.userEdit} 回调内（编辑器自己的命令、工具栏、`execCommand` 都应包在里面）；或
 * - 发生在某个容器的 `beforeinput` → `input` 窗口内，或该容器的输入法组合（`compositionstart` → `compositionend`）期间，
 *   且变动位于该容器内。
 *
 * 其余一律视为**脚本改动**：落在容器内则该容器收回可编辑并标灰；新增的、无区间（或被挪离原位）的元素标灰。
 * 标灰 = `data-eh-generated` 属性 + `title` 提示「由脚本生成，请编辑其数据/源码」+ 一条 `<style data-eh-preserve>` 规则。
 *
 * @module
 */
import type { ElementSpan, SpanIndex, SpanNode } from './span-index.js';

/** 标灰属性名。 */
export const GENERATED_ATTR = 'data-eh-generated';
/** 标灰元素的悬停提示。 */
export const GENERATED_TIP = '由脚本生成，请编辑其数据/源码';
/** 注入的唯一样式元素上的标记属性。 */
export const STYLE_ATTR = 'data-eh-preserve';

const STYLE_TEXT = `[${GENERATED_ATTR}]{filter:grayscale(1);opacity:.55;outline:1px dashed rgba(128,128,128,.7);outline-offset:2px;cursor:not-allowed}`;

const HTML_NS = 'http://www.w3.org/1999/xhtml';

const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;
const DOCUMENT = 9;
const DOCTYPE = 10;

/** 永不可编辑，也不深入其内部。 */
const FORBIDDEN: ReadonlySet<string> = new Set([
  'head',
  'title',
  'meta',
  'link',
  'base',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'canvas',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'video',
  'audio',
  'picture',
  'map',
  'input',
  'textarea',
  'select',
  'option',
  'optgroup',
  'button',
  'datalist',
  'output',
  'progress',
  'meter',
  'xmp',
  'plaintext',
  'noembed',
  'noframes',
  'slot',
]);

/** 结构元素：自身不做容器，但向内寻找。 */
const STRUCTURAL: ReadonlySet<string> = new Set([
  'html',
  'body',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'colgroup',
  'col',
  'ul',
  'ol',
  'dl',
  'menu',
  'hr',
  'form',
  'fieldset',
]);

/** 可出现在容器内部的短语元素。 */
const PHRASING: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'big',
  'br',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'img',
  'ins',
  'kbd',
  'mark',
  'nobr',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'time',
  'tt',
  'u',
  'var',
  'wbr',
]);

/** {@link mountPreserve} 的选项。 */
export interface MountOptions {
  /** 用户编辑了某个容器（同一批变动对同一容器只回调一次）。T2.4 据此生成补丁。 */
  onUserEdit?: (container: HTMLElement) => void;
  /** 某元素被标灰（脚本生成，或容器被脚本改动而收回可编辑）。 */
  onGenerated?: (el: Element) => void;
  /** 挂载时把未配对的元素标灰，默认 `true`。 */
  markUnpaired?: boolean;
}

/** {@link mountPreserve} 的返回值。 */
export interface PreserveMount {
  readonly index: SpanIndex;
  /** DOM 节点 → 区间记录；未配对（脚本生成、分歧处、编辑器/用户新建）时为 `undefined`。 */
  spanOf(node: Node): SpanNode | undefined;
  /** 区间记录 → DOM 节点（{@link spanOf} 的逆）。 */
  nodeOf(span: SpanNode): Node | undefined;
  /** 当前仍可编辑的容器，按文档顺序。 */
  containers(): HTMLElement[];
  /** `node` 所在（或自身即是）的可编辑容器。 */
  containerOf(node: Node): HTMLElement | undefined;
  /** `node` 是否位于某个可编辑容器内。 */
  isEditable(node: Node): boolean;
  /** 在 `fn` 中发生的所有 DOM 变动都视为用户编辑（编辑器命令、工具栏、`execCommand` 须包在这里）。 */
  userEdit<T>(fn: () => T): T;
  /** 立即处理尚未派发的变动记录（按脚本改动处理），便于在同步流程/测试中观察结果。 */
  flush(): void;
  /** 把 `from` 的区间转给 `to`（打开器重建 `<script>` 以激活脚本时使用）。 */
  transfer(from: Node, to: Node): void;
  /** 断开观察者、移除监听、还原全部属性并删除注入的样式；DOM 回到挂载前（脚本自己的改动除外）。 */
  unmount(): void;
}

/** 两个 32 位 FNV-1a 叠成的结构指纹：只用来找锚点，配对后仍逐层校验，碰撞不会导致错配内容。 */
function hashStr(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * 与 parse5 `tagName` 对应的元素名。HTML 解析器从不给 HTML 元素加前缀，所以小写的 `tagName` 即完整名
 * （`o:p` 不会被拆成前缀 `o` + `p`）；外来命名空间（SVG/MathML）用 `localName`，保留 `foreignObject` 的大小写。
 */
function nameOf(el: Element): string {
  return el.namespaceURI === HTML_NS ? el.tagName.toLowerCase() : el.localName;
}

function childrenOf(n: Node): Node[] {
  const host = n.nodeType === ELEMENT && nameOf(n as Element) === 'template' ? (n as HTMLTemplateElement).content : n;
  const out: Node[] = [];
  for (let c = host.firstChild; c; c = c.nextSibling) if (c.nodeType !== DOCTYPE) out.push(c);
  return out;
}

function domKey(n: Node): string {
  switch (n.nodeType) {
    case ELEMENT:
      return `e|${(n as Element).namespaceURI ?? ''}|${nameOf(n as Element)}`;
    case TEXT:
      return `t|${(n as Text).data}`;
    case COMMENT:
      return `c|${(n as Comment).data}`;
    case DOCUMENT:
      return 'd';
    default:
      return `?|${n.nodeType}`;
  }
}

function spanKey(s: SpanNode): string {
  switch (s.kind) {
    case 'element':
      return `e|${s.namespace}|${s.tag}`;
    case 'text':
      return `t|${s.value}`;
    case 'comment':
      return `c|${s.value}`;
    case 'document':
      return 'd';
  }
}

const spanChildren = (s: SpanNode): readonly SpanNode[] =>
  s.kind === 'element' || s.kind === 'document' ? s.children : [];

/** LCS 表的规模上限；超出时只用首尾锚点。 */
const LCS_LIMIT = 200_000;

/**
 * 在 live DOM 上挂载保真编辑。必须在页面脚本改动 DOM **之前**调用（见模块说明）。
 *
 * @param doc 由 `index.source` 解析得到的文档（可来自 iframe 等其他 realm）。
 * @param index {@link buildSpanIndex} 的结果。
 */
export function mountPreserve(doc: Document, index: SpanIndex, options: MountOptions = {}): PreserveMount {
  const toSpan = new WeakMap<Node, SpanNode>();
  const toNode = new WeakMap<SpanNode, Node>();
  /** 子树完整配对的元素。 */
  const complete = new WeakSet<Node>();
  const containers = new Set<HTMLElement>();
  /** 我们改过的属性 → 原值（`null` 表示原本没有）。 */
  const original = new Map<Element, Map<string, string | null>>();
  const unpaired: Element[] = [];

  // ---- 1. 并行结构遍历配对 ----
  const domHash = new WeakMap<Node, number>();
  const spHash = new WeakMap<SpanNode, number>();
  const hashDom = (n: Node): number => {
    const hit = domHash.get(n);
    if (hit !== undefined) return hit;
    let h = hashStr(2166136261, domKey(n));
    for (const c of childrenOf(n)) h = hashStr(Math.imul(h, 31) ^ hashDom(c), '/');
    domHash.set(n, h);
    return h;
  };
  const hashSpan = (s: SpanNode): number => {
    const hit = spHash.get(s);
    if (hit !== undefined) return hit;
    let h = hashStr(2166136261, spanKey(s));
    for (const c of spanChildren(s)) h = hashStr(Math.imul(h, 31) ^ hashSpan(c), '/');
    spHash.set(s, h);
    return h;
  };

  /** 配对一个节点并递归；返回子树是否完整。浅比较不等（指纹碰撞）时拒绝配对。 */
  const pairNode = (n: Node, s: SpanNode): boolean => {
    if (domKey(n) !== spanKey(s)) {
      leave([n]);
      return false;
    }
    toSpan.set(n, s);
    toNode.set(s, n);
    if (s.kind !== 'element' && s.kind !== 'document') return true;
    const ok = pairChildren(childrenOf(n), s.children);
    if (ok) complete.add(n);
    return ok;
  };

  const positional = (ds: readonly Node[], ss: readonly SpanNode[]): boolean =>
    ds.length === ss.length && ds.every((d, i) => domKey(d) === spanKey(ss[i] as SpanNode));

  const pairAll = (ds: readonly Node[], ss: readonly SpanNode[]): boolean => {
    let ok = true;
    ds.forEach((d, i) => {
      if (!pairNode(d, ss[i] as SpanNode)) ok = false;
    });
    return ok;
  };

  const leave = (ds: readonly Node[]): void => {
    for (const d of ds) if (d.nodeType === ELEMENT) unpaired.push(d as Element);
  };

  /** 间隙内：同形则按位置配对；否则只配两边都唯一出现的键（有序），其余留空。 */
  const pairGap = (ds: readonly Node[], ss: readonly SpanNode[]): void => {
    if (ds.length === 0 && ss.length === 0) return;
    if (positional(ds, ss)) {
      pairAll(ds, ss);
      return;
    }
    const count = (keys: string[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
      return m;
    };
    const dk = ds.map(domKey);
    const sk = ss.map(spanKey);
    const dc = count(dk);
    const sc = count(sk);
    let j0 = 0;
    let i0 = 0;
    for (let i = 0; i < ds.length; i++) {
      const k = dk[i] as string;
      if (dc.get(k) !== 1 || sc.get(k) !== 1) continue;
      const j = sk.indexOf(k);
      if (j < j0) continue;
      const subD = ds.slice(i0, i);
      const subS = ss.slice(j0, j);
      if (positional(subD, subS)) pairAll(subD, subS);
      else leave(subD);
      pairNode(ds[i] as Node, ss[j] as SpanNode);
      i0 = i + 1;
      j0 = j + 1;
    }
    const subD = ds.slice(i0);
    const subS = ss.slice(j0);
    if (positional(subD, subS)) pairAll(subD, subS);
    else leave(subD);
  };

  /** 配对两组子节点；返回是否全部配上且子树都完整。 */
  const pairChildren = (ds: readonly Node[], ss: readonly SpanNode[]): boolean => {
    if (positional(ds, ss)) return pairAll(ds, ss);
    // 有分歧：先用结构指纹的 LCS 找可靠锚点，锚点之间再逐段处理。
    const anchors: [number, number][] = [];
    const n = ds.length;
    const m = ss.length;
    if ((n + 1) * (m + 1) <= LCS_LIMIT) {
      const dh = ds.map(hashDom);
      const sh = ss.map(hashSpan);
      const w = m + 1;
      const t = new Int32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
          t[i * w + j] =
            dh[i] === sh[j]
              ? (t[(i + 1) * w + j + 1] ?? 0) + 1
              : Math.max(t[(i + 1) * w + j] ?? 0, t[i * w + j + 1] ?? 0);
      for (let i = 0, j = 0; i < n && j < m;) {
        if (dh[i] === sh[j]) anchors.push([i++, j++]);
        else if ((t[(i + 1) * w + j] ?? 0) >= (t[i * w + j + 1] ?? 0)) i++;
        else j++;
      }
    } else {
      let a = 0;
      while (a < n && a < m && hashDom(ds[a] as Node) === hashSpan(ss[a] as SpanNode)) anchors.push([a, a++]);
      const tail: [number, number][] = [];
      for (let i = n - 1, j = m - 1; i >= a && j >= a; i--, j--) {
        if (hashDom(ds[i] as Node) !== hashSpan(ss[j] as SpanNode)) break;
        tail.unshift([i, j]);
      }
      anchors.push(...tail);
    }
    let pi = 0;
    let pj = 0;
    for (const [i, j] of anchors) {
      pairGap(ds.slice(pi, i), ss.slice(pj, j));
      pairNode(ds[i] as Node, ss[j] as SpanNode);
      pi = i + 1;
      pj = j + 1;
    }
    pairGap(ds.slice(pi), ss.slice(pj));
    return false;
  };

  pairNode(doc, index.root);

  // ---- 属性改动记账（unmount 时还原） ----
  const setAttr = (el: Element, name: string, value: string): void => {
    let m = original.get(el);
    if (!m) original.set(el, (m = new Map()));
    if (!m.has(name)) m.set(name, el.getAttribute(name));
    el.setAttribute(name, value);
  };
  const restoreAttr = (el: Element, name: string): void => {
    const m = original.get(el);
    if (!m?.has(name)) return;
    const v = m.get(name) ?? null;
    if (v === null) el.removeAttribute(name);
    else el.setAttribute(name, v);
    m.delete(name);
  };

  const markGenerated = (el: Element): void => {
    if (original.get(el)?.has(GENERATED_ATTR)) return;
    setAttr(el, GENERATED_ATTR, '');
    if (!el.hasAttribute('title')) setAttr(el, 'title', GENERATED_TIP);
    options.onGenerated?.(el);
  };

  // ---- 2. 可编辑判定 ----
  /** 内容是否全为文本/注释/短语元素；返回 `null` 表示不合格，否则返回是否含非空白文本。 */
  const phrasingText = (el: Element): boolean | null => {
    let text = false;
    for (const c of childrenOf(el)) {
      if (c.nodeType === TEXT) {
        if (/\S/.test((c as Text).data)) text = true;
      } else if (c.nodeType === ELEMENT) {
        const e = c as Element;
        if (e.namespaceURI !== HTML_NS) return null;
        if (!PHRASING.has(nameOf(e)) && !nameOf(e).includes(':')) return null;
        if (e.hasAttribute('contenteditable')) return null;
        const t = phrasingText(e);
        if (t === null) return null;
        if (t) text = true;
      } else if (c.nodeType !== COMMENT) return null;
    }
    return text;
  };

  const isCandidate = (el: Element, s: ElementSpan): boolean =>
    !STRUCTURAL.has(nameOf(el)) && s.inner !== null && complete.has(el) && phrasingText(el) === true;

  const decide = (el: Element): void => {
    const s = toSpan.get(el);
    if (s?.kind !== 'element') return;
    if (el.namespaceURI !== HTML_NS || FORBIDDEN.has(nameOf(el))) return;
    if (el.hasAttribute('contenteditable')) return;
    if (isCandidate(el, s)) {
      setAttr(el, 'contenteditable', 'true');
      containers.add(el as HTMLElement);
      return;
    }
    for (const c of childrenOf(el)) if (c.nodeType === ELEMENT) decide(c as Element);
  };
  if (doc.documentElement) decide(doc.documentElement);

  if (options.markUnpaired !== false) for (const el of unpaired) markGenerated(el);

  // ---- 3. 样式 + 观察脚本改动 ----
  const style = doc.createElement('style');
  style.setAttribute(STYLE_ATTR, '');
  style.textContent = STYLE_TEXT;
  (doc.head ?? doc.documentElement)?.appendChild(style);

  const containerOf = (node: Node): HTMLElement | undefined => {
    for (let n: Node | null = node; n; n = n.parentNode)
      if (n.nodeType === ELEMENT && containers.has(n as HTMLElement)) return n as HTMLElement;
    return undefined;
  };

  const revoke = (c: HTMLElement): void => {
    if (!containers.delete(c)) return;
    restoreAttr(c, 'contenteditable');
    markGenerated(c);
  };

  const insideGenerated = (n: Node): boolean => {
    for (let p = n.parentNode; p; p = p.parentNode)
      if (p.nodeType === ELEMENT && original.get(p as Element)?.has(GENERATED_ATTR)) return true;
    return false;
  };

  const considerAdded = (n: Node): void => {
    if (n.nodeType !== ELEMENT) return;
    const el = n as Element;
    if (el === style) return;
    const s = toSpan.get(el);
    const placed = s?.parent ? toNode.get(s.parent) === el.parentNode : false;
    if (placed) return;
    for (const c of [...containers]) if (el.contains(c)) revoke(c);
    if (!insideGenerated(el)) markGenerated(el);
  };

  /** 容器级「用户编辑窗口」：beforeinput→input 或输入法组合期间。 */
  const userWindow = new Set<HTMLElement>();
  const composing = new Set<HTMLElement>();
  let userDepth = 0;

  const process = (records: readonly MutationRecord[]): void => {
    const touched = new Set<HTMLElement>();
    for (const r of records) {
      const c = containerOf(r.target);
      const user = userDepth > 0 || (c !== undefined && userWindow.has(c));
      if (user) {
        if (c) touched.add(c);
        continue;
      }
      if (c) revoke(c);
      if (r.type === 'childList') r.addedNodes.forEach(considerAdded);
    }
    for (const c of touched) if (containers.has(c)) options.onUserEdit?.(c);
  };

  const MO = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const observer = new MO(process);
  observer.observe(doc, { childList: true, characterData: true, subtree: true });
  const flush = (): void => process(observer.takeRecords());

  const targetContainer = (e: Event): HTMLElement | undefined => {
    const t = e.target as Node | null;
    return t && typeof t.nodeType === 'number' ? containerOf(t) : undefined;
  };
  const onBeforeInput = (e: Event): void => {
    const c = targetContainer(e);
    if (!c) return;
    flush();
    userWindow.add(c);
  };
  const onInput = (e: Event): void => {
    const c = targetContainer(e);
    flush();
    if (c && !composing.has(c)) userWindow.delete(c);
  };
  const onCompositionStart = (e: Event): void => {
    const c = targetContainer(e);
    if (!c) return;
    flush();
    composing.add(c);
    userWindow.add(c);
  };
  const onCompositionEnd = (e: Event): void => {
    const c = targetContainer(e);
    flush();
    if (c) {
      composing.delete(c);
      userWindow.delete(c);
    }
  };
  const listeners: [string, (e: Event) => void][] = [
    ['beforeinput', onBeforeInput],
    ['input', onInput],
    ['compositionstart', onCompositionStart],
    ['compositionend', onCompositionEnd],
  ];
  for (const [type, fn] of listeners) doc.addEventListener(type, fn, true);

  let mounted = true;

  return {
    index,
    spanOf: (node) => toSpan.get(node),
    nodeOf: (s) => toNode.get(s),
    containers() {
      const all = [...containers];
      // 文档顺序：DOCUMENT_POSITION_FOLLOWING = 4
      return all.sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1));
    },
    containerOf,
    isEditable: (node) => containerOf(node) !== undefined,
    userEdit<T>(fn: () => T): T {
      if (mounted) flush();
      userDepth++;
      try {
        return fn();
      } finally {
        if (mounted) flush();
        userDepth--;
      }
    },
    flush() {
      if (mounted) flush();
    },
    transfer(from, to) {
      const s = toSpan.get(from);
      if (!s) return;
      toSpan.delete(from);
      toSpan.set(to, s);
      toNode.set(s, to);
      if (complete.has(from)) complete.add(to);
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      observer.takeRecords();
      observer.disconnect();
      for (const [type, fn] of listeners) doc.removeEventListener(type, fn, true);
      for (const [el, m] of original)
        for (const [name, v] of m) {
          if (v === null) el.removeAttribute(name);
          else el.setAttribute(name, v);
        }
      original.clear();
      containers.clear();
      userWindow.clear();
      composing.clear();
      style.remove();
    },
  };
}
