/**
 * 基础格式工具栏（T2.8）：粗体 / 斜体 / 链接 / 标题级别。
 *
 * 命令直接用 Range / Selection 改 DOM，而不是 `document.execCommand`（已废弃、各浏览器结果不一致，
 * 且 Chrome 不为它派发 `beforeinput`，保真模式的挂载层会把它当成脚本改动）。
 *
 * ## 宿主
 *
 * 工具栏不依赖具体编辑模式，只通过 {@link ToolbarHost} 与宿主交互。保真模式下由
 * `@edithtml/importer` 的 `preserveToolbarHost(session)` 适配：`run` 包在 `mount.userEdit` 里，
 * `touch` 记为已改动，`adopt` 把改了标签名的新块登记为容器，`ownsAttribute` 让复制属性时跳过挂载层加的属性。
 *
 * ## 命令语义
 *
 * - **粗体 / 斜体**：选区内所有非空文本都已带该格式 → 去掉（只去掉选中部分，两侧拆成原元素与浅克隆）；
 *   否则给未带格式的部分包上标签。标签沿用文件已有写法：容器（其次是整个文档）只用 `<b>` 时用 `<b>`，否则 `<strong>`；
 *   斜体同理 `<i>` / `<em>`。折叠选区不做任何事。
 * - **链接**：{@link setLink} 选区整体在一个链接内时改 `href`；否则先去掉选中部分已有的链接再包 `<a href>`；
 *   折叠选区插入以 URL 为文字的链接。{@link removeLink} 去掉选中部分的链接，折叠时去掉光标所在的整个链接。
 *   URL 先经 {@link sanitizeLinkUrl}：拒绝 `javascript:` / `vbscript:` / `data:` 等协议。
 * - **标题级别**：容器本身是 `p` / `h1`–`h6` 时可切换；新建目标标签元素，复制属性、**移动**（而非复制）子节点，
 *   于是保真模式补丁层对子节点仍按原文字节输出，变化只在开始/结束标签。
 *
 * 拆分文本节点只在选区边界处进行；工具栏自己拆出来的文本节点在命令结束时与左邻文本合并，
 * 所以「加粗再取消」会回到原来的单个文本节点（原文字节不变）。
 *
 * @module
 */

const TEXT = 3;
const ELEMENT = 1;

/** 工具栏需要的宿主能力。 */
export interface ToolbarHost {
  /** 被编辑的文档（选区、键盘事件都取自它）。 */
  readonly doc: Document;
  /** 执行一次 DOM 改动（保真模式：包在 `mount.userEdit` 中，否则会被当作脚本改动标灰）。 */
  run<T>(fn: () => T): T;
  /** `node` 是否位于可编辑容器内。 */
  isEditable(node: Node): boolean;
  /** `node` 所在（或自身即是）的可编辑容器。 */
  containerOf(node: Node): HTMLElement | undefined;
  /** 命令改完后标记改动（保真模式：`session.touch`）。 */
  touch?(node: Node): void;
  /** 把新建的块（改了标签名的标题/段落）登记为可编辑容器。 */
  adopt?(el: HTMLElement): boolean;
  /** 属性是否由宿主添加（如保真挂载层的 `contenteditable`）；改标签名时不复制这些属性。 */
  ownsAttribute?(el: Element, name: string): boolean;
}

/** 块级别：0 = 段落 `<p>`，1–6 = `<h1>`–`<h6>`。 */
export type BlockLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** 当前选区的格式状态（按钮高亮用）。 */
export interface FormatState {
  /** 选区是否在（同一个）可编辑容器内；否则所有命令禁用。 */
  readonly enabled: boolean;
  readonly bold: boolean;
  readonly italic: boolean;
  /** 选区所在链接的 `href`；不在链接内为 `null`。 */
  readonly link: string | null;
  /** 容器的块级别；容器不是 `p` / `h1`–`h6`（如 `li`、`td`）时为 `null`。 */
  readonly block: BlockLevel | null;
}

const DISABLED: FormatState = { enabled: false, bold: false, italic: false, link: null, block: null };

