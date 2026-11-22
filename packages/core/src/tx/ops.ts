/**
 * 操作（Op）定义（docs/02-architecture.md §2）。
 *
 * ## 可逆性设计：apply 时捕获
 *
 * 每个 Op 由两部分组成：
 * - **意图字段**（调用方填写）：如 `deleteText` 的 `block/from/to`；
 * - **捕获字段**（可选，`apply` 填写）：应用时从文档中读出的、构造逆操作所需的旧数据，
 *   如 `deleteText.deleted`（被删除的行内切片）、`removeBlock.removed`（子树与位置）。
 *
 * `apply` 返回的 `applied` 是"已解析"的 Op（捕获字段已填好）。`invert(op)` 是只依赖
 * 已解析 Op 的纯函数（不需要文档），对未解析的 Op 抛出 `TxError('notResolved')`。
 * `apply` 总是**重新计算**捕获字段、忽略输入中已有的值，所以把已解析的 Op 映射后
 * 重新应用（撤销/重做）是安全的。
 *
 * 所有偏移都处于模型的行内偏移空间（`inlineLength`：UTF-16 码元；`br` / `atom` 长度 1），
 * 且不得落在代理对中间。Op 载荷（文本、块、props 值）被文档**直接采用**，调用方之后不得修改。
 *
 * @module
 */
import type { Block, BlockId, DocHead, InlineNode, Mark, TableData } from '../model.js';

/** JSON Patch（RFC 6902）子集：`add` / `remove` / `replace`，路径为 JSON Pointer（RFC 6901）。 */
export type PatchOp =
  | { readonly op: 'add'; readonly path: string; readonly value: unknown }
  | { readonly op: 'replace'; readonly path: string; readonly value: unknown }
  | { readonly op: 'remove'; readonly path: string };

/** 块在树中的位置：父容器（`null` 为顶层）、槽位与下标。 */
export interface BlockPlace {
  readonly parent: BlockId | null;
  readonly slot: number;
  readonly index: number;
}

/** 被移除子树的捕获数据。 */
export interface RemovedSubtree extends BlockPlace {
  /** 子树根块。 */
  readonly block: Block;
  /** 子树内其余块（先序）。 */
  readonly descendants: readonly Block[];
}

/** `setMark` 捕获：范围内该类型标记的原值分段（`mark: null` 表示原来没有该类型标记）。 */
export interface MarkSegment {
  readonly from: number;
  readonly to: number;
  readonly mark: Mark | null;
}

/** `setHead` 可设置的键。 */
export type HeadKey = keyof DocHead;

/** 在 `offset` 处插入带标记的纯文本（`marks` 省略即无标记）。 */
export interface InsertTextOp {
  readonly t: 'insertText';
  readonly block: BlockId;
  readonly offset: number;
  readonly text: string;
  readonly marks?: readonly Mark[];
}

/** 在 `offset` 处插入任意行内内容（含 `br` / `atom`；粘贴、`deleteText` 的逆操作）。 */
export interface InsertContentOp {
  readonly t: 'insertContent';
  readonly block: BlockId;
  readonly offset: number;
  readonly content: readonly InlineNode[];
}

/** 删除 `[from, to)`。 */
export interface DeleteTextOp {
  readonly t: 'deleteText';
  readonly block: BlockId;
  readonly from: number;
  readonly to: number;
  /** 捕获：被删除的规范化行内切片。 */
  readonly deleted?: readonly InlineNode[];
}

/**
 * 对 `[from, to)` 添加（`value: true`）或移除（`value: false`）一种标记。
 * 添加时替换范围内同类型的旧标记（如不同 href 的 link）；移除时去掉该类型的任何标记（忽略 attrs）。
 * 作用于范围内所有行内节点（含 `br` / `atom`）。
 */
export interface SetMarkOp {
  readonly t: 'setMark';
  readonly block: BlockId;
  readonly from: number;
  readonly to: number;
  readonly mark: Mark;
  readonly value: boolean;
  /** 捕获：范围内**被改变的**分段及其原标记。 */
  readonly prev?: readonly MarkSegment[];
}

/**
 * 插入块（可带子树）。`parent: null` 为顶层（`slot` 必须为 0）。
 * 插入容器块时，其 `slots` 引用的所有后代放在 `descendants` 中（任意顺序，必须恰好覆盖整棵子树）。
 */
export interface InsertBlockOp {
  readonly t: 'insertBlock';
  readonly parent: BlockId | null;
  readonly slot: number;
  readonly index: number;
  readonly block: Block;
  readonly descendants?: readonly Block[];
}

/** 移除块及其整棵子树。 */
export interface RemoveBlockOp {
  readonly t: 'removeBlock';
  readonly id: BlockId;
  /** 捕获：子树与原位置。 */
  readonly removed?: RemovedSubtree;
}

/** 移动块（连同子树）。`index` 是在**移除该块之后**的目标序列中的下标。 */
export interface MoveBlockOp {
  readonly t: 'moveBlock';
  readonly id: BlockId;
  readonly parent: BlockId | null;
  readonly slot: number;
  readonly index: number;
  /** 捕获：原位置。 */
  readonly from?: BlockPlace;
}

