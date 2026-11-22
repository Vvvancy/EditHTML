/**
 * 组件块 ↔ 指令块的映射规格（{@link DirectiveSpec}）。
 *
 * 默认（没有注册规格的组件类型，包括所有叶子组件）：`:::type {#id 其余块属性}` + YAML 体（props）。
 * 容器组件通过规格把 props 编码为"标签 + 属性 + 子指令标签"，见内置的 callout / toggle / tabs / columns。
 * 任何编码不了（`encode` 返回 `null` 或往返校验失败）的组件改用通用形式：
 *
 * ```markdown
 * ::::type {#id 块属性}
 * :::props
 * …YAML…
 * :::
 * :::slot
 * …槽位 0…
 * :::
 * ::::
 * ```
 *
 * @module
 */
import { stableStringify } from '../model.js';

/** 指令的标签与属性（不含 `#id`）。 */
export interface DirectiveHead {
  /** 指令名后的标签文本（已去首尾空白）；没有时为 `undefined`。 */
  label?: string;
  /** 属性块中的属性（不含 `#id`）。 */
  attrs: Record<string, string>;
}

/** 容器 props 编码结果。 */
export interface ContainerEncoding extends DirectiveHead {
  /** 每个槽位子指令的标签/属性（仅 `slot` 已定义时）。 */
  slots?: DirectiveHead[];
}

/** 容器 props 解码结果。 */
export interface ContainerDecoding {
  props: unknown;
  /** 没有被 props 消耗的属性 → 组件块 `attrs`。 */
  attrs: Record<string, string>;
}

/**
 * 组件 ↔ 指令的映射规格。T1.7 / `packages/blocks` 可以通过 `EhmdExtension.directives` 注册新的规格
 * （同名覆盖内置规格）。
 */
export interface DirectiveSpec {
  /** 组件类型 = 指令名。 */
  readonly type: string;
  /**
   * 子槽位指令名（如 tabs 的 `tab`）。省略表示单槽位容器：指令体本身就是槽位 0 的内容。
   */
  readonly slot?: string;
  /**
   * props（与块属性）→ 指令的标签/属性。返回 `null` 表示无法编码（改用通用形式）。
   * 结果会经 {@link DirectiveSpec.decode} 往返校验，不一致时同样改用通用形式。
   */
  encode(props: unknown, attrs: Readonly<Record<string, string>>, slotCount: number): ContainerEncoding | null;
  /** 指令的标签/属性 → props 与剩余块属性。 */
  decode(head: DirectiveHead, slots: readonly DirectiveHead[]): ContainerDecoding;
}