const BOLD_TAGS = ['strong', 'b'] as const;
const ITALIC_TAGS = ['em', 'i'] as const;
const LINK_TAGS = ['a'] as const;
const BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

/** 工具栏拆分出来的文本节点：命令结束时与左邻文本合并回去。 */
const splitOff = new WeakSet<Text>();

// ---------------------------------------------------------------------------
// URL 校验

/** 允许的链接协议。 */
const SAFE_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'tel', 'ftp']);

/**
 * 校验并规范化用户输入的链接地址；不安全或无效时返回 `null`。
 *
 * - 去掉首尾空白；含控制字符的一律拒绝；
 * - 带协议的只允许 `http(s)` / `mailto` / `tel` / `ftp`（`javascript:`、`vbscript:`、`data:` 等被拒绝，
 *   浏览器会忽略协议中的制表符/换行，所以先去掉它们再判断）；
 * - 相对地址、`#锚点`、`//host` 原样保留；形如 `example.com/x` 的裸域名补上 `https://`。
 */
export function sanitizeLinkUrl(input: string): string | null {
  const url = input.trim();
  if (url === '') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url)) return null;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (m) {
    const scheme = (m[1] ?? '').toLowerCase();
    // `localhost:8080` 这类「主机:端口」不是协议
    if (!SAFE_SCHEMES.has(scheme) && !/^[a-z0-9.-]+:\d+(\/|$)/i.test(url)) return null;
    return url;
  }
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(url) && !url.startsWith('.')) return `https://${url}`;
  return url;
}

// ---------------------------------------------------------------------------
// 选区

interface Point {
  node: Node;
  offset: number;
}

interface Ctx {
  host: ToolbarHost;
  container: HTMLElement;
  range: Range;
}

const nameOf = (n: Node): string => (n.nodeType === ELEMENT ? (n as Element).localName : '');
const isText = (n: Node | null): n is Text => n !== null && n.nodeType === TEXT;
const len = (n: Node): number => (isText(n) ? n.data.length : n.childNodes.length);

function currentRange(host: ToolbarHost): Range | undefined {
  const sel = host.doc.getSelection();
  if (!sel || sel.rangeCount === 0) return undefined;
  return sel.getRangeAt(0);
}

/** 选区所在的可编辑容器；两端不在同一容器时为 `undefined`。 */
function context(host: ToolbarHost, range = currentRange(host)): Ctx | undefined {
  if (!range) return undefined;
  if (!host.isEditable(range.startContainer) || !host.isEditable(range.endContainer)) return undefined;
  const container = host.containerOf(range.startContainer);
  if (!container || container !== host.containerOf(range.endContainer)) return undefined;
  return { host, container, range };
}

