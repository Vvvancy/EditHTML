/**
 * 测试工具：在任意 DOM 实现（happy-dom 等）里按 parse5 的树逐节点搭出文档，
 * 模拟严格符合 WHATWG 的浏览器解析器。
 *
 * @module
 */
import { parse, type DefaultTreeAdapterMap } from 'parse5';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
type P5Node = DefaultTreeAdapterMap['node'];

/**
 * 用 parse5 的树在 happy-dom 文档里逐节点搭出 DOM，模拟一个严格符合 WHATWG 的浏览器解析器
 * （happy-dom 自带解析器在若干 fixture 上与规范不一致，见下方「happy-dom 原生解析」用例）。
 */
export function loadSpec(doc: Document, source: string): void {
  while (doc.firstChild) doc.removeChild(doc.firstChild);
  const build = (n: P5Node, parent: Node): void => {
    if (n.nodeName === '#text') {
      parent.appendChild(doc.createTextNode((n as DefaultTreeAdapterMap['textNode']).value));
    } else if (n.nodeName === '#comment') {
      parent.appendChild(doc.createComment((n as DefaultTreeAdapterMap['commentNode']).data));
    } else if (n.nodeName === '#documentType') {
      const d = n as DefaultTreeAdapterMap['documentType'];
      parent.appendChild(doc.implementation.createDocumentType(d.name || 'html', d.publicId, d.systemId));
    } else if ('tagName' in n) {
      const el =
        n.namespaceURI === HTML_NS ? doc.createElement(n.tagName) : doc.createElementNS(n.namespaceURI, n.tagName);
      for (const a of n.attrs) {
        try {
          el.setAttribute(a.prefix ? `${a.prefix}:${a.name}` : a.name, a.value);
        } catch {
          // 非法属性名：浏览器解析器会保留，这里无关紧要
        }
      }
      parent.appendChild(el);
      const host = n.tagName === 'template' ? (el as HTMLTemplateElement).content : el;
      const kids =
        n.tagName === 'template' ? (n as DefaultTreeAdapterMap['template']).content.childNodes : n.childNodes;
      for (const c of kids) build(c, host);
    }
  };
  for (const c of parse(source).childNodes) build(c, doc);
}
