/**
 * 区域源码编辑器（T2.5，docs/06-import.md §2「页面脚本的处理」最后一条）：每个顶层区域提供「编辑 HTML 源码」入口，
 * 弹层里改的是该区域对应的源码区间（{@link PreserveSession.replaceSource}）。
 *
 * 本模块只含与编辑器实现无关的部分：
 * - {@link sourceRegions}：列出可编辑源码的区域；
 * - {@link createSourcePopover}：悬停按钮、弹层、预览/应用/取消的状态机。代码编辑器由调用方注入
 *   （{@link SourceEditorFactory}；`apps/web` 注入按需加载的 CodeMirror 6），importer 不依赖 CodeMirror。
 *
 * ## 哪些区域
 *
 * - 顶层区域：`<body>` 的已配对子元素；若是 `<main>` / `<article>` 包装（或 body 中唯一的 `div`/`section` 包装），
 *   改为取它的子元素。`script/style/link/meta/template/noscript` 不算区域；
 * - 标灰区域：含脚本生成内容（`data-eh-generated`）的元素向上找到的最近已配对元素；不是顶层区域时作为嵌套区域单独列出；
 * - 图表占位：标灰区域、或没有文字的空占位元素（脚本未运行时的图表容器），连同紧随其后的行内 `<script>`
 *   （中间只隔空白/注释，且在源码中同属一个父元素）作为一个区域——编辑的是「容器 + 生成它的脚本」这段源码。
 *
 * ## 界面放在宿主页面
 *
 * 按钮、高亮框、弹层都插在**宿主**文档（打开器页面）里，用 `position: fixed` 按 iframe 的位置换算坐标；
 * 被编辑的文档里不插任何节点（否则会被挂载层当成脚本改动标灰，或被序列化进文件）。
 * 只在被编辑的文档上挂 `mousemove` / `scroll` 监听。弹层打开时用遮罩挡住 iframe（模态），
 * 这样预览期间撤销栈顶一定是预览那一步。
 *
 * ## 预览
 *
 * 开启「实时预览」时，编辑停顿 `previewDelay` 毫秒后把当前源码真正替换进页面（一步历史）；下一次预览或取消时
 * 先撤销上一次预览并丢弃其 redo。应用 = 保留最后一次预览（与编辑器内容一致时）或重新替换；取消 = 撤销预览。
 * 因此不论预览多少次，应用后都只占一步撤销。
 *
 * @module
 */
import type { PreserveSession, SourceTarget } from './edit.js';
import { GENERATED_ATTR } from './mount.js';

const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;

/** 不作为区域的元素。 */
const SKIP: ReadonlySet<string> = new Set(['script', 'style', 'link', 'meta', 'template', 'noscript', 'base', 'title']);
/** 向内展开的包装元素。 */
const WRAPPERS: ReadonlySet<string> = new Set(['main', 'article']);

/** 一个可编辑源码的区域：同一父元素下从 `first` 到 `last`（含）的一段兄弟。 */
export interface SourceRegion {
  readonly first: Element;
  readonly last: Element;
  /** 区域内有脚本生成（标灰）的内容。 */
  readonly generated: boolean;
  /** 简短描述，如 `div#pv-chart`、`p「本周 PV 在周三达…」`。 */
  readonly label: string;
}

const tagOf = (el: Element): string => el.localName.toLowerCase();

/** 区域覆盖的元素（`first` … `last` 之间的元素兄弟）。 */
export function regionElements(r: SourceTarget): Element[] {
  const { first, last } = 'first' in r ? r : { first: r, last: r };
  const out: Element[] = [];
  for (let n: Node | null = first; n; n = n.nextSibling) {
    if (n.nodeType === ELEMENT) out.push(n as Element);
    if (n === last) break;
  }
  return out;
}

/** `node` 是否落在区域内。 */
export function regionContains(r: SourceRegion, node: Node): boolean {
  return regionElements(r).some((el) => el.contains(node));
}

