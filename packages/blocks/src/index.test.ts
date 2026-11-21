import { describe, expect, it } from 'vitest';
import { BLOCKS_SPEC_VERSION } from './index.js';

describe('@edithtml/blocks', () => {
  it('links against @edithtml/core', () => {
    expect(BLOCKS_SPEC_VERSION).toBe('0.1');
  });
});
