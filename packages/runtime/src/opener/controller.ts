/**
 * 打开器的状态机（T2.7）：打开文件 → 保真编辑 → 脏标记 → 保存写回 → 在新文本上重新打开会话。
 * 与界面无关：页面怎么建（iframe / 测试用的 happy-dom 文档）、会话怎么开（importer 的 `openPreserve`）、
 * 文件怎么写都由调用方注入，因此运行时不依赖 importer，`apps/web` 负责把两者接起来。
 *
 * ## 脚本与信任
 *
 * 打开时先算出页面可运行代码的指纹：没有脚本 → `none`；指纹在 {@link TrustStore} 中 → 直接运行（`running`）；
 * 否则不运行（`blocked`），由界面询问。{@link PreserveController.runScripts} 用当前文本（含未保存的修改）
 * 重建页面并运行脚本——sandbox 只能在载入前决定，所以必须重建。
 *
 * ## 保存之后
 *
 * 会话不会变基到新文本上，所以保存后要在新文本上重新开会话。默认**就地重挂**：卸载旧挂载层（属性还原）、
 * 合并容器内相邻的文本节点（编辑器常把文本拆成多段，而重新解析得到的是一段），再用新文本在同一个 DOM 上挂载。
 * 页面不刷新、滚动位置与脚本状态都保留。若重挂后出现了新的未配对元素（编辑产生了重新解析后结构不同的 DOM，
 * 如 `<p>` 里出现块级元素），说明 DOM 与新文本已不同形，则**整页重建**（保留滚动位置）。
 *
 * @module
 */
import { writeBack, type OpenedFile, type SaveResult } from './files.js';
import { mountThenRun, type OpenPreserve, type PreserveSessionLike } from './frame.js';
import { parseInert, scriptFingerprint } from './scripts.js';
import { TrustStore } from './trust.js';

/** 页面脚本的状态。 */
export type ScriptState = 'none' | 'blocked' | 'running';

/** 与 importer `GENERATED_ATTR` 相同（运行时不依赖 importer，此处重复定义）。 */
const GENERATED = 'data-eh-generated';

/** {@link PreserveController} 的选项。 */
export interface ControllerOptions<S extends PreserveSessionLike> {
  /** 开启保真会话（importer 的 `openPreserve`）。 */
  open: OpenPreserve<S>;
  /** 为 `source` 建一个与原文同形、脚本尚未运行的文档（浏览器中为 `loadInertFrame`）。 */
  createDocument: (source: string, runScripts: boolean) => Promise<Document>;
  /** 写回文件，默认 {@link writeBack}。返回 `null` 表示用户取消。 */
  write?: (file: OpenedFile, text: string) => Promise<SaveResult | null>;
  trust?: TrustStore;
  /** 状态变化（打开、脏标记、脚本状态、保存）。 */
  onChange?: () => void;
  /** 每建好一个新文档后回调（例如在 iframe 文档上绑定 Ctrl+S）。 */
  onDocument?: (doc: Document) => void;
  /** 编辑后多久重新计算脏标记（毫秒），默认 120。 */
  dirtyDelay?: number;
}

/** 保存的结果；`unchanged` 表示没有改动、什么也没写。 */
export type SaveOutcome = SaveResult | 'unchanged' | null;

/** 打开器状态机。 */
export class PreserveController<S extends PreserveSessionLike> {
  #file: OpenedFile | null = null;
  #doc: Document | null = null;
  #session: S | null = null;
  #scripts: ScriptState = 'none';
  #fingerprint: string | null = null;
  /** 磁盘上（最近一次保存后）的文本。 */
  #saved = '';
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #trust: TrustStore;

  constructor(private readonly options: ControllerOptions<S>) {
    this.#trust = options.trust ?? new TrustStore();
  }

  get file(): OpenedFile | null {
    return this.#file;
  }
  get doc(): Document | null {
    return this.#doc;
  }
  get session(): S | null {
    return this.#session;
  }
  get scripts(): ScriptState {
    return this.#scripts;
  }
  /** 当前内容是否与磁盘上的不同。 */
  get dirty(): boolean {
    return this.#dirty;
  }

