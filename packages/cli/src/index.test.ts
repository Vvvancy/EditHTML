import { describe, expect, it } from 'vitest';
import { helpText } from './index.js';

describe('@edithtml/cli', () => {
  it('prints help with the spec version', () => {
    expect(helpText()).toContain('spec v0.1');
  });
});
