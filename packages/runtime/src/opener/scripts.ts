/**
 * 「先挂载、后运行脚本」（T2.7，按 importer `mount.ts` 模块说明的调用时机实现）。
 *
 * 1. {@link parseInert}：用 `DOMParser` 解析原文——它产出的 `<script>` 被标记为不可执行，移入 live 文档也不会运行；
 * 2. {@link adoptInto}：把解析结果整体搬进目标文档（iframe），此时 DOM 与原文同形，可以挂载保真模式；
 * 3. {@link activateScripts}：按文档顺序把每个 `<script>` 换成一个新建的同内容 `<script>`（新节点插入时才会执行），
 *    并调用 `transfer(old, fresh)` 把区间转给新节点，脚本元素自身不会被误判为「脚本生成」而标灰。
 *
 * ## 执行顺序（尽量贴近浏览器的解析期语义）
 *
 * - 第一轮：普通经典脚本（行内的，以及不带 `async`/`defer` 的外链）按文档顺序逐个激活；外链脚本等待 `load`/`error`
 *   之后再激活下一个，相当于解析器阻塞；
 * - 带 `async` 的外链经典脚本与 `async` 模块：激活后不等待；
 * - 第二轮：`defer` 外链脚本与（非 async 的）模块脚本，按文档顺序逐个激活并等待；
 * - 最后补发 `DOMContentLoaded`（document）与 `load`（window）：页面原本挂在这两个事件上的初始化代码才会运行。
 *   文档的 `readyState` 此时已是 `complete`，自行判断 `readyState` 的库（如 jQuery）会直接运行并忽略重复事件。
 * - `nomodule` 脚本与非 JS 类型（`application/json`、`text/template` …）不动：它们本来就不会执行。
 * - 激活期间 `document.write` 被临时替换为「把写入的 HTML 插到当前脚本之后」，避免在已加载的文档上调用它清空整页。
 *
 * @module
 */

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** 可执行脚本的种类；`null` 表示不会执行（数据块、模板、`nomodule`）。 */
export type ScriptKind = 'classic' | 'module' | 'importmap';

/** 经典脚本的 MIME 类型（HTML 规范 JavaScript MIME type essence）。 */
const JS_TYPES: ReadonlySet<string> = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

/** 脚本元素会以哪种方式执行。 */
export function scriptKind(el: Element): ScriptKind | null {
  if (el.namespaceURI === HTML_NS && el.hasAttribute('nomodule')) return null;
  const type = (el.getAttribute('type') ?? '').trim().toLowerCase();
  if (type === '') return 'classic';
  if (type === 'module') return 'module';
  if (type === 'importmap') return 'importmap';
  return JS_TYPES.has(type.split(';')[0]?.trim() ?? '') ? 'classic' : null;
}

const isScript = (el: Element): boolean => el.localName === 'script';

/** 外链地址（HTML `src`；SVG `href` / `xlink:href`）。 */
function scriptSrc(el: Element): string | null {
  if (el.namespaceURI === SVG_NS) return el.getAttribute('href') ?? el.getAttributeNS(XLINK_NS, 'href');
  return el.getAttribute('src');
}

/** 文档中所有会执行的脚本元素，按文档顺序。 */
export function executableScripts(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll('script')).filter((s) => scriptKind(s) !== null);
}

/** 文档是否含有会运行的代码：可执行的 `<script>`，或 `on*` 事件属性。 */
export function hasActiveContent(doc: Document): boolean {
  return activeParts(doc).length > 0;
}

/** 列出所有会运行的代码片段（指纹的输入）。 */
function activeParts(doc: Document): string[] {
  const parts: string[] = [];
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (isScript(el)) {
      const kind = scriptKind(el);
      if (kind) parts.push(`script|${kind}|${scriptSrc(el) ?? ''}|${el.textContent ?? ''}`);
    }
    for (const a of Array.from(el.attributes))
      if (a.name.toLowerCase().startsWith('on')) parts.push(`attr|${el.localName}|${a.name}|${a.value}`);
  }
  return parts;
}

/** FNV-1a 64 位（没有 `crypto.subtle` 的非安全上下文中的退路）。 */
function fnv64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(s);
  for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return `fnv:${h.toString(16)}`;
}

/**
 * 页面全部可运行代码的指纹（脚本内容 + 外链地址 + 事件属性）；没有可运行代码时为 `null`。
 * 信任的是**这段代码**而不是文件名：脚本一改，指纹就变，会重新询问。
 */