function labelOf(el: Element): string {
  let s = tagOf(el);
  const id = el.getAttribute('id');
  const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/)[0];
  if (id) s += `#${id}`;
  else if (cls) s += `.${cls}`;
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text) s += `「${text.length > 14 ? `${text.slice(0, 14)}…` : text}」`;
  return s;
}

/**
 * 列出可以「编辑 HTML 源码」的区域，按文档顺序（嵌套区域排在其外层区域之后）。
 *
 * @param doc 会话所在的文档。
 */
export function sourceRegions(session: PreserveSession, doc: Document): SourceRegion[] {
  const { mount } = session;
  const body = doc.body;
  if (!body) return [];
  const paired = (el: Element): boolean => {
    const s = mount.spanOf(el);
    return s?.kind === 'element' && s.span !== null && s.startTag !== null;
  };
  const isRegion = (el: Element): boolean => paired(el) && !SKIP.has(tagOf(el)) && !mount.scriptMade(el);

  interface Draft {
    first: Element;
    last: Element;
    generated: boolean;
  }
  const drafts: Draft[] = [];
  const wrappers = new Set<Element>();
  const walk = (parent: Element, depth: number): void => {
    const kids = Array.from(parent.children).filter(isRegion);
    const sole = parent === body && kids.length === 1 ? kids[0] : undefined;
    for (const el of kids) {
      const t = tagOf(el);
      const wraps = WRAPPERS.has(t) || (el === sole && (t === 'div' || t === 'section'));
      if (depth < 3 && wraps && Array.from(el.children).some(isRegion)) {
        wrappers.add(el);
        walk(el, depth + 1);
      } else drafts.push({ first: el, last: el, generated: false });
    }
  };
  walk(body, 0);

  // 标灰区域
  const nested: Draft[] = [];
  for (const g of Array.from(body.querySelectorAll(`[${GENERATED_ATTR}]`))) {
    let r: Element | null = g;
    while (r && !paired(r)) r = r.parentElement;
    if (!r || r === body || !body.contains(r) || wrappers.has(r) || SKIP.has(tagOf(r))) continue;
    const top = drafts.find((d) => d.first === r);
    if (top) {
      top.generated = true;
      continue;
    }
    const known = nested.find((d) => d.first === r);
    if (known) continue;
    nested.push({ first: r, last: r, generated: true });
  }

  const textless = (el: Element): boolean => !/\S/.test(el.textContent ?? '');
  /** 图表占位连同其后的行内脚本。 */
  const extend = (d: Draft): void => {
    if (!d.generated && !textless(d.first)) return;
    const parentSpan = mount.spanOf(d.first)?.parent;
    for (let n = d.last.nextSibling; n; n = n.nextSibling) {
      if (n.nodeType === COMMENT || (n.nodeType === TEXT && !/\S/.test((n as Text).data))) continue;
      if (n.nodeType !== ELEMENT) break;
      const el = n as Element;
      if (tagOf(el) !== 'script' || el.hasAttribute('src') || !paired(el) || mount.spanOf(el)?.parent !== parentSpan)
        break;
      d.last = el;
    }
  };

  const out: SourceRegion[] = [];
  for (const d of drafts) {
    extend(d);
    out.push({ ...d, label: labelOf(d.first) });
    for (const n of nested)
      if (regionElements(d).some((el) => el.contains(n.first))) {
        extend(n);
        out.push({ ...n, label: labelOf(n.first) });
      }
  }
  for (const n of nested)
    if (!out.some((r) => r.first === n.first)) {
      extend(n);
      out.push({ ...n, label: labelOf(n.first) });
    }
  return out;
}

/** 注入的代码编辑器（apps/web 中为 CodeMirror 6）。 */
export interface SourceEditor {
  getValue(): string;
  focus(): void;
  destroy(): void;
}

