/**
 * EHMD 公共类型：选项、告警与扩展点。
 *
 * @module
 */
import type { Nodes, Root, RootContent, PhrasingContent } from 'mdast';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Extension as MicromarkExtension } from 'micromark-util-types';
import type { Block, BlockId, Doc, DocHead, InlineAtom, InlineNode, Mark, TableData, TextBlockType } from '../model.js';
import type { ParseWarningCode } from '../parse/warnings.js';
import type { DirectiveSpec } from './directives.js';

/**
 * 块 ID 写入策略（05 #6）：
 * - `'all'`：每个块都写 ID（往返测试、源码模式切换用）；
 * - `'referenced'`（默认）：只写"需要的" ID——被文档内链接（`#id`、`[[#^id]]`）引用的块、
 *   `keepIds` 中的块，以及结构上必须写 ID 的块（空段落，及其前面无法内联 ID 的块）；
 * - `'none'`：不写 ID（导出给其他工具）；空段落会被省略。
 */
export type EhmdIdMode = 'all' | 'referenced' | 'none';

/** EHMD 告警代码：HTML 解析器的代码（来自 Markdown 中的原始 HTML）加上 EHMD 自己的代码。 */
export type EhmdWarningCode =
  | ParseWarningCode
  /** frontmatter 不是合法 YAML 映射（原文保留为 `yaml` 代码块）。 */
  | 'invalid-frontmatter'
  /** 指令体不是合法 YAML（整个指令原文保留为 `ehmd` 代码块）。 */
  | 'invalid-yaml'
  /** 指令没有结束行，延伸到文本末尾。 */
  | 'unclosed-directive'
  /** 指令中被忽略的部分（叶子组件的标签、槽位上的 `#id`、标签与 `title` 属性冲突等）。 */
  | 'ignored-directive-part'
  /** 容器中不在任何槽位子指令里的内容，并入相邻槽位。 */
  | 'stray-slot-content'
  /** 多段/嵌套引用被拆成多个 `quote` 块（引用中的其他块原样输出在其位置）。 */
  | 'flattened-quote'
  /** 列表项中第一段之后的内容：段落以 `br` 并入，其他块移出列表。 */
  | 'flattened-list-item'
  /** 段落中的图片被拆成独立的 figure 块。 */
  | 'split-paragraph'
  /** 无法放进模型的 Markdown 节点（原文保留为代码块）。 */
  | 'unsupported-node';

/** 一条 EHMD 告警。 */
export interface EhmdWarning {
  readonly code: EhmdWarningCode;
  /** 人类可读的说明（英文）。 */
  readonly message: string;
  /** 在源字符串中的大致偏移（UTF-16 码元）。 */
  readonly offset: number;
}

/** `parseEhmd` 的选项。 */
export interface EhmdParseOptions {
  /** 新分配块 ID 的前缀，默认 `'b'`。 */
  readonly idPrefix?: string;
  /** 结果文档的 `head`（EHMD 不承载 head；源码模式切换时传入原文档的 head）。 */
  readonly head?: DocHead;
  /** 扩展（按顺序应用；后注册的处理器优先）。 */
  readonly extensions?: readonly EhmdExtension[];
  /** 为 `true` 时在结果中附带 {@link EhmdSourceMap}（顶层块 ↔ 源码区间，T1.7 的无损导出用）。 */
  readonly sourceMap?: boolean;
}

/**
 * 顶层源码区间：一个顶层 Markdown 节点（或指令块）在输入中的范围，以及它产生的顶层块。
 * 单独一行的 `^id` 附着到前一个块时，其区间并入前一段。
 */
export interface EhmdSourceSegment {
  /** 在 {@link EhmdSourceMap.text} 中的起点（UTF-16 码元）。 */
  readonly start: number;
  /** 终点（不含）。 */
  readonly end: number;
  /** 该区间产生的顶层块（可能为空，如空白 HTML）。 */
  readonly blocks: readonly BlockId[];
}

