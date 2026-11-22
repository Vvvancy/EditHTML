/**
 * EHMD 中的 YAML：frontmatter（`meta`）与叶子组件的数据（`props`）。
 *
 * - 读取：`js-yaml` 的 YAML 1.2 Core schema（不把 `2026-11-22` 解析成日期，只产生 JSON 兼容值）。
 * - 输出：这里的小型确定性输出器（块映射；全是标量的数组写成流式 `[a, b]`；多行字符串写成 `|-` 块标量；
 *   其余字符串能写成 plain 标量时不加引号，否则用 JSON 风格双引号）。每个标量都用解析器做"预言机"校验，
 *   最终整体再校验一次；若仍不一致则退回 JSON（JSON 是 YAML 的子集），保证 `load(emit(v))` 与 `v` 等价。
 *
 * @module
 */
import { CORE_SCHEMA, load } from 'js-yaml';
import { stableStringify } from '../model.js';

/** YAML 解析结果。 */
export type YamlResult = { ok: true; value: unknown } | { ok: false; error: string };

/** 解析 YAML 文本；空文本（仅空白/注释）返回 `undefined`。不会抛错。 */
export function loadYaml(src: string): YamlResult {
  if (src.split('\n').every((l) => /^\s*(#.*)?$/.test(l))) return { ok: true, value: undefined };
  try {
    return { ok: true, value: load(src, { schema: CORE_SCHEMA }) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? (e.message.split('\n')[0] ?? 'invalid YAML') : 'invalid YAML' };
  }
}

const isScalar = (v: unknown): boolean => v === null || typeof v !== 'object';

function same(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function tryLoad(src: string): unknown {
  try {
    return load(src, { schema: CORE_SCHEMA });
  } catch {
    return Symbol.for('invalid');
  }
}

/** 键：能作为 plain 键时原样，否则 JSON 双引号。 */
function emitKey(k: string): string {
  if (/^[\p{L}\p{N}_][\p{L}\p{N}_ .-]*$/u.test(k) && !/[ .]$/.test(k)) {
    const v = tryLoad(`${k}: 0`);
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && k in v) return k;
  }
  return JSON.stringify(k);
}

/** 单行标量。`flow` 表示处于流式序列 `[…]` 中。 */
function emitScalar(v: unknown, flow: boolean): string {
  if (typeof v !== 'string') return v === undefined ? 'null' : JSON.stringify(v);
  if (v !== '' && !/[\n\r\t]/.test(v) && v.trim() === v && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(v)) {
    const probe = flow ? tryLoad(`[${v}]`) : tryLoad(`k: ${v}`);
    const got = flow
      ? Array.isArray(probe) && probe.length === 1
        ? probe[0]
        : undefined
      : (probe as { k?: unknown })?.k;
    if (got === v) return v;
  }
  return JSON.stringify(v);
}

/** 多行字符串的块标量形式（不可用时返回 null）。`indent` 为内容缩进。 */
function emitBlockScalar(s: string, indent: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (!s.includes('\n') || /[\r\t\u0000-\u0008\u000b-\u001f\u007f\u0085\u2028\u2029\ufeff]/.test(s)) return null;
  const body = s.replace(/\n+$/, '');
  const trailing = s.length - body.length;
  if (body === '' || /^[ ]/.test(body)) return null;
  if (body.split('\n').some((l) => / $/.test(l))) return null;
  const chomp = trailing === 0 ? '-' : trailing === 1 ? '' : '+';
  const lines = s.slice(0, trailing > 1 ? s.length - 1 : body.length).split('\n');
  return `|${chomp}\n` + lines.map((l) => (l === '' ? '' : indent + l)).join('\n');
}

function emitValue(v: unknown, indent: string): string {
  // 返回值：以 ' ' + 标量 或 '\n' + 块 开头，用于拼接在 "key:" 或 "-" 之后
  if (isScalar(v)) {
    if (typeof v === 'string') {
      const block = emitBlockScalar(v, indent + '  ');
      if (block !== null) return ' ' + block;
    }
    return ' ' + emitScalar(v, false);
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return ' []';
    if (v.every(isScalar) && v.every((x) => typeof x !== 'string' || !x.includes('\n'))) {
      const flow = `[${v.map((x) => emitScalar(x, true)).join(', ')}]`;
      if (flow.length <= 100) return ' ' + flow;
    }
    return '\n' + emitSeq(v, indent + '  ');
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (keys.length === 0) return ' {}';
  return '\n' + emitMap(obj, indent + '  ');
}

function emitSeq(arr: readonly unknown[], indent: string): string {
  return arr
    .map((item) => {
      if (!isScalar(item) && !Array.isArray(item) && Object.keys(item as object).length > 0) {
        // 映射作为序列项：第一行跟在 "- " 之后
        const inner = emitMap(item as Record<string, unknown>, indent + '  ');
        return `${indent}- ${inner.slice(indent.length + 2)}`;
      }
      return `${indent}-${emitValue(item, indent)}`;
    })
    .join('\n');
}

function emitMap(obj: Record<string, unknown>, indent: string): string {
  return Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${indent}${emitKey(k)}:${emitValue(obj[k], indent)}`)
    .join('\n');
}

/**
 * 把 JSON 兼容值输出为 YAML 文档文本（无结尾换行）。对象为顶层块映射；`{}` 输出空串。
 * 保证 `loadYaml(emitYaml(v))` 与 `v` 等价（`{}` ↔ 空文本由调用方约定）。
 */
export function emitYaml(value: unknown): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
    return '';
  let out: string;
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    out = emitMap(value as Record<string, unknown>, '');
  else if (Array.isArray(value) && value.length > 0) out = emitSeq(value, '');
  else out = emitValue(value, '').slice(1);
  if (same(tryLoad(out), value)) return out;
  return JSON.stringify(value, null, 2);
}
