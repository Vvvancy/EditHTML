/**
 * 打开与写回文件（T2.7）：File System Access API 可用时拿到 `FileSystemFileHandle` 直接写回原文件；
 * 不可用（Firefox / Safari、`<input type=file>`、不支持句柄的拖入）时退化为下载新文件。
 *
 * @module
 */
import { decodeHtml, encodeHtml, type HtmlText } from './encoding.js';

/** 一个已打开的 HTML 文件。 */
export interface OpenedFile extends HtmlText {
  /** 文件名（不含路径）。 */
  readonly name: string;
  /** 可写回的句柄；没有时保存只能下载。 */
  handle: FileSystemFileHandle | null;
}

/** `showOpenFilePicker` / `showSaveFilePicker` 尚未进入 TS 的 DOM 类型。 */
interface PickerWindow {
  showOpenFilePicker?: (options?: object) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options?: object) => Promise<FileSystemFileHandle>;
}

/** Chromium 的拖入句柄扩展。 */
interface HandleItem {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
}

const HTML_TYPES = [{ description: 'HTML 文件', accept: { 'text/html': ['.html', '.htm'] } }];

/** 用户取消选择时浏览器抛出的错误。 */
export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

/** 读取一个 `File`（可附带它的句柄）。 */
export async function readFile(
  file: Blob & { name: string },
  handle: FileSystemFileHandle | null = null,
): Promise<OpenedFile> {
  const { text, bom } = decodeHtml(await file.arrayBuffer());
  return { name: file.name, text, bom, handle };
}

/** 是否支持 File System Access API 的打开选择器（支持即可写回）。 */
export function canPickWithHandle(win: Window = window): boolean {
  return typeof (win as PickerWindow).showOpenFilePicker === 'function';
}

/**
 * 用 `showOpenFilePicker` 选择文件；不支持时返回 `undefined`（调用方改用 `<input type=file>`），用户取消时返回 `null`。
 */
export async function pickWithHandle(win: Window = window): Promise<OpenedFile | null | undefined> {
  const pick = (win as PickerWindow).showOpenFilePicker;
  if (typeof pick !== 'function') return undefined;
  try {
    const [handle] = await pick.call(win, { types: HTML_TYPES, multiple: false });
    if (!handle) return null;
    return await readFile(await handle.getFile(), handle);
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** 从拖入的数据中取出第一个文件；Chromium 下同时拿到句柄以便写回。 */
export async function readDropped(data: DataTransfer): Promise<OpenedFile | null> {
  const item = Array.from(data.items).find((i) => i.kind === 'file');
  // 句柄必须在 drop 事件同步阶段内请求，先拿到 Promise 再 await。
  const handlePromise = (item as (DataTransferItem & HandleItem) | undefined)?.getAsFileSystemHandle?.();
  const file = item?.getAsFile() ?? data.files[0] ?? null;
  if (!file) return null;
  let handle: FileSystemFileHandle | null = null;
  try {
    const h = await handlePromise;
    if (h?.kind === 'file') handle = h as FileSystemFileHandle;
  } catch {
    handle = null;
  }
  return readFile(file, handle);
}

/** 保存的结果：写回了原文件，或触发了下载。 */
export type SaveResult = 'written' | 'downloaded';

/**
 * 写回文件：有句柄时用 `createWritable` 覆盖原文件；没有句柄但支持 `showSaveFilePicker` 时请用户选一次保存位置
 * （之后记住该句柄）；否则下载。用户取消时返回 `null`。
 */
export async function writeBack(file: OpenedFile, text: string, win: Window = window): Promise<SaveResult | null> {
  const bytes = encodeHtml({ text, bom: file.bom });
  if (!file.handle) {
    const pick = (win as PickerWindow).showSaveFilePicker;
    if (typeof pick === 'function') {
      try {
        file.handle = await pick.call(win, { suggestedName: file.name, types: HTML_TYPES });
      } catch (e) {
        if (isAbort(e)) return null;
        throw e;
      }
    }
  }
  if (file.handle) {
    const w = await file.handle.createWritable();
    try {
      await w.write(bytes as Uint8Array<ArrayBuffer>);
    } catch (e) {
      // 写到一半失败时放弃，原文件保持不变（close 才会提交）。
      await w.abort();
      throw e;
    }
    await w.close();
    return 'written';
  }
  download(win.document, file.name, bytes);
  return 'downloaded';
}

/** 以下载的方式保存字节。 */
export function download(doc: Document, name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'text/html' }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
