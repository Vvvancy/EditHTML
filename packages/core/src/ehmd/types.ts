/**
 * EHMD 公共类型：选项、告警与扩展点。
 *
 * @module
 */
import type { Nodes, Root, RootContent, PhrasingContent } from 'mdast';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Extension as MicromarkExtension } from 'micromark-util-types';
import type { Block, BlockId, Doc, DocHead, InlineNode, Mark, TableData, TextBlockType } from '../model.js';
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
}

/** `parseEhmd` 的结果。 */
export interface EhmdParseResult {
  /** 解析得到的文档（`validateDoc(doc)` 恒为空）。 */
  readonly doc: Doc;
  readonly warnings: EhmdWarning[];
}

/** `serializeEhmd` 的选项。 */
export interface EhmdSerializeOptions {
  /** 块 ID 写入策略，默认 `'referenced'`。 */
  readonly ids?: EhmdIdMode;
  /** `'referenced'` 模式下额外需要保留的 ID（如其他笔记的反向链接引用的块）。 */
  readonly keepIds?: Iterable<BlockId>;
  /** 扩展（只用到 `directives` 与 `serializeBlock`）。 */
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
 * EHMD 扩展（T1.7 的 Obsidian 方言、`.md` 导出、`packages/blocks` 的组件都通过它接入）。
 */
export interface EhmdExtension {
  /** micromark 语法扩展（追加在 GFM、math 与 EHMD 行内语法之后）。 */
  readonly micromark?: readonly MicromarkExtension[];
  /** mdast-util-from-markdown 扩展，与 `micromark` 配对。 */
  readonly fromMarkdown?: readonly FromMarkdownExtension[];
  /** 转换前对每棵 mdast 树（每段 Markdown 一棵）做的变换。 */
  readonly transforms?: readonly ((tree: Root) => void)[];
  /** 块级处理器，按 mdast 节点类型（`node.type`）注册。 */
  readonly blockHandlers?: Readonly<Record<string, BlockHandler>>;
  /** 行内处理器，按 mdast 节点类型注册。 */
  readonly inlineHandlers?: Readonly<Record<string, InlineHandler>>;
  /** 组件 ↔ 指令映射规格（同 `type` 覆盖内置规格）。 */
  readonly directives?: readonly DirectiveSpec[];
  /** 块序列化钩子。 */
  readonly serializeBlock?: BlockSerializer;
}
