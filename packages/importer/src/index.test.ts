import { describe, expect, it } from 'vitest';
import { IMPORTER_SPEC_VERSION } from './index.js';

describe('@edithtml/importer', () => {
  it('links against @edithtml/core', () => {
    expect(IMPORTER_SPEC_VERSION).toBe('0.1');
  });
});
