/**
 * 规范形式的转义、属性与 JSON 嵌入规则（01 §6.1「属性」「文本」「JSON 嵌入」）。
 *
 * @module
 */
import type { DocMeta } from '../model.js';

const TEXT_SPECIAL = /[&<>]/;
const TEXT_SPECIAL_G = /[&<>]/g;
const ATTR_SPECIAL = /[&<>"]/;
const ATTR_SPECIAL_G = /[&<>"]/g;

const ENTITY: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const toEntity = (c: string): string => ENTITY[c] as string;

/**
 * 转义文本内容：只转义 `&` `<` `>`；其他字符（含 `"`、`'`、`\u00a0`、emoji）原样输出。
 *
 * @example escapeText('a < b & "c"') === 'a &lt; b &amp; "c"'
 */
export function escapeText(s: string): string {
  return TEXT_SPECIAL.test(s) ? s.replace(TEXT_SPECIAL_G, toEntity) : s;
}

/**
 * 转义属性值（用于双引号包裹的属性）：转义 `&` `<` `>` `"`；其他字符原样输出。
 *
 * @example escapeAttr('a"b') === 'a&quot;b'
 */
export function escapeAttr(s: string): string {
  return ATTR_SPECIAL.test(s) ? s.replace(ATTR_SPECIAL_G, toEntity) : s;
}

/**
 * 把一段 JSON 文本变为可安全嵌入 `<script>` 的形式：`</` → `<\/`、`<!--` → `\u003c!--`
 * （两者都是合法的 JSON 字符串转义，`JSON.parse` 结果不变）。
 */
export function escapeJsonForScript(json: string): string {
  if (!json.includes('<')) return json;
  return json.replaceAll('<!--', '\\u003c!--').replaceAll('</', '<\\/');
}

/**
 * 把 JSON 值嵌入 `<script type="application/json">`：`JSON.stringify` 单行紧凑输出
 * （对象键保持插入顺序），再按 {@link escapeJsonForScript} 处理。
 * `JSON.stringify` 返回 `undefined` 的值（`undefined`、函数等）输出为 `null`。
 */
export function embedJson(value: unknown): string {
  return escapeJsonForScript(JSON.stringify(value) ?? 'null');
}

/** `#eh-meta` 中固定在前的键（01 §6.1），其余键按字典序排在后面。 */
export const META_KEY_ORDER: readonly string[] = ['title', 'created', 'tags', 'theme'];

/** 按 UTF-16 码元比较的字典序（与 `Array.prototype.sort()` 默认行为一致，不依赖 locale）。 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 元数据 JSON（`#eh-meta` 内容，已做 script 嵌入转义）。
 * 顶层键顺序：`title, created, tags, theme`，其余键按字典序；值为 `undefined`（或其他
 * `JSON.stringify` 无法表示的值）的键省略；嵌套值按 {@link embedJson} 的规则（插入顺序）输出。
 * 空对象输出 `{}`。
 */
export function serializeMeta(meta: Readonly<DocMeta>): string {
  const keys = Object.keys(meta);
  const rest = keys.filter((k) => !META_KEY_ORDER.includes(k)).sort(compareCodeUnits);
  const ordered = [...META_KEY_ORDER.filter((k) => Object.hasOwn(meta, k)), ...rest];
  const parts: string[] = [];
  for (const k of ordered) {
    const v = JSON.stringify(meta[k]);
    if (v !== undefined) parts.push(`${JSON.stringify(k)}:${v}`);
  }
  return escapeJsonForScript(`{${parts.join(',')}}`);
}

/**
 * 按规范顺序输出属性串（每个属性前带一个空格）：`data-eh` → 其余 `data-eh-*`（字典序）
 * → 其他属性（字典序）。值用双引号并经 {@link escapeAttr} 转义；空字符串值输出为 `name=""`。
 *
 * @param id `data-eh` 的值；省略时不输出 `data-eh`。`attrs` 中的 `data-eh` 键总是被忽略。
 * @param attrs 属性名 → 值。
 */
export function serializeAttrs(id: string | undefined, attrs: Readonly<Record<string, string>>): string {
  let out = id === undefined ? '' : ` data-eh="${escapeAttr(id)}"`;
  const keys = Object.keys(attrs);
  if (keys.length === 0) return out;
  const eh: string[] = [];
  const other: string[] = [];
  for (const k of keys) {
    if (k === 'data-eh') continue;
    (k.startsWith('data-eh-') ? eh : other).push(k);
  }
  eh.sort(compareCodeUnits);
  other.sort(compareCodeUnits);
  for (const k of eh) out += ` ${k}="${escapeAttr(attrs[k] as string)}"`;
  for (const k of other) out += ` ${k}="${escapeAttr(attrs[k] as string)}"`;
  return out;
}
