/**
 * 区域源码弹层（T2.5）的接线：importer 的 {@link createSourcePopover} 负责区域、按钮、弹层与预览/应用，
 * 这里注入按需加载的 CodeMirror，并在会话更换时重建弹层。
 */
import { createSourcePopover, type SourceEditorFactory, type SourcePopover } from '@edithtml/importer';
import type { Opener } from './opener.js';

/** 第一次打开弹层时才加载 CodeMirror（独立的分包）。 */
export const loadCodeMirror: SourceEditorFactory = async (parent, value, onChange) => {
  const { createEditor } = await import('./codemirror.js');
  return createEditor(parent, value, onChange);
};

/**
 * 让区域源码弹层跟随打开器的会话：每次 {@link SourcePopoverBinding.sync} 时若会话变了（打开、保存后重挂、运行脚本），
 * 就销毁旧弹层、在新会话上重建。
 */
export interface SourcePopoverBinding {
  sync(): void;
  readonly popover: SourcePopover | null;
}

/** 见 {@link SourcePopoverBinding}。 */
export function bindSourcePopover(
  opener: Opener,
  stage: HTMLElement,
  onChange: () => void,
  editor: SourceEditorFactory = loadCodeMirror,
): SourcePopoverBinding {
  let popover: SourcePopover | null = null;
  let bound: unknown = null;
  return {
    get popover() {
      return popover;
    },
    sync() {
      const session = opener.session;
      const doc = opener.doc;
      if (session === bound) return;
      popover?.destroy();
      popover = null;
      bound = session;
      if (!session || !doc) return;
      popover = createSourcePopover({
        session,
        doc,
        host: stage.ownerDocument,
        frame: stage.querySelector('iframe'),
        editor,
        runScripts: () => opener.scripts === 'running',
        onChange,
      });
    },
  };
}