/** {@link EhmdParseOptions.sourceMap} 的结果。 */
export interface EhmdSourceMap {
  /** 规范化后的输入（去 BOM、换行统一为 `\n`），所有偏移都相对于它。 */
  readonly text: string;
  /** frontmatter（含首尾 `---` 行及其后的换行）的终点；没有 frontmatter 时为 `null`。 */
  readonly frontmatterEnd: number | null;
  /** 按文档顺序的顶层区间。 */
  readonly segments: readonly EhmdSourceSegment[];
}

/** `parseEhmd` 的结果。 */
export interface EhmdParseResult {
  /** 解析得到的文档（`validateDoc(doc)` 恒为空）。 */
  readonly doc: Doc;
  readonly warnings: EhmdWarning[];
  /** 仅当 `opts.sourceMap` 为 `true` 时存在。 */
  readonly sourceMap?: EhmdSourceMap;
}

/** `serializeEhmd` 的选项。 */
export interface EhmdSerializeOptions {
  /** 块 ID 写入策略，默认 `'referenced'`。 */
  readonly ids?: EhmdIdMode;
  /** `'referenced'` 模式下额外需要保留的 ID（如其他笔记的反向链接引用的块）。 */
  readonly keepIds?: Iterable<BlockId>;
  /**
   * 只输出块序列（文档片段）：不写 frontmatter，也不把开头的 `---` 改写成 `***`。
   * 用于把若干块嵌入更大的 Markdown 文本（T1.7 的逐段导出）。
   */
  readonly fragment?: boolean;
  /** 扩展（只用到 `directives`、`serializeBlock`、`serializeAtom` 与 `escapeChar`）。 */
  readonly extensions?: readonly EhmdExtension[];
}

// ───────────────────────────── 解析扩展点 ─────────────────────────────

/**
 * 解析时的中间块（ID 尚未分配）。`id` 为源码中写明的 ID（可能非法或重复，最后统一处理）。
 */
export type PendingBlock =
  | {
      readonly k: 'text';
      type: TextBlockType;
      attrs: Record<string, string>;
      content: InlineNode[];
      table?: TableData;
      id?: string;
      /** 可以接收其后单独一行 `^id` 的块（table/quote/hr/原始 HTML 产生的块）。 */
      trailingId?: boolean;
      offset: number;
    }
  | {
      readonly k: 'component';
      type: string;
      props: unknown;
      attrs: Record<string, string>;
      slots?: PendingBlock[][];
      id?: string;
      trailingId?: boolean;
      offset: number;
    }
  | { readonly k: 'html'; html: string; id?: string; trailingId?: boolean; offset: number };

/** 块转换上下文（传给 {@link BlockHandler}）。 */
export interface BlockContext {
  /** 当前正在转换的 Markdown 文本（占位替换后），节点 `position.offset` 指向它。 */
  readonly source: string;
  /** 节点在 {@link BlockContext.source} 中的原文。 */
  raw(node: Nodes): string;
  /** 转换一组块级节点（走完整的处理器链）。 */
  blocks(nodes: readonly RootContent[]): PendingBlock[];
  /** 转换一组行内节点。`marks` 为外层标记。 */
  inline(nodes: readonly PhrasingContent[], marks?: readonly Mark[]): InlineNode[];
  /** 从段落/标题末尾剥离块 ID 标记（`^id`，`allowBraces` 时也认 `{#id}`），返回 ID 与剩余子节点。 */
  stripId(
    node: Nodes & { children: PhrasingContent[] },
    allowBraces?: boolean,
  ): { id?: string; children: PhrasingContent[] };
  /** 按 YAML 解析文本。 */
  yaml(src: string): { ok: true; value: unknown } | { ok: false; error: string };
  /** 递归解析一段 EHMD 文本（如容器指令体）。 */
  parseBody(src: string, offset: number): PendingBlock[];
  /** 节点在原始输入中的偏移。 */
  offset(node: Nodes): number;
  warn(code: EhmdWarningCode, message: string, offset: number): void;
}

/**
 * 块级处理器：把一个 mdast 块节点转为若干中间块。返回 `undefined` 表示不处理，交给 `next`
 * （下一个注册的处理器，最终是内置处理器）。
 */
export type BlockHandler = (
  node: RootContent,
  ctx: BlockContext,
  next: () => PendingBlock[],
) => PendingBlock[] | undefined;

