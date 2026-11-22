/**
 * @edithtml/importer — 任意 HTML 保真编辑、HTML/MD → 原生块、批量导入（docs/06-import.md）。
 *
 * @packageDocumentation
 */
import { SPEC_VERSION } from '@edithtml/core';

/** 本包所针对的规范版本。 */
export const IMPORTER_SPEC_VERSION: string = SPEC_VERSION;

export * from './markdown/index.js';