function select(host: ToolbarHost, start: Point, end: Point): void {
  const sel = host.doc.getSelection();
  if (!sel) return;
  const r = host.doc.createRange();
  r.setStart(start.node, start.offset);
  r.setEnd(end.node, end.offset);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** 叶子：文本节点与没有子节点的元素（`br`、`img`…）。 */
function leavesOf(root: Node): Node[] {
  const out: Node[] = [];
  const walk = (n: Node): void => {
    if (!n.firstChild) {
      out.push(n);
      return;
    }
    for (let c: Node | null = n.firstChild; c; c = c.nextSibling) walk(c);
  };
  for (let c: Node | null = root.firstChild; c; c = c.nextSibling) walk(c);
  return out;
}

function firstLeaf(n: Node): Node {
  let x = n;
  while (x.firstChild) x = x.firstChild;
  return x;
}

function lastLeaf(n: Node): Node {
  let x = n;
  while (x.lastChild) x = x.lastChild;
  return x;
}

/** 在选区边界处拆分文本节点，返回边界对齐到节点之后的起止点。 */
function splitBoundaries(range: Range): { start: Point; end: Point } {
  let sc = range.startContainer;
  let so = range.startOffset;
  let ec = range.endContainer;
  let eo = range.endOffset;
  if (isText(ec) && eo > 0 && eo < ec.data.length) {
    const right = ec.splitText(eo);
    splitOff.add(right);
  }
  if (isText(sc) && so > 0 && so < sc.data.length) {
    const right = sc.splitText(so);
    splitOff.add(right);
    if (ec === sc) {
      ec = right;
      eo -= so;
    }
    sc = right;
    so = 0;
  }
  return { start: { node: sc, offset: so }, end: { node: ec, offset: eo } };
}

/** 选中的叶子（按文档顺序、连续）。 */
interface Selected {
  leaves: Node[];
  /** 容器内全部叶子 → 下标。 */
  index: Map<Node, number>;
  from: number;
  to: number;
}

function selectedLeaves(container: HTMLElement, start: Point, end: Point): Selected {
  const all = leavesOf(container);
  const index = new Map<Node, number>();
  all.forEach((n, i) => index.set(n, i));
  const at = (n: Node): number => index.get(n) ?? -1;
  // 起点：该点之后的第一个叶子
  let from: number;
  if (isText(start.node)) from = start.offset < start.node.data.length ? at(start.node) : at(start.node) + 1;
  else if (!start.node.firstChild) from = at(start.node);
  else {
    const child = start.node.childNodes[start.offset];
    from = child ? at(firstLeaf(child)) : at(lastLeaf(start.node)) + 1;
  }
  // 终点：该点之前的最后一个叶子
  let to: number;
  if (isText(end.node)) to = end.offset > 0 ? at(end.node) : at(end.node) - 1;
  else if (!end.node.firstChild) to = at(end.node) - 1;
  else {
    const child = end.offset > 0 ? end.node.childNodes[end.offset - 1] : undefined;
    to = child ? at(lastLeaf(child)) : at(firstLeaf(end.node)) - 1;
  }
  if (from < 0) from = 0;
  if (to >= all.length) to = all.length - 1;
  return { leaves: from <= to ? all.slice(from, to + 1) : [], index, from, to };
}

/** `n` 到容器（含）之间是否有标签属于 `tags` 的祖先（含自身）；返回最近的一个。 */
function markAncestor(n: Node, container: HTMLElement, tags: readonly string[]): Element | undefined {
  for (let x: Node | null = n; x; x = x.parentNode) {
    if (x.nodeType === ELEMENT && tags.includes(nameOf(x))) return x as Element;
    if (x === container) break;
  }
  return undefined;
}

/** 最外层（容器之下）的 `tags` 祖先。 */
function outerMark(n: Node, container: HTMLElement, tags: readonly string[]): Element | undefined {
  let found: Element | undefined;
  for (let x: Node | null = n.parentNode; x && x !== container; x = x.parentNode)
    if (x.nodeType === ELEMENT && tags.includes(nameOf(x))) found = x as Element;
  if (n.nodeType === ELEMENT && n !== container && tags.includes(nameOf(n)) && !found) found = n as Element;
  return found;
}

const textLeaves = (leaves: readonly Node[]): Text[] => leaves.filter((n): n is Text => isText(n) && n.data !== '');

function allMarked(leaves: readonly Node[], container: HTMLElement, tags: readonly string[]): boolean {
  const ts = textLeaves(leaves);
  return ts.length > 0 && ts.every((t) => markAncestor(t, container, tags) !== undefined);
}

// ---------------------------------------------------------------------------
// DOM 变换

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  el.remove();
}

/** 把 `node` 与其后的兄弟移入 `to`。 */
function moveFrom(node: Node, to: Node): void {
  let n: Node | null = node;
  while (n) {
    const next: Node | null = n.nextSibling;
    to.appendChild(n);
    n = next;
  }
}

/**
 * 在 `node` 之前把 `anc` 切成两半：`anc` 保留前半，后半（从 `node` 开始）放进浅克隆并插在 `anc` 之后。
 * 某一层 `node` 之前没有内容时不切这一层；`node` 之前整个 `anc` 都没有内容时直接返回 `anc` 本身。
 */
