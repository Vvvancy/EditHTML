import { describe, expect, it } from 'vitest';
import { TrustStore } from './trust.js';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('TrustStore', () => {
  it('记住指纹并持久化', () => {
    const storage = memoryStorage();
    const a = new TrustStore(storage);
    expect(a.has('sha256:1')).toBe(false);
    a.add('sha256:1');
    expect(a.has('sha256:1')).toBe(true);
    expect(new TrustStore(storage).has('sha256:1')).toBe(true);
  });

  it('存储损坏或不可写时不抛错', () => {
    const broken = {
      getItem: () => '{not json',
      setItem: () => {
        throw new Error('quota');
      },
    };
    const t = new TrustStore(broken);
    t.add('x');
    expect(t.has('x')).toBe(true);
    expect(new TrustStore(null).has('x')).toBe(false);
  });
});