/** 通用形式中的保留子指令名。 */
export const PROPS_DIRECTIVE = 'props';
/** 通用形式中的槽位子指令名。 */
export const SLOT_DIRECTIVE = 'slot';
/** HTML 块的指令名（`:::html {#id}` + 原文）。 */
export const HTML_DIRECTIVE = 'html';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 标签文本能否安全地写在指令名之后（否则改用 `title="…"` 属性）。 */
export function isSafeLabel(s: string): boolean {
  return s !== '' && s.trim() === s && !/[{}\n\r]/.test(s) && !/^\[/.test(s);
}

/** 把 title 编码为标签或 `title` 属性；`''` 编码为"什么都不写"。 */
function encodeTitle(title: string, head: DirectiveHead): void {
  if (title === '') return;
  if (isSafeLabel(title)) head.label = title;
  else head.attrs.title = title;
}

function decodeTitle(head: DirectiveHead, rest: Record<string, string>): string {
  if ('title' in rest) {
    const t = rest.title as string;
    delete rest.title;
    return t;
  }
  return head.label ?? '';
}

/** 块属性中与 props 键冲突的不能编码。 */
function mergeAttrs(
  head: DirectiveHead,
  attrs: Readonly<Record<string, string>>,
  reserved: readonly string[],
): ContainerEncoding | null {
  for (const k of Object.keys(attrs)) if (reserved.includes(k)) return null;
  return { ...head, attrs: { ...head.attrs, ...attrs } };
}

/** 单槽位、props 为 `{kind?, title}` 的 callout。 */
const callout: DirectiveSpec = {
  type: 'callout',
  encode(props, attrs, slotCount) {
    if (slotCount !== 1 || !isObj(props)) return null;
    const head: DirectiveHead = { attrs: {} };
    for (const k of Object.keys(props)) if (k !== 'kind' && k !== 'title') return null;
    if (typeof props.title !== 'string') return null;
    if ('kind' in props) {
      if (typeof props.kind !== 'string') return null;
      head.attrs.kind = props.kind;
    }
    encodeTitle(props.title, head);
    return mergeAttrs(head, attrs, ['kind', 'title']);
  },
  decode(head) {
    const rest = { ...head.attrs };
    const props: Record<string, unknown> = {};
    if ('kind' in rest) {
      props.kind = rest.kind;
      delete rest.kind;
    }
    props.title = decodeTitle(head, rest);
    return { props, attrs: rest };
  },
};

/** 单槽位、props 为 `{title, open?}` 的 toggle。 */
const toggle: DirectiveSpec = {
  type: 'toggle',
  encode(props, attrs, slotCount) {
    if (slotCount !== 1 || !isObj(props)) return null;
    for (const k of Object.keys(props)) if (k !== 'open' && k !== 'title') return null;
    if (typeof props.title !== 'string') return null;
    const head: DirectiveHead = { attrs: {} };
    encodeTitle(props.title, head);
    if ('open' in props) {
      if (typeof props.open !== 'boolean') return null;
      head.attrs.open = String(props.open);
    }
    return mergeAttrs(head, attrs, ['open', 'title']);
  },
  decode(head) {
    const rest = { ...head.attrs };
    const props: Record<string, unknown> = { title: decodeTitle(head, rest) };
    if ('open' in rest) {
      props.open = rest.open !== 'false';
      delete rest.open;
    }
    return { props, attrs: rest };
  },
};

/** `{tabs:[{title}]}`，每个槽位一个 `:::tab 标题`。 */
const tabs: DirectiveSpec = {
  type: 'tabs',
  slot: 'tab',
  encode(props, attrs, slotCount) {
    if (!isObj(props) || Object.keys(props).length !== 1 || !Array.isArray(props.tabs)) return null;
    if (props.tabs.length !== slotCount) return null;
    const slots: DirectiveHead[] = [];
    for (const t of props.tabs) {
      if (!isObj(t) || Object.keys(t).length !== 1 || typeof t.title !== 'string') return null;
      const h: DirectiveHead = { attrs: {} };
      encodeTitle(t.title, h);
      slots.push(h);
    }
    return { attrs: { ...attrs }, slots };
  },
  decode(head, slots) {
    return {
      props: { tabs: slots.map((s) => ({ title: decodeTitle(s, { ...s.attrs }) })) },
      attrs: { ...head.attrs },
    };
  },
};

/** `{ratio:[1,2]}` → `ratio="1,2"`，每个槽位一个 `:::column`。 */
const columns: DirectiveSpec = {
  type: 'columns',
  slot: 'column',
  encode(props, attrs, slotCount) {
    if (!isObj(props)) return null;
    for (const k of Object.keys(props)) if (k !== 'ratio') return null;
    const head: DirectiveHead = { attrs: {} };
    if ('ratio' in props) {
      const r = props.ratio;
      if (!Array.isArray(r) || !r.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
      head.attrs.ratio = r.map(String).join(',');
    }
    const enc = mergeAttrs(head, attrs, ['ratio']);
    return enc && { ...enc, slots: Array.from({ length: slotCount }, () => ({ attrs: {} })) };
  },
  decode(head) {
    const rest = { ...head.attrs };
    const props: Record<string, unknown> = {};
    if ('ratio' in rest) {
      const raw = (rest.ratio as string).trim();
      props.ratio = raw === '' ? [] : raw.split(/\s*,\s*/).map(Number);
      delete rest.ratio;
    }
    return { props, attrs: rest };
  },
};

/** 内置的容器规格。 */
export const BUILTIN_DIRECTIVES: readonly DirectiveSpec[] = [callout, toggle, tabs, columns];

/** `encode` 的往返校验：解码结果与原 props/attrs 一致才可使用。 */
export function encodeContainer(
  spec: DirectiveSpec,
  props: unknown,
  attrs: Readonly<Record<string, string>>,
  slotCount: number,
): ContainerEncoding | null {
  const enc = spec.encode(props, attrs, slotCount);
  if (!enc) return null;
  if (spec.slot !== undefined && (enc.slots?.length ?? 0) !== slotCount) return null;
  if (spec.slot === undefined && slotCount !== 1) return null;
  if ('id' in enc.attrs) return null;
  if (enc.label !== undefined && !isSafeLabel(enc.label)) return null;
  for (const s of enc.slots ?? []) if (s.label !== undefined && !isSafeLabel(s.label)) return null;
  const dec = spec.decode(enc, enc.slots ?? []);
  if (stableStringify(dec.props) !== stableStringify(props)) return null;
  if (stableStringify(dec.attrs) !== stableStringify(attrs)) return null;
  return enc;
}
