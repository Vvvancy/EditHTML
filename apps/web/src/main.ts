/**
 * apps/web 最小页面（T2.7）：打开任意 `.html` → 保真模式编辑 → 保存写回；区域源码弹层（T2.5）。
 * 逻辑都在 `@edithtml/runtime`，这里只有界面接线。
 */
import { canPickWithHandle, pickWithHandle, readDropped, readFile, type OpenedFile } from '@edithtml/runtime';
import { createOpener } from './opener.js';
import { bindSourcePopover } from './source-editor.js';
import './style.css';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

const openBtn = $<HTMLButtonElement>('open');
const saveBtn = $<HTMLButtonElement>('save');
const nameEl = $('name');
const dirtyEl = $('dirty');
const statusEl = $('status');
const banner = $('banner');
const stage = $('stage');
const picker = $<HTMLInputElement>('picker');

function status(text: string, error = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

const opener = createOpener(stage, {
  onChange: render,
  onDocument(doc) {
    // iframe 内的按键与拖放不会冒泡到宿主，需要单独监听。
    doc.addEventListener('keydown', onKey);
    bindDrop(doc);
  },
});

// 区域源码弹层（T2.5）：悬停区域时在宿主页面显示「编辑 HTML 源码」，CodeMirror 按需加载。
const sourcePopover = bindSourcePopover(opener, stage, () => {
  opener.refreshDirty();
  render();
});

function render(): void {
  sourcePopover.sync();
  const file = opener.file;
  nameEl.textContent = file ? file.name : '未打开文件';
  nameEl.title = file ? `${file.name}${file.handle ? '' : '（保存时将下载新文件）'}` : '';
  dirtyEl.hidden = !opener.dirty;
  saveBtn.disabled = !file;
  banner.hidden = opener.scripts !== 'blocked';
  document.title = file ? `${opener.dirty ? '● ' : ''}${file.name} — EditHTML` : 'EditHTML';
}

async function load(file: OpenedFile | null | undefined): Promise<void> {
  if (!file) return;
  opener.refreshDirty();
  if (opener.dirty && !confirm('当前文件有未保存的修改，确定放弃并打开新文件？')) return;
  status('正在打开…');
  try {
    await opener.open(file);
    status(opener.scripts === 'running' ? '已打开（脚本已运行）' : '已打开');
  } catch (e) {
    status(e instanceof Error ? e.message : String(e), true);
  }
  render();
}

async function open(): Promise<void> {
  if (!canPickWithHandle()) {
    picker.click();
    return;
  }
  try {
    await load(await pickWithHandle());
  } catch (e) {
    status(e instanceof Error ? e.message : String(e), true);
  }
}

async function save(): Promise<void> {
  if (!opener.file) return;
  status('正在保存…');
  try {
    const r = await opener.save();
    status(
      r === 'written'
        ? `已保存 ${new Date().toLocaleTimeString()}`
        : r === 'downloaded'
          ? '已下载（此浏览器不能写回原文件）'
          : r === 'unchanged'
            ? '没有改动'
            : '已取消保存',
    );
  } catch (e) {
    status(`保存失败：${e instanceof Error ? e.message : String(e)}`, true);
  }
  render();
}

function onKey(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const key = e.key.toLowerCase();
  if (key === 's') {
    e.preventDefault();
    void save();
  } else if (key === 'o') {
    e.preventDefault();
    void open();
  }
}

const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');

function bindDrop(target: Document): void {
  target.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return; // 页面内拖动文字交给编辑器
    e.preventDefault();
    stage.classList.add('drop');
  });
  target.addEventListener('dragleave', () => stage.classList.remove('drop'));
  target.addEventListener('drop', (e) => {
    stage.classList.remove('drop');
    if (!hasFiles(e) || !e.dataTransfer) return;
    e.preventDefault();
    readDropped(e.dataTransfer).then(load, (err: unknown) =>
      status(err instanceof Error ? err.message : String(err), true),
    );
  });
}

openBtn.addEventListener('click', () => void open());
saveBtn.addEventListener('click', () => void save());
$('run-once').addEventListener('click', () => void opener.runScripts(false).then(render));
$('run-always').addEventListener('click', () => void opener.runScripts(true).then(render));
picker.addEventListener('change', () => {
  const f = picker.files?.[0];
  picker.value = '';
  if (f) readFile(f).then(load, (err: unknown) => status(err instanceof Error ? err.message : String(err), true));
});
document.addEventListener('keydown', onKey);
bindDrop(document);
addEventListener('beforeunload', (e) => {
  opener.refreshDirty();
  if (opener.dirty) e.preventDefault();
});
render();