function splitBefore(anc: Element, node: Node): Element {
  let cur: Node = node;
  while (cur.parentNode && cur.parentNode !== anc) {
    const p = cur.parentNode as Element;
    if (cur.previousSibling) {
      const right = p.cloneNode(false) as Element;
      moveFrom(cur, right);
      p.after(right);
      cur = right;
    } else cur = p;
  }
  if (!cur.previousSibling) return anc;
  const right = anc.cloneNode(false) as Element;
  moveFrom(cur, right);
  anc.after(right);
  return right;
}

/** `anc` 内、`node` 子树之后的第一个节点。 */
function nextWithin(node: Node, anc: Node): Node | null {
  for (let x: Node | null = node; x && x !== anc; x = x.parentNode) if (x.nextSibling) return x.nextSibling;
  return null;
}

/** 去掉选中叶子上的 `tags` 格式（只去掉选中部分）。 */
function removeMark(ctx: Ctx, leaves: readonly Node[], tags: readonly string[]): void {
  const marks: Element[] = [];
  for (const l of leaves) {
    const m = outerMark(l, ctx.container, tags);
    if (m && !marks.includes(m)) marks.push(m);
  }
  for (const m of marks) {
    const inside = leaves.filter((l) => m.contains(l));
    const first = inside[0];
    const last = inside[inside.length - 1];
    if (!first || !last) continue;
    const mid = splitBefore(m, first);
    const after = nextWithin(last, mid);
    if (after) splitBefore(mid, after);
    for (const inner of Array.from(mid.querySelectorAll(tags.join(',')))) unwrap(inner);
    unwrap(mid);
  }
}

/** 选中叶子的最高层整体选中祖先（不越过容器），按文档顺序分成连续兄弟段。 */
function runsOf(container: HTMLElement, sel: Selected): Node[][] {
  const inSel = (n: Node): boolean => {
    const a = sel.index.get(firstLeaf(n)) ?? -1;
    const b = sel.index.get(lastLeaf(n)) ?? -1;
    return a >= sel.from && b <= sel.to && a >= 0;
  };
  const tops: Node[] = [];
  for (const l of sel.leaves) {
    let n = l;
    while (n.parentNode && n.parentNode !== container && inSel(n.parentNode)) n = n.parentNode;
    if (tops[tops.length - 1] !== n) tops.push(n);
  }
  const runs: Node[][] = [];
  for (const t of tops) {
    const run = runs[runs.length - 1];
    const prev = run?.[run.length - 1];
    if (run && prev && prev.nextSibling === t) run.push(t);
    else runs.push([t]);
  }
  return runs;
}

/** 把每段包进 `make()` 新建的元素，去掉其内部同类标签，并与相邻的无属性同名元素合并。 */
function wrapRuns(ctx: Ctx, sel: Selected, tags: readonly string[], make: () => Element): void {
  for (const run of runsOf(ctx.container, sel)) {
    const head = run[0];
    if (!head?.parentNode) continue;
    if (markAncestor(head.parentNode, ctx.container, tags)) continue;
    if (run.every((n) => isText(n) && n.data === '')) continue;
    const w = make();
    head.parentNode.insertBefore(w, head);
    for (const n of run) w.appendChild(n);
    for (const inner of Array.from(w.querySelectorAll(tags.join(',')))) unwrap(inner);
    if (w.attributes.length === 0) mergeSiblings(w);
  }
}

/** 与相邻的、无属性的同名元素合并（只合并到左边元素中，保住已有元素的身份）。 */
function mergeSiblings(w: Element): void {
  const same = (n: Node | null): n is Element =>
    n !== null && n.nodeType === ELEMENT && nameOf(n) === nameOf(w) && (n as Element).attributes.length === 0;
  let keep = w;
  const prev = w.previousSibling;
  if (same(prev)) {
    if (w.firstChild) moveFrom(w.firstChild, prev);
    w.remove();
    keep = prev;
  }
  const next = keep.nextSibling;
  if (same(next)) {
    if (next.firstChild) moveFrom(next.firstChild, keep);
    next.remove();
  }
}

