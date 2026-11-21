/**
 * 不可变 JSON Patch 子集（add / remove / replace）及其逆 patch。
 *
 * 写时复制：只复制从根到目标的路径，其余子树按引用共享；输入值从不被修改。
 *
 * 逆 patch 的构造保证撤销后**对象键顺序**也复原（序列化器按插入顺序输出 props，见 01 §6.1）：
 * 删除对象键的逆操作是用原父对象 `replace` 父路径，而非在末尾重新 `add`。
 *
 * @module
 */
import { fail } from './errors.js';
import type { PatchOp } from './ops.js';

/** 解析 JSON Pointer（RFC 6901）。`''` 为根。 */
export function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) fail('invalid', `JSON pointer must start with "/": ${JSON.stringify(path)}`);
  return path
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** 由路径片段构造 JSON Pointer。 */
export function formatPointer(tokens: readonly string[]): string {
  return tokens.map((t) => '/' + t.replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}

type Container = Record<string, unknown> | unknown[];

const isContainer = (v: unknown): v is Container => v !== null && typeof v === 'object';

function arrayIndex(token: string, len: number, allowEnd: boolean, path: string): number {
  if (allowEnd && token === '-') return len;
  if (!/^(0|[1-9][0-9]*)$/.test(token)) fail('invalid', `bad array index in ${path}`);
  const i = Number(token);
  if (i > len || (!allowEnd && i === len)) fail('range', `array index out of range in ${path}`);
  return i;
}

function getChild(c: Container, token: string, path: string): unknown {
  if (Array.isArray(c)) return c[arrayIndex(token, c.length, false, path)];
  if (!Object.prototype.hasOwnProperty.call(c, token)) fail('invalid', `path not found: ${path}`);
  return c[token];
}

function setChild(c: Container, token: string, value: unknown, path: string): Container {
  if (Array.isArray(c)) {
    const copy = c.slice();
    copy[arrayIndex(token, c.length, false, path)] = value;
    return copy;
  }
  return { ...c, [token]: value };
}

/**
 * 应用 patch，返回新值与逆 patch（逆 patch 作用于结果值时得到原值）。无效 patch 抛 `TxError`。
 */
export function applyPatch(value: unknown, patch: readonly PatchOp[]): { value: unknown; inverse: PatchOp[] } {
  let doc = value;
  const inverse: PatchOp[] = [];
  for (const op of patch) {
    const tokens = parsePointer(op.path);
    if (op.op !== 'remove' && op.value === undefined) fail('invalid', `${op.op} ${op.path}: value is undefined`);
    if (tokens.length === 0) {
      if (op.op === 'remove') fail('invalid', 'cannot remove the root');
      inverse.push({ op: 'replace', path: '', value: doc });
      doc = op.value;
      continue;
    }
    // 沿路径收集容器。
    const chain: Container[] = [];
    let cur: unknown = doc;
    for (let i = 0; i < tokens.length - 1; i++) {
      if (!isContainer(cur)) fail('invalid', `path not found: ${op.path}`);
      chain.push(cur);
      cur = getChild(cur, tokens[i] as string, op.path);
    }
    if (!isContainer(cur)) fail('invalid', `path not found: ${op.path}`);
    const parent = cur;
    const last = tokens[tokens.length - 1] as string;
    const parentPath = formatPointer(tokens.slice(0, -1));
    let next: Container;
    if (Array.isArray(parent)) {
      if (op.op === 'add') {
        const i = arrayIndex(last, parent.length, true, op.path);
        next = [...parent.slice(0, i), op.value, ...parent.slice(i)];
        inverse.push({ op: 'remove', path: formatPointer([...tokens.slice(0, -1), String(i)]) });
      } else {
        const i = arrayIndex(last, parent.length, false, op.path);
        if (op.op === 'remove') {
          next = [...parent.slice(0, i), ...parent.slice(i + 1)];
          inverse.push({ op: 'add', path: op.path, value: parent[i] });
        } else {
          next = setChild(parent, last, op.value, op.path);
          inverse.push({ op: 'replace', path: op.path, value: parent[i] });
        }
      }
    } else {
      const has = Object.prototype.hasOwnProperty.call(parent, last);
      if (op.op === 'add' || op.op === 'replace') {
        if (op.op === 'replace' && !has) fail('invalid', `path not found: ${op.path}`);
        next = { ...parent, [last]: op.value };
        inverse.push(has ? { op: 'replace', path: op.path, value: parent[last] } : { op: 'remove', path: op.path });
      } else {
        if (!has) fail('invalid', `path not found: ${op.path}`);
        const { [last]: _removed, ...rest } = parent;
        next = rest;
        inverse.push({ op: 'replace', path: parentPath, value: parent });
      }
    }
    // 写回路径。
    let acc: unknown = next;
    for (let i = chain.length - 1; i >= 0; i--)
      acc = setChild(chain[i] as Container, tokens[i] as string, acc, op.path);
    doc = acc;
  }
  return { value: doc, inverse: inverse.reverse() };
}
