/**
 * 保真会话 → 格式工具栏宿主的薄适配（T2.8）。
 *
 * 返回值在结构上满足 `@edithtml/editor` 的 `ToolbarHost`；这里不导入 editor，避免 importer 反向依赖编辑器。
 *
 * @module
 */
import type { PreserveSession } from './edit.js';

/** {@link preserveToolbarHost} 的返回值（与 `@edithtml/editor` 的 `ToolbarHost` 同形）。 */
export interface PreserveToolbarHost {
  readonly doc: Document;
  run<T>(fn: () => T): T;
  isEditable(node: Node): boolean;
  containerOf(node: Node): HTMLElement | undefined;
  touch(node: Node): void;
  adopt(el: HTMLElement): boolean;
  ownsAttribute(el: Element, name: string): boolean;
}

/**
 * 让格式工具栏作用于保真会话：命令改动包在 `mount.userEdit` 中（否则会被当作脚本改动标灰），
 * 改完 `touch` 以生成补丁；改标签名后的新块经 `mount.adopt` 重新登记为容器，复制属性时跳过挂载层添加的属性。
 *
 * @param doc 会话所在的文档（与 {@link openPreserve} 的 `doc` 相同）。
 */
export function preserveToolbarHost(session: PreserveSession, doc: Document): PreserveToolbarHost {
  const { mount } = session;
  return {
    doc,
    run: (fn) => mount.userEdit(fn),
    isEditable: (node) => mount.isEditable(node),
    containerOf: (node) => mount.containerOf(node),
    touch: (node) => session.touch(node),
    adopt: (el) => mount.adopt(el),
    ownsAttribute: (el, name) => mount.owns(el, name),
  };
}
