/**
 * 在同源 iframe 中搭建「与原文同形、脚本未运行」的页面（T2.7）。
 *
 * 做法：先用 `DOMParser` 解析原文（脚本不可执行），再把一个只含原 doctype 的 blob 页面载入 iframe，
 * 等它加载完后把解析结果整体搬进去（{@link adoptInto}）。这样：
 * - 标准/怪异模式与直接打开文件一致（`srcdoc` 文档永远是标准模式，所以不用 `srcdoc`）；
 * - blob URL 与宿主同源，宿主可以直接操作 iframe 的 DOM 挂载保真模式；
 * - 是否允许运行脚本由 `sandbox` 决定，且在载入**之前**就定下来（sandbox 只对下一次导航生效）：
 *   - 不运行：`sandbox="allow-same-origin …"`（无 `allow-scripts`）——脚本、`on*` 事件属性、`javascript:` 链接都不会执行，
 *     宿主自己的监听器与 `MutationObserver` 照常工作；
 *   - 运行：额外加 `allow-scripts`，脚本由 {@link activateScripts} 在挂载后按顺序激活。
 *     `allow-scripts` + `allow-same-origin` 意味着页面脚本与编辑器同源、可以访问编辑器——只对用户确认信任的文件这样做。
 *
 * 已知限制：页面的 base URL 是 blob URL，原文件中的相对路径资源（本地图片、CSS）无法加载。
 *
 * @module
 */
import { activateScripts, adoptInto, doctypeHtml, parseInert, type ScriptTransfer } from './scripts.js';

/** 不运行脚本时的 sandbox。 */
export const SANDBOX_NO_SCRIPTS = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads';
/** 运行脚本时的 sandbox（仍不允许导航顶层窗口）。 */
export const SANDBOX_SCRIPTS = `${SANDBOX_NO_SCRIPTS} allow-scripts allow-forms allow-modals`;

/**
 * 把 `source` 载入 `iframe`，返回其中脚本尚未运行、与原文同形的文档。`iframe` 必须已插入文档。
 * 每次打开请用一个新的 iframe：旧页面脚本留下的全局变量、定时器会随旧 iframe 一起销毁。
 */
export async function loadInertFrame(
  iframe: HTMLIFrameElement,
  source: string,
  options: { runScripts: boolean },
): Promise<Document> {
  if (!iframe.isConnected) throw new Error('loadInertFrame: iframe 必须已插入文档');
  const parsed = parseInert(source);
  iframe.setAttribute('sandbox', options.runScripts ? SANDBOX_SCRIPTS : SANDBOX_NO_SCRIPTS);
  const url = URL.createObjectURL(new Blob([doctypeHtml(parsed)], { type: 'text/html' }));
  try {
    await new Promise<void>((resolve, reject) => {
      const onLoad = (): void => {
        if (iframe.contentDocument?.URL !== url) return; // 初始 about:blank
        iframe.removeEventListener('load', onLoad);
        resolve();
      };
      iframe.addEventListener('load', onLoad);
      iframe.addEventListener('error', () => reject(new Error('预览页面加载失败')), { once: true });
      iframe.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  const doc = iframe.contentDocument;
  if (!doc) throw new Error('无法访问预览页面（需要同源 iframe）');
  adoptInto(doc, parsed);
  guardNavigation(doc);
  return doc;
}

/**
 * 阻止页面内的链接把 iframe 导航走（那会丢掉正在编辑的页面）：普通点击不跳转，
 * `Ctrl/Cmd`+点击 或 `target=_blank` 在新标签页打开。
 */
export function guardNavigation(doc: Document): void {
  doc.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const t = e.target as Element | null;
    const a = t && typeof t.closest === 'function' ? t.closest('a[href]') : null;
    if (!a) return;
    const href = (a as HTMLAnchorElement).href;
    if ((a.getAttribute('href') ?? '').startsWith('#')) return; // 页内锚点
    e.preventDefault();
    const blank = a.getAttribute('target') === '_blank';
    if ((blank || e.ctrlKey || e.metaKey) && /^https?:/i.test(href)) window.open(href, '_blank', 'noopener');
  });
}

/** 保真会话中打开器用到的部分（importer 的 `PreserveSession` 满足此接口）。 */
export interface PreserveSessionLike {
  readonly mount: ScriptTransfer & {
    /** 当前可编辑的容器。 */
    containers(): HTMLElement[];
  };
  /** 应用补丁后的新文本。 */
  save(): string;
  /** 卸载挂载层。 */
  close(): void;
}

/** 打开会话时的回调。 */
export interface SessionHooks {
  onUserEdit?: (container: HTMLElement) => void;
}

/** 在文档上开启保真会话的函数（即 importer 的 `openPreserve`）。 */
export type OpenPreserve<S extends PreserveSessionLike> = (doc: Document, source: string, hooks: SessionHooks) => S;

/**
 * 按 importer `mount.ts` 规定的顺序开启会话：先在脚本未运行的文档上挂载，再（可选）激活脚本。
 *
 * @returns 会话与激活的脚本数。
 */
export async function mountThenRun<S extends PreserveSessionLike>(
  doc: Document,
  source: string,
  options: { open: OpenPreserve<S>; runScripts: boolean; hooks?: SessionHooks },
): Promise<{ session: S; scripts: number }> {
  const session = options.open(doc, source, options.hooks ?? {});
  const scripts = options.runScripts ? await activateScripts(doc, session.mount) : 0;
  return { session, scripts };
}

/** {@link loadInertFrame} + {@link mountThenRun}：把文件载入 iframe 并进入保真编辑。 */
export async function loadPreserveFrame<S extends PreserveSessionLike>(
  iframe: HTMLIFrameElement,
  source: string,
  options: { open: OpenPreserve<S>; runScripts: boolean; hooks?: SessionHooks },
): Promise<{ doc: Document; session: S; scripts: number }> {
  const doc = await loadInertFrame(iframe, source, options);
  return { doc, ...(await mountThenRun(doc, source, options)) };
}
