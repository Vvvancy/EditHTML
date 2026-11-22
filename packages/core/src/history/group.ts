/**
 * 输入合并规则（03 §4）：与变更类型无关，只看"在哪个目标的哪个位置插入/删除了什么文本"。
 *
 * 块模型的 {@link History} 把单个 `insertText` / `deleteText` 描述为 {@link TextEdit}；
 * 保真补丁层（T2.6）可把"在原始 HTML 的某个文本区间内输入"同样描述为 `TextEdit`（`target` 用区间 ID），
 * 复用同一套规则。
 *
 * ## 规则
 *
 * 新编辑合并进栈顶的输入组，当且仅当：
 * - 距组内最后一次编辑的时间 `< window`（默认 500ms，且时间未倒退）；
 * - 同一目标（块），且位置衔接（插入：从上次插入的末尾继续；删除：退格向前接上 / Delete 键原地继续）——
 *   位置不衔接即视为**选区跳转**；
 * - 同一种类：插入接插入（且 `style`（标记）相同），退格接退格，Delete 接 Delete；
 * - **在空白/标点之后断开**：插入时，若组内已输入的文本以空白或标点（含中文全角标点 `，。！？、；：` 等，
 *   即 Unicode `\p{P}`）结尾，则新开一组——所以 "hello world" 分成 "hello " 与 "world" 两步撤销；
 *   删除时，被删文本含空白或标点则新开一组（退格删 "world" 后再删空格，空格开始新的一组）。
 *
 * 其余情况（换块、非文本 Op、多 Op 事务、粘贴等）都不合并——由调用方不产生 `TextEdit` 来表达。
 *
 * @module
 */

/** 一次纯文本编辑的描述。 */
export interface TextEdit {
  /** `insert`：在 `from` 处插入 `text`（`to = from + text.length`）；`delete`：删除事务前的 `[from, to)`，`text` 为被删文本。 */
  readonly kind: 'insert' | 'delete';
  /** 目标（块 ID 或保真区间 ID）。 */
  readonly target: string;
  readonly from: number;
  readonly to: number;
  readonly text: string;
  /** 插入时的样式键（如标记集合的稳定串）；不同样式不合并。 */
  readonly style?: string;
}

/** 输入组种类。`delete` 为方向尚未确定的单次删除。 */
export type InputGroupKind = 'insert' | 'delete' | 'deleteBackward' | 'deleteForward';

/** 栈顶输入组的合并状态。 */
export interface InputGroup {
  readonly kind: InputGroupKind;
  readonly target: string;
  /** 组内最后一次编辑之后的光标位置（编辑后的坐标）。 */
  readonly cursor: number;
  readonly style: string;
  /** 组内最后一次编辑的文本（插入的或删除的）。 */
  readonly last: string;
  /** 组内最后一次编辑的时间（毫秒）。 */
  readonly time: number;
}

/** 合并参数。 */
export interface GroupOptions {
  /** 合并时间窗（毫秒），默认 {@link DEFAULT_MERGE_WINDOW}。 */
  readonly window?: number;
  /** 断开字符判定，默认 {@link isBreakChar}。 */
  readonly isBreak?: (ch: string) => boolean;
}

/** 默认合并时间窗：500ms（03 §4）。 */
export const DEFAULT_MERGE_WINDOW = 500;

const BREAK_RE = /^[\s\p{P}]$/u;

/** 默认断开字符：Unicode 空白与标点（`\p{P}`，含 `，。！？、；：「」` 等全角标点）。 */
export function isBreakChar(ch: string): boolean {
  return BREAK_RE.test(ch);
}

function lastChar(s: string): string {
  if (!s) return '';
  const c = s.codePointAt(s.length - 1) ?? 0;
  // 末尾是低代理项时取完整代理对。
  return c >= 0xdc00 && c <= 0xdfff && s.length >= 2 ? s.slice(-2) : s.slice(-1);
}

function hasBreak(s: string, isBreak: (ch: string) => boolean): boolean {
  for (const ch of s) if (isBreak(ch)) return true;
  return false;
}

/** 由一次编辑开启新的输入组。 */
export function startGroup(edit: TextEdit, now: number): InputGroup {
  return {
    kind: edit.kind === 'insert' ? 'insert' : 'delete',
    target: edit.target,
    cursor: edit.kind === 'insert' ? edit.from + (edit.to - edit.from) : edit.from,
    style: edit.style ?? '',
    last: edit.text,
    time: now,
  };
}

/**
 * 尝试把 `edit` 并入 `group`：可合并时返回更新后的组，否则返回 `null`（调用方应新开一项）。
 */
export function extendGroup(
  group: InputGroup,
  edit: TextEdit,
  now: number,
  opts: GroupOptions = {},
): InputGroup | null {
  const window = opts.window ?? DEFAULT_MERGE_WINDOW;
  const isBreak = opts.isBreak ?? isBreakChar;
  if (!(now >= group.time && now - group.time < window)) return null;
  if (edit.target !== group.target || !edit.text) return null;
  if (edit.kind === 'insert') {
    if (group.kind !== 'insert' || edit.from !== group.cursor || (edit.style ?? '') !== group.style) return null;
    const prev = lastChar(group.last);
    if (prev && isBreak(prev)) return null;
    return { ...group, cursor: edit.to, last: edit.text, time: now };
  }
  if (group.kind === 'insert' || hasBreak(edit.text, isBreak)) return null;
  if (edit.to === group.cursor && group.kind !== 'deleteForward')
    return { ...group, kind: 'deleteBackward', cursor: edit.from, last: edit.text, time: now };
  if (edit.from === group.cursor && group.kind !== 'deleteBackward')
    return { ...group, kind: 'deleteForward', last: edit.text, time: now };
  return null;
}