  /** 打开文件：受信任的脚本直接运行，否则不运行（`scripts === 'blocked'`）。 */
  async open(file: OpenedFile): Promise<void> {
    this.close();
    this.#file = file;
    this.#saved = file.text;
    this.#fingerprint = await scriptFingerprint(parseInert(file.text));
    const run = this.#fingerprint !== null && this.#trust.has(this.#fingerprint);
    await this.#load(file.text, run);
  }

  /** 运行页面脚本；`remember` 为真时记住信任，以后打开同样的脚本不再询问。 */
  async runScripts(remember = false): Promise<void> {
    const session = this.#session;
    if (!session || this.#scripts !== 'blocked') return;
    if (remember && this.#fingerprint) this.#trust.add(this.#fingerprint);
    const text = session.save();
    session.close();
    this.#session = null;
    await this.#load(text, true);
    this.refreshDirty();
  }

  /** 立即重新计算脏标记（编辑器在会话之外改动 DOM 并 `touch` 之后也应调用）。 */
  refreshDirty(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const dirty = this.#session ? this.#session.save() !== this.#saved : false;
    if (dirty !== this.#dirty) {
      this.#dirty = dirty;
      this.#emit();
    }
  }

  /** 当前完整文本（含未保存的修改）。 */
  text(): string {
    return this.#session?.save() ?? this.#saved;
  }

  /** 保存：写回文件，然后在新文本上重新开会话（见模块说明）。 */
  async save(): Promise<SaveOutcome> {
    const file = this.#file;
    const session = this.#session;
    if (!file || !session) return null;
    const text = session.save();
    if (text === this.#saved) return 'unchanged';
    const write = this.options.write ?? writeBack;
    const result = await write(file, text);
    if (!result) return null;
    this.#saved = text;
    this.#file = { ...file, text }; // 句柄可能刚由 writeBack 补上，一并保留
    await this.#rebase(text);
    this.#dirty = false;
    this.#emit();
    return result;
  }

  /** 关闭当前文件（卸载挂载层）。 */
  close(): void {
    clearTimeout(this.#timer);
    this.#session?.close();
    this.#session = null;
    this.#doc = null;
    this.#file = null;
    this.#dirty = false;
    this.#scripts = 'none';
    this.#fingerprint = null;
  }

  async #load(text: string, run: boolean): Promise<void> {
    const win = this.#doc?.defaultView;
    const scroll = win ? [win.scrollX, win.scrollY] : null;
    const doc = await this.options.createDocument(text, run);
    this.#doc = doc;
    const { session } = await mountThenRun(doc, text, {
      open: this.options.open,
      runScripts: run,
      hooks: { onUserEdit: () => this.#edited() },
    });
    this.#session = session;
    this.#scripts = this.#fingerprint === null ? 'none' : run ? 'running' : 'blocked';
    if (scroll) doc.defaultView?.scrollTo(scroll[0] ?? 0, scroll[1] ?? 0);
    this.options.onDocument?.(doc);
    this.#emit();
  }

  /** 保存后在新文本上重开会话：优先就地重挂，DOM 与新文本不同形时整页重建。 */
  async #rebase(text: string): Promise<void> {
    const doc = this.#doc;
    const session = this.#session;
    if (!doc || !session) return;
    const before = doc.querySelectorAll(`[${GENERATED}]`).length;
    const containers = session.mount.containers();
    session.close();
    this.#session = null;
    for (const c of containers) c.normalize();
    const next = this.options.open(doc, text, { onUserEdit: () => this.#edited() });
    if (doc.querySelectorAll(`[${GENERATED}]`).length <= before) {
      this.#session = next;
      return;
    }
    next.close();
    await this.#load(text, this.#scripts === 'running');
  }

  #edited(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.refreshDirty(), this.options.dirtyDelay ?? 120);
  }

  #emit(): void {
    this.options.onChange?.();
  }
}
