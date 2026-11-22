/**
 * 按 parse5 的片段树在 live 文档中逐节点搭建 DOM（T2.5 区域源码替换）。
 *
 * 不用 `innerHTML` / `createContextualFragment`：宿主解析器（如 happy-dom）未必完全符合 WHATWG，
 * 而这里搭出的节点必须与片段区间树逐节点同形，挂载层才能配对。
 *
 * `<script>` 一律搭成**不会执行**的脚本元素（由 `innerHTML` 片段解析产生的脚本带「已开始」标记，插入文档也不运行），
 * 需要执行时由调用方换成新建的同内容脚本。
 *
 * @module
 */
import type { DefaultTreeAdapterMap } from 'parse5';
import type { FragmentTree } from './span-index.js';

type P5Node = DefaultTreeAdapterMap['childNode'];

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 搭建片段树的顶层节点（尚未插入文档）。 */
export function buildFragmentDom(doc: Document, tree: FragmentTree): Node[] {
  const scratch = doc.createElement('div'); // 未插入文档：其中的变动不会被挂载层观察到
  const inertScript = (ns: string): Element => {
    scratch.innerHTML = ns === SVG_NS ? '<svg><script></script></svg>' : '<script></script>';
    const s = scratch.querySelector('script');
    if (!s) throw new Error('无法创建脚本元素');
    s.remove();
    return s;
  };

  const build = (n: P5Node): Node | null => {
    if (n.nodeName === '#text') return doc.createTextNode((n as DefaultTreeAdapterMap['textNode']).value);
    if (n.nodeName === '#comment') return doc.createComment((n as DefaultTreeAdapterMap['commentNode']).data);
    if (!('tagName' in n)) return null;
    const ns: string = n.namespaceURI;
    const el =
      n.tagName === 'script'
        ? inertScript(ns)
        : ns === HTML_NS
          ? doc.createElement(n.tagName)
          : doc.createElementNS(ns, n.tagName);
    for (const a of n.attrs) {
      try {
        if (a.namespace) el.setAttributeNS(a.namespace, a.prefix ? `${a.prefix}:${a.name}` : a.name, a.value);
        else el.setAttribute(a.name, a.value);
      } catch {
        // 非法属性名：浏览器解析器会保留，DOM API 无法创建；序列化时按原文输出（见挂载层的属性比对）
      }
    }
    const host = n.tagName === 'template' ? (el as HTMLTemplateElement).content : el;
    const kids = n.tagName === 'template' ? (n as DefaultTreeAdapterMap['template']).content.childNodes : n.childNodes;
    for (const c of kids) {
      const k = build(c);
      if (k) host.appendChild(k);
    }
    return el;
  };

  const out: Node[] = [];
  for (const c of tree.childNodes) {
    const k = build(c);
    if (k) out.push(k);
  }
  return out;
}
