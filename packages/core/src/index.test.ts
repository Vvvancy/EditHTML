import { describe, expect, it } from 'vitest';
import { SPEC_VERSION } from './index.js';

describe('@edithtml/core', () => {
  it('exposes the spec version', () => {
    expect(SPEC_VERSION).toBe('0.1');
  });
});