export async function scriptFingerprint(doc: Document): Promise<string | null> {
  const parts = activeParts(doc);
  if (parts.length === 0) return null;
  const text = parts.join('\u0000');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fnv64(text);
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 以「脚本不执行」的方式解析原文。
 *
 * @param win 解析所在的 realm（通常是 iframe 的 `contentWindow`）；省略时用当前全局的 `DOMParser`。
 */
export function parseInert(source: string, win?: Window | null): Document {
  const P = (win as (Window & { DOMParser?: typeof DOMParser }) | null | undefined)?.DOMParser ?? DOMParser;
  return new P().parseFromString(source, 'text/html');
}

/**
 * 由解析结果的 doctype 还原出一行 `<!DOCTYPE …>`（没有 doctype 时为空串）。
 * 用它作为空白宿主页的内容，宿主页的标准/怪异模式就与原文件一致。
 */
export function doctypeHtml(parsed: Document): string {
  const dt = parsed.doctype;
  if (!dt) return '';
  const q = (s: string): string => (s.includes('"') ? `'${s}'` : `"${s}"`);
  if (dt.publicId) return `<!DOCTYPE ${dt.name} PUBLIC ${q(dt.publicId)}${dt.systemId ? ` ${q(dt.systemId)}` : ''}>`;
  if (dt.systemId) return `<!DOCTYPE ${dt.name} SYSTEM ${q(dt.systemId)}>`;
  return `<!DOCTYPE ${dt.name}>`;
}

/** 用 `parsed` 的全部节点替换 `target` 的内容（脚本保持不可执行）。返回 `target`。 */
export function adoptInto(target: Document, parsed: Document): Document {
  const nodes = Array.from(parsed.childNodes).map((n) => target.adoptNode(n));
  target.replaceChildren(...nodes);
  return target;
}

/** 区间转交接口（即 importer 的 `PreserveMount.transfer`）。 */
export interface ScriptTransfer {
  transfer(from: Node, to: Node): void;
}

/** {@link activateScripts} 的选项。 */
export interface ActivateOptions {
  /** 单个脚本等待 `load`/`error` 的上限（毫秒），默认 15000；超时后继续下一个。 */
  timeout?: number;
  /** 激活完成后补发 `DOMContentLoaded` 与 `load`，默认 `true`。 */
  dispatchLoadEvents?: boolean;
}

/** 新建同内容的脚本元素（属性、文本原样复制）。 */
function cloneScript(doc: Document, old: Element): Element {
  const fresh =
    old.namespaceURI === HTML_NS ? doc.createElement('script') : doc.createElementNS(old.namespaceURI, 'script');
  for (const a of Array.from(old.attributes)) {
    if (a.namespaceURI) fresh.setAttributeNS(a.namespaceURI, a.name, a.value);
    else fresh.setAttribute(a.name, a.value);
  }
  fresh.textContent = old.textContent;
  return fresh;
}

/** 等待脚本的 `load` / `error`（或超时）。 */
function settled(el: Element, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      el.removeEventListener('load', done);
      el.removeEventListener('error', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    el.addEventListener('load', done);
    el.addEventListener('error', done);
  });
}

type WriteFn = (...text: string[]) => void;

/**
 * 按文档顺序激活 `doc` 中的脚本（见模块说明）。必须在保真模式挂载**之后**调用，并传入挂载层的 `transfer`。
 *
 * @returns 激活的脚本数量。
 */
export async function activateScripts(
  doc: Document,
  host?: ScriptTransfer,
  options: ActivateOptions = {},
): Promise<number> {
  const timeout = options.timeout ?? 15_000;
  const all = executableScripts(doc);
  const async: Element[] = [];
  const first: Element[] = [];
  const later: Element[] = [];
  for (const s of all) {
    const kind = scriptKind(s);
    const external = scriptSrc(s) !== null;
    if (kind === 'module') (s.hasAttribute('async') ? async : later).push(s);
    else if (kind === 'classic' && external && s.hasAttribute('async')) async.push(s);
    else if (kind === 'classic' && external && s.hasAttribute('defer') && s.namespaceURI === HTML_NS) later.push(s);
    else first.push(s);
  }

  // document.write 垫片：把一个脚本内的所有写入攒起来，脚本结束后插到它后面。
  const pending = new Map<Element, string>();
  const shim = doc as unknown as { write: WriteFn; writeln: WriteFn };
  const hadOwn = Object.prototype.hasOwnProperty.call(doc, 'write');
  const buffer =
    (nl: string): WriteFn =>
    (...text) => {
      const cur = doc.currentScript;
      if (!cur) return;
      pending.set(cur, (pending.get(cur) ?? '') + text.join('') + nl);
    };
  if (!hadOwn) {
    shim.write = buffer('');
    shim.writeln = buffer('\n');
  }
  const flushWrites = (s: Element): void => {
    const html = pending.get(s);
    pending.delete(s);
    if (!html || !s.parentNode) return;
    const range = doc.createRange();
    range.selectNode(s);
    s.after(range.createContextualFragment(html));
  };

  let count = 0;
  const run = async (old: Element, wait: boolean): Promise<void> => {
    if (!old.isConnected) return; // 已被前面的脚本移除
    const fresh = cloneScript(doc, old);
    const done = wait ? settled(fresh, timeout) : null;
    old.replaceWith(fresh); // 行内经典脚本在此同步执行
    host?.transfer(old, fresh);
    count++;
    if (done) await done;
    flushWrites(fresh);
  };

  try {
    for (const s of first) await run(s, scriptSrc(s) !== null);
    for (const s of async) await run(s, false);
    for (const s of later) await run(s, true);
  } finally {
    if (!hadOwn) {
      delete (shim as Partial<typeof shim>).write;
      delete (shim as Partial<typeof shim>).writeln;
    }
  }

  if (options.dispatchLoadEvents !== false) {
    const win = doc.defaultView;
    const E = (win as (Window & { Event?: typeof Event }) | null)?.Event ?? Event;
    doc.dispatchEvent(new E('DOMContentLoaded', { bubbles: true }));
    win?.dispatchEvent(new E('load'));
  }
  return count;
}
