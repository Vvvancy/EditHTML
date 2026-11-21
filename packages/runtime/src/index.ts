/**
 * @edithtml/runtime — 嵌入 `.ehtml` 文件的运行时加载器（任务 T2.7）。
 * 体积预算：< 8KB gzip，因此不依赖其他包。
 *
 * @packageDocumentation
 */

/** 运行时是否已在当前页面启动。 */
export function isEditHtmlDocument(doc: Document): boolean {
  return doc.documentElement.hasAttribute('data-eh-version');
}