/** 把工具栏拆出来的文本节点合并回左邻文本，并相应移动选区端点。 */
function mergeSplits(container: HTMLElement, points: Point[]): void {
  const texts: Text[] = [];
  const w = container.ownerDocument.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = w.nextNode(); n; n = w.nextNode()) texts.push(n as Text);
  for (const t of texts) {
    if (!splitOff.has(t) || !t.parentNode) continue;
    const prev = t.previousSibling;
    if (!isText(prev)) continue;
    const shift = prev.data.length;
    prev.appendData(t.data);
    for (const p of points) {
      if (p.node === t) {
        p.node = prev;
        p.offset += shift;
      } else if (p.node === t.parentNode) {
        const i = Array.prototype.indexOf.call(p.node.childNodes, t) as number;
        if (p.offset > i) p.offset--;
      }
    }
    splitOff.delete(t);
    t.remove();
  }
}

function startOf(n: Node): Point {
  if (isText(n) || !n.parentNode) return { node: n, offset: 0 };
  return { node: n.parentNode, offset: Array.prototype.indexOf.call(n.parentNode.childNodes, n) as number };
}

function endOf(n: Node): Point {
  if (isText(n) || !n.parentNode) return { node: n, offset: len(n) };
  return { node: n.parentNode, offset: (Array.prototype.indexOf.call(n.parentNode.childNodes, n) as number) + 1 };
}

/** 选择粗体/斜体标签：沿用容器（其次是文档）已有的写法。 */
function pickTag(ctx: Ctx, preferred: string, legacy: string): string {
  const uses = (root: ParentNode, tag: string): boolean => root.querySelector(tag) !== null;
  for (const root of [ctx.container, ctx.host.doc.body ?? ctx.host.doc]) {
    if (!root) continue;
    const p = uses(root, preferred);
    const l = uses(root, legacy);
    if (p !== l) return l ? legacy : preferred;
    if (p) return preferred;
  }
  return preferred;
}

/** 在当前选区上执行一次行内变换，结束后恢复选区并标记改动。 */
function inline(host: ToolbarHost, fn: (ctx: Ctx, sel: Selected) => void): boolean {
  const ctx = context(host);
  if (!ctx || ctx.range.collapsed) return false;
  const points = host.run(() => {
    const { start, end } = splitBoundaries(ctx.range);
    const sel = selectedLeaves(ctx.container, start, end);
    const first = sel.leaves[0];
    const last = sel.leaves[sel.leaves.length - 1];
    if (!first || !last) return undefined;
    fn(ctx, sel);
    const ps = [startOf(first), endOf(last)];
    mergeSplits(ctx.container, ps);
    return ps;
  });
  if (!points) return false;
  host.touch?.(ctx.container);
  const [s, e] = points;
  if (s && e) select(host, s, e);
  return true;
}

function toggleMark(host: ToolbarHost, tags: readonly [string, string]): boolean {
  return inline(host, (ctx, sel) => {
    if (allMarked(sel.leaves, ctx.container, tags)) removeMark(ctx, sel.leaves, tags);
    else {
      const tag = pickTag(ctx, tags[0], tags[1]);
      wrapRuns(ctx, sel, tags, () => host.doc.createElement(tag));
    }
  });
}

// ---------------------------------------------------------------------------
// 公共命令

/** 切换粗体。返回是否执行了改动。 */
export function toggleBold(host: ToolbarHost): boolean {
  return toggleMark(host, BOLD_TAGS);
}

/** 切换斜体。返回是否执行了改动。 */
export function toggleItalic(host: ToolbarHost): boolean {
  return toggleMark(host, ITALIC_TAGS);
}

/** 光标/选区所在的链接元素（选区两端须在同一个链接内）。 */
function linkAt(ctx: Ctx): HTMLAnchorElement | undefined {
  const a = markAncestor(ctx.range.startContainer, ctx.container, LINK_TAGS);
  if (!a || a !== markAncestor(ctx.range.endContainer, ctx.container, LINK_TAGS)) return undefined;
  return a as HTMLAnchorElement;
}

