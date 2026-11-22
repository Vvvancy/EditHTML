/**
 * {@link Doc} → EHMD（T1.6）。规则见 docs/01-format-spec.md §7 与其"实现约定（T1.6，暂定）"。
 *
 * 输出是确定的：同一文档总得到同一文本；`serializeEhmd ∘ parseEhmd` 幂等。
 * 降级内容（fallback）与 `head` 不写入 EHMD。
 *
 * @module
 */
import {
  getBlock,
  type Block,
  type BlockId,
  type ComponentBlock,
  type Doc,
  type HtmlBlock,
  type InlineNode,
  type TextBlock,
} from '../model.js';
import { emitAttrBlock, isAttrKey } from './attrs.js';
import { encodeContainer, HTML_DIRECTIVE, PROPS_DIRECTIVE, SLOT_DIRECTIVE, type DirectiveHead } from './directives.js';
import { destination, escapeText, serializeInline, titleString } from './inline-serialize.js';
import { directiveRegistry, parseEhmd } from './parse.js';
import { maxColonRun } from './prepass.js';
import type { BlockSerializer, EhmdSerializeOptions, SerializeContext } from './types.js';
import { emitYaml } from './yaml.js';

/** meta 键的输出顺序：与 `#eh-meta` 一致（01 §6.1）。 */
const META_ORDER = ['title', 'created', 'tags', 'theme'];

function orderedMeta(meta: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of META_ORDER) if (meta[k] !== undefined) out[k] = meta[k];
  for (const k of Object.keys(meta).sort()) if (!META_ORDER.includes(k) && meta[k] !== undefined) out[k] = meta[k];
  return out;
}

