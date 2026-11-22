/**
 * 指令属性块 `{#id key=val key="v w" .cls flag}` 的解析与输出。
 *
 * - `#id`：块 ID；`.cls`：并入 `class` 属性（空格分隔）；
 * - `key=val`（无引号值不含空白与 `"'={}`）、`key="…"`、`key='…'`；引号内用 `\"`、`\'`、`\\` 转义；
 * - 只有键：值为空串。
 *
 * @module
 */

/** 解析后的属性块。 */
export interface AttrBlock {
  /** `#id`（多个时取最后一个）。 */
  id?: string;
  /** 其余属性，按出现顺序。 */
  attrs: Record<string, string>;
}

const KEY = /^[A-Za-z_:][\w:.-]*/;

/** 解析属性块内部（不含花括号）。语法错误时返回 `null`。 */
export function parseAttrBlock(inner: string): AttrBlock | null {
  const out: AttrBlock = { attrs: {} };
  let i = 0;
  const s = inner;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '#' || c === '.') {
      const m = /^[^\s{}#.'"=][^\s{}'"=]*/.exec(s.slice(i + 1));
      if (!m) return null;
      if (c === '#') out.id = m[0];
      else out.attrs.class = out.attrs.class ? `${out.attrs.class} ${m[0]}` : m[0];
      i += 1 + m[0].length;
      continue;
    }
    const km = KEY.exec(s.slice(i));
    if (!km) return null;
    const key = km[0];
    i += key.length;
    if (s[i] !== '=') {
      out.attrs[key] = '';
      continue;
    }
    i++;
    const q = s[i];
    if (q === '"' || q === "'") {
      let v = '';
      i++;
      for (;;) {
        if (i >= s.length) return null;
        const ch = s[i] as string;
        if (ch === '\\' && i + 1 < s.length) {
          const e = s[i + 1] as string;
          v += e === 'n' ? '\n' : e === 'r' ? '\r' : e;
          i += 2;
          continue;
        }
        if (ch === q) {
          i++;
          break;
        }
        v += ch;
        i++;
      }
      out.attrs[key] = v;
    } else {
      const m = /^[^\s"'={}]+/.exec(s.slice(i));
      if (!m) return null;
      out.attrs[key] = m[0];
      i += m[0].length;
    }
  }
  return out;
}

/** 属性值：可不加引号时原样，否则双引号并转义 `\`、`"`、换行（`\n`、`\r`）。 */
export function attrValue(v: string): string {
  if (/^[^\s"'={}\\`]+$/.test(v)) return v;
  return `"${v.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/** 属性键是否可以写进属性块。 */
export function isAttrKey(k: string): boolean {
  return KEY.test(k) && KEY.exec(k)?.[0] === k;
}

/** 输出属性块（含花括号）；无内容时返回空串。 */
export function emitAttrBlock(id: string | undefined, attrs: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  if (id !== undefined) parts.push(`#${id}`);
  for (const [k, v] of Object.entries(attrs)) parts.push(`${k}=${attrValue(v)}`);
  return parts.length ? `{${parts.join(' ')}}` : '';
}

/**
 * 从行尾拆出属性块：`"label {#a k=v}"` → `{ rest: 'label', block }`。
 * 只认最后一个 `{` 起、到行尾 `}` 止且能完整解析的属性块。
 */
export function splitTrailingAttrs(line: string): { rest: string; block: AttrBlock | null } {
  const t = line.replace(/[ \t]+$/, '');
  if (!t.endsWith('}')) return { rest: t, block: null };
  for (let i = t.lastIndexOf('{'); i >= 0; i = i > 0 ? t.lastIndexOf('{', i - 1) : -1) {
    const block = parseAttrBlock(t.slice(i + 1, -1));
    if (block) return { rest: t.slice(0, i).replace(/[ \t]+$/, ''), block };
  }
  return { rest: t, block: null };
}