/**
 * 给选区加链接（或修改所在链接的地址）。`url` 不安全/无效时不做改动并返回 `false`。
 */
export function setLink(host: ToolbarHost, url: string): boolean {
  const href = sanitizeLinkUrl(url);
  const ctx = context(host);
  if (href === null || !ctx) return false;
  const existing = linkAt(ctx);
  if (existing) {
    host.run(() => existing.setAttribute('href', href));
    host.touch?.(ctx.container);
    return true;
  }
  if (ctx.range.collapsed) {
    const a = host.doc.createElement('a');
    a.setAttribute('href', href);
    a.textContent = href;
    host.run(() => {
      const { node, offset } = { node: ctx.range.startContainer, offset: ctx.range.startOffset };
      if (isText(node)) {
        if (offset === 0) node.before(a);
        else if (offset >= node.data.length) node.after(a);
        else {
          const right = node.splitText(offset);
          right.before(a);
        }
      } else node.insertBefore(a, node.childNodes[offset] ?? null);
    });
    host.touch?.(ctx.container);
    const t = a.firstChild;
    if (t) select(host, { node: t, offset: 0 }, { node: t, offset: len(t) });
    return true;
  }
  return inline(host, (c, sel) => {
    removeMark(c, sel.leaves, LINK_TAGS);
    wrapRuns(c, sel, LINK_TAGS, () => {
      const a = host.doc.createElement('a');
      a.setAttribute('href', href);
      return a;
    });
  });
}

/** 去掉链接：选区非折叠时只去掉选中部分，折叠时去掉光标所在的整个链接。 */
export function removeLink(host: ToolbarHost): boolean {
  const ctx = context(host);
  if (!ctx) return false;
  if (ctx.range.collapsed) {
    const a = markAncestor(ctx.range.startContainer, ctx.container, LINK_TAGS);
    if (!a || a === ctx.container) return false;
    const { startContainer: n, startOffset: o } = ctx.range;
    host.run(() => unwrap(a));
    host.touch?.(ctx.container);
    if (n.isConnected) select(host, { node: n, offset: o }, { node: n, offset: o });
    return true;
  }
  if (!hitLeaves(ctx).some((l) => outerMark(l, ctx.container, LINK_TAGS))) return false;
  return inline(host, (c, sel) => removeMark(c, sel.leaves, LINK_TAGS));
}

const levelOf = (el: Element): BlockLevel | null => {
  const i = (BLOCK_TAGS as readonly string[]).indexOf(nameOf(el));
  return i < 0 ? null : (i as BlockLevel);
};

/**
 * 把选区所在的块改成段落（`level = 0`）或 `<h1>`–`<h6>`。保留属性（宿主自己加的除外）与全部子节点（移动，不复制）。
 * 返回是否执行了改动。
 */
export function setBlockLevel(host: ToolbarHost, level: BlockLevel): boolean {
  const ctx = context(host);
  if (!ctx) return false;
  const old = ctx.container;
  const cur = levelOf(old);
  if (cur === null || cur === level || !old.parentNode) return false;
  const r = ctx.range;
  const s: Point = { node: r.startContainer, offset: r.startOffset };
  const e: Point = { node: r.endContainer, offset: r.endOffset };
  const tag = BLOCK_TAGS[level];
  const el = old.namespaceURI ? host.doc.createElementNS(old.namespaceURI, tag) : host.doc.createElement(tag);
  host.run(() => {
    for (const a of Array.from(old.attributes)) {
      if (host.ownsAttribute?.(old, a.name)) continue;
      if (a.namespaceURI) el.setAttributeNS(a.namespaceURI, a.name, a.value);
      else el.setAttribute(a.name, a.value);
    }
    while (old.firstChild) el.appendChild(old.firstChild);
    old.replaceWith(el);
  });
  const nel = el as HTMLElement;
  host.adopt?.(nel);
  host.touch?.(nel);
  for (const p of [s, e]) if (p.node === old) p.node = nel;
  if (nel.contains(s.node) && nel.contains(e.node)) select(host, s, e);
  return true;
}

