/**
 * 把 runtime 的打开器与 importer 的保真会话接起来（T2.7）。
 * runtime 为了体积不依赖 importer，`openPreserve` 在这里注入。
 */
import { openPreserve, type PreserveSession } from '@edithtml/importer';
import { PreserveController, loadInertFrame, type ControllerOptions } from '@edithtml/runtime';

/** apps/web 使用的打开器类型。 */
export type Opener = PreserveController<PreserveSession>;

/**
 * 创建打开器：每次载入都在 `stage` 中换上一个新的 iframe（旧页面脚本的全局状态随之销毁）。
 */
export function createOpener(
  stage: HTMLElement,
  options: Omit<ControllerOptions<PreserveSession>, 'open' | 'createDocument'>,
): Opener {
  return new PreserveController<PreserveSession>({
    ...options,
    open: openPreserve,
    async createDocument(source, runScripts) {
      const iframe = stage.ownerDocument.createElement('iframe');
      iframe.className = 'eh-frame';
      iframe.title = '正在编辑的页面';
      stage.replaceChildren(iframe);
      return loadInertFrame(iframe, source, { runScripts });
    },
  });
}