/** 改块类型：文本块须为合法 `TextBlockType`；组件块为组件类型名；HTML 块不支持。 */
export interface SetTypeOp {
  readonly t: 'setType';
  readonly id: BlockId;
  readonly type: string;
  /** 捕获：原类型。 */
  readonly prev?: string;
}

/** 以 JSON Patch 修改组件块 `props`。 */
export interface SetPropsOp {
  readonly t: 'setProps';
  readonly id: BlockId;
  readonly patch: readonly PatchOp[];
  /** 捕获：逆 patch（可直接作为 `setProps.patch` 应用）。 */
  readonly inverse?: readonly PatchOp[];
}

/** 合并修改文本块 / 组件块的 `attrs`：值为 `null` 表示删除该键。 */
export interface SetAttrsOp {
  readonly t: 'setAttrs';
  readonly id: BlockId;
  readonly attrs: Readonly<Record<string, string | null>>;
  /** 捕获：这些键的原值（`null` 表示原来不存在）。 */
  readonly prev?: Readonly<Record<string, string | null>>;
}

/** 整体替换文本块的 `table`（`null` 删除）。用于增删行列、改对齐。单元格内容会被规范化。 */
export interface SetTableOp {
  readonly t: 'setTable';
  readonly id: BlockId;
  readonly table: TableData | null;
  /** 捕获：原表格（`null` 表示原来没有）。 */
  readonly prev?: TableData | null;
}

/** 替换表格的一个单元格内容。`section: 'head'` 时 `row` 必须为 0。 */
export interface SetCellOp {
  readonly t: 'setCell';
  readonly id: BlockId;
  readonly section: 'head' | 'body';
  readonly row: number;
  readonly col: number;
  readonly content: readonly InlineNode[];
  /** 捕获：原单元格内容。 */
  readonly prev?: readonly InlineNode[];
}

/** 设置组件块的降级 HTML 缓存（`null` 删除）。 */
export interface SetFallbackOp {
  readonly t: 'setFallback';
  readonly id: BlockId;
  readonly fallback: string | null;
  /** 捕获：原值。 */
  readonly prev?: string | null;
}

/**
 * 替换 HTML 块（`eh-html`）的原始 HTML。M2/M3 的区间补丁编辑最终都归结为本操作。
 */
export interface SetHtmlOp {
  readonly t: 'setHtml';
  readonly id: BlockId;
  readonly html: string;
  /** 捕获：原值。 */
  readonly prev?: string;
}

/**
 * 在组件块的 `slot` 处插入一个空槽位（如 tabs 新增一页）。
 * 对没有 `slots` 的组件块，`slot` 必须为 0，结果为 `[[]]`。
 */
export interface InsertSlotOp {
  readonly t: 'insertSlot';
  readonly id: BlockId;
  readonly slot: number;
  /** 捕获：应用前 `slots` 是否为 `undefined`。 */
  readonly created?: boolean;
}

/** 删除组件块的一个**空**槽位（先移走/删除其中的子块）。`unset: true` 且删除后无槽位时把 `slots` 置为 `undefined`。 */
export interface RemoveSlotOp {
  readonly t: 'removeSlot';
  readonly id: BlockId;
  readonly slot: number;
  readonly unset?: boolean;
}

/** 以 JSON Patch 修改文档 `meta`（根必须保持为对象）。 */
export interface SetMetaOp {
  readonly t: 'setMeta';
  readonly patch: readonly PatchOp[];
  /** 捕获：逆 patch。 */
  readonly inverse?: readonly PatchOp[];
}

/** 合并修改 `head` 字段：值为 `null` 表示删除。 */
export interface SetHeadOp {
  readonly t: 'setHead';
  readonly head: Readonly<Partial<Record<HeadKey, string | null>>>;
  /** 捕获：原值。 */
  readonly prev?: Readonly<Partial<Record<HeadKey, string | null>>>;
}

/**
 * 全部操作。HTML 块（`HtmlBlock`，06 §4）可编辑：用 `setHtml` 替换其原始 HTML；它没有 type/attrs。
 */
export type Op =
  | InsertTextOp
  | InsertContentOp
  | DeleteTextOp
  | SetMarkOp
  | InsertBlockOp
  | RemoveBlockOp
  | MoveBlockOp
  | SetTypeOp
  | SetPropsOp
  | SetAttrsOp
  | SetTableOp
  | SetCellOp
  | SetFallbackOp
  | SetHtmlOp
  | InsertSlotOp
  | RemoveSlotOp
  | SetMetaOp
  | SetHeadOp;

/** Op 的类型标签。 */
export type OpType = Op['t'];

/** 事务：有序的 Op 列表 + 可选元数据（供撤销历史使用，如时间戳、输入类型、`addToHistory`）。 */
export interface Transaction {
  readonly ops: readonly Op[];
  readonly meta?: Readonly<Record<string, unknown>>;
}