/** 当前选区的格式状态。 */
export function formatState(host: ToolbarHost): FormatState {
  const ctx = context(host);
  if (!ctx) return DISABLED;
  const { container, range } = ctx;
  const block = levelOf(container);
  if (range.collapsed) {
    const n = range.startContainer;
    return {
      enabled: true,
      bold: markAncestor(n, container, BOLD_TAGS) !== undefined,
      italic: markAncestor(n, container, ITALIC_TAGS) !== undefined,
      link: linkAt(ctx)?.getAttribute('href') ?? null,
      block,
    };
  }
  // 不拆分文本：按与选区相交的文本叶子判断
  const leaves = hitLeaves(ctx);
  const a = linkAt(ctx);
  return {
    enabled: true,
    bold: allMarked(leaves, container, BOLD_TAGS),
    italic: allMarked(leaves, container, ITALIC_TAGS),
    link: a?.getAttribute('href') ?? (allMarked(leaves, container, LINK_TAGS) ? '' : null),
    block,
  };
}

/** 与选区有非空交集的文本叶子（不拆分文本节点）。 */
function hitLeaves(ctx: Ctx): Text[] {
  const { range, container } = ctx;
  const r = container.ownerDocument.createRange();
  return textLeaves(leavesOf(container)).filter((t) => {
    r.selectNodeContents(t);
    // range.start < t.end && range.end > t.start（1 = START_TO_END，3 = END_TO_START）
    return range.compareBoundaryPoints(1, r) > 0 && range.compareBoundaryPoints(3, r) < 0;
  });
}

// ---------------------------------------------------------------------------
// UI

/** {@link mountToolbar} 的选项。 */
export interface ToolbarOptions {
  /** 询问链接地址（默认 `window.prompt`）。返回 `null` 表示取消。 */
  prompt?: (message: string, initial: string) => string | null;
  /** 链接地址被拒绝时的提示（默认 `window.alert`）。 */
  onInvalidUrl?: (input: string) => void;
}

/** {@link mountToolbar} 的返回值。 */
export interface Toolbar {
  /** 工具栏根元素（`role="toolbar"`）。 */
  readonly element: HTMLElement;
  /** 当前格式状态。 */
  state(): FormatState;
  /** 按当前选区刷新按钮状态（选区变化时自动调用）。 */
  update(): void;
  /** 执行一个命令（与点击按钮相同）。 */
  exec(cmd: 'bold' | 'italic' | 'link'): boolean;
  /** 移除 DOM 与全部监听。 */
  destroy(): void;
}

/** 工具栏元素上的标记属性（宿主可据此把它排除在序列化之外）。 */
export const TOOLBAR_ATTR = 'data-eh-toolbar';

/**
 * 挂载格式工具栏。
 *
 * - 传入 `container`：固定工具栏，追加到该元素内，始终可见，选区不在可编辑容器内时按钮禁用；
 * - 省略：浮动工具栏，追加到 `host.doc.body`，跟随选区显示，选区不可编辑时隐藏。
 *
 * **保真模式**必须传入不属于被编辑文档序列化范围的 `container`（例如打开器自身页面上的元素）：
 * 工具栏若插在被编辑文档里，会被挂载层当作脚本生成内容标灰，且可能被写进保存结果。
 *
 * 键盘快捷键（`Ctrl/Cmd + B / I / K`）监听在 `host.doc` 上。
 */