/** 在 `parent` 中创建代码编辑器，初始内容 `value`；内容变化时调用 `onChange`。 */
export type SourceEditorFactory = (
  parent: HTMLElement,
  value: string,
  onChange: () => void,
) => SourceEditor | Promise<SourceEditor>;

/** {@link createSourcePopover} 的选项。 */
export interface SourcePopoverOptions {
  readonly session: PreserveSession;
  /** 被编辑的文档（iframe 内）。 */
  readonly doc: Document;
  /** 承载界面的宿主文档；缺省为 `frame` 所在文档。不能与 `doc` 相同。 */
  readonly host?: Document;
  /** 被编辑文档所在的 iframe，用于把坐标换算到宿主页面。 */
  readonly frame?: HTMLIFrameElement | null;
  readonly editor: SourceEditorFactory;
  /** 页面脚本是否在运行（运行时替换进来的脚本也执行，图表按新源码重绘）。 */
  readonly runScripts?: () => boolean;
  /** 实时预览的防抖毫秒数，`0` 关闭实时预览；默认 400。 */
  readonly previewDelay?: number;
  /** 文档因预览、应用、取消而改变之后回调（刷新脏标记、按钮状态）。 */
  readonly onChange?: () => void;
}

/** {@link createSourcePopover} 的返回值。 */
export interface SourcePopover {
  /** 当前可编辑源码的区域。 */
  regions(): SourceRegion[];
  /** 包含 `node` 的最内层区域。 */
  regionAt(node: Node): SourceRegion | undefined;
  /** 打开弹层编辑 `region` 的源码。已打开时忽略。 */
  open(region: SourceRegion): Promise<void>;
  /** 正在编辑的区域。 */
  readonly current: SourceRegion | null;
  /** 立即把编辑器内容作为预览替换进页面；源码无法替换时返回 `false`（错误显示在弹层中）。 */
  preview(): boolean;
  /** 应用并关闭；源码无法替换时返回 `false`，弹层保持打开。 */
  apply(): boolean;
  /** 撤销预览并关闭。 */
  cancel(): void;
  /** 移除界面与监听（会话关闭或更换时调用；不撤销预览）。 */
  destroy(): void;
}

const STYLE_MARK = 'data-eh-source-popover';
const STYLE_TEXT = `
.eh-src-btn{position:fixed;z-index:2147483000;font:12px/1.2 system-ui,sans-serif;padding:3px 8px;border-radius:4px;border:1px solid var(--line,#c8cbd0);background:var(--panel,#fff);color:var(--text,#1f2328);box-shadow:0 1px 3px rgba(0,0,0,.15);cursor:pointer}
.eh-src-btn:hover{border-color:var(--accent,#2f6feb);color:var(--accent,#2f6feb)}
.eh-src-outline{position:fixed;z-index:2147482999;pointer-events:none;outline:2px dashed var(--accent,#2f6feb);outline-offset:2px;border-radius:2px}
.eh-src-layer{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center;padding:16px}
.eh-src-pop{display:flex;flex-direction:column;width:min(860px,100%);height:min(560px,100%);background:var(--panel,#fff);color:var(--text,#1f2328);border:1px solid var(--line,#d8dadd);border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.25);overflow:hidden;font:13px/1.4 system-ui,sans-serif}
.eh-src-pop header,.eh-src-pop footer{display:flex;align-items:center;gap:8px;padding:8px 12px}
.eh-src-pop header{border-bottom:1px solid var(--line,#d8dadd)}
.eh-src-pop footer{border-top:1px solid var(--line,#d8dadd)}
.eh-src-label{color:var(--muted,#6b7076);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eh-src-msg{padding:6px 12px;background:var(--warn-bg,#fff6d6);border-bottom:1px solid var(--warn-line,#e8cf72)}
.eh-src-msg[hidden]{display:none}
.eh-src-editor{flex:1;min-height:0;overflow:auto}
.eh-src-editor>.cm-editor{height:100%}
.eh-src-editor textarea{width:100%;height:100%;border:0;resize:none;font:12px/1.5 ui-monospace,monospace;padding:8px}
.eh-src-hint{flex:1;color:var(--muted,#6b7076);font-size:12px}
.eh-src-pop button{font:inherit;padding:4px 12px;border-radius:4px;border:1px solid var(--line,#c8cbd0);background:transparent;color:inherit;cursor:pointer}
.eh-src-pop button.primary{background:var(--accent,#2f6feb);border-color:var(--accent,#2f6feb);color:#fff}
`;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 在宿主页面上搭建区域源码编辑的悬停按钮与弹层（见模块说明）。会话更换（打开器保存后重挂、重新载入）时
 * 应 {@link SourcePopover.destroy} 后重新创建。
 */
