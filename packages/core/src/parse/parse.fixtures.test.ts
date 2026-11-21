/** 解析 `tests/fixtures/ehtml/*.ehtml`（T0.3 提供；目录不存在时跳过）。 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateDoc } from '../model.js';
import { parse } from './parser.js';

const dir = resolve(import.meta.dirname, '../../../../tests/fixtures/ehtml');
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.ehtml')) : [];

describe('fixtures', () => {
  it.skipIf(files.length === 0)('parses every fixture without throwing and with a valid doc', () => {
    for (const f of files) {
      const { doc } = parse(readFileSync(join(dir, f), 'utf8'));
      expect(validateDoc(doc), f).toEqual([]);
    }
  });
});