/** 行内处理器：把一个 mdast 行内节点转为行内节点。返回 `undefined` 表示交给 `next`。 */
export type InlineHandler = (
  node: PhrasingContent,
  marks: readonly Mark[],
  ctx: BlockContext,
  next: () => InlineNode[],
) => InlineNode[] | undefined;

// ───────────────────────────── 序列化扩展点 ─────────────────────────────

/** 块序列化上下文。 */
export interface SerializeContext {
  readonly doc: Doc;
  /** 该块是否要写 ID（按 ids 策略计算）。 */
  emitId(id: BlockId): boolean;
  /** 序列化一串块（如容器槽位），块之间空一行。 */
  blocks(ids: readonly BlockId[]): string;
  /** 序列化行内内容（单行段落语境）。 */
  inline(content: readonly InlineNode[]): string;
}

/**
 * 块序列化钩子：返回字符串则替代内置输出（应为完整的 EHMD 块，不含首尾空行）；返回 `undefined` 交给内置实现。
 * 注意：自定义输出必须能被（同一组扩展下的）`parseEhmd` 读回，往返测试才成立。
 */
export type BlockSerializer = (block: Block, ctx: SerializeContext) => string | undefined;

/**
 * 原子序列化钩子：返回字符串则替代内置的原子输出（`$tex$`、`[[…]]`、`#tag` 或 span）；
 * 返回 `undefined` 交给内置实现。`prev` / `next` 是同一行内序列中的相邻节点。
 */
export type AtomSerializer = (
  atom: InlineAtom,
  ctx: { readonly table?: boolean; readonly singleLine?: boolean },
  prev: InlineNode | undefined,
  next: InlineNode | undefined,
) => string | undefined;

/**
 * 文本转义钩子：对文本中的 ASCII 标点 `c`（`prev` / `next` 为同一文本节点中的相邻字符，节点边缘为 `undefined`）
 * 返回 `true` 时额外转义。用于扩展新增的行内语法（如 Obsidian 的 `%%注释%%`）。
 */
export type EscapeHook = (c: string, prev: string | undefined, next: string | undefined) => boolean;

/**
 * EHMD 扩展（T1.7 的 Obsidian 方言、`.md` 导出、`packages/blocks` 的组件都通过它接入）。
 */
export interface EhmdExtension {
  /** micromark 语法扩展（追加在 GFM、math 与 EHMD 行内语法之后）。 */
  readonly micromark?: readonly MicromarkExtension[];
  /** mdast-util-from-markdown 扩展，与 `micromark` 配对。 */
  readonly fromMarkdown?: readonly FromMarkdownExtension[];
  /**
   * 转换前对每棵 mdast 树（每段 Markdown 一棵）做的变换。`source` 是该树对应的 Markdown 文本
   * （节点 `position.offset` 指向它；指令已替换为占位注释）。
   */
  readonly transforms?: readonly ((tree: Root, source: string) => void)[];
  /** 块级处理器，按 mdast 节点类型（`node.type`）注册。 */
  readonly blockHandlers?: Readonly<Record<string, BlockHandler>>;
  /** 行内处理器，按 mdast 节点类型注册。 */
  readonly inlineHandlers?: Readonly<Record<string, InlineHandler>>;
  /** 组件 ↔ 指令映射规格（同 `type` 覆盖内置规格）。 */
  readonly directives?: readonly DirectiveSpec[];
  /**
   * 中间块变换：在分配块 ID 之前，对顶层中间块序列（含容器槽位中的子块，需自行递归）调用一次，可原地修改。
   * 例如把不符合 `BLOCK_ID_RE` 的源码 ID 转存到 `attrs` 中。
   */
  readonly pendingTransforms?: readonly ((blocks: PendingBlock[]) => void)[];
  /** 块序列化钩子。 */
  readonly serializeBlock?: BlockSerializer;
  /** 原子序列化钩子（`serializeEhmd` 中所有行内内容都会经过它）。 */
  readonly serializeAtom?: AtomSerializer;
  /** 文本转义钩子（`serializeEhmd` 中所有行内文本都会经过它）。 */
  readonly escapeChar?: EscapeHook;
}
