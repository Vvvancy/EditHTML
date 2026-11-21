import { describe, expect, it } from 'vitest';
import { RENDERER_SPEC_VERSION } from './index.js';

describe('@edithtml/renderer', () => {
  it('links against @edithtml/core', () => {
    expect(RENDERER_SPEC_VERSION).toBe('0.1');
  });
});
