/**
 * @edithtml/cli — `eh convert / check / fmt`（任务 T1.7）。
 *
 * @packageDocumentation
 */
import { SPEC_VERSION } from '@edithtml/core';

/** CLI 帮助文本。 */
export function helpText(): string {
  return `eh — EditHTML command line (spec v${SPEC_VERSION})

Usage:
  eh convert <in> <out>   md ↔ ehtml (T1.7)
  eh check <file...>      validate (T1.7)
  eh fmt <file...>        canonicalize (T1.7)
`;
}