export function createSourcePopover(options: SourcePopoverOptions): SourcePopover {
  const { session, doc } = options;
  const frame = options.frame ?? null;
  const host = options.host ?? frame?.ownerDocument;
  if (!host || host === doc) throw new Error('createSourcePopover: 界面必须放在宿主文档中，不能放进被编辑的文档');
  const delay = options.previewDelay ?? 400;
  const runScripts = options.runScripts ?? (() => false);

  if (!host.querySelector(`style[${STYLE_MARK}]`)) {
    const style = host.createElement('style');
    style.setAttribute(STYLE_MARK, '');
    style.textContent = STYLE_TEXT;
    host.head.appendChild(style);
  }
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] => {
    const el = host.createElement(tag);
    el.className = cls;
    if (text) el.textContent = text;
    return el;
  };

  // ---- 悬停按钮与高亮框 ----
  const btn = make('button', 'eh-src-btn', '编辑 HTML 源码');
  btn.type = 'button';
  btn.hidden = true;
  const outline = make('div', 'eh-src-outline');
  outline.hidden = true;
  host.body.append(outline, btn);

  // ---- 弹层 ----
  const layer = make('div', 'eh-src-layer');
  layer.hidden = true;
  const pop = make('div', 'eh-src-pop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'true');
  pop.setAttribute('aria-label', '编辑 HTML 源码');
  const head = make('header', '');
  const label = make('span', 'eh-src-label');
  head.append(make('strong', '', '编辑 HTML 源码'), label);
  const msg = make('div', 'eh-src-msg');
  msg.setAttribute('role', 'alert');
  msg.hidden = true;
  const box = make('div', 'eh-src-editor');
  const foot = make('footer', '');
  const live = host.createElement('input');
  live.type = 'checkbox';
  live.checked = delay > 0;
  live.disabled = delay <= 0;
  const liveLabel = make('label', '');
  liveLabel.append(live, ' 实时预览');
  const cancelBtn = make('button', '', '取消');
  cancelBtn.type = 'button';
  const applyBtn = make('button', 'primary', '应用');
  applyBtn.type = 'button';
  foot.append(liveLabel, make('span', 'eh-src-hint', 'Ctrl/⌘+Enter 应用 · Esc 取消'), cancelBtn, applyBtn);
  pop.append(head, msg, box, foot);
  layer.append(pop);
  host.body.append(layer);

  let hovered: SourceRegion | null = null;
  let current: SourceRegion | null = null;
  let editor: SourceEditor | null = null;
  let initial = '';
  /** 当前预览：替换进去的源码、插入的节点、预览之后的撤销深度。 */
  let pv: { text: string; nodes: Node[]; depth: number } | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTarget: Node | null = null;
  let destroyed = false;
  /** 打开编辑器的序号：异步创建编辑器期间若已关闭/重开，丢弃过期的编辑器。 */
  let generation = 0;

  const frameOffset = (): { x: number; y: number; clip: Rect } => {
    if (!frame) {
      const v = doc.defaultView;
      return { x: 0, y: 0, clip: { left: 0, top: 0, right: v?.innerWidth ?? 1e9, bottom: v?.innerHeight ?? 1e9 } };
    }
    const r = frame.getBoundingClientRect();
    const x = r.left + frame.clientLeft;
    const y = r.top + frame.clientTop;
    return { x, y, clip: { left: x, top: y, right: x + frame.clientWidth, bottom: y + frame.clientHeight } };
  };

  /** 区域在宿主视口中的矩形；不可见时为 `null`。 */
  const rectOf = (els: readonly Element[]): Rect | null => {
    let u: Rect | null = null;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      u = u
        ? {
            left: Math.min(u.left, r.left),
            top: Math.min(u.top, r.top),
            right: Math.max(u.right, r.right),
            bottom: Math.max(u.bottom, r.bottom),
          }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    if (!u) return null;
    const { x, y, clip } = frameOffset();
    const v = { left: u.left + x, top: u.top + y, right: u.right + x, bottom: u.bottom + y };
    if (v.bottom <= clip.top || v.top >= clip.bottom || v.right <= clip.left || v.left >= clip.right) return null;
    return v;
  };

  const showOutline = (els: readonly Element[]): Rect | null => {
    const r = rectOf(els);
    outline.hidden = r === null;
    if (r) {
      outline.style.left = `${r.left}px`;
      outline.style.top = `${r.top}px`;
      outline.style.width = `${r.right - r.left}px`;
      outline.style.height = `${r.bottom - r.top}px`;
    }
    return r;
  };

  const place = (): void => {
    if (current) {
      showOutline(pv ? pv.nodes.filter((n): n is Element => n.nodeType === ELEMENT) : regionElements(current));
      return;
    }
    const r = hovered ? showOutline(regionElements(hovered)) : null;
    if (!hovered || !r) {
      btn.hidden = true;
      outline.hidden = true;
      return;
    }
    const { clip } = frameOffset();
    btn.hidden = false;
    btn.title = hovered.generated ? `${hovered.label}（含脚本生成的内容，编辑其源码与数据）` : hovered.label;
    const w = btn.offsetWidth || 96;
    const h = btn.offsetHeight || 22;
    btn.style.left = `${Math.max(clip.left, Math.min(r.right, clip.right) - w)}px`;
    btn.style.top = `${Math.min(Math.max(r.top, clip.top) + 2, clip.bottom - h)}px`;
  };

  const hover = (r: SourceRegion | null): void => {
    clearTimeout(hideTimer);
    if (r?.first !== hovered?.first || r?.last !== hovered?.last) hovered = r;
    place();
  };
  const scheduleHide = (): void => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hover(null), 400);
  };

  const regions = (): SourceRegion[] => sourceRegions(session, doc);
  const regionAt = (node: Node): SourceRegion | undefined => {
    let best: SourceRegion | undefined;
    for (const r of regions())
      if (
        regionContains(r, node) &&
        (!best || regionElements(best).some((el) => el !== r.first && el.contains(r.first)))
      )
        best = r;
    return best;
  };

  const onMove = (e: Event): void => {
    if (current) return;
    const t = e.target as Node | null;
    if (!t || typeof t.nodeType !== 'number' || t === lastTarget) {
      if (hovered) hover(hovered);
      return;
    }
    lastTarget = t;
    const r = regionAt(t);
    if (r) hover(r);
    else scheduleHide();
  };
  const onScroll = (): void => place();
  const onFrameLeave = (): void => {
    lastTarget = null;
    scheduleHide();
  };
  doc.addEventListener('mousemove', onMove, true);
  doc.addEventListener('scroll', onScroll, true);
  frame?.addEventListener('mouseleave', onFrameLeave);
  host.defaultView?.addEventListener('resize', onScroll);
  btn.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  btn.addEventListener('mouseleave', scheduleHide);
  btn.addEventListener('click', () => {
    if (hovered) void api.open(hovered);
  });

  // ---- 预览 / 应用 / 取消 ----
  const say = (text: string): void => {
    msg.textContent = text;
    msg.hidden = text === '';
  };

  const revert = (): boolean => {
    const p = pv;
    pv = null;
    if (!p) return false;
    if (session.history.undoDepth === p.depth && session.undo()) session.history.discardRedo();
    return true;
  };

  const replace = (region: SourceRegion, text: string): Node[] | null => {
    try {
      const nodes = session.replaceSource(region, text, { runScripts: runScripts() });
      say('');
      return nodes;
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  const close = (): void => {
    generation++;
    clearTimeout(previewTimer);
    editor?.destroy();
    editor = null;
    current = null;
    pv = null;
    layer.hidden = true;
    outline.hidden = true;
    box.replaceChildren();
    say('');
    hover(null);
  };

  const onEditorChange = (): void => {
    clearTimeout(previewTimer);
    if (live.checked && delay > 0) previewTimer = setTimeout(() => api.preview(), delay);
  };

  // Ctrl/⌘+Enter 在捕获阶段处理：代码编辑器自己也绑定了它（插入空行），不能让它先收到。
  const onKeyCapture = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    api.apply();
  };
  const onKey = (e: KeyboardEvent): void => {
    e.stopPropagation(); // 弹层打开时不触发宿主页面的快捷键（如 Ctrl+S）
    // Esc：编辑器已处理（关闭补全、收起多选区）时不取消
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      api.cancel();
    }
  };
  layer.addEventListener('keydown', onKeyCapture, true);
  layer.addEventListener('keydown', onKey);
  cancelBtn.addEventListener('click', () => api.cancel());
  applyBtn.addEventListener('click', () => api.apply());
  live.addEventListener('change', () => {
    if (live.checked) api.preview();
    else if (revert()) options.onChange?.();
  });

  const api: SourcePopover = {
    regions,
    regionAt,
    get current() {
      return current;
    },
    async open(region) {
      if (current || destroyed) return;
      const text = session.getSource(region);
      current = region;
      initial = text;
      pv = null;
      btn.hidden = true;
      label.textContent = region.generated ? `${region.label} · 含脚本生成的内容` : region.label;
      say(region.generated ? '图表等由脚本生成的内容不在源码中：请修改容器与脚本里的数据。' : '');
      layer.hidden = false;
      place();
      const gen = ++generation;
      const ed = await options.editor(box, text, onEditorChange);
      if (gen !== generation) {
        ed.destroy();
        return;
      }
      editor = ed;
      ed.focus();
    },
    preview() {
      const region = current;
      if (!region || !editor) return false;
      clearTimeout(previewTimer);
      const text = editor.getValue();
      if (pv ? pv.text === text : text === initial) return true;
      const changed = revert();
      let ok = true;
      if (text !== initial) {
        const nodes = replace(region, text);
        if (nodes) pv = { text, nodes, depth: session.history.undoDepth };
        else ok = false;
      }
      if (changed || pv) options.onChange?.();
      place();
      return ok;
    },
    apply() {
      const region = current;
      if (!region || !editor) return false;
      clearTimeout(previewTimer);
      const text = editor.getValue();
      if (!(pv && pv.text === text)) {
        const reverted = revert();
        if (text !== initial && !replace(region, text)) {
          if (reverted) options.onChange?.();
          return false;
        }
      }
      pv = null; // 保留预览，不再撤销
      close();
      options.onChange?.();
      return true;
    },
    cancel() {
      if (!current) return;
      const changed = revert();
      close();
      if (changed) options.onChange?.();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      close();
      clearTimeout(hideTimer);
      doc.removeEventListener('mousemove', onMove, true);
      doc.removeEventListener('scroll', onScroll, true);
      frame?.removeEventListener('mouseleave', onFrameLeave);
      host.defaultView?.removeEventListener('resize', onScroll);
      btn.remove();
      outline.remove();
      layer.remove();
    },
  };
  return api;
}