export function mountToolbar(host: ToolbarHost, container?: HTMLElement, options: ToolbarOptions = {}): Toolbar {
  const uiDoc = container?.ownerDocument ?? host.doc;
  const floating = !container;
  const root = uiDoc.createElement('div');
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', '格式工具栏');
  root.setAttribute(TOOLBAR_ATTR, '');
  root.className = 'eh-toolbar';
  if (floating) {
    root.style.position = 'fixed';
    root.style.zIndex = '2147483647';
    root.hidden = true;
  }

  const view = host.doc.defaultView;
  const ask =
    options.prompt ??
    ((m: string, d: string): string | null => (typeof view?.prompt === 'function' ? view.prompt(m, d) : null));
  const invalid =
    options.onInvalidUrl ??
    ((u: string): void => {
      if (typeof view?.alert === 'function') view.alert(`链接地址无效或不安全：${u}`);
    });

  const button = (
    label: string,
    text: string,
    cmd: 'bold' | 'italic' | 'link',
    shortcut: string,
  ): HTMLButtonElement => {
    const b = uiDoc.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-keyshortcuts', shortcut);
    b.title = `${label}（${shortcut.replace('Control', 'Ctrl')}）`;
    b.dataset['cmd'] = cmd;
    // 保住被编辑文档里的选区
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      exec(cmd);
    });
    root.appendChild(b);
    return b;
  };
  const bBold = button('粗体', 'B', 'bold', 'Control+B');
  const bItalic = button('斜体', 'I', 'italic', 'Control+I');
  const bLink = button('链接', '链接', 'link', 'Control+K');
  bBold.style.fontWeight = 'bold';
  bItalic.style.fontStyle = 'italic';

  const level = uiDoc.createElement('select');
  level.setAttribute('aria-label', '标题级别');
  const labels = ['正文', '标题 1', '标题 2', '标题 3', '标题 4', '标题 5', '标题 6'];
  labels.forEach((l, i) => {
    const o = uiDoc.createElement('option');
    o.value = String(i);
    o.textContent = l;
    level.appendChild(o);
  });
  let saved: Range | undefined;
  level.addEventListener('mousedown', () => {
    saved = currentRange(host)?.cloneRange();
  });
  level.addEventListener('change', () => {
    if (saved && !context(host)) restore(saved);
    setBlockLevel(host, Number(level.value) as BlockLevel);
    update();
  });
  root.appendChild(level);

  const restore = (r: Range): void => {
    const sel = host.doc.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(r);
  };

  const link = (): boolean => {
    const st = formatState(host);
    if (!st.enabled) return false;
    const r = currentRange(host)?.cloneRange();
    const input = ask('链接地址（留空则移除链接）', st.link ?? 'https://');
    if (r) restore(r);
    if (input === null) return false;
    if (input.trim() === '') return st.link !== null ? removeLink(host) : false;
    if (sanitizeLinkUrl(input) === null) {
      invalid(input);
      return false;
    }
    return setLink(host, input);
  };

  const exec = (cmd: 'bold' | 'italic' | 'link'): boolean => {
    const ok = cmd === 'bold' ? toggleBold(host) : cmd === 'italic' ? toggleItalic(host) : link();
    update();
    return ok;
  };

  const update = (): void => {
    const st = formatState(host);
    for (const [b, on] of [
      [bBold, st.bold],
      [bItalic, st.italic],
      [bLink, st.link !== null],
    ] as const) {
      b.disabled = !st.enabled;
      b.setAttribute('aria-pressed', String(on));
    }
    level.disabled = st.block === null;
    level.value = String(st.block ?? 0);
    if (floating) {
      root.hidden = !st.enabled;
      const r = st.enabled ? currentRange(host) : undefined;
      const rect = r && typeof r.getBoundingClientRect === 'function' ? r.getBoundingClientRect() : undefined;
      if (rect) {
        root.style.left = `${Math.max(0, rect.left)}px`;
        root.style.top = `${Math.max(0, rect.top - 40)}px`;
      }
    }
  };

  const onKey = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    const cmd = k === 'b' ? 'bold' : k === 'i' ? 'italic' : k === 'k' ? 'link' : undefined;
    if (!cmd || !formatState(host).enabled) return;
    e.preventDefault();
    exec(cmd);
  };

  host.doc.addEventListener('keydown', onKey, true);
  host.doc.addEventListener('selectionchange', update);
  (container ?? host.doc.body ?? host.doc.documentElement)?.appendChild(root);
  update();

  return {
    element: root,
    state: () => formatState(host),
    update,
    exec,
    destroy() {
      host.doc.removeEventListener('keydown', onKey, true);
      host.doc.removeEventListener('selectionchange', update);
      root.remove();
    },
  };
}
