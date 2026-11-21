// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isEditHtmlDocument } from './index.js';

describe('@edithtml/runtime', () => {
  it('detects .ehtml documents by data-eh-version', () => {
    expect(isEditHtmlDocument(document)).toBe(false);
    document.documentElement.setAttribute('data-eh-version', '0.1');
    expect(isEditHtmlDocument(document)).toBe(true);
  });
});
