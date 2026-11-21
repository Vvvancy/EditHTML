import { describe, expect, it } from 'vitest';
import { EDITOR_SPEC_VERSION } from './index.js';

describe('@edithtml/editor', () => {
  it('links against @edithtml/core', () => {
    expect(EDITOR_SPEC_VERSION).toBe('0.1');
  });
});