/** 文档内被引用的块 ID：链接 `#id` 与双链 `[[#^id…]]`。 */
function referencedIds(doc: Doc): Set<BlockId> {
  const refs = new Set<BlockId>();
  const scan = (content: readonly InlineNode[]): void => {
    for (const n of content) {
      for (const m of n.marks) if (m.type === 'link' && m.attrs?.href?.startsWith('#')) refs.add(m.attrs.href.slice(1));
      if (n.t === 'atom' && n.kind === 'wikilink') {
        const mm = /^\[\[#\^([^\]|#]+)/.exec(n.text);
        if (mm) refs.add(mm[1] as string);
      }
    }
  };
  for (const b of doc.blocks.values()) {
    if (b.kind !== 'text') continue;
    scan(b.content);
    if (b.table) for (const row of [b.table.head, ...b.table.body]) for (const c of row) scan(c);
  }
  return refs;
}

/** 可以在其后单独一行写 `^id` 的块（无法内联 ID）。 */
function takesTrailingId(b: Block, bareHtml: (h: string) => boolean): boolean {
  if (b.kind === 'text') return b.type === 'table' || b.type === 'quote' || b.type === 'hr' || b.type === 'code';
  return b.kind === 'html' && bareHtml(b.html);
}

const isEmptyP = (b: Block): boolean => b.kind === 'text' && b.type === 'p' && b.content.length === 0;

const fence = (n: number): string => ':'.repeat(Math.max(3, n));

/**
 * 序列化文档为 EHMD 文本（以 `\n` 结尾；空文档为空串）。
 *
 * @param doc 文档。
 * @param opts 选项；`ids` 默认 `'referenced'`，见 {@link EhmdSerializeOptions}。
 */
export function serializeEhmd(doc: Doc, opts: EhmdSerializeOptions = {}): string {
  const mode = opts.ids ?? 'referenced';
  const registry = directiveRegistry(opts.extensions ?? []);
  const hooks: BlockSerializer[] = (opts.extensions ?? []).flatMap((e) => (e.serializeBlock ? [e.serializeBlock] : []));
  const refs = mode === 'referenced' ? referencedIds(doc) : new Set<BlockId>();
  for (const id of opts.keepIds ?? []) refs.add(id);
  const forced = new Set<BlockId>();

  const bareCache = new Map<string, boolean>();
  const bareHtml = (html: string): boolean => {
    let ok = bareCache.get(html);
    if (ok === undefined) {
      // 原样写出的 HTML 必须单独成为一个 HTML 块，且在其后空一行就结束（不吞掉后续内容、不让预扫描误入围栏）
      const { doc: d } = parseEhmd(`${html}\n\n:::probe\n:::\n\nx`);
      const [first, second, third] = d.root.map((id) => d.blocks.get(id));
      ok =
        d.root.length === 3 &&
        first?.kind === 'html' &&
        first.html === html &&
        second?.kind === 'component' &&
        second.type === 'probe' &&
        third?.kind === 'text' &&
        third.type === 'p' &&
        third.content.length === 1 &&
        third.content[0]?.t === 'text' &&
        third.content[0].text === 'x';
      bareCache.set(html, ok);
    }
    return ok;
  };

  const emitId = (id: BlockId): boolean => mode === 'all' || forced.has(id) || (mode === 'referenced' && refs.has(id));

  const ctx: SerializeContext = {
    doc,
    emitId,
    blocks: (ids) => sequence(ids),
    inline: (content) => serializeInline(content),
  };

  /** 一串块：连续 li 归为一个列表；块之间空一行。 */
  function sequence(ids: readonly BlockId[]): string {
    const blocks = ids.map((id) => getBlock(doc, id));
    // 结构上必须写的 ID：空段落；以及空段落前面那个只能把 ID 写在其后的块
    if (mode !== 'none')
      blocks.forEach((b, i) => {
        if (!isEmptyP(b)) return;
        forced.add(b.id);
        const prev = blocks[i - 1];
        if (prev && takesTrailingId(prev, bareHtml)) forced.add(prev.id);
      });
    const parts: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i] as Block;
      if (b.kind === 'text' && b.type === 'li') {
        let j = i;
        while (j < blocks.length && (blocks[j] as Block).kind === 'text' && (blocks[j] as TextBlock).type === 'li') j++;
        parts.push(listGroup(blocks.slice(i, j) as TextBlock[]));
        i = j - 1;
        continue;
      }
      if (mode === 'none' && isEmptyP(b)) continue;
      parts.push(block(b));
    }
    return parts.join('\n\n');
  }

  function block(b: Block): string {
    for (const h of hooks) {
      const r = h(b, ctx);
      if (r !== undefined) return r;
    }
    if (b.kind === 'html') return htmlBlockOut(b);
    if (b.kind === 'component') return component(b);
    return textBlockOut(b);
  }

  const caret = (b: Block): string => (emitId(b.id) ? ` ^${b.id}` : '');
  const trailing = (b: Block): string => (emitId(b.id) ? `\n\n^${b.id}` : '');

  function textBlockOut(b: TextBlock): string {
    switch (b.type) {
      case 'p':
        if (b.content.length === 0) return `^${b.id}`;
        return serializeInline(b.content) + caret(b);
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const text = serializeInline(b.content, { singleLine: true });
        return `${'#'.repeat(Number(b.type[1]))}${text ? ' ' + text : ''}${emitId(b.id) ? ` {#${b.id}}` : ''}`;
      }
      case 'quote': {
        const text = serializeInline(b.content, { prefix: '> ' });
        return (text ? `> ${text}` : '>') + trailing(b);
      }
      case 'hr':
        return '---' + trailing(b);
      case 'code':
        return codeOut(b);
      case 'table':
        return tableOut(b) + trailing(b);
      case 'figure':
        return figureOut(b) + caret(b);
      case 'li':
        return listGroup([b]);
    }
  }

  function codeOut(b: TextBlock): string {
    const text = b.content.map((n) => (n.t === 'text' ? n.text : '')).join('');
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    const { lang, ...rest } = b.attrs;
    const attrs: Record<string, string> = {};
    let info = '';
    if (lang !== undefined && lang !== '') {
      if (/^[^\s`~{}\\&]+(?: [^\s`~{}\\&]+)*$/.test(lang)) info = lang;
      else attrs.lang = lang;
    }
    for (const [k, v] of Object.entries(rest)) if (isAttrKey(k) && k !== 'id') attrs[k] = v;
    const ab = emitAttrBlock(emitId(b.id) ? b.id : undefined, attrs);
    const infoLine = [info, ab].filter((x) => x).join(' ');
    // 信息串含反引号时只能用 ~~~ 围栏
    const useTilde = infoLine.includes('`');
    const ch = useTilde ? '~' : '`';
    let longest = 0;
    for (const m of body.matchAll(useTilde ? /^ {0,3}(~+)/gm : /^ {0,3}(`+)/gm))
      longest = Math.max(longest, (m[1] as string).length);
    const f = ch.repeat(Math.max(3, longest + 1));
    return text === '' ? `${f}${infoLine}\n${f}` : `${f}${infoLine}\n${body}\n${f}`;
  }

  function tableOut(b: TextBlock): string {
    const t = b.table ?? { head: [], body: [] };
    const cols = Math.max(t.align?.length ?? 0, t.head.length, ...t.body.map((r) => r.length), 1);
    const row = (cells: readonly (readonly InlineNode[])[]): string => {
      const out: string[] = [];
      for (let i = 0; i < cols; i++) out.push(serializeInline(cells[i] ?? [], { table: true, singleLine: true }));
      return `| ${out.join(' | ')} |`;
    };
    const align = Array.from({ length: cols }, (_, i) => {
      const a = t.align?.[i] ?? null;
      return a === 'left' ? ':---' : a === 'center' ? ':---:' : a === 'right' ? '---:' : '---';
    });
    return [row(t.head), `| ${align.join(' | ')} |`, ...t.body.map(row)].join('\n');
  }

  function figureOut(b: TextBlock): string {
    const alt = escapeText(b.attrs.alt ?? '', { singleLine: true }, false, false);
    const dest = destination(b.attrs.src ?? '', false);
    const c = b.content;
    const plain = c.length === 1 && c[0]?.t === 'text' && c[0].marks.length === 0;
    if (c.length === 0) return `![${alt}](${dest})`;
    if (plain) return `![${alt}](${dest} ${titleString((c[0] as { text: string }).text, false)})`;
    return `![${alt}](${dest}) ${serializeInline(c)}`;
  }

  function listGroup(items: readonly TextBlock[]): string {
    const lines: string[] = [];
    // 每层：当前列表类型、序号、该层项目内容的缩进
    const levels: { list: string; n: number; indent: string }[] = [];
    for (const li of items) {
      const depth = Math.min(Number(li.attrs.indent ?? '0') || 0, levels.length);
      const list = li.attrs.list === 'ol' ? 'ol' : 'ul';
      levels.length = Math.min(levels.length, depth + 1);
      const parentIndent = depth > 0 ? (levels[depth - 1] as { indent: string }).indent : '';
      let lv = levels[depth];
      if (!lv || lv.list !== list) {
        lv = { list, n: 0, indent: '' };
        levels[depth] = lv;
      }
      lv.n++;
      const marker = list === 'ol' ? `${lv.n}.` : '-';
      lv.indent = parentIndent + ' '.repeat(marker.length + 1);
      const task = li.attrs.task === 'done' ? '[x]' : li.attrs.task === 'todo' ? '[ ]' : '';
      const text = serializeInline(li.content, { prefix: lv.indent });
      const id = emitId(li.id) ? `^${li.id}` : '';
      const parts: string[] = [];
      if (task) parts.push(task);
      // 空任务项：`- [ ]` 单独一行不是任务项，用空注释占位
      if (text) parts.push(text);
      else if (task && !id) parts.push('<!---->');
      if (id) parts.push(id);
      lines.push(`${parentIndent}${marker}${parts.length ? ' ' + parts.join(' ') : ''}`);
    }
    return lines.join('\n');
  }

  function directiveHeadLine(
    colons: number,
    name: string,
    label: string | undefined,
    id: string | undefined,
    attrs: Readonly<Record<string, string>>,
  ): string {
    const ab = emitAttrBlock(id, Object.fromEntries(Object.entries(attrs).filter(([k]) => isAttrKey(k) && k !== 'id')));
    return `${fence(colons)}${name}${label !== undefined ? ' ' + label : ''}${ab ? ' ' + ab : ''}`;
  }

  function wrap(
    name: string,
    label: string | undefined,
    id: string | undefined,
    attrs: Readonly<Record<string, string>>,
    body: string,
  ): string {
    const n = Math.max(3, maxColonRun(body) + 1);
    const head = directiveHeadLine(n, name, label, id, attrs);
    return body === '' ? `${head}\n${fence(n)}` : `${head}\n${body}\n${fence(n)}`;
  }

  function component(b: ComponentBlock): string {
    const id = emitId(b.id) ? b.id : undefined;
    const spec = registry.get(b.type);
    const reserved = b.type === HTML_DIRECTIVE || b.type === PROPS_DIRECTIVE || b.type === SLOT_DIRECTIVE;
    if (!spec && !b.slots && !reserved) return wrap(b.type, undefined, id, b.attrs, emitYaml(b.props));
    if (spec && b.slots) {
      const enc = encodeContainer(spec, b.props, b.attrs, b.slots.length);
      if (enc) {
        let body: string;
        if (spec.slot !== undefined) {
          const slotName = spec.slot;
          body = b.slots
            .map((s, i) => {
              const h = (enc.slots?.[i] ?? { attrs: {} }) as DirectiveHead;
              return wrap(slotName, h.label, undefined, h.attrs, sequence(s));
            })
            .join('\n');
        } else body = sequence(b.slots[0] ?? []);
        return wrap(b.type, enc.label, id, enc.attrs, body);
      }
    }
    // 通用形式
    const parts = [wrap(PROPS_DIRECTIVE, undefined, undefined, {}, emitYaml(b.props))];
    for (const s of b.slots ?? []) parts.push(wrap(SLOT_DIRECTIVE, undefined, undefined, {}, sequence(s)));
    return wrap(b.type, undefined, id, b.attrs, parts.join('\n'));
  }

  function htmlBlockOut(b: HtmlBlock): string {
    if (bareHtml(b.html)) return b.html + trailing(b);
    return wrap(HTML_DIRECTIVE, undefined, emitId(b.id) ? b.id : undefined, {}, b.html);
  }

  const parts: string[] = [];
  const meta = orderedMeta(doc.meta);
  if (Object.keys(meta).length > 0) parts.push(`---\n${emitYaml(meta)}\n---`);
  let body = sequence(doc.root);
  if (parts.length === 0 && body.startsWith('---')) body = '***' + body.slice(3);
  if (body !== '') parts.push(body);
  return parts.length ? parts.join('\n\n') + '\n' : '';
}
